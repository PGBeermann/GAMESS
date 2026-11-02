# Química Cuántica con Psi4 — JSME + 3Dmol.js (UNACHI)

Aplicación web en **Node.js** para hacer cálculos mecánico-cuánticos con **Psi4** a partir de una molécula
orgánica dibujada en el editor **JSME**, con un **visor 3D** (3Dmol.js) para la geometría, los orbitales,
el potencial electrostático y las vibraciones.

## Qué hace

1. **Dibujar** la molécula en JSME (o escribir un SMILES, o elegir uno de 20 ejemplos).
2. **Generar la geometría 3D**: RDKit añade los hidrógenos, genera coordenadas (ETKDG) y las
   preoptimiza con MMFF94. Sugiere la carga y la multiplicidad.
3. **Configurar el cálculo**:
   - Métodos: HF, B3LYP, PBE0, ωB97X-D, M06-2X, MP2
   - Bases: STO-3G, 3-21G, 6-31G, 6-31G(d), 6-31G(d,p), 6-31+G(d), 6-311G(d,p), cc-pVDZ, aug-cc-pVDZ, def2-SVP, def2-TZVP
   - Tareas: energía (punto simple), optimización de geometría, optimización + frecuencias
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
   - Descarga de la salida completa de Psi4 y de la geometría final (.xyz), imagen PNG del visor

Los cálculos se ponen en una **cola** en el servidor; cada navegador guarda la lista de «Mis cálculos».

## Estructura

```
servidor.js              Servidor Express: API, cola de cálculos, archivos estáticos
python/geometria.py      JSME (molfile/SMILES) → geometría 3D con RDKit
python/calculo_psi4.py   Ejecuta Psi4 y escribe resultado.json + archivos .cube
python/version.py        Informa versiones de Psi4 y RDKit
public/                  Interfaz (index.html, app.js, estilos.css)
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
| POST | `/api/geometria` | `{molfile, smiles}` → geometría 3D (RDKit) |
| POST | `/api/calculos` | `{xyz, metodo, base, tarea, carga, multiplicidad, mep, titulo}` → crea un cálculo |
| GET | `/api/calculos/:id` | Estado, salida en vivo y resultado |
| DELETE | `/api/calculos/:id` | Cancela un cálculo (sólo la misma IP) |
| GET | `/api/calculos/:id/archivo/:nombre` | `salida.dat`, `geometria.xyz`, `homo.cube`, `lumo.cube`, `densidad.cube`, `mep.cube` |

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
