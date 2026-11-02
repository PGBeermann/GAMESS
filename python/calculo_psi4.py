"""Ejecuta un cálculo mecánico-cuántico con Psi4 y guarda los resultados en JSON.

Uso:  python calculo_psi4.py <carpeta_del_trabajo>

La carpeta debe contener `entrada.json` (lo escribe servidor.js):
    {"xyz": "C 0 0 0\\nH ...", "carga": 0, "multiplicidad": 1,
     "metodo": "b3lyp", "base": "6-31g*", "tarea": "energia|optimizacion|frecuencias|ts",
     "mep": true, "hilos": 2, "memoria": "2 GB", "titulo": "etanol"}

Archivos que produce en la carpeta:
    salida.dat        salida completa de Psi4 (texto)
    resultado.json    resumen para la interfaz web
    geometria.xyz     geometría final
    homo.cube / lumo.cube / densidad.cube / mep.cube   (superficies para el visor 3D)

Las líneas que empiezan con "@@ETAPA" en la salida estándar las usa el servidor
para mostrar el progreso.
"""
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
TAREAS = {"energia", "optimizacion", "frecuencias", "ts"}


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


def optimizar(metodo, mol):
    """Optimiza la geometría y, si Psi4 lo permite, devuelve también la trayectoria.

    Para mostrar la geometría en vivo se envuelve gradient(), que el ciclo de optimización de
    Psi4 llama una vez por paso. Se reemplaza en el espacio de nombres de la propia función
    optimize (optimize.__globals__), que es donde Psi4 la busca. Ojo: «psi4.driver» no sirve,
    porque `from .driver import *` en psi4/__init__.py lo deja apuntando al módulo driver.py.
    Si la envoltura no es posible, la optimización funciona igual, sin pasos intermedios.
    """
    espacio = getattr(psi4.optimize, "__globals__", None)
    if not (isinstance(espacio, dict) and callable(espacio.get("gradient"))):
        espacio = getattr(sys.modules.get("psi4.driver.driver"), "__dict__", None)
    original = espacio.get("gradient") if isinstance(espacio, dict) else None
    pasos = [0]

    def gradiente_con_aviso(name, **kwargs):
        salida = original(name, **kwargs)
        # Sólo los pasos del ciclo de optimización (que usa nuestra molécula), no las
        # geometrías desplazadas de un hessiano por diferencias finitas
        if kwargs.get("molecule") is not mol:
            return salida
        try:
            pasos[0] += 1
            emitir_paso(pasos[0], kwargs.get("molecule") or mol, salida[0] if isinstance(salida, tuple) else salida)
        except Exception:  # noqa: BLE001  (el aviso nunca debe interrumpir el cálculo)
            pass
        return salida

    if callable(original):
        espacio["gradient"] = gradiente_con_aviso
    historia = None
    try:
        try:
            salida = psi4.optimize(metodo, molecule=mol, return_wfn=True, return_history=True)
            energia, historia = salida[0], salida[-1]
        except TypeError:
            energia = psi4.optimize(metodo, molecule=mol)
    finally:
        if callable(original):
            espacio["gradient"] = original
    trayectoria = []
    if isinstance(historia, dict) and historia.get("coordinates"):
        simbolos = [mol.symbol(i).capitalize() for i in range(mol.natom())]
        energias = list(historia.get("energy") or [])
        for i, c in enumerate(historia["coordinates"]):
            coords = a_numpy(c).reshape(-1, 3) * BOHR_ANG
            e = float(energias[i]) if i < len(energias) else None
            trayectoria.append({"paso": i + 1, "energia": e, "xyz": texto_xyz(simbolos, coords)})
    return float(energia), trayectoria


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
