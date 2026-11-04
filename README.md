# Química Cuántica con Psi4 — JSME + 3Dmol.js (UNACHI)

Aplicación web en **Node.js** para hacer cálculos mecánico-cuánticos con **Psi4** a partir de una molécula
orgánica dibujada en el editor **JSME**, con un **visor 3D** (3Dmol.js) para la geometría, los orbitales,
el potencial electrostático y las vibraciones.

## Qué hace

1. **Dibujar** la molécula en JSME (o escribir un SMILES, o elegir uno de 20 ejemplos).
   También se puede **abrir un archivo de entrada de Psi4 (.in)** o un **.xyz** (botón o arrastrando
   el archivo): se leen la molécula (cartesianas o matriz Z, Å o bohr), la carga, la multiplicidad,
   el método, la base y el tipo de cálculo. El .in **no se ejecuta** en el servidor (sería ejecutar
   Python arbitrario): se interpreta y se valida como cualquier otro cálculo.
   El archivo se abre en un **editor de código** (con números de línea y validación al escribir:
   los errores señalan la línea). Desde ahí se puede corregir, guardar y **ejecutar el cálculo
   directamente** (botón «▶ Ejecutar cálculo» o Ctrl+Enter).
   **El código y la ejecución**: la ventana «Código de entrada (.in)» muestra siempre lo que se va
   a ejecutar. «Generar geometría 3D» crea el código con las opciones del formulario y, mientras no
   se edite a mano, se actualiza al cambiarlas. Hay **un solo botón «▶ Ejecutar cálculo»**, que
   ejecuta ese código. Al lanzar o abrir un cálculo (incluidos «Calcular IRC desde este TS»,
   «Calcular frecuencias» y «Mis cálculos»), la ventana muestra el `.in` de ese trabajo.
2. **Generar la geometría 3D**: RDKit añade los hidrógenos, genera coordenadas (ETKDG) y las
   preoptimiza con MMFF94. Sugiere la carga y la multiplicidad.
   En el visor, **«📏 Medir»**: clic en 2 átomos → distancia, 3 → ángulo (vértice en el 2.º),
   4 → diedro (signo IUPAC). La medida se recalcula al cambiar la geometría (optimización en
   vivo, IRC, scan) y un 5.º clic empieza otra. Las etiquetas muestran el índice de cada átomo
   (el mismo que usan el scan y las medidas), sin fondo.
3. **Configurar el cálculo**:
   - Métodos: HF, B3LYP, PBE0, ωB97X-D, M06-2X, MP2
   - Bases: STO-3G, 3-21G, 6-31G, 6-31G(d), 6-31G(d,p), 6-31+G(d), 6-311G(d,p), cc-pVDZ, aug-cc-pVDZ, def2-SVP, def2-TZVP
   - Tareas: energía (punto simple), optimización de geometría, optimización + frecuencias y
     **estado de transición (TS) + frecuencias**. El TS usa optking con `opt_type ts`
     (algoritmo RS-I-RFO) y `full_hess_every 0` (hessiano exacto al inicio: el estimado no tiene
     curvatura negativa); al final las frecuencias deben dar una sola imaginaria. En un .in se
     activa con `set opt_type ts`, `set optking { opt_type ts }` u `optimizer_keywords`.
     Ojo: «Optimización» busca un **mínimo**; si se parte de un TS simétrico, el gradiente es ~0
     y converge sin mover los átomos (aparece una frecuencia imaginaria).
   - **Camino de reacción IRC** (desde un TS): optking con `opt_type irc`. Como cada
     `optimize()` recorre una sola dirección, se parte dos veces del TS (`backward` y `forward`)
     y se unen los puntos: perfil de energía relativo al TS frente a la coordenada de reacción,
     barreras desde cada extremo, animación reactivo → TS → producto y descarga como XYZ de
     varios cuadros. Opciones: dirección (ambas / forward / backward), puntos por dirección
     (3–60) y paso (0.05–0.5 bohr·amu½). Los puntos se leen del `.opt.json` que escribe Psi4
     con `write_opt_history`. En un .in: `set opt_type irc`, `irc_direction`, `irc_points`,
     `irc_step_size`. Tras un TS con una sola imaginaria aparece «Calcular IRC desde este TS».
   - **Scan relajado** de una **distancia** (2 átomos), un **ángulo de enlace** (3, vértice en el
     2.º) o un **ángulo diedro** (4), con casillas excluyentes: un solo tipo por cálculo; el scan
     reemplaza al «Tipo de cálculo». Valores desde/hasta/paso (hasta 40 puntos). En cada punto se
     coloca el valor moviendo rígidamente el fragmento del último átomo (traslación o rotación de
     Rodrigues), se congela con `frozen_distance` / `frozen_bend` / `frozen_dihedral` (optking 0.5
     ya no tiene `fixed_*`) y se optimiza el resto, partiendo del punto anterior. Antes del primer
     punto se optimiza la geometría sin restricciones; el scan usa pasos cortos de optking y, si la
     coordenada congelada se desvía, repite el punto con pasos aún más cortos. La salida de
     Psi4 (.out) termina con la tabla «SCAN RELAJADO» (valor, E, ΔE) escrita con
     `psi4.core.print_out`; la página muestra la curva, la tabla, la animación y descargas
     CSV/XYZ. «Usar átomos de «Medir»» copia los átomos elegidos en el visor. Se lee de un .in
     con `fixed_/frozen_/ranged_distance|bend|dihedral` y un bucle `for` (lista, `np.arange`,
     `np.linspace`).
   - **Coordenada congelada (sin scan)**: en el mismo recuadro, «Congelar en un valor» fija una
     distancia, un ángulo o un diedro en el valor indicado (propone el valor actual) y hace una
     sola optimización del resto de la molécula (tarea `congelar`). El valor se coloca igual que en
     el scan (el último átomo se mueve con lo que cuelga de él) y se congela con `frozen_*`; no
     hay optimización previa sin restricciones. El .out termina con «OPTIMIZACIÓN CON …
     CONGELADA». Se lee de un .in con `frozen_*`/`fixed_*` y sin bucle (valor de `colocar(…)`, de
     `fixed_*` o el de la geometría).
   - **Función de onda en formato Molden, siempre**: cada cálculo escribe `orbitales.molden`
     (SCF/KS, con `psi4.molden`) y el resumen tiene «Descargar .molden». IboView construye con
     ella los orbitales intrínsecos de enlace (IBO). Con MP2 de capa cerrada, además
     `naturales.molden` (orbitales naturales de la densidad MP2 relajada).
   - **Un .molden por punto en IRC y scan**: `molden/irc_001.molden…` (reactivo → TS → producto)
     o `molden/scan_001.molden…` (orden del scan), más `irc_iboview.zip` / `scan_iboview.zip`
     con un .xyz de varios cuadros y `LEAME.txt`. Al terminar un IRC o un scan que se estaba
     siguiendo, la página pide un **nombre base** y una **carpeta** (File System Access API:
     Chrome/Edge) y escribe `base_001.molden`, `base_002.molden`…; si la carpeta ya tiene esos
     nombres, pide confirmación. En navegadores sin esa API se descargan con esos nombres en la
     carpeta de descargas. El botón «Guardar … .molden numerados…» repite el proceso. En IboView se
     abren todos a la vez como cuadros de una trayectoria para seguir el flujo de electrones. Los
     coeficientes cumplen CᵀSC = I con la convención estándar de Molden (comprobado en bases
     cartesianas y esféricas).
   - **El servidor no ejecuta el código Python de un .in** (seguridad): interpreta la molécula,
     el nivel de teoría y el tipo de cálculo, y avisa si el archivo trae código que no se ejecuta.
4. **Resultados**:
   - Energía total (E<sub>h</sub>, kcal/mol, eV) y sus componentes
   - Momento dipolar, cargas de Mulliken (también como colores y etiquetas en 3D)
   - Diagrama y tabla de orbitales, HOMO/LUMO y brecha
   - Superficies 3D: orbitales HOMO y LUMO, potencial electrostático (MEP) sobre la isodensidad 0.002
   - Espectro IR simulado (absorbancia o transmitancia, factor de escala y ancho de banda ajustables)
     con cada banda rotulada con su número de onda (cm⁻¹) y su **asignación**: ν estiramiento,
     δ flexión/deformación, ρ balanceo, γ fuera del plano, τ torsión, con ₛ/ₐₛ simétrico/asimétrico
     y grupos CH₃/CH₂. Descarga del espectro en SVG/PNG y de la tabla de modos en CSV
   - Animación de cada modo normal en el visor 3D (amplitud, velocidad, flechas, XYZ animado)
   - Termoquímica (ZPVE, H, G)
   - Trayectoria de la optimización (gráfico de energía + animación paso a paso)
   - **Geometría en vivo**: mientras Psi4 optimiza, el visor 3D se actualiza con la geometría
     de cada paso (transición suave), junto con la energía, ΔE y el gradiente máximo. El script
     envuelve `psi4.driver.driver.gradient`, que el ciclo de optimización llama en cada paso, y
     emite líneas `@@GEOM` que el servidor entrega en `GET /api/calculos/:id` (campo `vivo`).
   - **Salida completa de Psi4 como .out**, la **entrada .in** equivalente (para ejecutarla con
     `psi4 archivo.in archivo.out` en otra computadora), la geometría final (.xyz) e imagen PNG del visor

Los cálculos se ponen en una **cola** en el servidor; cada navegador guarda la lista de «Mis cálculos».

## Estructura

```
servidor.js              Servidor Express: API, cola de cálculos, archivos estáticos
python/geometria.py      JSME (molfile/SMILES) → geometría 3D con RDKit
python/calculo_psi4.py   Ejecuta Psi4 y escribe resultado.json + archivos .cube
python/version.py        Informa versiones de Psi4 y RDKit
public/                  Interfaz (index.html, app.js, estilos.css)
public/entrada.js        Lectura y generación de archivos .in de Psi4 (navegador y servidor)
public/asignaciones.js   Asignación automática de modos (PED aproximada con coordenadas internas)
environment.yml          Psi4 1.11 + RDKit + Python 3.12 + Node.js 22 (conda-forge)
Dockerfile               Imagen para Dokploy
```

JSME y 3Dmol.js se instalan con npm y los sirve el propio servidor (no dependen de CDNs externos).

## Despliegue en el VPS con Dokploy

1. En Dokploy: **Create Service → Application**.
2. **Provider: GitHub** → repositorio `PGBeermann/GAMESS`, rama `main`.
3. **Build Type: Dockerfile** (ruta `Dockerfile`, contexto `.`).
4. **Domains**: agregue su dominio o subdominio, **Container Port `3000`**, active HTTPS (Let's Encrypt).
   Cree antes el registro DNS tipo A apuntando a la IP del VPS para que se emita el certificado.
5. **Advanced → Volumes / Mounts**: monte un volumen en `/app/datos` para conservar los resultados
   al redeplegar (opcional pero recomendado).
6. **Environment** (opcional, ver tabla). Para uso en clase se recomienda definir `CLAVE_ACCESO`.
7. **Deploy**. La primera construcción tarda varios minutos (descarga Psi4 ≈ 1–2 GB).
   Compruebe `https://su-dominio/salud` → `{"ok":true,"psi4":"1.11",...}`.

Recomendado: VPS con al menos **2 vCPU y 4 GB de RAM**. Ajuste `PSI4_HILOS` y `PSI4_MEMORIA` al VPS.

### Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PUERTO` | `3000` | Puerto HTTP interno |
| `CLAVE_ACCESO` | *(vacía)* | Si se define, la interfaz pide esta clave para usar la API |
| `PSI4_HILOS` | mín(4, núcleos) | Hilos de cada cálculo Psi4 |
| `PSI4_MEMORIA` | `2 GB` | Memoria para Psi4 (formato `512 MB`, `4 GB`) |
| `MAX_CALCULOS_SIMULTANEOS` | `1` | Cálculos que se ejecutan a la vez (el resto espera en cola) |
| `MAX_COLA` | `30` | Tamaño máximo de la cola |
| `MAX_POR_USUARIO` | `3` | Cálculos pendientes por dirección IP |
| `MAX_ATOMOS` | `40` | Átomos máximos (incluidos H) |
| `TIEMPO_MAXIMO_MIN` | `30` | Tiempo máximo por cálculo; después se cancela |
| `HORAS_RETENCION` | `48` | Horas que se guardan los resultados |
| `CARPETA_DATOS` | `/app/datos` | Carpeta de los trabajos |

## Ejecutar en local (sin Docker)

```bash
micromamba create -f environment.yml
micromamba activate psi4web
npm install
npm start
```

Luego abra http://localhost:3000.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/salud` | Estado del servidor y versión de Psi4 |
| GET | `/api/opciones` | Métodos, bases, tareas y límites |
| POST | `/api/geometria` | `{molfile, smiles}` → geometría 3D (RDKit); `{xyz, carga, multiplicidad}` → enlaces y dibujo 2D conservando las coordenadas |
| POST | `/api/calculos` | `{xyz, metodo, base, tarea, carga, multiplicidad, mep, titulo}` → crea un cálculo |
| GET | `/api/calculos/:id` | Estado, salida en vivo y resultado |
| DELETE | `/api/calculos/:id` | Cancela un cálculo (sólo la misma IP) |
| GET | `/api/calculos/:id/archivo/:nombre` | `salida.dat` (se guarda como .out), `entrada.in`, `geometria.xyz`, `homo.cube`, `lumo.cube`, `densidad.cube`, `mep.cube`, `orbitales.molden`, `naturales.molden`, `irc_###.molden` / `scan_###.molden` (uno por punto), `irc_iboview.zip`, `scan_iboview.zip` |

Si `CLAVE_ACCESO` está definida, las rutas `/api/*` (salvo `/api/opciones`) exigen la cabecera `x-clave-acceso`.

## Notas

- Todos los cálculos usan simetría C1 y *density fitting* (`scf_type df`); referencia RHF para
  multiplicidad 1 y UHF para capa abierta.
- Para DFT y MP2 las frecuencias se obtienen por diferencias finitas de gradientes (más lento que HF).
- Con MP2, orbitales, dipolo y cargas se calculan con la densidad HF de referencia.
- Las frecuencias son armónicas; use el factor de escala sugerido para comparar con el experimento.
- Las asignaciones se obtienen proyectando cada modo sobre coordenadas internas (enlaces, ángulos,
  fuera del plano y torsiones) con constantes de fuerza típicas: una PED aproximada y orientativa.

Créditos: [Psi4](https://psicode.org), [JSME](https://jsme-editor.github.io),
[3Dmol.js](https://3dmol.csb.pitt.edu), [RDKit](https://www.rdkit.org).
