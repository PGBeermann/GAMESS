/* Asignación aproximada de modos normales de vibración (UNACHI · Psi4)
 *
 * Para cada modo se mide cuánto cambia cada coordenada interna cuando los átomos
 * se desplazan según el vector del modo (derivada numérica):
 *   ν  estiramiento de enlace          δ  flexión / deformación de ángulo
 *   ρ  balanceo (rocking) de CH₂/CH₃   γ  flexión fuera del plano
 *   τ  torsión alrededor de un enlace
 * El peso de cada coordenada es k·(Δq)², con constantes de fuerza típicas: una
 * «distribución de energía potencial» (PED) aproximada. Es orientativa, para la
 * enseñanza; no reemplaza un análisis PED riguroso.
 */
(function (global) {
  'use strict';

  const RCOV = { H: 0.31, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Br: 1.20, I: 1.39 };
  const radio = (el) => RCOV[el] || 1.2;
  const SUB = { 2: '₂', 3: '₃', 4: '₄' };

  const resta = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const punto = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cruz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norma = (a) => Math.hypot(a[0], a[1], a[2]);

  const distancia = (P, i, j) => norma(resta(P[i], P[j]));
  function angulo(P, i, j, k) {
    const a = resta(P[i], P[j]); const b = resta(P[k], P[j]);
    return Math.acos(Math.max(-1, Math.min(1, punto(a, b) / (norma(a) * norma(b)))));
  }
  function diedro(P, i, j, k, l) {
    const b1 = resta(P[j], P[i]); const b2 = resta(P[k], P[j]); const b3 = resta(P[l], P[k]);
    const n1 = cruz(b1, b2); const n2 = cruz(b2, b3);
    const m = cruz(n1, b2.map((v) => v / norma(b2)));
    return Math.atan2(punto(m, n2), punto(n1, n2));
  }
  // Ángulo entre el enlace j–i y el plano formado por j y sus otros dos vecinos k, l
  function fueraPlano(P, i, j, k, l) {
    const n = cruz(resta(P[k], P[j]), resta(P[l], P[j]));
    const u = resta(P[i], P[j]);
    return Math.asin(Math.max(-1, Math.min(1, punto(n, u) / (norma(n) * norma(u)))));
  }
  const anguloDif = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

  function ordenEnlace(a, b, d) {
    const par = [a, b].sort().join('');
    if (par === 'CC') return d < 1.25 ? 3 : d < 1.37 ? 2 : d < 1.44 ? 1.5 : 1;
    if (par === 'CN') return d < 1.20 ? 3 : d < 1.31 ? 2 : 1;
    if (par === 'CO') return d < 1.28 ? 2 : 1;
    if (par === 'NN') return d < 1.15 ? 3 : d < 1.30 ? 2 : 1;
    if (par === 'NO') return d < 1.25 ? 2 : 1;
    if (par === 'CS') return d < 1.70 ? 2 : 1;
    if (par === 'OS' || par === 'OP') return d < 1.52 ? 2 : 1;
    return 1;
  }
  const SIMBOLO = { 1: '–', 1.5: '⋯', 2: '=', 3: '≡' };
  const K_TENSION = { 1: 4.5, 1.5: 7, 2: 10, 3: 16 };

  // «C–H», «O–H», «C=O»: el átomo pesado primero y el H al final
  function nombreEnlace(A, B, orden) {
    const [x, y] = (A === 'H' || (B !== 'H' && A > B)) ? [B, A] : [A, B];
    return `${x}${SIMBOLO[orden] || '–'}${y}`;
  }

  function coordenadasInternas(el, P) {
    const n = el.length;
    const vecinos = Array.from({ length: n }, () => []);
    const enlaces = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = distancia(P, i, j);
        if (d < 1.25 * (radio(el[i]) + radio(el[j]))) {
          enlaces.push({ i, j, orden: ordenEnlace(el[i], el[j], d) });
          vecinos[i].push(j); vecinos[j].push(i);
        }
      }
    }
    const pesados = el.filter((e) => e !== 'H').length;
    const nH = vecinos.map((v) => v.filter((x) => el[x] === 'H').length);
    // Grupo «CH₃», «CH₂», «NH₂»… si el átomo tiene 2 o más H y no es la molécula entera
    const grupo = (j) => (el[j] !== 'H' && nH[j] >= 2 && pesados > 1 ? `${el[j]}H${SUB[nH[j]] || nH[j]}` : '');

    const coords = [];
    for (const e of enlaces) {
      const conH = el[e.i] === 'H' || el[e.j] === 'H';
      const pesado = el[e.i] === 'H' ? e.j : e.i;
      coords.push({
        tipo: 'nu', atomos: [e.i, e.j], k: conH ? 5.0 : K_TENSION[e.orden],
        clave: nombreEnlace(el[e.i], el[e.j], e.orden), grupo: conH ? grupo(pesado) : '',
        valor: (Q) => distancia(Q, e.i, e.j),
      });
    }
    for (let j = 0; j < n; j++) {
      const v = vecinos[j];
      for (let a = 0; a < v.length; a++) {
        for (let b = a + 1; b < v.length; b++) {
          const [i, k] = [v[a], v[b]];
          const ext = [el[i], el[k]].sort((x, y) => (x === 'H') - (y === 'H') || x.localeCompare(y));
          const clave = `${ext[0]}–${el[j]}–${ext[1]}`;
          const hs = (el[i] === 'H') + (el[k] === 'H');
          const g = hs ? grupo(j) : '';
          const tipo = g ? (hs === 2 ? 'delta' : 'rho') : 'delta';
          if (angulo(P, i, j, k) > 3.0) {
            // Ángulo casi lineal (CO2, C≡C–H…): se mide el desplazamiento perpendicular
            coords.push({ tipo, atomos: [i, j, k], k: 0.6, clave, grupo: g, lineal: true });
          } else {
            coords.push({ tipo, atomos: [i, j, k], k: hs ? 0.5 : 0.8, clave, grupo: g, valor: (Q) => angulo(Q, i, j, k) });
          }
        }
      }
      // Fuera del plano: una sola coordenada por átomo trigonal, la del sustituyente terminal (H primero)
      if (v.length === 3) {
        const terminales = v.filter((x) => vecinos[x].length === 1).sort((x, y) => (el[y] === 'H') - (el[x] === 'H'));
        if (terminales.length) {
          const i = terminales[0];
          const [k, l] = v.filter((x) => x !== i);
          const e = enlaces.find((b) => (b.i === i && b.j === j) || (b.i === j && b.j === i));
          coords.push({
            tipo: 'gamma', atomos: [i, j, k, l], k: 0.35, grupo: '',
            clave: nombreEnlace(el[j], el[i], e ? e.orden : 1), valor: (Q) => fueraPlano(Q, i, j, k, l),
          });
        }
      }
    }
    for (const e of enlaces) {
      const [j, k] = [e.i, e.j];
      const lados = [];
      for (const i of vecinos[j]) {
        if (i === k || angulo(P, i, j, k) > 2.97) continue;
        for (const l of vecinos[k]) {
          if (l === j || l === i || angulo(P, j, k, l) > 2.97) continue;
          lados.push([i, j, k, l]);
        }
      }
      if (lados.length) {
        coords.push({ tipo: 'tau', atomos: [j, k], k: 0.1, grupo: '', diedros: lados, clave: nombreEnlace(el[j], el[k], e.orden) });
      }
    }
    // Átomos en anillo: dos vecinos de j siguen conectados sin pasar por j
    coords.anillo = new Set();
    for (let j = 0; j < n; j++) {
      const v = vecinos[j];
      if (v.length < 2) continue;
      const visto = new Set([j, v[0]]); const cola = [v[0]];
      while (cola.length) { const a = cola.shift(); for (const b of vecinos[a]) if (!visto.has(b)) { visto.add(b); cola.push(b); } }
      if (v.slice(1).some((x) => visto.has(x))) coords.anillo.add(j);
    }
    return coords;
  }

  function variacion(c, P, D) {
    const eps = 0.005;
    const mas = P.map((p, a) => [p[0] + eps * D[a][0], p[1] + eps * D[a][1], p[2] + eps * D[a][2]]);
    const menos = P.map((p, a) => [p[0] - eps * D[a][0], p[1] - eps * D[a][1], p[2] - eps * D[a][2]]);
    if (c.tipo === 'tau') {
      let mejor = 0; // la mayor variación entre los diedros de ese enlace
      for (const [i, j, k, l] of c.diedros) {
        const d = anguloDif(diedro(mas, i, j, k, l), diedro(menos, i, j, k, l)) / (2 * eps);
        if (Math.abs(d) > Math.abs(mejor)) mejor = d;
      }
      return mejor;
    }
    if (c.lineal) {
      const [i, j, k] = c.atomos;
      const eje = resta(P[k], P[i]); const u = eje.map((x) => x / norma(eje));
      const rel = resta(D[j], D[i].map((x, t) => (x + D[k][t]) / 2));
      const perp = resta(rel, u.map((x) => x * punto(rel, u)));
      return norma(perp) / (0.5 * norma(eje));
    }
    return (c.valor(mas) - c.valor(menos)) / (2 * eps);
  }

  const SIMB = { nu: 'ν', delta: 'δ', rho: 'ρ', gamma: 'γ', tau: 'τ' };
  const NOMBRE = { nu: 'estiramiento', delta: 'flexión', rho: 'balanceo', gamma: 'flexión fuera del plano', tau: 'torsión' };
  const SUBIND = { s: 'ₛ', as: 'ₐₛ' };

  // ¿Las coordenadas de un mismo grupo se mueven en fase (simétrico) o en contrafase (asimétrico)?
  function simetria(g, anillo) {
    if (g.tipo !== 'nu' && g.tipo !== 'delta') return '';
    const maxAbs = Math.max(...g.miembros.map((m) => Math.abs(m.dq)));
    const activos = g.miembros.filter((m) => Math.abs(m.dq) > 0.3 * maxAbs && !m.c.lineal);
    if (activos.length < 2) return '';
    // Átomo compartido con más peso (C de un CH₃, O del agua, C del CO₂…)
    const peso = new Map();
    for (const m of activos) for (const a of m.c.atomos) peso.set(a, (peso.get(a) || 0) + m.peso);
    let centro = null; let mejor = -1;
    for (const [a, p] of peso) {
      const veces = activos.filter((m) => m.c.atomos.includes(a)).length;
      if (veces >= 2 && p > mejor) { mejor = p; centro = a; }
    }
    if (centro === null || anillo.has(centro)) return ''; // en anillos no aporta
    const signos = new Set(activos.filter((m) => m.c.atomos.includes(centro)).map((m) => Math.sign(m.dq)));
    return signos.size === 1 ? 's' : 'as';
  }

  function textoLargo(g) {
    const fem = g.tipo === 'delta' || g.tipo === 'gamma' || g.tipo === 'tau';
    const adj = g.modo ? (g.modo === 's' ? (fem ? ' simétrica' : ' simétrico') : (fem ? ' asimétrica' : ' asimétrico')) : '';
    let base;
    if (g.grupo && g.tipo === 'nu') base = `estiramiento${adj} ${g.clave} del ${g.grupo}`;
    else if (g.grupo && g.tipo === 'delta') base = `deformación${adj} del ${g.grupo}`;
    else if (g.grupo && g.tipo === 'rho') base = `balanceo del ${g.grupo}`;
    else base = `${NOMBRE[g.tipo]}${adj} ${g.clave}`;
    return `${base} (${Math.round(100 * g.fraccion)} %)`;
  }

  function asignarModo(coords, P, D) {
    const datos = coords.map((c) => { const dq = variacion(c, P, D); return { c, dq, peso: c.k * dq * dq }; });
    const total = datos.reduce((s, x) => s + x.peso, 0) || 1;
    const grupos = new Map();
    for (const x of datos) {
      const id = `${x.c.tipo}|${x.c.grupo || x.c.clave}`;
      if (!grupos.has(id)) grupos.set(id, { tipo: x.c.tipo, clave: x.c.clave, grupo: x.c.grupo, peso: 0, miembros: [] });
      const g = grupos.get(id);
      g.peso += x.peso;
      g.miembros.push(x);
    }
    const lista = [...grupos.values()].map((g) => ({ ...g, fraccion: g.peso / total })).sort((a, b) => b.fraccion - a.fraccion);
    const elegidos = lista.filter((g, idx) => idx === 0 || g.fraccion >= 0.15).slice(0, 3);
    for (const g of elegidos) g.modo = simetria(g, coords.anillo || new Set());
    const corta = elegidos.map((g) => `${SIMB[g.tipo]}${SUBIND[g.modo] || ''}(${g.grupo || g.clave})`).join(' + ');
    const larga = elegidos.map(textoLargo).join(' + ');
    return {
      corta,
      larga: larga.charAt(0).toUpperCase() + larga.slice(1),
      contribuciones: elegidos.map((g) => ({ tipo: g.tipo, clave: g.clave, grupo: g.grupo, modo: g.modo, fraccion: g.fraccion })),
    };
  }

  /**
   * @param {string} xyz  líneas "El x y z" (Å)
   * @param {Array} modos [{numero, desplazamientos: [[dx,dy,dz],...]}]
   * @returns {Map<number, {corta, larga, contribuciones}>}
   */
  function asignarModos(xyz, modos) {
    const lineas = String(xyz).trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/));
    const el = lineas.map((l) => l[0]);
    const P = lineas.map((l) => [+l[1], +l[2], +l[3]]);
    const coords = coordenadasInternas(el, P);
    const res = new Map();
    for (const m of modos || []) {
      if (!m.desplazamientos || m.desplazamientos.length !== el.length) continue;
      try { res.set(m.numero, asignarModo(coords, P, m.desplazamientos)); } catch { /* sin asignación */ }
    }
    return res;
  }

  global.asignarModos = asignarModos;
  if (typeof module !== 'undefined') module.exports = { asignarModos };
})(typeof window !== 'undefined' ? window : globalThis);
