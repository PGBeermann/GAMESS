// Servidor de cálculos mecánico-cuánticos con Psi4 (UNACHI)
// ---------------------------------------------------------------
// - Sirve la interfaz web (JSME para dibujar + 3Dmol.js para ver en 3D).
// - /api/geometria : molfile/SMILES de JSME → geometría 3D (RDKit, python/geometria.py)
// - /api/calculos  : pone en cola un cálculo Psi4 (python/calculo_psi4.py)
//
// Variables de entorno (todas opcionales): ver README.md

'use strict';

const express = require('express');
const compression = require('compression');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

// ---------- Configuración ----------
const entero = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const CONFIG = {
  puerto: entero(process.env.PUERTO || process.env.PORT, 3000),
  python: process.env.PYTHON || 'python',
  datos: path.resolve(process.env.CARPETA_DATOS || path.join(__dirname, 'datos')),
  simultaneos: Math.max(1, entero(process.env.MAX_CALCULOS_SIMULTANEOS, 1)),
  hilos: Math.max(1, entero(process.env.PSI4_HILOS, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length))),
  memoria: /^\d+(\.\d+)?\s*(MB|GB)$/i.test(process.env.PSI4_MEMORIA || '') ? process.env.PSI4_MEMORIA : '2 GB',
  maxAtomos: Math.max(1, entero(process.env.MAX_ATOMOS, 40)),
  minutosMax: Math.max(1, entero(process.env.TIEMPO_MAXIMO_MIN, 30)),
  horasRetencion: Math.max(1, entero(process.env.HORAS_RETENCION, 48)),
  maxCola: Math.max(1, entero(process.env.MAX_COLA, 30)),
  maxPorIp: Math.max(1, entero(process.env.MAX_POR_USUARIO, 3)),
  clave: process.env.CLAVE_ACCESO || '',
};
const DIR_TRABAJOS = path.join(CONFIG.datos, 'trabajos');
const SCRIPT_GEOM = path.join(__dirname, 'python', 'geometria.py');
const SCRIPT_PSI4 = path.join(__dirname, 'python', 'calculo_psi4.py');

// ---------- Catálogos permitidos ----------
const METODOS = [
  { id: 'hf', nombre: 'Hartree–Fock (HF)', tipo: 'HF' },
  { id: 'b3lyp', nombre: 'B3LYP', tipo: 'DFT híbrido' },
  { id: 'pbe0', nombre: 'PBE0', tipo: 'DFT híbrido' },
  { id: 'wb97x-d', nombre: 'ωB97X-D', tipo: 'DFT con dispersión' },
  { id: 'm06-2x', nombre: 'M06-2X', tipo: 'DFT meta-GGA' },
  { id: 'mp2', nombre: 'MP2', tipo: 'Correlación electrónica' },
];
const BASES = [
  { id: 'sto-3g', nombre: 'STO-3G' },
  { id: '3-21g', nombre: '3-21G' },
  { id: '6-31g', nombre: '6-31G' },
  { id: '6-31g*', nombre: '6-31G(d)' },
  { id: '6-31g**', nombre: '6-31G(d,p)' },
  { id: '6-31+g*', nombre: '6-31+G(d)' },
  { id: '6-311g**', nombre: '6-311G(d,p)' },
  { id: 'cc-pvdz', nombre: 'cc-pVDZ' },
  { id: 'aug-cc-pvdz', nombre: 'aug-cc-pVDZ' },
  { id: 'def2-svp', nombre: 'def2-SVP' },
  { id: 'def2-tzvp', nombre: 'def2-TZVP' },
];
const TAREAS = [
  { id: 'energia', nombre: 'Energía (punto simple)' },
  { id: 'optimizacion', nombre: 'Optimización de geometría' },
  { id: 'frecuencias', nombre: 'Optimización + frecuencias (IR y termoquímica)' },
  { id: 'ts', nombre: 'Estado de transición (TS) + frecuencias' },
  { id: 'irc', nombre: 'Camino de reacción IRC (desde un TS)' },
  { id: 'scan', nombre: 'Scan relajado (distancia, ángulo o diedro)' },
  { id: 'congelar', nombre: 'Optimización con una coordenada congelada' },
];

// Solventes predefinidos de PCMSolver: la tabla está en public/entrada.js (la usan también la página y el lector de .in)
const { SOLVENTES } = require('./public/entrada.js');
const MODELOS_PCM = [
  { id: 'IEFPCM', nombre: 'IEFPCM (formalismo de ecuación integral)' },
  { id: 'CPCM', nombre: 'CPCM (conductor)' },
];
// Solvente del formulario (id o nombre de PCMSolver); null = fase gaseosa
function opcionesPCM(b, metodo) {
  const id = b.solvente;
  if (!id || id === 'ninguno') return null;
  const s = SOLVENTES.find((x) => x.id === id || x.pcm.toLowerCase() === String(id).toLowerCase() || x.alias.toLowerCase() === String(id).toLowerCase());
  if (!s) throw new Error('Solvente no disponible en PCMSolver.');
  if (pcmDisponible === false) throw new Error('PCMSolver no está instalado en este servidor: sólo se pueden hacer cálculos en fase gaseosa.');
  if (metodo === 'mp2') throw new Error('PCM en Psi4 sólo funciona con HF o DFT (no con MP2). Elija otro método o «Sin solvente».');
  const modelo = MODELOS_PCM.some((m) => m.id === b.modelo_pcm) ? b.modelo_pcm : 'IEFPCM';
  return { id: s.id, solvente: s.pcm, nombre: s.nombre, epsilon: s.epsilon, modelo };
}

// Opciones del scan relajado: tipo, 2/3/4 átomos (desde 1) y hasta 40 valores dentro de un rango razonable
const SCAN = {
  distancia: { natom: 2, min: 0.5, max: 6, nombre: 'distancias', unidad: 'Å' },
  angulo: { natom: 3, min: 20, max: 179, nombre: 'ángulos', unidad: '°' },
  diedro: { natom: 4, min: -360, max: 360, nombre: 'diedros', unidad: '°' },
};
function opcionesScan(o = {}, natomos = 0, congelar = false) {
  const tipo = SCAN[o.tipo] ? o.tipo : 'distancia';
  const c = SCAN[tipo];
  const atomos = (Array.isArray(o.atomos) ? o.atomos : []).slice(0, c.natom).map((a) => Math.round(Number(a)));
  if (atomos.length !== c.natom || new Set(atomos).size !== c.natom || !atomos.every((a) => a >= 1 && a <= natomos)) {
    throw new Error(`Scan de ${tipo}: indique ${c.natom} átomos distintos entre 1 y ${natomos}.`);
  }
  const valores = (Array.isArray(o.valores) ? o.valores : []).map(Number).filter(Number.isFinite);
  if (congelar && valores.length !== 1) throw new Error('Coordenada congelada: indique un solo valor.');
  if (valores.length < 1 || valores.length > 40) throw new Error(`Scan: se necesitan entre 1 y 40 ${c.nombre}.`);
  if (valores.some((v) => v < c.min || v > c.max)) throw new Error(`Scan: los ${c.nombre} deben estar entre ${c.min} y ${c.max} ${c.unidad}.`);
  return { tipo, atomos, valores: valores.map((v) => Math.round(v * 10000) / 10000) };
}

// Opciones del IRC (dirección, puntos por dirección y tamaño de paso en bohr·amu^½), acotadas
function opcionesIRC(o = {}) {
  const direccion = ['ambas', 'forward', 'backward'].includes(o.direccion) ? o.direccion : 'ambas';
  const puntos = Math.min(60, Math.max(3, Math.round(Number(o.puntos) || 20)));
  const paso = Math.min(0.5, Math.max(0.05, Number(o.paso) || 0.2));
  return { direccion, puntos, paso: Math.round(paso * 1000) / 1000 };
}
// Elementos H–Kr y I (número atómico para validar electrones/multiplicidad)
const Z = Object.fromEntries(
  ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr')
    .split(' ').map((s, i) => [s, i + 1]).concat([['I', 53]]),
);
const { generarEntradaPsi4 } = require('./public/entrada.js');
const ARCHIVOS_PERMITIDOS = new Set(['salida.dat', 'entrada.in', 'geometria.xyz', 'homo.cube', 'lumo.cube', 'densidad.cube', 'mep.cube',
  'orbitales.molden', 'naturales.molden', 'irc_iboview.zip', 'scan_iboview.zip']); // los .molden y los .zip son para IboView
// Un .molden por punto de un IRC o de un scan (carpeta molden/ del trabajo)
const MOLDEN_PUNTO = /^(irc|scan)_\d{3}\.molden$/;

// ---------- Estado de los trabajos ----------
/** @type {Map<string, any>} */
const trabajos = new Map();
const cola = [];
let enEjecucion = 0;
let versionPsi4 = null;
let pcmDisponible = null; // se sabe al arrancar (version.py)

const ahora = () => new Date().toISOString();
const carpetaDe = (id) => path.join(DIR_TRABAJOS, id);
const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function guardarMeta(t) {
  const { proceso, vivo, ...meta } = t; // la geometría en vivo sólo vive en memoria
  const tmp = path.join(carpetaDe(t.id), 'trabajo.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, path.join(carpetaDe(t.id), 'trabajo.json'));
}

async function cargarTrabajosPrevios() {
  await fsp.mkdir(DIR_TRABAJOS, { recursive: true });
  for (const id of await fsp.readdir(DIR_TRABAJOS)) {
    if (!ID_VALIDO.test(id)) continue;
    try {
      const t = JSON.parse(await fsp.readFile(path.join(carpetaDe(id), 'trabajo.json'), 'utf8'));
      if (t.estado === 'en_cola' || t.estado === 'ejecutando') {
        t.estado = 'error';
        t.error = 'El servidor se reinició antes de terminar este cálculo.';
        t.fin = ahora();
        trabajos.set(id, t);
        await guardarMeta(t);
      } else {
        trabajos.set(id, t);
      }
    } catch { /* carpeta incompleta: se ignora */ }
  }
}

async function limpiarAntiguos() {
  const limite = Date.now() - CONFIG.horasRetencion * 3600e3;
  for (const [id, t] of trabajos) {
    if ((t.estado === 'terminado' || t.estado === 'error') && Date.parse(t.fin || t.creado) < limite) {
      trabajos.delete(id);
      await fsp.rm(carpetaDe(id), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function siguiente() {
  while (enEjecucion < CONFIG.simultaneos && cola.length) {
    const id = cola.shift();
    const t = trabajos.get(id);
    if (t && t.estado === 'en_cola') ejecutar(t);
  }
}

function ejecutar(t) {
  enEjecucion++;
  t.estado = 'ejecutando';
  t.inicio = ahora();
  t.etapa = 'Iniciando Psi4';
  guardarMeta(t).catch(() => {});

  const carpeta = carpetaDe(t.id);
  const scratch = path.join(carpeta, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const proceso = spawn(CONFIG.python, ['-u', SCRIPT_PSI4, carpeta], {
    cwd: carpeta,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PSI_SCRATCH: scratch, OMP_NUM_THREADS: String(CONFIG.hilos), MKL_NUM_THREADS: String(CONFIG.hilos) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.proceso = proceso;

  let resto = '';
  let stderr = '';
  proceso.stdout.on('data', (b) => {
    resto += b.toString();
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const l of lineas) {
      if (l.startsWith('@@ETAPA ')) {
        t.etapa = l.slice(8).trim();
        guardarMeta(t).catch(() => {});
      } else if (l.startsWith('@@GEOM ')) {
        // Geometría de cada paso de la optimización, para actualizar el visor 3D en vivo
        try {
          const g = JSON.parse(l.slice(7));
          if (!t.vivo) t.vivo = { energias: [], pasos: [] };
          const paso = { paso: g.paso, energia: g.energia, grad_rms: g.grad_rms, grad_max: g.grad_max, xyz: String(g.xyz || '') };
          Object.assign(t.vivo, paso);
          if (t.vivo.energias.length < 500) t.vivo.energias.push(g.energia);
          // Se guardan todos los pasos (hasta 300) para que la página no se salte ninguno
          t.vivo.pasos.push(paso);
          if (t.vivo.pasos.length > 300) t.vivo.pasos.shift();
        } catch { /* línea incompleta o no válida */ }
      }
    }
  });
  proceso.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-4000); });

  const reloj = setTimeout(() => {
    t.excedido = true;
    proceso.kill('SIGKILL');
  }, CONFIG.minutosMax * 60e3);

  let terminado = false;
  const terminar = async (codigo) => {
    if (terminado) return;
    terminado = true;
    clearTimeout(reloj);
    delete t.proceso;
    let res = null;
    try { res = JSON.parse(await fsp.readFile(path.join(carpeta, 'resultado.json'), 'utf8')); } catch { /* sin resultado */ }
    t.fin = ahora();
    if (res && res.ok) {
      t.estado = 'terminado';
      t.energia = res.energia && res.energia.hartree;
    } else {
      t.estado = 'error';
      t.error = t.cancelado ? 'Cancelado por el usuario.' : t.excedido
        ? `Se superó el tiempo máximo de ${CONFIG.minutosMax} min. Use una base más pequeña o una molécula menor.`
        : (res && res.error) || `Psi4 terminó con código ${codigo}. ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim();
    }
    t.etapa = null;
    delete t.vivo;
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    await guardarMeta(t).catch(() => {});
    enEjecucion--;
    siguiente();
  };
  proceso.on('close', terminar);
  proceso.on('error', (e) => {
    stderr += `
No se pudo iniciar Python/Psi4: ${e.message}`;
    terminar(-1);
  });
}

// ---------- Utilidades ----------
function correrPython(script, entrada, msMax = 60e3) {
  return new Promise((resolve, reject) => {
    const p = spawn(CONFIG.python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const reloj = setTimeout(() => p.kill('SIGKILL'), msMax);
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    p.on('error', (e) => { clearTimeout(reloj); reject(e); });
    p.on('close', () => {
      clearTimeout(reloj);
      try { resolve(JSON.parse(out)); } catch { reject(new Error(err.trim() || 'Respuesta vacía de Python')); }
    });
    p.stdin.end(JSON.stringify(entrada));
  });
}

function validarXYZ(texto) {
  const lineas = String(texto || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lineas.length) throw new Error('La geometría está vacía.');
  if (lineas.length > CONFIG.maxAtomos) throw new Error(`Máximo ${CONFIG.maxAtomos} átomos (con H).`);
  const num = '(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)';
  const re = new RegExp(`^([A-Z][a-z]?)\\s+${num}\\s+${num}\\s+${num}$`);
  let electrones = 0;
  const limpias = lineas.map((l) => {
    const m = re.exec(l);
    if (!m) throw new Error(`Línea de geometría no válida: "${l.slice(0, 60)}"`);
    if (!Z[m[1]]) throw new Error(`Elemento no soportado: ${m[1]}`);
    const xyz = [m[2], m[3], m[4]].map(Number);
    if (xyz.some((v) => !Number.isFinite(v) || Math.abs(v) > 1000)) throw new Error('Coordenadas fuera de rango.');
    electrones += Z[m[1]];
    return `${m[1]} ${xyz.map((v) => v.toFixed(8)).join(' ')}`;
  });
  return { xyz: limpias.join('\n'), electrones, natomos: limpias.length };
}

function ipDe(req) { return req.ip || req.socket.remoteAddress || '?'; }

function resumen(t) {
  const posicion = t.estado === 'en_cola' ? cola.indexOf(t.id) + 1 : 0;
  return {
    id: t.id, estado: t.estado, etapa: t.etapa || null, posicion_cola: posicion,
    titulo: t.titulo, formula: t.formula, metodo: t.metodo, base: t.base, tarea: t.tarea,
    carga: t.carga, multiplicidad: t.multiplicidad, solvente: t.solvente || null,
    creado: t.creado, inicio: t.inicio || null, fin: t.fin || null, error: t.error || null,
  };
}

async function colaSalida(id, lineas = 60) {
  try {
    const fh = await fsp.open(path.join(carpetaDe(id), 'salida.dat'), 'r');
    const { size } = await fh.stat();
    const n = Math.min(size, 16384);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, size - n);
    await fh.close();
    return buf.toString('utf8').split('\n').slice(-lineas).join('\n');
  } catch { return ''; }
}

// ---------- Aplicación web ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use('/vendor/jsme', express.static(path.join(__dirname, 'node_modules', 'jsme-editor'), { maxAge: '7d' }));
app.use('/vendor/3dmol', express.static(path.join(__dirname, 'node_modules', '3dmol', 'build'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/salud', (req, res) => res.json({ ok: true, psi4: versionPsi4, pcm: pcmDisponible, cola: cola.length, ejecutando: enEjecucion }));

app.get('/api/opciones', (req, res) => {
  res.json({
    metodos: METODOS, bases: BASES, tareas: TAREAS,
    max_atomos: CONFIG.maxAtomos, minutos_max: CONFIG.minutosMax,
    hilos: CONFIG.hilos, memoria: CONFIG.memoria, simultaneos: CONFIG.simultaneos,
    requiere_clave: Boolean(CONFIG.clave), psi4: versionPsi4,
    solventes: SOLVENTES.map(({ id, nombre, formula, epsilon, pcm }) => ({ id, nombre, formula, epsilon, pcm })),
    modelos_pcm: MODELOS_PCM, pcm: pcmDisponible !== false,
  });
});

// Clave de acceso opcional para todo /api (excepto /api/opciones)
app.use('/api', (req, res, next) => {
  if (!CONFIG.clave) return next();
  const dada = Buffer.from(String(req.get('x-clave-acceso') || ''));
  const real = Buffer.from(CONFIG.clave);
  if (dada.length === real.length && crypto.timingSafeEqual(dada, real)) return next();
  res.status(401).json({ error: 'Clave de acceso incorrecta.' });
});

app.post('/api/geometria', async (req, res) => {
  const { molfile, smiles, xyz } = req.body || {};
  // Geometría leída de un archivo .in/.xyz: se valida y se conservan las coordenadas
  if (xyz) {
    try {
      const g = validarXYZ(xyz);
      const carga = Number(req.body.carga) || 0;
      const multiplicidad = Number(req.body.multiplicidad) || 1;
      if (!Number.isInteger(carga) || Math.abs(carga) > 4 || !Number.isInteger(multiplicidad) || multiplicidad < 1 || multiplicidad > 5) {
        return res.status(400).json({ error: 'Carga o multiplicidad no válidas en el archivo.' });
      }
      const r = await correrPython(SCRIPT_GEOM, { xyz: g.xyz, carga, multiplicidad }, 60e3);
      if (!r.ok) return res.status(422).json({ error: r.error });
      return res.json(r);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (!molfile && !smiles) return res.status(400).json({ error: 'Envíe un molfile o un SMILES.' });
  if (String(molfile || '').length > 200000 || String(smiles || '').length > 2000) {
    return res.status(400).json({ error: 'Estructura demasiado grande.' });
  }
  try {
    const r = await correrPython(SCRIPT_GEOM, { molfile, smiles, max_atomos: CONFIG.maxAtomos }, 60e3);
    if (!r.ok) return res.status(422).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: `No se pudo generar la geometría: ${e.message}` });
  }
});

app.post('/api/calculos', async (req, res) => {
  try {
    const b = req.body || {};
    const metodo = METODOS.find((m) => m.id === b.metodo);
    const base = BASES.find((m) => m.id === b.base);
    const tarea = TAREAS.find((m) => m.id === b.tarea);
    if (!metodo || !base || !tarea) return res.status(400).json({ error: 'Método, base o tarea no válidos.' });
    const carga = Number(b.carga);
    const mult = Number(b.multiplicidad);
    if (!Number.isInteger(carga) || carga < -4 || carga > 4) return res.status(400).json({ error: 'La carga debe ser un entero entre -4 y 4.' });
    if (!Number.isInteger(mult) || mult < 1 || mult > 5) return res.status(400).json({ error: 'La multiplicidad debe ser un entero entre 1 y 5.' });
    const g = validarXYZ(b.xyz);
    const electrones = g.electrones - carga;
    if (electrones < 1) return res.status(400).json({ error: 'La molécula debe tener al menos un electrón.' });
    if ((electrones + mult - 1) % 2 !== 0) {
      return res.status(400).json({ error: `Con ${electrones} electrones la multiplicidad ${mult} es imposible (use ${electrones % 2 ? 'un número par: 2, 4' : 'un número impar: 1, 3'}).` });
    }
    if (cola.length >= CONFIG.maxCola) return res.status(503).json({ error: 'La cola de cálculos está llena. Intente en unos minutos.' });
    const ip = ipDe(req);
    const activos = [...trabajos.values()].filter((t) => t.ip === ip && (t.estado === 'en_cola' || t.estado === 'ejecutando')).length;
    if (activos >= CONFIG.maxPorIp) return res.status(429).json({ error: `Ya tiene ${activos} cálculos pendientes. Espere a que terminen.` });

    const id = crypto.randomUUID();
    const titulo = String(b.titulo || 'molécula').replace(/[^\p{L}\p{N} ()\-_,.+=#]/gu, '').slice(0, 80) || 'molécula';
    const irc = tarea.id === 'irc' ? opcionesIRC(b.irc) : undefined;
    const pcm = opcionesPCM(b, metodo.id);
    const scan = ['scan', 'congelar'].includes(tarea.id) ? opcionesScan(b.scan, g.natomos, tarea.id === 'congelar') : undefined;
    const t = {
      id, estado: 'en_cola', creado: ahora(), ip,
      titulo, formula: String(b.formula || '').slice(0, 60), smiles: String(b.smiles || '').slice(0, 500),
      metodo: metodo.id, base: base.id, tarea: tarea.id, carga, multiplicidad: mult, natomos: g.natomos,
      solvente: pcm ? `${pcm.nombre} (${pcm.modelo})` : null,
    };
    await fsp.mkdir(carpetaDe(id), { recursive: true });
    await fsp.writeFile(path.join(carpetaDe(id), 'entrada.json'), JSON.stringify({
      xyz: g.xyz, carga, multiplicidad: mult, metodo: metodo.id, base: base.id, tarea: tarea.id,
      mep: b.mep !== false, molden: true, hilos: CONFIG.hilos, memoria: CONFIG.memoria, titulo, irc, scan, pcm,
    }));
    // Entrada .in equivalente, para descargarla y ejecutarla con Psi4 fuera del servidor
    await fsp.writeFile(path.join(carpetaDe(id), 'entrada.in'), generarEntradaPsi4({
      titulo, xyz: g.xyz, carga, multiplicidad: mult, metodo: metodo.id, base: base.id, tarea: tarea.id,
      memoria: CONFIG.memoria, mep: b.mep !== false, molden: true, irc, scan, pcm,
    }));
    trabajos.set(id, t);
    await guardarMeta(t);
    cola.push(id);
    siguiente();
    res.status(201).json(resumen(t));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function buscar(req, res) {
  const { id } = req.params;
  const t = ID_VALIDO.test(id) && trabajos.get(id);
  if (!t) { res.status(404).json({ error: 'Cálculo no encontrado (puede haber expirado).' }); return null; }
  return t;
}

app.get('/api/calculos/:id', async (req, res) => {
  const t = buscar(req, res);
  if (!t) return;
  const r = resumen(t);
  if (t.estado === 'ejecutando' || t.estado === 'error') r.registro = await colaSalida(t.id);
  if (t.estado === 'ejecutando' && t.vivo) {
    // ?desde=N devuelve sólo los pasos posteriores al N (los que la página aún no tiene)
    const desde = Math.max(0, parseInt(req.query.desde, 10) || 0);
    const { pasos, ...ultimo } = t.vivo;
    r.vivo = { ...ultimo, pasos: pasos.filter((p) => p.paso > desde).slice(0, 50) };
  }
  if (t.estado === 'terminado' || t.estado === 'error') {
    try { r.resultado = JSON.parse(await fsp.readFile(path.join(carpetaDe(t.id), 'resultado.json'), 'utf8')); } catch { /* nada */ }
    if (r.resultado) delete r.resultado.traza;
  }
  res.json(r);
});

app.delete('/api/calculos/:id', (req, res) => {
  const t = buscar(req, res);
  if (!t) return;
  if (t.ip !== ipDe(req)) return res.status(403).json({ error: 'Sólo quien lanzó el cálculo puede cancelarlo.' });
  if (t.estado === 'en_cola') {
    cola.splice(cola.indexOf(t.id), 1);
    t.estado = 'error'; t.error = 'Cancelado por el usuario.'; t.fin = ahora();
    guardarMeta(t).catch(() => {});
  } else if (t.estado === 'ejecutando' && t.proceso) {
    t.cancelado = true;
    t.proceso.kill('SIGKILL');
  }
  res.json(resumen(t));
});

app.get('/api/calculos/:id/archivo/:nombre', (req, res) => {
  const t = buscar(req, res);
  if (!t) return;
  const nombre = req.params.nombre;
  const porPunto = MOLDEN_PUNTO.test(nombre);
  if (!porPunto && !ARCHIVOS_PERMITIDOS.has(nombre)) return res.status(404).json({ error: 'Archivo no disponible.' });
  const ruta = path.join(carpetaDe(t.id), ...(porPunto ? ['molden', nombre] : [nombre]));
  if (!fs.existsSync(ruta)) return res.status(404).json({ error: 'Archivo no disponible.' });
  res.type(nombre.endsWith('.zip') ? 'application/zip' : 'text/plain; charset=utf-8');
  if (req.query.descargar) res.attachment(`${t.titulo.replace(/\s+/g, '_')}_${nombre}`);
  res.sendFile(ruta);
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'Solicitud demasiado grande.' : 'Error interno.' });
});

// ---------- Arranque ----------
async function iniciar() {
  await cargarTrabajosPrevios();
  setInterval(() => limpiarAntiguos().catch(() => {}), 3600e3).unref();
  limpiarAntiguos().catch(() => {});
  correrPython(path.join(__dirname, 'python', 'version.py'), {}, 120e3)
    .then((r) => {
      versionPsi4 = r.psi4 || null;
      pcmDisponible = Boolean(r.pcm);
      console.log(`Psi4 ${versionPsi4} / RDKit ${r.rdkit} / PCMSolver ${pcmDisponible ? 'sí' : `no (${r.error_pcm || '?'})`}`);
    })
    .catch((e) => console.warn('Aviso: no se pudo importar Psi4/RDKit:', e.message));
  app.listen(CONFIG.puerto, () => {
    console.log(`Servidor Psi4 + JSME escuchando en http://localhost:${CONFIG.puerto}`);
    console.log(`Hilos Psi4: ${CONFIG.hilos} · Memoria: ${CONFIG.memoria} · Simultáneos: ${CONFIG.simultaneos} · Máx. átomos: ${CONFIG.maxAtomos}`);
  });
}

iniciar();

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    for (const t of trabajos.values()) if (t.proceso) t.proceso.kill('SIGKILL');
    process.exit(0);
  });
}
