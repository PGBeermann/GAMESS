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
  const INOFENSIVAS = /^(scf_type|cubeprop_\w+|cubic_grid_\w+|print|maxiter|geom_maxiter|e_convergence|d_convergence|g_convergence|guess|puream|freeze_core|mp2_type|ints_tolerance|dft_\w+|num_threads|full_hess_every|step_type|hess_update)$/;
  const NOMBRE_TAREA = { energia: 'energía (punto simple)', optimizacion: 'optimización de geometría', frecuencias: 'optimización + frecuencias', ts: 'estado de transición (TS) + frecuencias' };
  const ELEMENTOS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr I').split(' '));

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
    const resto = sinComentarios.slice(0, mol.index) + sinComentarios.slice(mol.index + mol[0].length);
    const lineas = resto.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

    // Opciones: «set basis X», «set globals basis X» y bloques «set { … }»
    let base = null; let esTS = false; const ignoradas = [];
    const opcion = (clave, valor) => {
      const k = clave.toLowerCase();
      if (k === 'basis') base = valor;
      else if (k === 'opt_type') {
        const v = valor.trim().toLowerCase();
        if (v === 'ts') esTS = true;
        else if (v === 'irc') throw new Error('Los cálculos IRC («opt_type irc») no están disponibles en este servidor.');
      } else if (k === 'reference') { if (/rohf|cuhf/i.test(valor)) avisos.push(`reference ${valor}: se usa RHF/UHF según la multiplicidad.`); } else if (!INOFENSIVAS.test(k)) ignoradas.push(`${clave} ${valor}`);
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
    let tarea = hayFreq ? 'frecuencias' : hayOpt ? 'optimizacion' : 'energia';
    if (esTS) {
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
    if (!base) { base = '6-31g*'; avisos.push('El archivo no indicaba la base: se usa 6-31G(d).'); }
    const baseId = normalizarBase(base);
    if (ignoradas.length) avisos.push(`Opciones ignoradas: ${ignoradas.slice(0, 6).join('; ')}${ignoradas.length > 6 ? '…' : ''}`);
    return {
      titulo, xyz, carga: carga ?? 0, multiplicidad: mult ?? 1, metodo, base: baseId, tarea, avisos,
      mep: /\bcubeprop\s*\(/i.test(sinBloques),
    };
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

  function generarEntradaPsi4({ titulo = 'molecula', xyz, carga = 0, multiplicidad = 1, metodo, base, tarea, memoria = '2 GB', mep = false, fecha = new Date() }) {
    const nombre = String(titulo).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'molecula';
    const ref = Number(multiplicidad) === 1 ? 'rhf' : 'uhf';
    const llamadas = {
      energia: [`E, wfn = energy('${metodo}', return_wfn=True)`],
      optimizacion: [`E, wfn = optimize('${metodo}', return_wfn=True)`],
      frecuencias: [`optimize('${metodo}')`, `E, wfn = frequency('${metodo}', return_wfn=True)`],
      ts: ['# Búsqueda del estado de transición; las frecuencias deben dar una sola imaginaria',
        `optimize('${metodo}')`, `E, wfn = frequency('${metodo}', return_wfn=True)`],
    }[tarea];
    const lineasXYZ = String(xyz).trim().split(/\r?\n/).map((l) => {
      const [el, x, y, z] = l.trim().split(/\s+/);
      return `  ${el.padEnd(2)} ${(+x).toFixed(8).padStart(14)} ${(+y).toFixed(8).padStart(14)} ${(+z).toFixed(8).padStart(14)}`;
    });
    const f = fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha);
    return [
      `# Entrada de Psi4 generada por «Química Cuántica con Psi4» (UNACHI) — ${f}`,
      `# ${titulo} · ${metodo.toUpperCase()}/${base} · ${NOMBRE_TAREA[tarea] || tarea}`,
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
      '}',
      '',
      ...llamadas,
      '',
      "oeprop(wfn, 'DIPOLE', 'MULLIKEN_CHARGES', title='SCF')",
      ...(mep ? ['', "# Superficies para visualizar (HOMO, LUMO, densidad y potencial electrostático)", "set cubeprop_tasks ['orbitals', 'esp']", 'cubeprop(wfn)'] : []),
      '',
    ].join('\n');
  }

  const api = { leerEntradaPsi4, leerXYZ, generarEntradaPsi4 };
  Object.assign(global, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
