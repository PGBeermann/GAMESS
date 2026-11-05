/* Archivos de entrada de Psi4 (.in) — lectura y generación (UNACHI)
 *
 * leerEntradaPsi4(texto)  → { titulo, xyz, carga, multiplicidad, metodo, base, tarea, avisos }
 * leerXYZ(texto)          → { titulo, xyz, avisos }
 * generarEntradaPsi4(...) → texto .in listo para ejecutarse con «psi4 archivo.in»
 *
 * El .in NO se ejecuta (sería ejecutar Python arbitrario en el servidor): se interpreta
 * para extraer la molécula (cartesianas o matriz Z), la carga, la multiplicidad, el método,
 * la base y el tipo de cálculo, que se envían al servidor como un cálculo normal.
 * Funciona en el navegador y en Node (servidor.js lo usa para crear entrada.in).
 */
(function (global) {
  'use strict';

  const BOHR_A_ANG = 0.52917721067;
  const METODOS = ['hf', 'b3lyp', 'pbe0', 'wb97x-d', 'm06-2x', 'mp2'];
  const BASES = ['sto-3g', '3-21g', '6-31g', '6-31g*', '6-31g**', '6-31+g*', '6-311g**', 'cc-pvdz', 'aug-cc-pvdz', 'def2-svp', 'def2-tzvp'];
  // Opciones que no cambian el resultado químico (o que el servidor ya fija): se ignoran sin aviso
  const INOFENSIVAS = /^(scf_type|cubeprop_\w+|cubic_grid_\w+|print|maxiter|geom_maxiter|e_convergence|d_convergence|g_convergence|guess|puream|freeze_core|mp2_type|ints_tolerance|dft_\w+|num_threads|full_hess_every|step_type|hess_update|write_opt_history)$/;
  const NOMBRE_TAREA = { energia: 'energía (punto simple)', optimizacion: 'optimización de geometría', frecuencias: 'optimización + frecuencias', ts: 'estado de transición (TS) + frecuencias', irc: 'camino de reacción IRC', scan: 'scan relajado', congelar: 'optimización con coordenadas congeladas' };
  const ELEMENTOS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr I').split(' '));

  // Solventes predefinidos de PCMSolver: id de la página, nombre y alias que acepta PCMSolver, ε estática
  const SOLVENTES = [
    { id: 'agua', pcm: 'Water', alias: 'H2O', nombre: 'Agua', formula: 'H2O', epsilon: 78.39 },
    { id: 'carbonato_propileno', pcm: 'Propylene Carbonate', alias: 'C4H6O3', nombre: 'Carbonato de propileno', formula: 'C4H6O3', epsilon: 64.96 },
    { id: 'dmso', pcm: 'Dimethylsulfoxide', alias: 'DMSO', nombre: 'Dimetilsulfóxido (DMSO)', formula: 'C2H6OS', epsilon: 46.7 },
    { id: 'nitrometano', pcm: 'Nitromethane', alias: 'CH3NO2', nombre: 'Nitrometano', formula: 'CH3NO2', epsilon: 38.2 },
    { id: 'acetonitrilo', pcm: 'Acetonitrile', alias: 'CH3CN', nombre: 'Acetonitrilo', formula: 'CH3CN', epsilon: 36.64 },
    { id: 'metanol', pcm: 'Methanol', alias: 'CH3OH', nombre: 'Metanol', formula: 'CH3OH', epsilon: 32.63 },
    { id: 'etanol', pcm: 'Ethanol', alias: 'CH3CH2OH', nombre: 'Etanol', formula: 'CH3CH2OH', epsilon: 24.55 },
    { id: 'acetona', pcm: 'Acetone', alias: 'C2H6CO', nombre: 'Acetona', formula: 'C3H6O', epsilon: 20.7 },
    { id: 'dicloroetano', pcm: '1,2-Dichloroethane', alias: 'C2H4CL2', nombre: '1,2-Dicloroetano', formula: 'C2H4Cl2', epsilon: 10.36 },
    { id: 'diclorometano', pcm: 'Methylenechloride', alias: 'CH2CL2', nombre: 'Diclorometano', formula: 'CH2Cl2', epsilon: 8.93 },
    { id: 'thf', pcm: 'Tetrahydrofurane', alias: 'THF', nombre: 'Tetrahidrofurano (THF)', formula: 'C4H8O', epsilon: 7.58 },
    { id: 'anilina', pcm: 'Aniline', alias: 'C6H5NH2', nombre: 'Anilina', formula: 'C6H5NH2', epsilon: 6.89 },
    { id: 'clorobenceno', pcm: 'Chlorobenzene', alias: 'C6H5CL', nombre: 'Clorobenceno', formula: 'C6H5Cl', epsilon: 5.621 },
    { id: 'cloroformo', pcm: 'Chloroform', alias: 'CHCL3', nombre: 'Cloroformo', formula: 'CHCl3', epsilon: 4.9 },
    { id: 'tolueno', pcm: 'Toluene', alias: 'C6H5CH3', nombre: 'Tolueno', formula: 'C6H5CH3', epsilon: 2.379 },
    { id: 'dioxano', pcm: '1,4-Dioxane', alias: 'C4H8O2', nombre: '1,4-Dioxano', formula: 'C4H8O2', epsilon: 2.25 },
    { id: 'benceno', pcm: 'Benzene', alias: 'C6H6', nombre: 'Benceno', formula: 'C6H6', epsilon: 2.247 },
    { id: 'tetracloruro_carbono', pcm: 'Carbon Tetrachloride', alias: 'CCL4', nombre: 'Tetracloruro de carbono', formula: 'CCl4', epsilon: 2.228 },
    { id: 'ciclohexano', pcm: 'Cyclohexane', alias: 'C6H12', nombre: 'Ciclohexano', formula: 'C6H12', epsilon: 2.023 },
    { id: 'heptano', pcm: 'N-heptane', alias: 'C7H16', nombre: 'n-Heptano', formula: 'C7H16', epsilon: 1.92 },
  ];
  const MODELOS_PCM = ['IEFPCM', 'CPCM'];
  // Busca un solvente por id de la página, nombre de PCMSolver o fórmula (sin distinguir mayúsculas)
  function buscarSolvente(x) {
    const k = String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return SOLVENTES.find((s) => s.id === k || s.pcm.toLowerCase() === k || s.alias.toLowerCase() === k) || null;
  }

  // Bloque «pcm = { … }» de un .in (con llaves anidadas): devuelve su texto y su posición
  function bloquePCM(texto) {
    const m = /^[ \t]*pcm\s*=\s*\{/im.exec(texto);
    if (!m) return null;
    let nivel = 0;
    for (let i = m.index + m[0].length - 1; i < texto.length; i++) {
      if (texto[i] === '{') nivel++;
      else if (texto[i] === '}' && --nivel === 0) return { inicio: m.index, fin: i + 1, cuerpo: texto.slice(m.index + m[0].length, i) };
    }
    throw new Error('El bloque «pcm = { … }» no tiene cerradas todas sus llaves.');
  }

  function normalizarMetodo(m, avisos) {
    let x = String(m).trim().toLowerCase();
    const alias = { scf: 'hf', rhf: 'hf', uhf: 'hf', 'b3lyp-d3': 'b3lyp', 'b3lyp-d3bj': 'b3lyp', 'b3lyp-d3(bj)': 'b3lyp', wb97xd: 'wb97x-d', 'ωb97x-d': 'wb97x-d', m062x: 'm06-2x', 'df-mp2': 'mp2', 'conv-mp2': 'mp2', 'scs-mp2': 'mp2' };
    if (alias[x]) {
      if (x.startsWith('b3lyp-d3')) avisos.push('Se usa B3LYP sin la corrección de dispersión D3 (no disponible en este servidor).');
      if (x === 'scs-mp2') avisos.push('SCS-MP2 no está disponible: se usa MP2.');
      x = alias[x];
    }
    if (!METODOS.includes(x)) throw new Error(`El método «${m}» no está disponible. Use uno de: HF, B3LYP, PBE0, ωB97X-D, M06-2X o MP2.`);
    return x;
  }

  function normalizarBase(b) {
    let x = String(b).trim().toLowerCase().replace(/\s+/g, '').replace(/^["']|["']$/g, '');
    const alias = {
      '6-31g(d)': '6-31g*', '6-31g(d,p)': '6-31g**', '6-31+g(d)': '6-31+g*', '6-311g(d,p)': '6-311g**',
      sto3g: 'sto-3g', '321g': '3-21g', ccpvdz: 'cc-pvdz', augccpvdz: 'aug-cc-pvdz', def2svp: 'def2-svp', def2tzvp: 'def2-tzvp',
    };
    x = alias[x] || x;
    if (!BASES.includes(x)) throw new Error(`La base «${b}» no está disponible. Use una de: ${BASES.join(', ')}.`);
    return x;
  }

  const esNumero = (t) => /^[-+]?(\d+\.?\d*|\.\d+)([eEdD][-+]?\d+)?$/.test(t);
  const aNumero = (t) => parseFloat(String(t).replace(/[dD]/, 'e'));

  function simboloDe(etiqueta) {
    // Como en Psi4: símbolo del elemento, opcionalmente seguido de números o de _sufijo (C1, H_a)
    const m = /^([A-Za-z]{1,2})(?:\d+|_\w*)?$/.exec(etiqueta);
    if (!m) return null;
    const s = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    if (ELEMENTOS.has(s)) return s;
    return s === 'X' ? 'X' : null;
  }

  // ---- Geometría: cartesianas o matriz Z ----
  const resta = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cruz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };

  function colocar(A, B, C, r, theta, phi) {
    const bc = unit(resta(A, B));
    const n = unit(cruz(resta(B, C), bc));
    const m = cruz(n, bc);
    const d = [-r * Math.cos(theta), r * Math.sin(theta) * Math.cos(phi), r * Math.sin(theta) * Math.sin(phi)];
    return [A[0] + d[0] * bc[0] + d[1] * m[0] + d[2] * n[0], A[1] + d[0] * bc[1] + d[1] * m[1] + d[2] * n[1], A[2] + d[0] * bc[2] + d[1] * m[2] + d[2] * n[2]];
  }

  function geometria(lineasAtomos, variables, factor) {
    const atomos = []; // {sim, etiqueta, p}
    const valor = (tok, linea) => {
      if (esNumero(tok)) return aNumero(tok);
      const neg = tok.startsWith('-');
      const nombre = neg ? tok.slice(1) : tok;
      if (!(nombre in variables)) throw new Error(`Variable «${nombre}» sin definir en: «${linea}»`);
      return neg ? -variables[nombre] : variables[nombre];
    };
    const ref = (tok, linea) => {
      let i;
      if (/^\d+$/.test(tok)) i = parseInt(tok, 10) - 1;
      else i = atomos.findIndex((a) => a.etiqueta.toLowerCase() === tok.toLowerCase());
      if (i < 0 || i >= atomos.length) throw new Error(`Referencia de átomo «${tok}» no válida en: «${linea}»`);
      return atomos[i].p;
    };
    for (const linea of lineasAtomos) {
      const t = linea.split(/[\s,]+/).filter(Boolean);
      if (/^(gh\(|@)/i.test(t[0])) throw new Error(`Los átomos fantasma no se admiten: «${linea}»`);
      const sim = simboloDe(t[0]);
      if (!sim) throw new Error(`Elemento «${t[0]}» no reconocido en: «${linea}»`);
      let p;
      if (t.length === 4) {
        p = [valor(t[1], linea), valor(t[2], linea), valor(t[3], linea)].map((v) => v * factor);
      } else if (t.length === 1 && atomos.length === 0) {
        p = [0, 0, 0];
      } else if (t.length === 3 && atomos.length >= 1) {
        const A = ref(t[1], linea);
        p = [A[0], A[1], A[2] + valor(t[2], linea) * factor];
      } else if (t.length === 5 && atomos.length >= 2) {
        const A = ref(t[1], linea); const B = ref(t[3], linea);
        const r = valor(t[2], linea) * factor; const th = (valor(t[4], linea) * Math.PI) / 180;
        const eje = resta(B, A);
        const aux = Math.abs(unit(eje)[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const C = [B[0] + aux[0], B[1] + aux[1], B[2] + aux[2]];
        p = colocar(A, B, C, r, th, 0);
      } else if (t.length === 7 && atomos.length >= 3) {
        p = colocar(ref(t[1], linea), ref(t[3], linea), ref(t[5], linea), valor(t[2], linea) * factor,
          (valor(t[4], linea) * Math.PI) / 180, (valor(t[6], linea) * Math.PI) / 180);
      } else {
        throw new Error(`Línea de geometría no reconocida: «${linea}»`);
      }
      if (p.some((v) => !Number.isFinite(v))) throw new Error(`Coordenadas no válidas en: «${linea}»`);
      atomos.push({ sim, etiqueta: t[0], p });
    }
    const reales = atomos.filter((a) => a.sim !== 'X');
    if (!reales.length) throw new Error('El bloque molecule no contiene átomos.');
    return reales.map((a) => `${a.sim.padEnd(2)} ${a.p.map((v) => v.toFixed(8).padStart(14)).join(' ')}`).join('\n');
  }

  function leerMolecula(cuerpo, avisos) {
    const lineas = cuerpo.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
    let carga = null; let mult = null; let factor = 1; let fragmentos = 0;
    const atomosL = []; const variables = {};
    for (const l of lineas) {
      const low = l.toLowerCase();
      if (/^units?\s+/.test(low)) { factor = /bohr|au|a\.u\./.test(low) ? BOHR_A_ANG : 1; continue; }
      if (/^(symmetry|no_reorient|noreorient|no_com|nocom|pubchem|efp|fix_|zmat|units)/.test(low)) {
        if (low.startsWith('pubchem')) throw new Error('«pubchem:» no está disponible: escriba las coordenadas en el archivo.');
        continue;
      }
      if (l === '--') { fragmentos++; continue; }
      const t = l.split(/\s+/);
      if (t.length === 2 && /^[-+]?\d+$/.test(t[0]) && /^\d+$/.test(t[1])) {
        carga = (carga || 0) + parseInt(t[0], 10);
        mult = Math.max(mult || 1, parseInt(t[1], 10));
        continue;
      }
      const v = /^([A-Za-z_]\w*)\s*=\s*([-+]?[\d.]+(?:[eEdD][-+]?\d+)?)$/.exec(l);
      if (v) { variables[v[1]] = aNumero(v[2]); continue; }
      atomosL.push(l);
    }
    if (fragmentos) avisos.push('La molécula tenía varios fragmentos (--): se tratan como un solo sistema (carga total).');
    return { xyz: geometria(atomosL, variables, factor), carga, mult };
  }

  function leerEntradaPsi4(texto) {
    const avisos = [];
    const sinComentarios = String(texto).replace(/\r\n/g, '\n');
    // Bloque molecule nombre { ... }
    const mol = /molecule\s*([\w-]*)\s*\{([\s\S]*?)\}/i.exec(sinComentarios);
    if (!mol) throw new Error('No se encontró un bloque «molecule { … }» en el archivo .in.');
    const titulo = mol[1] || '';
    const { xyz, carga, mult } = leerMolecula(mol[2], avisos);
    let resto = sinComentarios.slice(0, mol.index) + sinComentarios.slice(mol.index + mol[0].length);
    // Solvatación PCM: bloque «pcm = { Medium { Solvent = … SolverType = … } … }» + «set pcm true»
    const bpcm = bloquePCM(resto);
    if (bpcm) resto = resto.slice(0, bpcm.inicio) + resto.slice(bpcm.fin);
    const lineas = resto.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

    // Opciones: «set basis X», «set globals basis X» y bloques «set { … }»
    let base = null; let esTS = false; let esIRC = false; let pcmActivo = false; const ignoradas = [];
    const irc = { direcciones: new Set(), puntos: null, paso: null };
    const opcion = (clave, valor) => {
      const k = clave.toLowerCase();
      const v = valor.trim().toLowerCase();
      if (k === 'basis') base = valor;
      else if (k === 'pcm') pcmActivo = /^(true|1|yes|on)$/.test(v);
      else if (k === 'pcm_scf_type') { /* total o separate: mismo resultado */ } else if (k === 'opt_type') {
        if (v === 'ts') esTS = true;
        else if (v === 'irc') esIRC = true;
      } else if (k === 'irc_direction') {
        if (v === 'forward' || v === 'backward') irc.direcciones.add(v);
        else ignoradas.push(`${clave} ${valor}`);
      } else if (k === 'irc_points') irc.puntos = parseInt(v, 10);
      else if (k === 'irc_step_size') irc.paso = parseFloat(v);
      else if (k === 'irc_mode' || k === 'irc_convergence') ignoradas.push(`${clave} ${valor}`);
      else if (/^(fixed|frozen|ranged)_(distance|bend|dihedral)$/.test(k)) { /* restricción del scan: se lee aparte */ } else if (k === 'reference') { if (/rohf|cuhf/i.test(valor)) avisos.push(`reference ${valor}: se usa RHF/UHF según la multiplicidad.`); } else if (!INOFENSIVAS.test(k)) ignoradas.push(`${clave} ${valor}`);
    };
    // set { … }, set globals { … } o con nombre de módulo: set optking { … }, set scf { … }
    const bloques = /set\s*(?:\w+\s*)?\{([\s\S]*?)\}/gi;
    let b;
    const textoResto = lineas.join('\n');
    while ((b = bloques.exec(textoResto))) {
      for (const l of b[1].split('\n').map((x) => x.trim()).filter(Boolean)) {
        const t = l.split(/\s+/);
        opcion(t[0], t.slice(1).join(' '));
      }
    }
    const sinBloques = textoResto.replace(bloques, '');
    for (const l of sinBloques.split('\n')) {
      const s = /^set\s+(?:globals\s+|(?:\w+\s+)?)?(\w+)\s+(.+)$/i.exec(l);
      if (s && !/^\{/.test(s[2])) opcion(s[1], s[2].trim());
    }
    // Llamadas: energy('b3lyp'), optimize('mp2/cc-pvdz'), frequency(...)…
    const llamadas = [...sinBloques.matchAll(/\b(energy|optimize|opt|frequency|frequencies|freq|properties|prop|gradient|hessian)\s*\(\s*['"]([^'"]+)['"]/gi)]
      .map((m) => ({ funcion: m[1].toLowerCase(), metodo: m[2] }));
    if (!llamadas.length) throw new Error('No se encontró ninguna llamada energy(…), optimize(…) o frequency(…) en el archivo .in.');
    const fs = new Set(llamadas.map((l) => l.funcion));
    const hayOpt = fs.has('optimize') || fs.has('opt');
    const hayFreq = fs.has('frequency') || fs.has('frequencies') || fs.has('freq') || fs.has('hessian');
    // opt_type también puede ir en optimize(…, optimizer_keywords={'opt_type': 'TS'})
    if (/['"]?opt_type['"]?\s*[:=]\s*['"]ts['"]/i.test(sinBloques)) esTS = true;
    if (/['"]?opt_type['"]?\s*[:=]\s*['"]irc['"]/i.test(sinBloques)) esIRC = true;
    let tarea = hayFreq ? 'frecuencias' : hayOpt ? 'optimizacion' : 'energia';
    let opcionesIrc = null;
    // Scan relajado: una distancia restringida (fixed_/frozen_/ranged_distance) y, en general,
    // un bucle for con los valores. El servidor hace el scan equivalente (no ejecuta el bucle).
    const opcionesScan = (hayOpt && !esIRC && !esTS) ? leerScan(textoResto, sinBloques, xyz, avisos) : null;
    if (opcionesScan) {
      tarea = opcionesScan.congelar ? 'congelar' : 'scan';
      delete opcionesScan.congelar;
      // frequency(…) tras la optimización con coordenadas congeladas: hessiano en esa geometría
      if (tarea === 'congelar' && hayFreq) opcionesScan.frecuencias = true;
    } else if (esIRC) {
      if (!hayOpt) throw new Error('«opt_type irc» necesita una llamada optimize(…): el IRC lo recorre el optimizador.');
      tarea = 'irc';
      const direccion = irc.direcciones.size === 1 ? [...irc.direcciones][0] : 'ambas';
      const puntos = Number.isInteger(irc.puntos) ? Math.min(60, Math.max(3, irc.puntos)) : 20;
      const paso = Number.isFinite(irc.paso) ? Math.min(0.5, Math.max(0.05, irc.paso)) : 0.2;
      if (Number.isInteger(irc.puntos) && puntos !== irc.puntos) avisos.push(`irc_points ${irc.puntos}: se usa ${puntos} (permitido 3–60).`);
      if (Number.isFinite(irc.paso) && paso !== irc.paso) avisos.push(`irc_step_size ${irc.paso}: se usa ${paso} (permitido 0.05–0.5).`);
      opcionesIrc = { direccion, puntos, paso };
      avisos.push(`Se calculará el camino de reacción IRC ${direccion === 'ambas' ? 'en ambas direcciones (hacia reactivos y productos)' : `sólo hacia ${direccion === 'forward' ? 'adelante (forward)' : 'atrás (backward)'}`}: hasta ${puntos} puntos por dirección, paso ${paso} bohr·amu½. La geometría debe ser un estado de transición.`);
      if (!irc.direcciones.size) avisos.push('El archivo no indica irc_direction: se recorren las dos direcciones (Psi4, por defecto, sólo haría «forward»).');
      if (hayFreq) avisos.push('Las frecuencias se omiten en el IRC: calcúlelas antes en el TS.');
    } else if (esTS) {
      if (tarea === 'energia') avisos.push('«opt_type ts» sin optimize(…) ni frequency(…): se calcula sólo la energía.');
      else {
        tarea = 'ts';
        avisos.push('Se buscará un estado de transición (opt_type ts): primero se calcula el hessiano exacto y al final las frecuencias, que deben dar una sola frecuencia imaginaria.');
      }
    } else if (hayFreq && !hayOpt) avisos.push('Este servidor optimiza la geometría (busca un mínimo) antes de calcular las frecuencias. Si su geometría es un estado de transición, añada «set opt_type ts».');
    if (fs.has('gradient')) avisos.push('gradient(…) se trata como un cálculo de energía.');
    let metodoTxt = llamadas[llamadas.length - 1].metodo;
    if (metodoTxt.includes('/')) { const [m, bb] = metodoTxt.split('/'); metodoTxt = m; if (!base) base = bb; }
    const metodo = normalizarMetodo(metodoTxt, avisos);
    let pcm = null;
    if (bpcm || pcmActivo) {
      if (bpcm && !pcmActivo) {
        avisos.push('El archivo tiene un bloque «pcm = { … }» pero no «set pcm true»: Psi4 lo ignoraría, así que el cálculo es en fase gaseosa.');
      } else {
        const solv = bpcm && /\bSolvent\s*=\s*([^\n}]+)/i.exec(bpcm.cuerpo);
        const tipo = bpcm && /\bSolverType\s*=\s*([A-Za-z]+)/i.exec(bpcm.cuerpo);
        let s = null;
        if (!solv) avisos.push('«set pcm true» sin bloque «pcm = { … }» con «Solvent»: se usa agua (IEFPCM).');
        else {
          s = buscarSolvente(solv[1].replace(/["']/g, ''));
          if (!s) throw new Error(`El solvente «${solv[1].trim()}» no está entre los predefinidos de PCMSolver (Water, Acetonitrile, Methanol, …).`);
        }
        s = s || buscarSolvente('agua');
        const modelo = tipo && MODELOS_PCM.includes(tipo[1].toUpperCase()) ? tipo[1].toUpperCase() : 'IEFPCM';
        if (tipo && modelo !== tipo[1].toUpperCase()) avisos.push(`SolverType ${tipo[1]}: se usa IEFPCM (disponibles: IEFPCM y CPCM).`);
        if (metodo === 'mp2') throw new Error('PCM en Psi4 sólo funciona con HF o DFT (no con MP2): cambie el método o quite «set pcm true».');
        pcm = { solvente: s.id, modelo };
        avisos.push(`Solvatación PCM: ${s.nombre} (ε = ${s.epsilon}), ${modelo}. La cavidad es GePol con radios UFF.`);
      }
    }
    if (!base) { base = '6-31g*'; avisos.push('El archivo no indicaba la base: se usa 6-31G(d).'); }
    const baseId = normalizarBase(base);
    if (ignoradas.length) avisos.push(`Opciones ignoradas: ${ignoradas.slice(0, 6).join('; ')}${ignoradas.length > 6 ? '…' : ''}`);
    // Lo que el servidor no aplicará (la página lo avisa antes de ejecutar)
    const noAplicado = ignoradas.map((x) => `set ${x}`);
    // Código Python que el servidor no ejecuta (bucles, print_out, variables…): se avisa
    if (tarea !== 'scan' && tarea !== 'congelar') {
      const codigo = sinBloques.split('\n').map((l) => l.trim()).filter((l) => l && !LINEA_CONOCIDA.test(l));
      noAplicado.push(...codigo);
      if (codigo.length) {
        avisos.push(`El archivo contiene código Python que el servidor no ejecuta (p. ej. «${codigo[0].slice(0, 70)}»${codigo.length > 1 ? ` y ${codigo.length - 1} línea(s) más` : ''}): sólo se interpretan la molécula, el método, la base y el tipo de cálculo. Para un scan relajado use «frozen_distance» (o «fixed_distance») con un bucle for.`);
      }
    }
    return {
      titulo, xyz, carga: carga ?? 0, multiplicidad: mult ?? 1, metodo, base: baseId, tarea, avisos, noAplicado,
      mep: /\bcubeprop\s*\(/i.test(sinBloques), molden: /\bmolden\s*\(/i.test(sinBloques), irc: opcionesIrc, scan: opcionesScan, pcm,
    };
  }

  // Líneas que el lector sí entiende (o que genera esta misma aplicación)
  const LINEA_CONOCIDA = /^(set\b|memory\b|E\s*,\s*wfn\s*=|geom_ts\s*=|oeprop\s*\(|cubeprop\s*\(|molden\s*\(|[\w.]+\.(set_geometry|update_geometry)\s*\()|\b(energy|optimize|opt|frequency|frequencies|freq|properties|prop|gradient|hessian)\s*\(/i;

  const numeros = (s) => (String(s).match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/g) || []).map(Number);

  // Valores de un bucle: lista literal, np.arange(a, b, paso), np.linspace(a, b, n) o una variable con eso
  function valoresDe(expr, texto) {
    let e = expr.trim();
    const envoltura = /^(enumerate|list|sorted|reversed|tuple)\s*\((.*)\)$/.exec(e);
    if (envoltura) {
      e = envoltura[2].trim();
      if (envoltura[1] === 'enumerate') e = e.replace(/,\s*(?:start\s*=\s*)?-?\d+\s*$/, '').trim(); // enumerate(lista, 1)
    }
    if (/^[A-Za-z_]\w*$/.test(e)) {
      const asignacion = new RegExp(`^\\s*${e}\\s*=\\s*(.+)$`, 'm').exec(texto);
      if (!asignacion) return null;
      e = asignacion[1].trim();
    }
    let m;
    if ((m = /^[[(]([^\])]*)[\])]$/.exec(e))) { const v = numeros(m[1]); return v.length ? v : null; }
    if ((m = /arange\s*\(([^)]*)\)/.exec(e))) {
      const [a, b, c = 1] = numeros(m[1]);
      if (![a, b, c].every(Number.isFinite) || c === 0) return null;
      const v = [];
      for (let x = a; (c > 0 ? x < b - Math.abs(c) * 1e-9 : x > b + Math.abs(c) * 1e-9) && v.length < 1000; x += c) v.push(+x.toFixed(6));
      return v.length ? v : null;
    }
    if ((m = /linspace\s*\(([^)]*)\)/.exec(e))) {
      const [a, b, n] = numeros(m[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !(n >= 1)) return null;
      return Array.from({ length: Math.round(n) }, (_, k) => +(n > 1 ? a + ((b - a) * k) / (n - 1) : a).toFixed(6));
    }
    return null;
  }

  // Tipos de scan: átomos, opción de optking, símbolo, unidad y rango permitido
  const SCAN_TIPOS = {
    distancia: { natom: 2, clave: 'distance', frozen: 'frozen_distance', simbolo: 'R', unidad: 'Å', min: 0.5, max: 6, nombre: 'distancia' },
    angulo: { natom: 3, clave: 'bend', frozen: 'frozen_bend', simbolo: 'θ', unidad: '°', min: 20, max: 179, nombre: 'ángulo' },
    diedro: { natom: 4, clave: 'dihedral', frozen: 'frozen_dihedral', simbolo: 'φ', unidad: '°', min: -360, max: 360, nombre: 'diedro' },
  };

  // Distancia (Å), ángulo (°) o diedro (°, signo IUPAC) entre puntos [x, y, z]
  function medirPuntos(P) {
    const v = (p, q) => [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const nrm = (a) => Math.hypot(...a);
    if (P.length === 2) return nrm(v(P[0], P[1]));
    if (P.length === 3) {
      const a = v(P[1], P[0]); const b = v(P[1], P[2]);
      return (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (nrm(a) * nrm(b))))) * 180) / Math.PI;
    }
    const b0 = v(P[1], P[0]); const b1 = v(P[1], P[2]); const b2 = v(P[2], P[3]);
    const n1 = b1.map((x) => x / nrm(b1));
    const p = b0.map((x, k) => x - dot(b0, n1) * n1[k]);
    const w = b2.map((x, k) => x - dot(b2, n1) * n1[k]);
    const c = [n1[1] * p[2] - n1[2] * p[1], n1[2] * p[0] - n1[0] * p[2], n1[0] * p[1] - n1[1] * p[0]];
    return (Math.atan2(dot(c, w), dot(p, w)) * 180) / Math.PI;
  }

  function leerScan(textoResto, sinBloques, xyz, avisos) {
    const r = /(fixed|frozen|ranged)_(distance|bend|dihedral)['"]?\s*[:=]?\s*(?:\(\s*)?[fFrRbBuU]?["']([^"']*)["']/i.exec(textoResto);
    if (!r) return null;
    const modo = r[1].toLowerCase();
    const tipo = { distance: 'distancia', bend: 'angulo', dihedral: 'diedro' }[r[2].toLowerCase()];
    const c = SCAN_TIPOS[tipo];
    const fichas = r[3].trim().split(/[\s,]+/).filter(Boolean);
    const atomos = fichas.slice(0, c.natom).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : NaN));
    const filas = String(xyz).trim().split('\n').map((l) => l.trim().split(/\s+/));
    const nat = filas.length;
    if (atomos.length !== c.natom || atomos.some((a) => !Number.isInteger(a) || a < 1 || a > nat) || new Set(atomos).size !== c.natom) {
      throw new Error(`La restricción ${modo}_${r[2]} necesita ${c.natom} átomos distintos entre 1 y ${nat}: «${r[0]}»`);
    }
    const etq = atomos.map((a) => `${filas[a - 1][0]}${a}`).join('–');
    let valores = null;
    for (const m of sinBloques.matchAll(/^\s*for\s+(?:\w+\s*,\s*)?\w+\s+in\s+(.+?)\s*:\s*$/gm)) {
      const v = valoresDe(m[1], sinBloques);
      if (v) { valores = v; break; }
    }
    // Sin bucle (o con la lista «congeladas = […]» que genera esta aplicación): una sola optimización
    // con todas las coordenadas congeladas a la vez
    if (!valores || /^\s*congeladas\s*=\s*\[/m.test(sinBloques)) return leerCongeladas(textoResto, sinBloques, filas, avisos);
    if (valores.length > 40) {
      avisos.push(`El scan tenía ${valores.length} puntos: se usan los 40 primeros.`);
      valores = valores.slice(0, 40);
    }
    if (valores.some((v) => v < c.min || v > c.max)) throw new Error(`Los valores del scan de ${c.nombre} deben estar entre ${c.min} y ${c.max} ${c.unidad} (leídos: ${valores.join(', ')}).`);
    avisos.push(`Scan relajado de ${c.nombre} ${c.simbolo}(${etq}) en ${valores.length} punto(s), de ${valores[0]} a ${valores[valores.length - 1]} ${c.unidad}: en cada punto se fija el valor y se optimiza el resto. El .out incluirá la tabla «SCAN RELAJADO».`);
    if (modo === 'fixed') avisos.push(`«fixed_${r[2]}» no existe en Psi4 1.11 (optking 0.5): el servidor coloca cada valor y lo congela con «${c.frozen}», que da el mismo scan.`);
    avisos.push('El bucle y el resto del código Python del archivo (print_out, variables…) no se ejecutan tal cual: el servidor hace el scan equivalente y escribe la tabla en el .out.');
    return { tipo, atomos, valores };
  }

  const MAX_CONGELADAS = 10;
  const TIPO_POR_NATOM = { 2: 'distancia', 3: 'angulo', 4: 'diedro' };
  const claveCoordenada = (tipo, atomos) => {
    const ida = atomos.join('-'); const vuelta = [...atomos].reverse().join('-'); // 1–2 y 2–1 son la misma
    return `${tipo}:${ida < vuelta ? ida : vuelta}`;
  };

  // Coordenadas congeladas a la vez (una sola optimización): todas las fixed_/frozen_/ranged_ del
  // archivo, p. ej. fixed_distance "1 2 2.320  1 3 2.500  1 4 1.090". El valor sale de fixed_ (el
  // número tras los átomos), del centro de ranged_, de colocar(…)/congeladas = […] o, si no hay
  // ninguno, de la geometría.
  function leerCongeladas(textoResto, sinBloques, filas, avisos) {
    const nat = filas.length;
    // colocar(mol, [0, 1], 2.32) y congeladas = [([0, 1], 2.32), …] (átomos desde 0)
    const colocados = new Map();
    for (const m of sinBloques.matchAll(/\[\s*(\d+(?:\s*,\s*\d+){1,3})\s*\]\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)) {
      const atomos = numeros(m[1]).map((a) => a + 1);
      colocados.set(claveCoordenada(TIPO_POR_NATOM[atomos.length], atomos), Number(m[2]));
    }
    const lista = new Map();
    let conFixed = false;
    for (const m of textoResto.matchAll(/(fixed|frozen|ranged)_(distance|bend|dihedral)['"]?\s*[:=]?\s*(?:\(\s*)?[fFrRbBuU]?["']([^"']*)["']/gi)) {
      const modo = m[1].toLowerCase();
      const tipo = { distance: 'distancia', bend: 'angulo', dihedral: 'diedro' }[m[2].toLowerCase()];
      const c = SCAN_TIPOS[tipo];
      const n = numeros(m[3]);
      if (!n.length) continue; // p. ej. la línea que las libera: {'frozen_distance': ''}
      const extra = modo === 'fixed' ? 1 : modo === 'ranged' ? 2 : 0;
      const tam = c.natom + extra;
      if (n.length % tam) {
        throw new Error(`«${modo}_${m[2]}» necesita grupos de ${tam} números (${c.natom} átomos${extra === 1 ? ' y el valor' : extra === 2 ? ', mínimo y máximo' : ''}): «${m[3].trim()}»`);
      }
      for (let k = 0; k < n.length; k += tam) {
        const atomos = n.slice(k, k + c.natom);
        if (atomos.some((a) => !Number.isInteger(a) || a < 1 || a > nat) || new Set(atomos).size !== c.natom) {
          throw new Error(`«${modo}_${m[2]}»: cada ${c.nombre} necesita ${c.natom} átomos distintos entre 1 y ${nat} (leído: ${atomos.join(' ')}).`);
        }
        const clave = claveCoordenada(tipo, atomos);
        let valor = modo === 'fixed' ? n[k + c.natom] : modo === 'ranged' ? (n[k + c.natom] + n[k + c.natom + 1]) / 2 : colocados.get(clave);
        if (valor === undefined) valor = medirPuntos(atomos.map((a) => filas[a - 1].slice(1, 4).map(Number)));
        valor = +Number(valor).toFixed(4);
        if (valor < c.min || valor > c.max) throw new Error(`El valor de ${c.nombre} congelado ${atomos.join('–')} debe estar entre ${c.min} y ${c.max} ${c.unidad} (leído: ${valor}).`);
        if (modo === 'fixed') conFixed = true;
        lista.set(clave, { tipo, atomos, valor });
      }
    }
    const restricciones = [...lista.values()];
    if (!restricciones.length) return null;
    if (restricciones.length > MAX_CONGELADAS) throw new Error(`Hay ${restricciones.length} coordenadas congeladas: el máximo es ${MAX_CONGELADAS}.`);
    const texto = restricciones.map((r) => {
      const c = SCAN_TIPOS[r.tipo];
      return `${c.simbolo}(${r.atomos.map((a) => `${filas[a - 1][0]}${a}`).join('–')}) = ${r.valor} ${c.unidad}`;
    }).join(', ');
    avisos.push(`Optimización con ${restricciones.length > 1 ? `${restricciones.length} coordenadas congeladas a la vez` : 'una coordenada congelada'}: ${texto}. Se coloca cada valor (el último átomo se mueve con lo que cuelga de él), se congelan juntas y se optimiza el resto en una sola optimización.`);
    if (conFixed) avisos.push('«fixed_*» no existe en Psi4 1.11 (optking 0.5): el servidor coloca los valores y los congela con «frozen_*», que da el mismo resultado.');
    return { restricciones, congelar: true };
  }

  function leerXYZ(texto) {
    const l = String(texto).replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < l.length && !l[i].trim()) i++;
    const n = parseInt(l[i], 10);
    if (!Number.isInteger(n) || n < 1) throw new Error('El archivo .xyz debe empezar con el número de átomos.');
    const titulo = (l[i + 1] || '').trim();
    const atomos = l.slice(i + 2, i + 2 + n).map((x) => x.trim()).filter(Boolean);
    if (atomos.length !== n) throw new Error(`El .xyz anuncia ${n} átomos pero contiene ${atomos.length}.`);
    return { titulo, xyz: geometria(atomos.map((a) => a.split(/\s+/).slice(0, 4).join(' ')), {}, 1), avisos: [] };
  }

  const NOMBRE_BASE_PSI4 = { 'sto-3g': 'sto-3g', '3-21g': '3-21g', '6-31g': '6-31g', '6-31g*': '6-31g*', '6-31g**': '6-31g**', '6-31+g*': '6-31+g*', '6-311g**': '6-311g**', 'cc-pvdz': 'cc-pvdz', 'aug-cc-pvdz': 'aug-cc-pvdz', 'def2-svp': 'def2-svp', 'def2-tzvp': 'def2-tzvp' };

  // Código del scan relajado para Psi4 ≥ 1.7 (optking 0.5 ya no tiene fixed_*): en cada punto se
  // coloca el valor moviendo el fragmento del último átomo, se congela y se optimiza el resto.
  function datosCoordenada(xyz, scan) {
    const tipo = SCAN_TIPOS[scan?.tipo] ? scan.tipo : 'distancia';
    const c = SCAN_TIPOS[tipo];
    const atomos = (scan?.atomos || [1, 2, 3, 4]).slice(0, c.natom);
    const sim = String(xyz).trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]);
    const etq = atomos.map((a) => `${sim[a - 1] || ''}${a}`).join('–');
    return { tipo, c, atomos, etq, valores: scan?.valores || [] };
  }

  // Coordenadas congeladas del cálculo: { restricciones: [{ tipo, atomos, valor }] } o la forma
  // antigua de una sola coordenada { tipo, atomos, valores: [v] }
  function restriccionesDe(scan) {
    if (Array.isArray(scan?.restricciones) && scan.restricciones.length) return scan.restricciones;
    return [{ tipo: scan?.tipo, atomos: scan?.atomos, valor: scan?.valores?.[0] }];
  }

  // Una sola optimización con una o varias coordenadas congeladas a la vez (lo que en Psi4 antiguos
  // era fixed_distance "1 2 2.320  1 3 2.500"): se coloca cada valor, se congelan juntas y se optimiza
  function lineasCongelar(nombre, metodo, xyz, scan) {
    const sim = String(xyz).trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]);
    const lista = restriccionesDe(scan).map((r) => {
      const tipo = SCAN_TIPOS[r.tipo] ? r.tipo : 'distancia';
      const c = SCAN_TIPOS[tipo];
      const atomos = (r.atomos || []).slice(0, c.natom);
      return { tipo, c, atomos, etq: atomos.map((a) => `${sim[a - 1] || ''}${a}`).join('–'), v: Number(r.valor) };
    });
    const porOpcion = {};
    lista.forEach((r) => { (porOpcion[r.c.frozen] ||= []).push(r.atomos.join(' ')); });
    const opciones = Object.entries(porOpcion).map(([k, v]) => `'${k}': '${v.join('  ')}'`).join(', ');
    const fixed = lista.map((r) => `${r.atomos.join(' ')} ${r.v}`);
    const varias = lista.length > 1;
    return [
      `# Optimización con ${varias ? `${lista.length} coordenadas congeladas a la vez` : 'una coordenada congelada'}: ${lista.map((r) => `${r.c.simbolo}(${r.etq}) = ${r.v} ${r.c.unidad}`).join(', ')}.`,
      '# Se coloca cada valor (el último átomo se mueve con todo lo que cuelga de él), se congelan juntas',
      `# y se optimiza el resto en una sola optimización. En Psi4 < 1.7 equivalía a fixed_${lista[0].c.frozen.split('_')[1]} "${fixed.filter((_, k) => lista[k].tipo === lista[0].tipo).join('  ')}";`,
      '# optking 0.5 (Psi4 ≥ 1.7) ya no tiene fixed_*, por eso se colocan los valores y se usa frozen_*.',
      ...lineasColocar(),
      `congeladas = [${lista.map((r) => `([${r.atomos.map((a) => a - 1).join(', ')}], ${r.v.toFixed(4)})`).join(', ')}]  # (átomos desde 0, valor)`,
      '# Colocar un valor puede mover a otro: se repite unas pasadas',
      'pasada = 0',
      'while pasada < 30:',
      '    for atomos_c, valor_c in congeladas:',
      `        colocar(${nombre}, atomos_c, valor_c)`,
      '    pasada += 1',
      `psi4.set_options({${opciones}})`,
      `E, wfn = optimize('${metodo}', return_wfn=True)`,
      `psi4.set_options({${Object.keys(porOpcion).map((k) => `'${k}': ''`).join(', ')}})`,
      ...(scan?.frecuencias ? [
        '# Frecuencias en esta misma geometría (sin volver a optimizar, para no liberar las coordenadas):',
        '# una sola frecuencia imaginaria a lo largo de la reacción indica que se va por buen camino hacia el TS.',
        `E, wfn = frequency('${metodo}', return_wfn=True)`,
      ] : []),
      '',
      `x = ${nombre}.geometry().np * psi4.constants.bohr2angstroms`,
      `psi4.core.print_out("\\n\\n===== OPTIMIZACIÓN CON ${varias ? `${lista.length} COORDENADAS CONGELADAS` : `${lista[0].c.simbolo}(${lista[0].etq}) CONGELADA`} =====\\n")`,
      ...lista.map((r) => `psi4.core.print_out(f"${r.c.simbolo}(${r.etq}):  pedido ${r.v.toFixed(r.tipo === 'distancia' ? 3 : 2)}   final {medir(x, [${r.atomos.map((a) => a - 1).join(', ')}]):.${r.tipo === 'distancia' ? 3 : 2}f} ${r.c.unidad}\\n")`),
      'psi4.core.print_out(f"E = {E:.10f} Eh\\n")',
    ];
  }

  function lineasScan(nombre, metodo, xyz, scan) {
    const { tipo, c, atomos, etq, valores } = datosCoordenada(xyz, scan);
    const formato = tipo === 'distancia' ? '{v:6.3f} Å' : '{v:7.2f}°';
    return [
      `# Scan relajado de ${c.nombre} ${c.simbolo}(${etq}): en cada punto se fija el valor (${c.frozen})`,
      '# y se optimiza el resto, partiendo de la geometría del punto anterior.',
      '# Cada punto deja su función de onda en scan_001.molden, scan_002.molden… (IboView).',
      ...lineasColocar(),
      `psi4.set_options({'${c.frozen}': '${atomos.join(' ')}'})`,
      'resultados, geometrias = [], []',
      `for n, v in enumerate([${valores.map((v) => v.toFixed(4)).join(', ')}], 1):`,
      `    colocar(${nombre}, [${atomos.map((a) => a - 1).join(', ')}], v)`,
      `    e, wfn_v = optimize('${metodo}', return_wfn=True)`,
      "    molden(wfn_v, f'scan_{n:03d}.molden')",
      '    resultados.append((v, e))',
      `    geometrias.append(${nombre}.geometry().clone())`,
      `psi4.set_options({'${c.frozen}': ''})`,
      '',
      `psi4.core.print_out("\\n\\n===== SCAN RELAJADO ${c.simbolo}(${etq}) =====\\n")`,
      'e_ref = resultados[0][1]',
      'for v, e in resultados:',
      `    psi4.core.print_out(f"${c.simbolo}(${etq}) = ${formato}   E = {e:.10f} Eh   ΔE = {(e - e_ref) * psi4.constants.hartree2kcalmol:8.3f} kcal/mol\\n")`,
      '',
      '# Función de onda en el punto de menor energía',
      'imin = min(range(len(resultados)), key=lambda k: resultados[k][1])',
      `${nombre}.set_geometry(geometrias[imin])`,
      `${nombre}.update_geometry()`,
      `E, wfn = energy('${metodo}', return_wfn=True)`,
    ];
  }

  // colocar(): pone la distancia, el ángulo o el diedro en un valor moviendo el último átomo
  // con todo lo que cuelga de él (lo mismo que hace el servidor)
  function lineasColocar() {
    return [
      'import numpy as np',
      "RADIOS = {'H': 0.31, 'C': 0.76, 'N': 0.71, 'O': 0.66, 'F': 0.57, 'P': 1.07, 'S': 1.05, 'Cl': 1.02, 'Br': 1.20, 'I': 1.39}",
      '',
      'def vecinos(x, s):',
      '    """Vecinos enlazados de cada átomo (distancia < 1.2 × suma de radios covalentes)."""',
      '    r = [RADIOS.get(e, 1.5) for e in s]',
      '    return [[b for b in range(len(s)) if b != a and np.linalg.norm(x[a] - x[b]) < 1.2 * (r[a] + r[b])] for a in range(len(s))]',
      '',
      'def grupo(vec, movil, fijos):',
      '    """«movil» y todo lo que cuelga de él: los trozos que quedan al quitarlo y no contienen átomos fijos."""',
      '    g, vistos = {movil}, {movil}',
      '    for v in vec[movil]:',
      '        if v in vistos:',
      '            continue',
      '        trozo, pila = {v}, [v]',
      '        while pila:',
      '            a = pila.pop()',
      '            for b in vec[a]:',
      '                if b != movil and b not in trozo:',
      '                    trozo.add(b)',
      '                    pila.append(b)',
      '        vistos |= trozo',
      '        if not trozo & set(fijos):',
      '            g |= trozo',
      '    return g',
      '',
      'def rotar(p, o, eje, ang):',
      '    k = eje / np.linalg.norm(eje)',
      '    p = p - o',
      '    return o + p * np.cos(ang) + np.cross(k, p) * np.sin(ang) + np.outer(p @ k, k) * (1 - np.cos(ang))',
      '',
      'def medir(x, idx):',
      '    """Distancia (Å), ángulo (°) o diedro (°) según el número de átomos (índices desde 0)."""',
      '    if len(idx) == 2:',
      '        return np.linalg.norm(x[idx[1]] - x[idx[0]])',
      '    if len(idx) == 3:',
      '        a, b = x[idx[0]] - x[idx[1]], x[idx[2]] - x[idx[1]]',
      '        return np.degrees(np.arccos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1)))',
      '    b0, b1, b2 = x[idx[0]] - x[idx[1]], x[idx[2]] - x[idx[1]], x[idx[3]] - x[idx[2]]',
      '    n1 = b1 / np.linalg.norm(b1)',
      '    v, w = b0 - (b0 @ n1) * n1, b2 - (b2 @ n1) * n1',
      '    return np.degrees(np.arctan2(np.cross(n1, v) @ w, v @ w))',
      '',
      'def colocar(mol, idx, valor):',
      '    """Pone la coordenada en «valor» moviendo el último átomo con todo lo que cuelga de él."""',
      '    x = mol.geometry().np * psi4.constants.bohr2angstroms',
      '    s = [mol.symbol(k).capitalize() for k in range(mol.natom())]',
      '    vec = vecinos(x, s)',
      '    if len(idx) == 2:',
      '        i, j = idx',
      '        frag = grupo(vec, j, {i})',
      '        v = x[j] - x[i]',
      '        d = np.linalg.norm(v)',
      '        for k in frag:',
      '            x[k] += (valor - d) * v / d',
      '    elif len(idx) == 3:',
      '        i, j, k = idx',
      '        f = sorted(grupo(vec, k, {i, j}))',
      '        x[f] = rotar(x[f], x[j], np.cross(x[i] - x[j], x[k] - x[j]), np.radians(valor - medir(x, idx)))',
      '    else:',
      '        i, j, k, l = idx',
      '        frag = grupo(vec, k, {i, j}) - {k}',
      '        if l not in frag:',
      '            frag = grupo(vec, l, {i, j, k})',
      '        f = sorted(frag)',
      '        x[f] = rotar(x[f], x[k], x[k] - x[j], np.radians(valor - medir(x, idx)))',
      '    mol.set_geometry(psi4.core.Matrix.from_array(x / psi4.constants.bohr2angstroms))',
      '    mol.update_geometry()',
      '',
    ];
  }

  function generarEntradaPsi4({ titulo = 'molecula', xyz, carga = 0, multiplicidad = 1, metodo, base, tarea, memoria = '2 GB', mep = false, fecha = new Date(), irc = null, scan = null, pcm = null }) {
    const nombre = String(titulo).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'molecula';
    const ref = Number(multiplicidad) === 1 ? 'rhf' : 'uhf';
    const llamadas = {
      energia: [`E, wfn = energy('${metodo}', return_wfn=True)`],
      optimizacion: [`E, wfn = optimize('${metodo}', return_wfn=True)`],
      frecuencias: [`optimize('${metodo}')`, `E, wfn = frequency('${metodo}', return_wfn=True)`],
      ts: ['# Búsqueda del estado de transición; las frecuencias deben dar una sola imaginaria',
        `optimize('${metodo}')`, `E, wfn = frequency('${metodo}', return_wfn=True)`],
      // optking recorre una dirección por optimize(): se vuelve al TS entre recorridos
      irc: [
        '# Camino de reacción IRC desde el TS (cada optimize() recorre una dirección)',
        `geom_ts = ${nombre}.geometry().clone()`,
        ...((irc?.direccion || 'ambas') === 'ambas' ? ['backward', 'forward'] : [irc.direccion]).flatMap((d) => [
          `set irc_direction ${d}`,
          `optimize('${metodo}')`,
          `${nombre}.set_geometry(geom_ts)`,
          `${nombre}.update_geometry()`,
        ]),
        '# Función de onda en el TS',
        `E, wfn = energy('${metodo}', return_wfn=True)`,
      ],
      scan: tarea === 'scan' ? lineasScan(nombre, metodo, xyz, scan) : [],
      congelar: tarea === 'congelar' ? lineasCongelar(nombre, metodo, xyz, scan) : [],
    }[tarea];
    const lineasXYZ = String(xyz).trim().split(/\r?\n/).map((l) => {
      const [el, x, y, z] = l.trim().split(/\s+/);
      return `  ${el.padEnd(2)} ${(+x).toFixed(8).padStart(14)} ${(+y).toFixed(8).padStart(14)} ${(+z).toFixed(8).padStart(14)}`;
    });
    const f = fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha);
    const solv = pcm ? buscarSolvente(pcm.solvente) : null;
    const modeloPcm = solv && MODELOS_PCM.includes(pcm.modelo) ? pcm.modelo : 'IEFPCM';
    return [
      `# Entrada de Psi4 generada por «Química Cuántica con Psi4» (UNACHI) — ${f}`,
      `# ${titulo} · ${metodo.toUpperCase()}/${base} · ${NOMBRE_TAREA[tarea] || tarea}${tarea === 'congelar' && scan?.frecuencias ? ' + frecuencias' : ''}${solv ? ` · en ${solv.nombre} (PCM)` : ' · fase gaseosa'}`,
      '# Ejecutar con:  psi4 archivo.in archivo.out',
      '',
      `memory ${memoria}`,
      '',
      `molecule ${nombre} {`,
      `  ${carga} ${multiplicidad}`,
      ...lineasXYZ,
      '  units angstrom',
      '  symmetry c1',
      '  no_reorient',
      '  no_com',
      '}',
      '',
      'set {',
      `  basis ${NOMBRE_BASE_PSI4[base] || base}`,
      `  reference ${ref}`,
      '  scf_type df',
      ...(tarea === 'ts' ? ['  opt_type ts', '  full_hess_every 0'] : []),
      ...(tarea === 'irc' ? ['  opt_type irc', `  irc_points ${irc?.puntos ?? 20}`, `  irc_step_size ${irc?.paso ?? 0.2}`, '  write_opt_history true'] : []),
      ...(solv ? ['  pcm true', '  pcm_scf_type total'] : []),
      '}',
      '',
      ...(solv ? [
        `# Solvatación PCM (PCMSolver): ${solv.nombre}, ε = ${solv.epsilon}. Psi4 no tiene gradientes analíticos`,
        '# con PCM: las optimizaciones y frecuencias usan diferencias finitas de energías (más lentas).',
        'pcm = {',
        '  Units = Angstrom',
        '  Medium {',
        `    SolverType = ${modeloPcm}`,
        `    Solvent = ${solv.pcm}`,
        '  }',
        '  Cavity {',
        '    RadiiSet = UFF',
        '    Type = GePol',
        '    Scaling = False',
        '    Area = 0.3',
        '    Mode = Implicit',
        '  }',
        '}',
        '',
      ] : []),
      ...llamadas,
      '',
      "oeprop(wfn, 'DIPOLE', 'MULLIKEN_CHARGES', title='SCF')",
      '', '# Función de onda en formato Molden para IboView (que construye los orbitales intrínsecos de enlace, IBO)',
      "molden(wfn, 'orbitales.molden')",
      ...(tarea === 'irc' ? ['# El servidor escribe además un .molden por punto del IRC (irc_001.molden…) para animarlo en IboView'] : []),
      ...(mep ? ['', "# Superficies para visualizar (HOMO, LUMO, densidad y potencial electrostático)", "set cubeprop_tasks ['orbitals', 'esp']", 'cubeprop(wfn)'] : []),
      '',
    ].join('\n');
  }

  const api = { leerEntradaPsi4, leerXYZ, generarEntradaPsi4, SOLVENTES, MODELOS_PCM, buscarSolvente };
  Object.assign(global, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
