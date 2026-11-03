"""Ejecuta un cálculo mecánico-cuántico con Psi4 y guarda los resultados en JSON.

Uso:  python calculo_psi4.py <carpeta_del_trabajo>

La carpeta debe contener `entrada.json` (lo escribe servidor.js):
    {"xyz": "C 0 0 0\\nH ...", "carga": 0, "multiplicidad": 1,
     "metodo": "b3lyp", "base": "6-31g*", "tarea": "energia|optimizacion|frecuencias|ts|irc|scan",
     "mep": true, "hilos": 2, "memoria": "2 GB", "titulo": "etanol"}

Archivos que produce en la carpeta:
    salida.dat        salida completa de Psi4 (texto)
    resultado.json    resumen para la interfaz web
    geometria.xyz     geometría final
    homo.cube / lumo.cube / densidad.cube / mep.cube   (superficies para el visor 3D)

Las líneas que empiezan con "@@ETAPA" en la salida estándar las usa el servidor
para mostrar el progreso.
"""
import contextlib
import json
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import psi4

HARTREE_KCAL = psi4.constants.hartree2kcalmol
HARTREE_EV = psi4.constants.hartree2ev
BOHR_ANG = psi4.constants.bohr2angstroms
AU_DEBYE = psi4.constants.dipmom_au2debye

METODOS = {"hf", "b3lyp", "pbe0", "wb97x-d", "m06-2x", "mp2"}
BASES = {"sto-3g", "3-21g", "6-31g", "6-31g*", "6-31g**", "6-31+g*", "6-311g**",
         "cc-pvdz", "aug-cc-pvdz", "def2-svp", "def2-tzvp"}
TAREAS = {"energia", "optimizacion", "frecuencias", "ts", "irc", "scan"}


def etapa(texto):
    print(f"@@ETAPA {texto}", flush=True)


def a_numpy(valor):
    """Convierte Matrix/Vector de Psi4 (o listas) en un arreglo de NumPy."""
    return np.asarray(getattr(valor, "np", valor))


def variable_global(nombre):
    try:
        if psi4.core.has_variable(nombre):
            return float(psi4.core.variable(nombre))
    except Exception:
        pass
    return None


def texto_xyz(simbolos, coords):
    return "\n".join(f"{s:<2s} {x:14.8f} {y:14.8f} {z:14.8f}" for s, (x, y, z) in zip(simbolos, coords))


def geometria_actual(mol):
    mol.update_geometry()
    simbolos = [mol.symbol(i).capitalize() for i in range(mol.natom())]
    coords = a_numpy(mol.geometry()).reshape(-1, 3) * BOHR_ANG
    return simbolos, coords


def funcion_scf(wfn):
    """Devuelve la función de onda SCF (útil cuando el método es MP2)."""
    try:
        ref = wfn.reference_wavefunction()
        if ref is not None:
            return ref
    except Exception:
        pass
    return wfn


def emitir_paso(paso, mol, gradiente):
    """Envía al servidor la geometría recién evaluada (línea @@GEOM con JSON) para el visor en vivo."""
    simbolos, coords = geometria_actual(mol)
    g = a_numpy(gradiente).reshape(-1)
    datos = {
        "paso": paso,
        "energia": variable_global("CURRENT ENERGY"),
        "grad_rms": float(np.sqrt(np.mean(g ** 2))) if g.size else None,
        "grad_max": float(np.abs(g).max()) if g.size else None,
        "xyz": texto_xyz(simbolos, coords),
    }
    print("@@GEOM " + json.dumps(datos), flush=True)


@contextlib.contextmanager
def en_vivo(mol, contador=None, registro=None):
    """Mientras dura el bloque, cada paso del optimizador se envía al visor 3D (@@GEOM).

    Se envuelve gradient(), que el ciclo de optimización de Psi4 llama una vez por paso. Se
    reemplaza en el espacio de nombres de la propia función optimize (optimize.__globals__),
    que es donde Psi4 la busca. Ojo: «psi4.driver» no sirve, porque `from .driver import *` en
    psi4/__init__.py lo deja apuntando al módulo driver.py. Si la envoltura no es posible, el
    cálculo funciona igual, sin pasos intermedios.
    `contador` (lista de un entero) permite numerar seguido entre varias llamadas; `registro`
    (lista) guarda la energía y la geometría de cada paso.
    """
    contador = contador if contador is not None else [0]
    espacio = getattr(psi4.optimize, "__globals__", None)
    if not (isinstance(espacio, dict) and callable(espacio.get("gradient"))):
        espacio = getattr(sys.modules.get("psi4.driver.driver"), "__dict__", None)
    original = espacio.get("gradient") if isinstance(espacio, dict) else None

    def gradiente_con_aviso(name, **kwargs):
        salida = original(name, **kwargs)
        # Sólo los pasos del ciclo de optimización (que usa nuestra molécula), no las
        # geometrías desplazadas de un hessiano por diferencias finitas
        if kwargs.get("molecule") is not mol:
            return salida
        try:
            contador[0] += 1
            emitir_paso(contador[0], mol, salida[0] if isinstance(salida, tuple) else salida)
            if registro is not None:
                simbolos, coords = geometria_actual(mol)
                registro.append({"energia": variable_global("CURRENT ENERGY"), "xyz": texto_xyz(simbolos, coords)})
        except Exception:  # noqa: BLE001  (el aviso nunca debe interrumpir el cálculo)
            pass
        return salida

    if callable(original):
        espacio["gradient"] = gradiente_con_aviso
    try:
        yield contador
    finally:
        if callable(original):
            espacio["gradient"] = original


def optimizar(metodo, mol):
    """Optimiza la geometría y, si Psi4 lo permite, devuelve también la trayectoria."""
    historia = None
    with en_vivo(mol):
        try:
            salida = psi4.optimize(metodo, molecule=mol, return_wfn=True, return_history=True)
            energia, historia = salida[0], salida[-1]
        except TypeError:
            energia = psi4.optimize(metodo, molecule=mol)
    trayectoria = []
    if isinstance(historia, dict) and historia.get("coordinates"):
        simbolos = [mol.symbol(i).capitalize() for i in range(mol.natom())]
        energias = list(historia.get("energy") or [])
        for i, c in enumerate(historia["coordinates"]):
            coords = a_numpy(c).reshape(-1, 3) * BOHR_ANG
            e = float(energias[i]) if i < len(energias) else None
            trayectoria.append({"paso": i + 1, "energia": e, "xyz": texto_xyz(simbolos, coords)})
    return float(energia), trayectoria


def leer_camino_irc(mol):
    """Puntos convergidos del IRC que Psi4 guarda en <prefijo>.opt.json (opción write_opt_history)."""
    candidatos = []
    try:
        candidatos.append(Path(f"{psi4.core.get_writer_file_prefix(mol.name())}.opt.json"))
    except Exception:  # noqa: BLE001
        pass
    candidatos += sorted(Path.cwd().glob("*.opt.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for ruta in candidatos:
        if not ruta.is_file():
            continue
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8"))
            ruta.unlink()  # para que la siguiente dirección no lea este archivo
        except Exception:  # noqa: BLE001
            continue
        camino = (datos.get("extras") or {}).get("irc_rxn_path") or []
        return [p for p in camino if p and p.get("x") is not None and p.get("energy") is not None]
    return None


def irc(metodo, mol, direccion="ambas", puntos=20, paso=0.2):
    """Camino de reacción intrínseco (IRC) desde un estado de transición.

    optking recorre una dirección por llamada (forward = + a lo largo del modo imaginario), así
    que para el camino completo se parte dos veces del TS. Cada recorrido calcula el hessiano en
    el TS. Devuelve los puntos ordenados de un extremo al otro, con la coordenada de reacción s
    (bohr·amu^½; negativa hacia atrás) y la energía.
    """
    simbolos = [mol.symbol(i).capitalize() for i in range(mol.natom())]
    geom_ts = a_numpy(mol.geometry()).reshape(-1, 3).copy()  # bohr
    direcciones = ["backward", "forward"] if direccion == "ambas" else [direccion]
    nombres = {"backward": "hacia atrás (−)", "forward": "hacia adelante (+)"}
    contador, ramas, avisos = [0], {}, []
    for d in direcciones:
        mol.set_geometry(psi4.core.Matrix.from_array(geom_ts))
        mol.update_geometry()
        psi4.set_options({"opt_type": "irc", "irc_direction": d, "irc_points": int(puntos),
                          "irc_step_size": float(paso), "write_opt_history": True,
                          "geom_maxiter": max(100, int(puntos) * 15)})
        etapa(f"IRC {nombres[d]}: hessiano en el TS y hasta {puntos} puntos")
        registro, error = [], None
        with en_vivo(mol, contador, registro):
            try:
                psi4.optimize(metodo, molecule=mol)
            except Exception as e:  # noqa: BLE001
                if type(e).__name__ != "OptimizationConvergenceError":
                    raise
                error = e
        camino = None if error else leer_camino_irc(mol)
        signo = -1 if d == "backward" else 1
        if camino:
            pts = []
            for i, p in enumerate(camino):
                s = p.get("arc_dist") or p.get("step_dist") or i * paso
                coords = a_numpy(p["x"]).reshape(-1, 3) * BOHR_ANG
                pts.append({"s": signo * abs(float(s)), "energia": float(p["energy"]), "xyz": texto_xyz(simbolos, coords)})
        else:
            # Sin el resumen de optking: se usan todos los pasos evaluados (camino aproximado)
            pts = [{"s": signo * i * paso, "energia": r["energia"], "xyz": r["xyz"]}
                   for i, r in enumerate(registro) if r.get("energia") is not None]
            if error:
                avisos.append(f"El IRC {nombres[d]} se detuvo antes de terminar "
                              f"({mensaje_error(error, 'irc')}). Se muestra el tramo recorrido, aproximado.")
        ramas[d] = pts
    psi4.set_options({"opt_type": "min", "write_opt_history": False})
    atras, adelante = ramas.get("backward", []), ramas.get("forward", [])
    # Ambas ramas empiezan en el TS (s = 0): se une sin repetirlo
    union = list(reversed(atras)) + (adelante[1:] if atras and adelante else adelante)
    if not union:
        raise RuntimeError("El IRC no produjo ningún punto.")
    e_ts = next((p["energia"] for p in union if abs(p["s"]) < 1e-9), union[0]["energia"])
    for i, p in enumerate(union):
        p["indice"] = i
        p["de_kcal"] = (p["energia"] - e_ts) * HARTREE_KCAL
    mol.set_geometry(psi4.core.Matrix.from_array(geom_ts))  # las propiedades se calculan en el TS
    mol.update_geometry()
    resumen = {"puntos": union, "energia_ts": e_ts, "direccion": direccion, "paso": paso,
               "puntos_max": puntos, "avisos": avisos}
    if atras:
        resumen["barrera_desde_atras_kcal"] = (e_ts - atras[-1]["energia"]) * HARTREE_KCAL
    if adelante:
        resumen["barrera_desde_adelante_kcal"] = (e_ts - adelante[-1]["energia"]) * HARTREE_KCAL
    if atras and adelante:
        resumen["energia_reaccion_kcal"] = (adelante[-1]["energia"] - atras[-1]["energia"]) * HARTREE_KCAL
    return resumen


# Radios covalentes (Å) para deducir qué átomos se mueven junto con el átomo j en el scan
RADIOS_COV = {"H": 0.31, "He": 0.28, "Li": 1.28, "Be": 0.96, "B": 0.84, "C": 0.76, "N": 0.71, "O": 0.66,
              "F": 0.57, "Ne": 0.58, "Na": 1.66, "Mg": 1.41, "Al": 1.21, "Si": 1.11, "P": 1.07, "S": 1.05,
              "Cl": 1.02, "Ar": 1.06, "K": 2.03, "Ca": 1.76, "Br": 1.20, "I": 1.39}


def fragmento_unido(x, simbolos, desde, corte):
    """Átomos unidos a `desde` si se corta el enlace `corte` (par de índices desde 0)."""
    n = len(simbolos)
    radio = [RADIOS_COV.get(s, 1.5) for s in simbolos]
    fragmento, pila = {desde}, [desde]
    while pila:
        a = pila.pop()
        for b in range(n):
            if b not in fragmento and {a, b} != set(corte) and np.linalg.norm(x[a] - x[b]) < 1.2 * (radio[a] + radio[b]):
                fragmento.add(b)
                pila.append(b)
    return fragmento


def rotar(puntos, origen, eje, angulo):
    """Rota puntos (n×3) alrededor del eje que pasa por `origen` (fórmula de Rodrigues)."""
    k = eje / np.linalg.norm(eje)
    p = puntos - origen
    c, s = np.cos(angulo), np.sin(angulo)
    return origen + p * c + np.cross(k, p) * s + np.outer(p @ k, k) * (1 - c)


def medir_coordenada(x, tipo, idx):
    """Distancia (Å), ángulo (°) o diedro (°, signo IUPAC) entre átomos (índices desde 0)."""
    if tipo == "distancia":
        return float(np.linalg.norm(x[idx[1]] - x[idx[0]]))
    if tipo == "angulo":
        a, b = x[idx[0]] - x[idx[1]], x[idx[2]] - x[idx[1]]
        return float(np.degrees(np.arccos(np.clip(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1))))
    b0, b1, b2 = x[idx[0]] - x[idx[1]], x[idx[2]] - x[idx[1]], x[idx[3]] - x[idx[2]]
    n1 = b1 / np.linalg.norm(b1)
    v, w = b0 - (b0 @ n1) * n1, b2 - (b2 @ n1) * n1
    return float(np.degrees(np.arctan2(np.cross(n1, v) @ w, v @ w)))


def colocar_coordenada(mol, tipo, idx, valor):
    """Pone la coordenada en `valor` moviendo rígidamente el fragmento del último átomo.

    distancia i–j: se traslada el fragmento de j a lo largo de i→j.
    ángulo i–j–k (vértice j): se gira el fragmento de k en el plano i–j–k, alrededor de j.
    diedro i–j–k–l: se gira todo el lado de k (con l) alrededor del enlace j–k.
    Si los átomos están en un anillo, sólo se mueve el último átomo.
    """
    simbolos = [mol.symbol(k).capitalize() for k in range(mol.natom())]
    x = a_numpy(mol.geometry()).reshape(-1, 3) * BOHR_ANG
    if tipo == "distancia":
        i, j = idx
        frag = fragmento_unido(x, simbolos, j, (i, j))
        if i in frag:
            frag = {j}
        v = x[j] - x[i]
        d = float(np.linalg.norm(v))
        for k in frag:
            x[k] += (valor - d) * v / d
    elif tipo == "angulo":
        i, j, k = idx
        frag = fragmento_unido(x, simbolos, k, (j, k))
        if i in frag or j in frag:
            frag = {k}
        eje = np.cross(x[i] - x[j], x[k] - x[j])
        if np.linalg.norm(eje) < 1e-8:  # ángulo de 180°: cualquier perpendicular sirve
            eje = np.cross(x[k] - x[j], [1.0, 0.0, 0.0])
            if np.linalg.norm(eje) < 1e-8:
                eje = np.cross(x[k] - x[j], [0.0, 1.0, 0.0])
        delta = np.radians(valor - medir_coordenada(x, "angulo", idx))
        lista = sorted(frag)
        x[lista] = rotar(x[lista], x[j], eje, delta)
    else:
        i, j, k, l = idx
        frag = fragmento_unido(x, simbolos, k, (j, k)) - {k}
        if j in frag or i in frag:
            frag = {l}
        delta = np.radians(valor - medir_coordenada(x, "diedro", idx))
        lista = sorted(frag)
        x[lista] = rotar(x[lista], x[k], x[k] - x[j], delta)
    mol.set_geometry(psi4.core.Matrix.from_array(x / BOHR_ANG))
    mol.update_geometry()


SCAN_TIPOS = {
    # tipo: (nº de átomos, opción de optking, símbolo, unidad)
    "distancia": (2, "frozen_distance", "R", "Å"),
    "angulo": (3, "frozen_bend", "θ", "°"),
    "diedro": (4, "frozen_dihedral", "φ", "°"),
}


def scan_relajado(metodo, mol, atomos, valores, tipo="distancia"):
    """Scan relajado de una distancia, un ángulo o un diedro (átomos numerados desde 1).

    Para cada valor se coloca la coordenada, se congela (optking: frozen_distance, frozen_bend
    o frozen_dihedral) y se optimiza el resto de la molécula, partiendo de la geometría
    optimizada del punto anterior. Al final se escribe la tabla del scan en el .out.
    """
    natom, opcion, simbolo, unidad = SCAN_TIPOS[tipo]
    idx = [a - 1 for a in atomos[:natom]]
    simbolos = [mol.symbol(k).capitalize() for k in range(mol.natom())]
    etiqueta = "–".join(f"{simbolos[i]}{i + 1}" for i in idx)
    fmt = (lambda v: f"{v:6.3f} Å") if tipo == "distancia" else (lambda v: f"{v:7.2f}°")
    contador, puntos = [0], []
    # Pasos cortos (como hace optking en TS/IRC): con pasos grandes, la coordenada congelada se
    # desvía al pasar de coordenadas internas a cartesianas y la molécula puede deformarse.
    pasos_cortos = {"intrafrag_step_limit": 0.2, "intrafrag_step_limit_max": 0.3}
    tolerancia = 0.01 if tipo == "distancia" else 0.5  # Å o grados
    with en_vivo(mol, contador):
        # El scan parte de una geometría optimizada con este método (la de MMFF no es un mínimo
        # aquí): así cada punto es un desplazamiento pequeño y optking converge en pocos pasos.
        etapa(f"Scan relajado {simbolo}({etiqueta}): optimizando primero la geometría de partida")
        inicial = a_numpy(mol.geometry()).reshape(-1, 3).copy()
        try:
            psi4.optimize(metodo, molecule=mol)
        except Exception as e:  # noqa: BLE001
            if type(e).__name__ not in ("OptimizationConvergenceError", "SCFConvergenceError"):
                raise
            mol.set_geometry(psi4.core.Matrix.from_array(inicial))
            mol.update_geometry()
    psi4.set_options({opcion: " ".join(str(a) for a in atomos[:natom]), **pasos_cortos})
    energias_pasos = []  # energía de cada paso (la registra en_vivo)
    with en_vivo(mol, contador, energias_pasos):
        for n, valor in enumerate(valores, 1):
            etapa(f"Scan relajado {simbolo}({etiqueta}): punto {n} de {len(valores)} ({simbolo} = {fmt(valor).strip()})")
            previa = a_numpy(mol.geometry()).reshape(-1, 3).copy()  # última geometría buena (bohr)
            for intento in (1, 2):
                mol.set_geometry(psi4.core.Matrix.from_array(previa))
                mol.update_geometry()
                colocar_coordenada(mol, tipo, idx, valor)
                convergio, nota = True, ""
                inicio = len(energias_pasos)
                try:
                    energia = float(psi4.optimize(metodo, molecule=mol))
                except Exception as e:  # noqa: BLE001
                    if type(e).__name__ not in ("OptimizationConvergenceError", "SCFConvergenceError"):
                        raise
                    convergio, nota = False, mensaje_error(e)
                    energia = variable_global("CURRENT ENERGY")
                    # Con una coordenada congelada, optking a veces no logra bajar la fuerza residual
                    # aunque la energía ya no cambia: si los últimos pasos son estables, el punto vale.
                    ultimas = [r["energia"] for r in energias_pasos[inicio:][-4:] if r.get("energia") is not None]
                    if type(e).__name__ == "OptimizationConvergenceError" and len(ultimas) == 4 \
                            and max(ultimas) - min(ultimas) < 2e-6:
                        convergio, nota = True, "convergió en energía (quedó una fuerza residual por la restricción)"
                sim, coords = geometria_actual(mol)
                final = medir_coordenada(coords, tipo, idx)
                desvio = abs(final - valor) if tipo != "diedro" else abs((final - valor + 180.0) % 360.0 - 180.0)
                if desvio <= tolerancia:
                    break
                convergio = False
                nota = f"la coordenada congelada se desvió a {fmt(final).strip()}"
                if intento == 1:
                    etapa(f"Scan relajado {simbolo}({etiqueta}): repitiendo el punto {n} con pasos más cortos")
                    psi4.set_options({"intrafrag_step_limit": 0.05, "intrafrag_step_limit_max": 0.1})
            psi4.set_options(pasos_cortos)
            puntos.append({"valor": float(valor), "valor_final": final, "energia": energia,
                           "convergio": convergio, "nota": nota, "xyz": texto_xyz(sim, coords)})
            if not convergio:
                # El punto siguiente parte de la última geometría buena, no de la deformada
                mol.set_geometry(psi4.core.Matrix.from_array(previa))
                mol.update_geometry()
    psi4.set_options({opcion: "", "intrafrag_step_limit": 0.5, "intrafrag_step_limit_max": 1.0})

    # El mínimo y el máximo se buscan entre los puntos fiables (si los hay)
    validos = [p for p in puntos if p["energia"] is not None and p["convergio"]] or \
              [p for p in puntos if p["energia"] is not None]
    if not validos:
        raise RuntimeError("Ningún punto del scan produjo una energía.")
    e_ref = next(p["energia"] for p in puntos if p["energia"] is not None)  # primer punto, como dice la tabla
    e_min = min(p["energia"] for p in validos)
    for p in puntos:
        p["de_kcal"] = None if p["energia"] is None else (p["energia"] - e_ref) * HARTREE_KCAL
        p["de_min_kcal"] = None if p["energia"] is None else (p["energia"] - e_min) * HARTREE_KCAL

    # Tabla en el .out (como haría un script de Psi4 con psi4.core.print_out)
    nombre = {"distancia": "distancia", "angulo": "ángulo", "diedro": "diedro"}[tipo]
    psi4.core.print_out(f"\n\n===== SCAN RELAJADO {simbolo}({etiqueta}) ({metodo.upper()}) =====\n")
    psi4.core.print_out(f"ΔE respecto al primer punto; el {nombre} queda congelado ({opcion}) en cada optimización.\n\n")
    for p in puntos:
        if p["energia"] is None:
            psi4.core.print_out(f"{simbolo}({etiqueta}) = {fmt(p['valor'])}   sin energía ({p['nota']})\n")
            continue
        aviso = ("   (convergió en energía)" if p["nota"] else "") if p["convergio"] else "   (no convergió)"
        psi4.core.print_out(f"{simbolo}({etiqueta}) = {fmt(p['valor'])}   E = {p['energia']:.10f} Eh   "
                            f"ΔE = {p['de_kcal']:8.3f} kcal/mol{aviso}\n")
    psi4.core.print_out("=" * 60 + "\n")

    minimo = min(validos, key=lambda p: p["energia"])
    maximo = max(validos, key=lambda p: p["energia"])
    # Las propiedades (orbitales, cargas…) se calculan en el punto de menor energía
    mol.set_geometry(psi4.core.Matrix.from_array(
        np.array([[float(v) for v in l.split()[1:4]] for l in minimo["xyz"].splitlines()]) / BOHR_ANG))
    mol.update_geometry()
    return {"tipo": tipo, "simbolo": simbolo, "unidad": unidad, "atomos": list(atomos[:natom]),
            "etiqueta": etiqueta, "puntos": puntos,
            "valor_minimo": minimo["valor"], "valor_maximo": maximo["valor"],
            "rango_kcal": (maximo["energia"] - minimo["energia"]) * HARTREE_KCAL,
            "no_convergidos": sum(1 for p in puntos if not p["convergio"])}


def propiedades_scf(scf, n_atomos, simbolos):
    res = {}
    # Dipolo y cargas de Mulliken
    try:
        psi4.oeprop(scf, "DIPOLE", "MULLIKEN_CHARGES", title="PROP")
    except Exception as e:  # noqa: BLE001
        res["aviso_propiedades"] = f"oeprop: {e}"
    dip = None
    for clave in ("PROP DIPOLE", "DIPOLE", "CURRENT DIPOLE", "SCF DIPOLE"):
        for origen in (scf.variable, psi4.core.variable):
            try:
                v = a_numpy(origen(clave)).reshape(-1)
                if v.size == 3:
                    dip = v
                    break
            except Exception:
                continue
        if dip is not None:
            break
    if dip is not None:
        d = dip * AU_DEBYE
        res["dipolo_debye"] = {"x": float(d[0]), "y": float(d[1]), "z": float(d[2]),
                               "total": float(np.linalg.norm(d))}
    try:
        q = a_numpy(scf.atomic_point_charges()).reshape(-1)
        if q.size == n_atomos:
            res["cargas_mulliken"] = [{"atomo": i + 1, "elemento": simbolos[i], "carga": float(q[i])}
                                      for i in range(n_atomos)]
    except Exception:
        pass

    # Orbitales moleculares (espín alfa)
    eps = a_numpy(scf.epsilon_a()).reshape(-1)
    nalfa, nbeta = scf.nalpha(), scf.nbeta()
    capa_cerrada = nalfa == nbeta and scf.same_a_b_orbs()
    homo = nalfa  # índice 1-based
    lumo = nalfa + 1 if nalfa < eps.size else None
    desde, hasta = max(1, homo - 5), min(eps.size, (lumo or homo) + 5)
    lista = []
    for i in range(desde, hasta + 1):
        ocup = (2 if capa_cerrada else 1) if i <= nalfa else 0
        etiqueta = ""
        if i == homo:
            etiqueta = "HOMO"
        elif lumo and i == lumo:
            etiqueta = "LUMO"
        elif i < homo:
            etiqueta = f"HOMO-{homo - i}"
        elif lumo and i > lumo:
            etiqueta = f"LUMO+{i - lumo}"
        lista.append({"indice": i, "etiqueta": etiqueta, "ocupacion": ocup,
                      "energia_hartree": float(eps[i - 1]), "energia_ev": float(eps[i - 1] * HARTREE_EV)})
    res["orbitales"] = {
        "capa_cerrada": bool(capa_cerrada),
        "n_alfa": int(nalfa), "n_beta": int(nbeta), "n_orbitales": int(eps.size),
        "n_funciones_base": int(scf.basisset().nbf()),
        "homo_indice": int(homo), "lumo_indice": int(lumo) if lumo else None,
        "homo_ev": float(eps[homo - 1] * HARTREE_EV) if homo >= 1 else None,
        "lumo_ev": float(eps[lumo - 1] * HARTREE_EV) if lumo else None,
        "lista": lista,
    }
    if lumo and homo >= 1:
        res["orbitales"]["gap_ev"] = float((eps[lumo - 1] - eps[homo - 1]) * HARTREE_EV)
    return res


def generar_cubos(scf, carpeta, homo, lumo, con_mep):
    """Escribe los archivos .cube de HOMO, LUMO y, opcionalmente, densidad + potencial electrostático."""
    dir_cubos = carpeta / "cubos"
    dir_cubos.mkdir(exist_ok=True)
    indices = [homo] + ([lumo] if lumo else [])
    tareas = ["orbitals"] + (["esp"] if con_mep else [])
    psi4.set_options({
        "cubeprop_tasks": tareas,
        "cubeprop_orbitals": indices,
        "cubeprop_filepath": str(dir_cubos),
        "cubic_grid_spacing": [0.3, 0.3, 0.3],
        "cubic_grid_overage": [5.0, 5.0, 5.0],
    })
    psi4.cubeprop(scf)
    disponibles = []
    for nombre, idx in (("homo", homo), ("lumo", lumo)):
        if not idx:
            continue
        hallados = sorted(dir_cubos.glob(f"Psi_a_{idx}_*.cube"))
        if hallados:
            hallados[0].replace(carpeta / f"{nombre}.cube")
            disponibles.append(nombre)
    for origen, destino in (("Dt.cube", "densidad"), ("ESP.cube", "mep")):
        f = dir_cubos / origen
        if f.exists():
            f.replace(carpeta / f"{destino}.cube")
            disponibles.append(destino)
    for f in dir_cubos.glob("*"):
        f.unlink()
    dir_cubos.rmdir()
    return disponibles


def frecuencias(wfn_freq, simbolos):
    res = {}
    vib = getattr(wfn_freq, "frequency_analysis", None)
    modos = []
    if vib:
        omega = np.asarray(vib["omega"].data)
        trv = list(vib["TRV"].data) if "TRV" in vib else ["V"] * len(omega)
        x = np.asarray(vib["x"].data) if "x" in vib else None
        ir = None
        for clave in ("IR_intensity", "IR intensity"):
            if clave in vib and vib[clave] is not None:
                ir = np.asarray(vib[clave].data)
                break
        n = len(simbolos)
        for i, w in enumerate(omega):
            if trv[i] != "V":
                continue
            w = complex(w)
            freq = w.real if abs(w.imag) < 1e-6 else -abs(w.imag)
            modo = {"numero": len(modos) + 1, "frecuencia_cm": float(freq), "imaginaria": bool(abs(w.imag) >= 1e-6)}
            if ir is not None and i < ir.size and np.isfinite(ir[i]):
                modo["intensidad_ir"] = float(np.real(ir[i]))
            if x is not None and x.shape[0] == 3 * n:
                d = np.real(x[:, i]).reshape(n, 3)
                maximo = np.max(np.linalg.norm(d, axis=1)) or 1.0
                modo["desplazamientos"] = np.round(d / maximo, 5).tolist()
            modos.append(modo)
    else:
        f = a_numpy(wfn_freq.frequencies()).reshape(-1)
        modos = [{"numero": i + 1, "frecuencia_cm": float(v), "imaginaria": bool(v < 0)} for i, v in enumerate(f)]
    res["modos"] = modos
    res["n_imaginarias"] = sum(1 for m in modos if m["imaginaria"])
    termo = {}
    for nombre, clave in (("zpve", "ZPVE"), ("energia_termica", "THERMAL ENERGY"),
                          ("entalpia", "ENTHALPY"), ("energia_libre_gibbs", "GIBBS FREE ENERGY"),
                          ("correccion_entalpia", "ENTHALPY CORRECTION"),
                          ("correccion_gibbs", "GIBBS FREE ENERGY CORRECTION")):
        v = variable_global(clave)
        if v is not None:
            termo[nombre] = v
    if termo:
        termo["temperatura_k"] = 298.15
        termo["presion_pa"] = 101325
        res["termoquimica_hartree"] = termo
    return res


def mensaje_error(e, tarea=None):
    tipo = type(e).__name__
    if tipo == "SCFConvergenceError":
        return "El SCF no convergió. Pruebe otra base, otro método o revise la carga/multiplicidad."
    if tipo == "OptimizationConvergenceError":
        if tarea == "ts":
            return ("La búsqueda del estado de transición no convergió. Parta de una geometría más "
                    "cercana al TS (por ejemplo, con los enlaces que se forman o rompen a distancias "
                    "intermedias) o pruebe primero con una base más pequeña.")
        if tarea == "irc":
            return ("optking no pudo seguir el camino (compruebe que la geometría de partida sea un "
                    "TS con una sola frecuencia imaginaria; si el camino es muy curvo, reduzca el paso)")
        return "La optimización de geometría no convergió en el número máximo de pasos."
    if tipo == "TDSCFConvergenceError" or tipo == "ConvergenceError":
        return f"Un procedimiento iterativo no convergió: {e}"
    texto = str(e).strip() or tipo
    return f"{tipo}: {texto}"[:1500]


def main():
    carpeta = Path(sys.argv[1]).resolve()
    entrada = json.loads((carpeta / "entrada.json").read_text(encoding="utf-8"))
    metodo, base, tarea = entrada["metodo"], entrada["base"], entrada["tarea"]
    carga, mult = int(entrada["carga"]), int(entrada["multiplicidad"])
    if metodo not in METODOS or base not in BASES or tarea not in TAREAS:
        raise SystemExit("Parámetros no permitidos")

    t0 = time.time()
    resultado = {"ok": False, "psi4_version": psi4.__version__, "metodo": metodo, "base": base,
                 "tarea": tarea, "carga": carga, "multiplicidad": mult}
    try:
        psi4.core.set_output_file(str(carpeta / "salida.dat"), False)
        psi4.set_memory(entrada.get("memoria", "1 GB"))
        psi4.set_num_threads(int(entrada.get("hilos", 1)))

        etapa("Preparando la molécula")
        mol = psi4.geometry(
            f"{carga} {mult}\n{entrada['xyz']}\nunits angstrom\nsymmetry c1\nno_com\nno_reorient\n",
            name="molecula",
        )
        n_atomos = mol.natom()
        if n_atomos == 1 and tarea != "energia":
            resultado["aviso"] = "Un solo átomo: se calcula sólo la energía."
            tarea = "energia"

        abierta = mult != 1
        psi4.set_options({
            "basis": base,
            "scf_type": "df",
            "reference": "uhf" if abierta else "rhf",
            "maxiter": 200,
            "geom_maxiter": 100,
        })

        wfn_freq = None
        if tarea == "energia":
            etapa("Calculando la energía (punto simple)")
            energia, wfn = psi4.energy(metodo, return_wfn=True, molecule=mol)
        elif tarea == "irc":
            op = entrada.get("irc") or {}
            direccion = op.get("direccion") if op.get("direccion") in ("ambas", "forward", "backward") else "ambas"
            puntos = min(60, max(3, int(op.get("puntos") or 20)))
            paso = min(0.5, max(0.05, float(op.get("paso") or 0.2)))
            resultado["irc"] = irc(metodo, mol, direccion, puntos, paso)
            etapa("Calculando la función de onda en el estado de transición")
            energia, wfn = psi4.energy(metodo, return_wfn=True, molecule=mol)
        elif tarea == "scan":
            op = entrada.get("scan") or {}
            tipo = op.get("tipo") if op.get("tipo") in SCAN_TIPOS else "distancia"
            natom = SCAN_TIPOS[tipo][0]
            atomos = [int(a) for a in (op.get("atomos") or [])][:natom]
            valores = [float(v) for v in (op.get("valores") or [])][:40]
            if len(atomos) != natom or len(set(atomos)) != natom or not all(1 <= a <= n_atomos for a in atomos) or not valores:
                raise ValueError("Opciones del scan no válidas.")
            resultado["scan"] = scan_relajado(metodo, mol, atomos, valores, tipo)
            etapa("Calculando la función de onda en el punto de menor energía del scan")
            energia, wfn = psi4.energy(metodo, return_wfn=True, molecule=mol)
        else:
            if tarea == "ts":
                # Búsqueda de estado de transición: optking sigue el modo de curvatura negativa
                # (RS-I-RFO). Necesita el hessiano exacto al inicio (full_hess_every 0): el
                # hessiano estimado por defecto no tiene valores propios negativos.
                psi4.set_options({"opt_type": "ts", "full_hess_every": 0})
                etapa("Buscando el estado de transición (primero calcula el hessiano exacto)")
            else:
                etapa("Optimizando la geometría")
            energia, trayectoria = optimizar(metodo, mol)
            resultado["trayectoria"] = trayectoria
            if tarea in ("frecuencias", "ts"):
                etapa("Calculando frecuencias vibracionales (hessiano)")
                _, wfn_freq = psi4.frequency(metodo, return_wfn=True, molecule=mol)
            simbolos, _ = geometria_actual(mol)
            if wfn_freq is not None:
                etapa("Analizando modos normales y termoquímica")
                resultado["frecuencias"] = frecuencias(wfn_freq, simbolos)
            etapa("Calculando la función de onda en la geometría final")
            energia, wfn = psi4.energy(metodo, return_wfn=True, molecule=mol)

        simbolos, coords = geometria_actual(mol)
        xyz = texto_xyz(simbolos, coords)
        resultado["geometria_xyz"] = xyz
        (carpeta / "geometria.xyz").write_text(
            f"{n_atomos}\n{entrada.get('titulo', 'molecula')} {metodo}/{base}\n{xyz}\n", encoding="utf-8")

        resultado["energia"] = {"hartree": float(energia), "kcal_mol": float(energia * HARTREE_KCAL),
                                "ev": float(energia * HARTREE_EV)}
        componentes = {}
        for nombre, clave in (("repulsion_nuclear", "NUCLEAR REPULSION ENERGY"),
                              ("scf_total", "SCF TOTAL ENERGY"),
                              ("correlacion_mp2", "MP2 CORRELATION ENERGY")):
            v = variable_global(clave)
            if v is not None:
                componentes[nombre] = v
        resultado["energia"]["componentes"] = componentes

        etapa("Analizando orbitales, dipolo y cargas")
        scf = funcion_scf(wfn)
        resultado.update(propiedades_scf(scf, n_atomos, simbolos))
        if metodo == "mp2":
            resultado["nota_propiedades"] = "Orbitales, dipolo y cargas calculados con la densidad SCF (HF) de referencia."

        orb = resultado.get("orbitales", {})
        if orb.get("homo_indice"):
            etapa("Generando superficies (orbitales" + (" y potencial electrostático)" if entrada.get("mep") else ")"))
            try:
                resultado["cubos"] = generar_cubos(scf, carpeta, orb["homo_indice"], orb.get("lumo_indice"),
                                                   bool(entrada.get("mep")))
            except Exception as e:  # noqa: BLE001
                resultado["aviso_cubos"] = mensaje_error(e)
        resultado["ok"] = True
    except Exception as e:  # noqa: BLE001
        resultado["error"] = mensaje_error(e, tarea)
        resultado["traza"] = traceback.format_exc()[-4000:]
    finally:
        resultado["tiempo_s"] = round(time.time() - t0, 2)
        temporal = carpeta / "resultado.json.tmp"
        temporal.write_text(json.dumps(resultado, ensure_ascii=False), encoding="utf-8")
        temporal.replace(carpeta / "resultado.json")
        try:
            psi4.core.clean()
        except Exception:
            pass
    etapa("Terminado" if resultado["ok"] else "Error")
    sys.exit(0 if resultado["ok"] else 2)


if __name__ == "__main__":
    main()
