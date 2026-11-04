/* Interfaz: JSME (dibujo 2D) + 3Dmol.js (visor 3D) + API Psi4 del servidor */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fx = (v, d = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const HARTREE_KCAL = 627.5094740631;
const HARTREE_EV = 27.211386245988;
const LS_CLAVE = 'psi4_clave';
const LS_HIST = 'psi4_historial';

const EJEMPLOS = [
  ['Agua', 'O'], ['Metano', 'C'], ['Amoníaco', 'N'], ['Formaldehído', 'C=O'], ['Etileno', 'C=C'],
  ['Acetileno', 'C#C'], ['Metanol', 'CO'], ['Etanol', 'CCO'], ['Acetona', 'CC(C)=O'],
  ['Ácido acético', 'CC(=O)O'], ['Ion acetato', 'CC(=O)[O-]'], ['Acetonitrilo', 'CC#N'],
  ['Urea', 'NC(N)=O'], ['Glicina', 'NCC(=O)O'], ['Benceno', 'c1ccccc1'], ['Fenol', 'Oc1ccccc1'],
  ['Piridina', 'c1ccncc1'], ['Anilina', 'Nc1ccccc1'], ['Butadieno', 'C=CC=C'], ['Radical metilo', '[CH3]'],
];

const estado = {
  opciones: null, geom: null, modificada: true, jsme: null, visor: null,
  trabajo: null, resultado: null, token: 0, reloj: null, inicio: null,
  modelo: null, cubos: new Map(), reproductor: null, girando: false, modoActivo: null, flechas: [],
  medir: false, seleccion: [], medidaFormas: [], // medidas en el visor 3D
  vivo: null, vivoAnim: 0, molblocks: new Map(), // geometría en vivo durante la optimización
};

// ---------- Utilidades ----------
function leerLS(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function escribirLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } }

async function api(ruta, opciones = {}) {
  const headers = { ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) };
  const clave = leerLS(LS_CLAVE, '');
  if (clave) headers['x-clave-acceso'] = clave;
  const r = await fetch(ruta, { ...opciones, headers });
  const tipo = r.headers.get('content-type') || '';
  const datos = tipo.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    let mensaje = (datos && datos.error) || `Error ${r.status}`;
    if (r.status === 401) {
      $('#panelClave').hidden = false;
      mensaje = clave
        ? 'La clave de acceso no es correcta. Escríbala de nuevo en el recuadro de arriba.'
        : 'Escriba arriba la clave de acceso del curso para empezar.';
    }
    const e = new Error(mensaje);
    e.status = r.status;
    throw e;
  }
  return datos;
}

// Descarga un archivo binario del servidor (p. ej. el .zip para IboView) con la clave de acceso
async function descargarBinario(ruta, nombre) {
  const clave = leerLS(LS_CLAVE, '');
  const r = await fetch(ruta, { headers: clave ? { 'x-clave-acceso': clave } : {} });
  if (!r.ok) throw new Error(r.status === 404 ? 'El archivo no está disponible (¿se calculó con la opción de IboView?).' : `Error ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function descargar(contenido, nombre, tipo = 'text/plain') {
  const url = contenido.startsWith?.('data:') ? contenido : URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  if (!url.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const nombreDe = (lista, id) => (estado.opciones?.[lista].find((x) => x.id === id) || {}).nombre || id;
const varCSS = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- Opciones del servidor ----------
async function cargarOpciones() {
  const sel = (id, lista, def) => {
    $(id).innerHTML = lista.map((o) => `<option value="${esc(o.id)}">${esc(o.nombre)}${o.tipo ? ` — ${esc(o.tipo)}` : ''}</option>`).join('');
    $(id).value = def;
  };
  try {
    const o = await api('/api/opciones');
    estado.opciones = o;
    sel('#metodo', o.metodos, 'b3lyp');
    sel('#base', o.bases, '6-31g*');
    sel('#tarea', o.tareas.filter((t) => t.id !== 'scan' && t.id !== 'congelar'), 'optimizacion'); // el scan y la coordenada congelada se eligen con sus casillas
    const es = $('#estadoServidor');
    es.textContent = o.psi4 ? `Psi4 ${o.psi4} · ${o.hilos} hilos` : 'Servidor activo (Psi4 cargando…)';
    es.className = 'estado-servidor ok';
    $('#versionPsi4').textContent = o.psi4 ? ` · Psi4 ${o.psi4}` : '';
    if (o.requiere_clave && !leerLS(LS_CLAVE, '')) $('#panelClave').hidden = false;
    if (!o.psi4) setTimeout(cargarOpciones, 8000);
    pintarHistorial();
    actualizarEstimacion();
    sincronizarCodigo(); // si la geometría ya estaba lista, se genera el código con las opciones cargadas
  } catch (e) {
    $('#estadoServidor').textContent = 'Sin conexión con el servidor';
    $('#estadoServidor').className = 'estado-servidor mal';
    setTimeout(cargarOpciones, 5000);
  }
}

function actualizarEstimacion() {
  const n = estado.geom?.natomos;
  const pesados = estado.geom ? estado.geom.xyz.split('\n').filter((l) => !/^H\s/.test(l)).length : null;
  const base = $('#base').value; const metodo = $('#metodo').value; const tarea = tareaEfectiva();
  const fb = { 'sto-3g': 0.3, '3-21g': 0.5, '6-31g': 0.7, '6-31g*': 1, '6-31g**': 1.3, '6-31+g*': 1.6, '6-311g**': 2, 'cc-pvdz': 1.3, 'aug-cc-pvdz': 4, 'def2-svp': 1.2, 'def2-tzvp': 5 }[base] || 1;
  const fm = { hf: 0.6, mp2: 3 }[metodo] || 1;
  // Hessiano analítico para HF; para DFT/MP2 Psi4 usa diferencias finitas de gradientes (~2 por coordenada)
  // El TS calcula dos hessianos (al inicio y al final) y suele necesitar más pasos
  // El IRC calcula un hessiano por dirección y ~4 gradientes por punto
  const dirs = $('#ircDireccion').value === 'ambas' ? 2 : 1;
  const puntosIrc = parseInt($('#ircPuntos').value, 10) || 20;
  const ft = {
    energia: 1, optimizacion: 10, frecuencias: metodo === 'hf' ? 15 : 10 + 3 * (n || 1), ts: metodo === 'hf' ? 30 : 15 + 6 * (n || 1),
    irc: dirs * ((metodo === 'hf' ? 5 : 3 * (n || 1)) + 4 * puntosIrc),
    scan: 6 * (opcionesScanForm(true).valores.length || 1), // una optimización corta por punto
    congelar: 10,
  }[tarea] || 1;
  actualizarInfoScan();
  if (!pesados) { $('#estimacion').textContent = ''; return; }
  const seg = 0.04 * Math.pow(Math.max(pesados, 1), 3) * fb * fm * ft; // segundos aproximados con 4 hilos
  const nivel = seg < 40 ? 'rápido (segundos)' : seg < 240 ? 'moderado (1–4 min)' : seg < 1200 ? 'lento (4–20 min)' : 'muy lento: considere una base más pequeña o «Energía»';
  $('#estimacion').textContent = `${n} átomos (${pesados} pesados) · tiempo estimado: ${nivel}`;
}

// ---------- JSME ----------
window.jsmeOnLoad = function jsmeOnLoad() {
  const caja = $('#jsme');
  caja.innerHTML = '';
  estado.jsme = new JSApplet.JSME('jsme', `${caja.clientWidth}px`, `${caja.clientHeight}px`, { options: 'polarnitro' });
  estado.jsme.setCallBack('AfterStructureModified', () => {
    if (Date.now() - (estado.cargaArchivo || 0) < 2000) return; // dibujo puesto desde un archivo
    estado.modificada = true;
    if (editorAbierto()) validarEditor();
  });
  leerEnJSME('CCO');
  $('#titulo').value = 'Etanol';
  generar3D().catch((e) => { $('#infoMolecula').textContent = e.message; });
  let pendiente;
  window.addEventListener('resize', () => {
    clearTimeout(pendiente);
    pendiente = setTimeout(() => estado.jsme.setSize(`${caja.clientWidth}px`, `${caja.clientHeight}px`), 150);
  });
};

function leerEnJSME(texto) {
  if (!estado.jsme) return;
  try { estado.jsme.readGenericMolecularInput(texto); } catch { estado.jsme.readMolecule?.(texto); }
  estado.modificada = true;
}

setTimeout(() => {
  if (!estado.jsme) $('#jsme').innerHTML = '<p class="cargando">El editor JSME no cargó. Recargue la página o use la casilla SMILES.</p>';
}, 15000);

// ---------- Visor 3D ----------
function iniciarVisor() {
  estado.visor = $3Dmol.createViewer($('#visor'), { backgroundColor: varCSS('--visor') || 'white', antialias: true });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => { estado.visor.setBackgroundColor(varCSS('--visor')); estado.visor.render(); });
}

function colorCarga(q) {
  // rojo (negativa) → blanco → azul (positiva), saturando en ±0.6 e
  const t = Math.max(-1, Math.min(1, q / 0.6));
  const a = Math.round(255 * (1 - Math.abs(t)));
  return t < 0 ? (0xff << 16) | (a << 8) | a : (a << 16) | (a << 8) | 0xff;
}

function estiloActual() {
  const cargas = $('#colorCargas').checked && estado.resultado?.cargas_mulliken;
  const c = cargas ? { colorfunc: (at) => colorCarga(cargas[at.index]?.carga ?? 0) } : { colorscheme: 'Jmol' };
  return {
    bolas: { stick: { radius: 0.12, ...c }, sphere: { scale: 0.27, ...c } },
    varillas: { stick: { radius: 0.16, ...c } },
    esferas: { sphere: { scale: 1.0, ...c } },
    lineas: { line: { linewidth: 2, ...c } },
  }[$('#estilo').value];
}

// Etiqueta de texto sin fondo (sólo el texto, del color del tema)
function etiquetaSinFondo(texto, pos, extra = {}) {
  return estado.visor.addLabel(texto, {
    position: { x: pos.x, y: pos.y, z: pos.z }, fontSize: 13, fontColor: varCSS('--texto') || '#16201a',
    showBackground: false, backgroundOpacity: 0, inFront: true, alignment: 'center', ...extra,
  });
}

// Etiquetas de los átomos: su índice (1, 2, 3…), el mismo que usan el scan y las medidas
function ponerEtiquetas() {
  const v = estado.visor;
  v.removeAllLabels();
  estado.medidaFormas = (estado.medidaFormas || []).filter((f) => f.tipo !== 'etiqueta'); // ya borradas
  if (!$('#etiquetas').checked || !v.getModel() || estado.modoActivo) return;
  const cargas = estado.resultado?.cargas_mulliken;
  const conCarga = $('#colorCargas').checked && cargas;
  v.getModel().selectedAtoms({}).forEach((a, i) => {
    const q = conCarga && cargas[i] ? ` (${cargas[i].carga >= 0 ? '+' : ''}${cargas[i].carga.toFixed(2)})` : '';
    // Un poco arriba a la derecha del átomo, para que se lea sobre la esfera
    etiquetaSinFondo(`${i + 1}${q}`, a, { fontSize: 12, screenOffset: { x: 15, y: 15 } });
  });
}

function aplicarEstilo() {
  const v = estado.visor;
  if (!v.getModel()) return;
  v.setStyle({}, estiloActual());
  ponerEtiquetas();
  v.setClickable({}, !!estado.medir, estado.medir ? alClicAtomo : null);
  dibujarMedida(false);
  v.render();
}

// ---------- Medir distancias, ángulos y diedros ----------
// Con «Medir» activo, cada clic en un átomo lo selecciona (máx. 4). 2 átomos → distancia,
// 3 → ángulo (vértice en el 2.º), 4 → diedro. Se recalcula al cambiar la geometría.
const COLOR_MEDIDA = '#d06400';
const vec = (p, q) => [q.x - p.x, q.y - p.y, q.z - p.z];
const punto = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cruz3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norma = (a) => Math.hypot(...a);

function calcularMedida(P) {
  if (P.length === 2) return norma(vec(P[0], P[1]));
  if (P.length === 3) {
    const a = vec(P[1], P[0]); const b = vec(P[1], P[2]);
    return (Math.acos(Math.max(-1, Math.min(1, punto(a, b) / (norma(a) * norma(b))))) * 180) / Math.PI;
  }
  if (P.length === 4) {
    // Diedro con el signo de la IUPAC (positivo en sentido horario mirando de 2 a 3)
    const b0 = vec(P[1], P[0]); const b1 = vec(P[1], P[2]); const b2 = vec(P[2], P[3]);
    const n1 = b1.map((x) => x / norma(b1));
    const v = b0.map((x, k) => x - punto(b0, n1) * n1[k]);
    const w = b2.map((x, k) => x - punto(b2, n1) * n1[k]);
    return (Math.atan2(punto(cruz3(n1, v), w), punto(v, w)) * 180) / Math.PI;
  }
  return null;
}

function textoMedida(atomos, sel) {
  const nombre = (i) => `${atomos[i]?.elem || ''}${i + 1}`;
  const cadena = sel.map(nombre).join('–');
  const P = sel.map((i) => atomos[i]);
  const val = calcularMedida(P);
  if (sel.length === 2) return { corto: `${val.toFixed(3)} Å`, largo: `Distancia ${cadena} = <span class="valor">${val.toFixed(4)} Å</span>` };
  if (sel.length === 3) {
    const d1 = norma(vec(P[1], P[0])); const d2 = norma(vec(P[1], P[2]));
    return { corto: `${val.toFixed(1)}°`, largo: `Ángulo ${cadena} = <span class="valor">${val.toFixed(2)}°</span> <span class="info">(vértice ${nombre(sel[1])}; ${nombre(sel[0])}–${nombre(sel[1])} ${d1.toFixed(3)} Å, ${nombre(sel[1])}–${nombre(sel[2])} ${d2.toFixed(3)} Å)</span>` };
  }
  if (sel.length === 4) return { corto: `${val.toFixed(1)}°`, largo: `Diedro ${cadena} = <span class="valor">${val >= 0 ? '+' : '−'}${Math.abs(val).toFixed(2)}°</span>` };
  return null;
}

function actualizarTextoMedida(atomos) {
  const caja = $('#medidaInfo');
  caja.hidden = !estado.medir;
  if (!estado.medir) return;
  const sel = estado.seleccion;
  let html;
  if (estado.modoActivo) html = 'Detenga la animación de la vibración para medir.';
  else if (!atomos.length) html = 'Cargue una molécula para medir.';
  else if (!sel.length) html = 'Haga clic en 2 átomos (distancia), 3 (ángulo) o 4 (diedro). Otro clic en un átomo seleccionado lo quita.';
  else if (sel.length === 1) html = `Átomo ${atomos[sel[0]]?.elem || ''}${sel[0] + 1} seleccionado: elija otro (2 = distancia, 3 = ángulo, 4 = diedro).`;
  else html = textoMedida(atomos, sel).largo + (sel.length < 4 ? ' <span class="info">· siga eligiendo para un ' + (sel.length === 2 ? 'ángulo' : 'diedro') + '</span>' : '');
  $('#medidaTexto').innerHTML = html;
}

function borrarFormasMedida() {
  const v = estado.visor;
  for (const f of estado.medidaFormas || []) {
    try { if (f.tipo === 'etiqueta') v.removeLabel(f.obj); else v.removeShape(f.obj); } catch { /* ya no existe */ }
  }
  estado.medidaFormas = [];
}

function dibujarMedida(render = true) {
  const v = estado.visor;
  borrarFormasMedida();
  const atomos = estado.modoActivo ? [] : (v.getModel()?.selectedAtoms({}) || []);
  if (estado.seleccion.some((i) => i >= atomos.length) && !estado.modoActivo) estado.seleccion = [];
  actualizarTextoMedida(atomos);
  const sel = estado.seleccion;
  if (!estado.medir || !sel.length || !atomos.length) { if (render) v.render(); return; }
  const P = sel.map((i) => atomos[i]);
  const forma = (obj) => estado.medidaFormas.push({ tipo: 'forma', obj });
  const etiqueta = (obj) => estado.medidaFormas.push({ tipo: 'etiqueta', obj });
  // Halo un poco mayor que la esfera del átomo en el estilo actual, para que se vea
  const vdw = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, F: 1.47, P: 1.8, S: 1.8, Cl: 1.75, Br: 1.85, I: 1.98 };
  const escala = { bolas: 0.27, esferas: 1.0 }[$('#estilo').value] || 0;
  P.forEach((a, k) => {
    const radio = Math.max(0.42, escala * (vdw[a.elem] || 1.7) + 0.18);
    forma(v.addSphere({ center: { x: a.x, y: a.y, z: a.z }, radius: radio, color: COLOR_MEDIDA, opacity: 0.4 }));
    // Índice del átomo seleccionado (si las etiquetas generales no lo muestran ya)
    if (!$('#etiquetas').checked) etiqueta(etiquetaSinFondo(String(sel[k] + 1), a, { fontColor: COLOR_MEDIDA, fontSize: 14, screenOffset: { x: 15, y: 15 } }));
  });
  for (let k = 0; k < P.length - 1; k++) {
    forma(v.addCylinder({ start: { x: P[k].x, y: P[k].y, z: P[k].z }, end: { x: P[k + 1].x, y: P[k + 1].y, z: P[k + 1].z }, radius: 0.03, color: COLOR_MEDIDA, dashed: true, fromCap: 1, toCap: 1 }));
  }
  if (P.length >= 2) {
    // Valor junto al centro de los átomos elegidos (en el diedro, sobre el enlace central)
    const base = P.length === 4 ? [P[1], P[2]] : P;
    const c = { x: 0, y: 0, z: 0 };
    base.forEach((a) => { c.x += a.x / base.length; c.y += a.y / base.length; c.z += a.z / base.length; });
    etiqueta(etiquetaSinFondo(textoMedida(atomos, sel).corto, c, { fontColor: COLOR_MEDIDA, fontSize: 15, screenOffset: { x: 0, y: -30 } }));
  }
  if (render) v.render();
}

function alClicAtomo(atomo) {
  if (!estado.medir || estado.modoActivo) return;
  const i = Number.isInteger(atomo.index) ? atomo.index : (estado.visor.getModel()?.selectedAtoms({}) || []).indexOf(atomo);
  if (i < 0) return;
  const s = estado.seleccion;
  const pos = s.indexOf(i);
  if (pos >= 0) s.splice(pos, 1);
  else {
    if (s.length >= 4) s.length = 0; // un 5.º clic empieza una medida nueva
    s.push(i);
  }
  dibujarMedida();
}

function alternarMedir() {
  estado.medir = !estado.medir;
  $('#medir').setAttribute('aria-pressed', String(estado.medir));
  if (!estado.medir) estado.seleccion = [];
  const v = estado.visor;
  if (v.getModel()) v.setClickable({}, estado.medir, estado.medir ? alClicAtomo : null);
  dibujarMedida();
}

// Molécula distinta: se descarta la selección
function reiniciarMedida() {
  estado.seleccion = [];
  dibujarMedida();
}

function quitarFlechas() {
  for (const s of estado.flechas || []) estado.visor.removeShape(s);
  estado.flechas = [];
}

function detenerAnimacion() {
  cancelAnimationFrame(estado.vivoAnim);
  estado.visor.stopAnimate();
  clearInterval(estado.reproductor);
  estado.reproductor = null;
  estado.modoActivo = null;
  quitarFlechas();
  $('#vibPlay').textContent = '▶ Animar';
  $$('.barra.activa, .etq.activa').forEach((b) => b.classList.remove('activa'));
  $$('tr.activa').forEach((r) => r.classList.remove('activa'));
}

// 3Dmol exige el formato XYZ completo: n.º de átomos, línea de comentario y coordenadas
function xyzCompleto(texto) {
  const lineas = String(texto).trim().split(/\r?\n/);
  return /^\s*\d+\s*$/.test(lineas[0]) ? texto : `${lineas.length}\nmolecula\n${lineas.join('\n')}\n`;
}

function cargarModelo(datos, formato, { zoom = true } = {}) {
  if (formato === 'xyz') datos = xyzCompleto(datos);
  detenerAnimacion();
  const v = estado.visor;
  v.removeAllModels();
  v.removeAllLabels();
  v.addModel(datos, formato);
  estado.modelo = { datos, formato };
  aplicarEstilo();
  if (zoom) v.zoomTo();
  v.render();
}

async function volumen(nombre) {
  const id = estado.trabajo;
  const k = `${id}/${nombre}`;
  if (!estado.cubos.has(k)) {
    const texto = await api(`/api/calculos/${id}/archivo/${nombre}.cube`);
    estado.cubos.set(k, new $3Dmol.VolumeData(texto, 'cube'));
  }
  return estado.cubos.get(k);
}

async function mostrarSuperficie() {
  const v = estado.visor;
  const tipo = $('#superficie').value;
  v.removeAllShapes();
  dibujarMedida(false);
  const ley = $('#leyenda');
  const ctrl = $('#ctrlIso');
  const iso = parseFloat($('#isovalor').value);
  $('#isoSalida').textContent = iso.toFixed(3);
  ley.hidden = true;
  ctrl.hidden = tipo === 'ninguna';
  if (tipo === 'ninguna') { v.render(); return; }
  $('#etiquetaModelo').textContent = 'cargando superficie…';
  try {
    if (tipo === 'homo' || tipo === 'lumo') {
      $('#isoTexto').textContent = 'Isovalor';
      const vol = await volumen(tipo);
      v.addIsosurface(vol, { isoval: iso, color: '#2b5cd7', opacity: 0.85, smoothness: 3 });
      v.addIsosurface(vol, { isoval: -iso, color: '#d7191c', opacity: 0.85, smoothness: 3 });
      const o = estado.resultado.orbitales;
      const e = tipo === 'homo' ? o.homo_ev : o.lumo_ev;
      ley.innerHTML = `<strong>${tipo.toUpperCase()}</strong> · ${fx(e, 3)} eV<br><span style="color:#2b5cd7">■</span> fase + &nbsp; <span style="color:#d7191c">■</span> fase −`;
    } else if (tipo === 'mep') {
      $('#isoTexto').textContent = 'Escala ±';
      const [dens, esp] = await Promise.all([volumen('densidad'), volumen('mep')]);
      v.addIsosurface(dens, { isoval: 0.002, voldata: esp, volscheme: new $3Dmol.Gradient.RWB(-iso, iso), opacity: 0.8, smoothness: 2 });
      const kcal = (iso * HARTREE_KCAL).toFixed(1);
      ley.innerHTML = `<strong>Potencial electrostático</strong> (isodensidad 0.002 u.a.)<div class="degradado"></div><div class="extremos"><span>−${kcal}</span><span>0</span><span>+${kcal} kcal/mol</span></div>rojo: rico en electrones · azul: pobre`;
    }
    ley.hidden = false;
  } catch (e) {
    ley.innerHTML = `No se pudo cargar la superficie: ${esc(e.message)}`;
    ley.hidden = false;
  }
  etiquetaModeloResultado();
  v.render();
}

function prepararSuperficies(cubos = []) {
  const opciones = [['ninguna', 'Ninguna']];
  if (cubos.includes('homo')) opciones.push(['homo', 'Orbital HOMO']);
  if (cubos.includes('lumo')) opciones.push(['lumo', 'Orbital LUMO']);
  if (cubos.includes('mep') && cubos.includes('densidad')) opciones.push(['mep', 'Potencial electrostático (MEP)']);
  $('#superficie').innerHTML = opciones.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('#superficie').value = 'ninguna';
  $('#ctrlIso').hidden = true;
  $('#leyenda').hidden = true;
  estado.visor.removeAllShapes();
  dibujarMedida(); // removeAllShapes también borró las marcas de la medida
}

function ajustarDeslizador() {
  const tipo = $('#superficie').value;
  const s = $('#isovalor');
  if (tipo === 'mep') { s.min = 0.01; s.max = 0.15; s.step = 0.005; s.value = 0.05; } else { s.min = 0.01; s.max = 0.12; s.step = 0.005; s.value = 0.05; }
}

// ---------- Geometría 3D (RDKit en el servidor) ----------
// JSME lee algunas entradas de forma diferida: se espera hasta 2 s a que haya estructura.
async function esperarEstructura() {
  for (let i = 0; i < 20; i++) {
    const s = estado.jsme.smiles();
    if (s) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return '';
}

async function generar3D({ explicito = false } = {}) {
  if (!estado.jsme) throw new Error('El editor JSME aún no está listo.');
  const smiles = await esperarEstructura();
  const molfile = estado.jsme.molFile();
  if (!smiles) throw new Error('El editor está vacío: dibuje una molécula.');
  const btn = $('#generar3d');
  btn.disabled = true;
  $('#infoMolecula').textContent = 'Generando geometría 3D…';
  try {
    const g = await api('/api/geometria', { method: 'POST', body: JSON.stringify({ molfile, smiles }) });
    estado.seleccion = []; // molécula nueva: la numeración de los átomos cambia
    estado.geom = g;
    estado.modificada = false;
    estado.resultado = null;
    $('#barraVib').hidden = true;
    $('#avisosArchivo').hidden = true;
    $('#ctrlCargas').hidden = true;
    $('#colorCargas').checked = false;
    $('#carga').value = g.carga;
    $('#multiplicidad').value = g.multiplicidad;
    $('#smiles').value = g.smiles;
    $('#infoMolecula').innerHTML = `<strong>${esc(g.formula)}</strong> · ${g.natomos} átomos · ${g.electrones} electrones · ${g.masa} uma · geometría inicial ${esc(g.campo_fuerza)}`;
    prepararSuperficies([]);
    cargarModelo(g.molblock, 'sdf');
    $('#etiquetaModelo').textContent = `${g.formula} · geometría inicial (${g.campo_fuerza})`;
    actualizarEstimacion();
    // El código .in se genera con la geometría nueva y las opciones del formulario
    const forzar = explicito && editadoAMano() && confirm('El código fue editado a mano. ¿Reemplazarlo con la geometría nueva y las opciones del formulario?');
    sincronizarCodigo({ forzar: forzar || !editadoAMano(), desplazar: explicito });
    return g;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Archivos de entrada (.in de Psi4 o .xyz) ----------
const nombreSeguro = (t) => String(t || 'molecula').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'molecula';

function mostrarAvisos(lista, error = false) {
  const caja = $('#avisosArchivo');
  if (!lista || !lista.length) { caja.hidden = true; return; }
  caja.className = `avisos${error ? ' error' : ''}`;
  caja.innerHTML = lista.length === 1 ? esc(lista[0]) : `<ul>${lista.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
  caja.hidden = false;
}

// ---------- Editor de la entrada de Psi4 ----------
// El código se interpreta en el navegador con leerEntradaPsi4 y se envía como un cálculo
// normal (molécula + opciones). Por seguridad, el servidor nunca ejecuta el texto del .in.
const editor = { nombre: '', aplicado: null, clave: null };
const textoEditor = () => $('#editorTexto').value;
const editorAbierto = () => !$('#tarjetaEditor').hidden;
// Mismo nombre de molécula que usa generarEntradaPsi4
const nombreMolecula = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const claveEntrada = (d) => `${d.xyz}|${d.carga}|${d.multiplicidad}`;

function pintarLineas(lineaError = 0) {
  const n = textoEditor().split('\n').length;
  let html = '';
  for (let i = 1; i <= n; i++) html += i === lineaError ? `<span class="err">${i}</span>\n` : `${i}\n`;
  $('#editorLineas').innerHTML = html;
  $('#editorLineas').scrollTop = $('#editorTexto').scrollTop;
}

// Los mensajes de error citan la línea problemática entre «…»: se busca su número
function lineaDelError(mensaje) {
  const citas = [...mensaje.matchAll(/«([^»]+)»/g)].map((m) => m[1].trim()).filter((c) => c.length > 1);
  if (!citas.length) return 0;
  const espacios = (t) => t.replace(/\s+/g, ' ').trim();
  const cita = espacios(citas[citas.length - 1]); // la última cita es la línea completa
  const lineas = textoEditor().split('\n').map(espacios);
  const i = lineas.findIndex((l) => l.replace(/#.*$/, '').includes(cita));
  return i >= 0 ? i + 1 : lineas.findIndex((l) => l.includes(cita)) + 1;
}

// ¿El formulario o el dibujo cambiaron después de aplicar el código?
function formularioDistinto(d) {
  return $('#metodo').value !== d.metodo || $('#base').value !== d.base || tareaEfectiva() !== d.tarea
    || parseInt($('#carga').value, 10) !== d.carga || parseInt($('#multiplicidad').value, 10) !== d.multiplicidad
    || estado.modificada || !estado.geom || estado.geom.claveEntrada !== editor.clave;
}

function validarEditor() {
  const caja = $('#editorEstado');
  try {
    const d = leerEntradaPsi4(textoEditor());
    pintarLineas();
    const natomos = d.xyz.trim().split('\n').length;
    let pendiente = '';
    if (textoEditor() !== editor.aplicado) pendiente = ' · <span class="pend">editado a mano: ya no se actualiza con el formulario («Regenerar desde el formulario» lo vuelve a sincronizar); se ejecuta tal cual</span>';
    else if (formularioDistinto(d)) pendiente = ' · <span class="pend">el formulario o el dibujo cambiaron; al ejecutar se usará este código</span>';
    if (estado.errorFormulario && textoEditor() === editor.aplicado) pendiente += ` · <span class="pend">formulario incompleto: ${esc(estado.errorFormulario)}</span>`;
    const origen = editor.trabajo ? `<span class="pend">Código del cálculo «${esc(editor.trabajo.titulo || '')}»</span> · ` : '';
    caja.innerHTML = `${origen}<span class="ok">✓ Código válido</span> · ${natomos} átomos · carga ${d.carga} · multiplicidad ${d.multiplicidad} · ${esc(nombreDe('metodos', d.metodo))}/${esc(nombreDe('bases', d.base))} · ${esc(nombreDe('tareas', d.tarea))}${pendiente}`;
    return d;
  } catch (e) {
    const linea = lineaDelError(e.message);
    pintarLineas(linea);
    caja.innerHTML = `<span class="mal">✗ ${linea ? `Línea ${linea}: ` : ''}</span>${esc(e.message)}`;
    return null;
  }
}

function abrirEditor(texto, nombre, { desplazar = true, trabajo = null } = {}) {
  editor.nombre = nombre;
  editor.aplicado = null;
  editor.clave = null;
  editor.trabajo = trabajo;
  $('#editorTexto').value = texto.replace(/\r\n/g, '\n');
  $('#editorTexto').scrollTop = 0;
  $('#nombreEditor').textContent = nombre;
  $('#tarjetaEditor').hidden = false;
  validarEditor();
  if (desplazar) $('#tarjetaEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// El código del editor coincide con la molécula y el formulario actuales
function marcarAplicado(texto, datos) {
  editor.aplicado = texto;
  editor.clave = claveEntrada(datos);
  if (estado.geom) estado.geom.claveEntrada = editor.clave;
  validarEditor();
}

// Lleva el código del editor a la molécula 3D, al dibujo y al formulario
async function aplicarEditor(avisosExtra = []) {
  const texto = textoEditor();
  const datos = leerEntradaPsi4(texto);
  const nombre = editor.nombre || 'entrada.in';
  const clave = claveEntrada(datos);
  let g = estado.geom;
  const avisos = [...(datos.avisos || []), ...avisosExtra];
  if (!g || estado.modificada || g.claveEntrada !== clave) {
    $('#infoMolecula').textContent = `Leyendo ${nombre}…`;
    g = await api('/api/geometria', {
      method: 'POST', body: JSON.stringify({ xyz: datos.xyz, carga: datos.carga, multiplicidad: datos.multiplicidad }),
    });
    estado.geom = { ...g, archivo: nombre, claveEntrada: clave };
    estado.seleccion = [];
    estado.modificada = false;
    estado.resultado = null;
    detenerVibracion();
    $('#barraVib').hidden = true;
    $('#ctrlCargas').hidden = true;
    $('#colorCargas').checked = false;
    $('#smiles').value = g.smiles || '';
    // Dibujo 2D en JSME (sin marcar la estructura como modificada)
    if (g.mol2d && estado.jsme) {
      estado.cargaArchivo = Date.now();
      try { estado.jsme.readMolFile(g.mol2d); } catch { /* el dibujo es opcional */ }
    }
    prepararSuperficies([]);
    cargarModelo(g.molblock || datos.xyz, g.molblock ? 'sdf' : 'xyz');
    $('#etiquetaModelo').textContent = `${g.formula} · geometría de ${nombre}`;
    if (g.aviso) avisos.push(g.aviso);
  }
  ponerFormulario(datos, nombre.replace(/\.[^.]+$/, ''));
  $('#infoMolecula').innerHTML = `<strong>${esc(nombre)}</strong>: ${esc(g.formula)} · ${g.natomos} átomos · ${g.electrones} electrones · carga ${datos.carga} · multiplicidad ${datos.multiplicidad} · ${esc(nombreDe('metodos', datos.metodo))}/${esc(nombreDe('bases', datos.base))} · ${esc(nombreDe('tareas', datos.tarea))}`;
  avisos.push('Se usan las coordenadas del código tal cual. Si edita el dibujo, se generará una geometría nueva.');
  mostrarAvisos(avisos);
  actualizarEstimacion();
  marcarAplicado(texto, datos);
  return datos;
}

// Formulario con lo que dice el código (el título se conserva si corresponde a la misma molécula)
function ponerFormulario(datos, tituloPorDefecto = '') {
  const tituloActual = $('#titulo').value.trim();
  if (!tituloActual || nombreMolecula(tituloActual) !== datos.titulo) $('#titulo').value = datos.titulo || tituloPorDefecto;
  $('#carga').value = datos.carga;
  $('#multiplicidad').value = datos.multiplicidad;
  $('#metodo').value = datos.metodo;
  $('#base').value = datos.base;
  if ((datos.tarea === 'scan' || datos.tarea === 'congelar') && datos.scan) ponerScanEnFormulario(datos.scan, datos.tarea === 'congelar');
  else {
    $$('.scan-tipo').forEach((c) => { c.checked = false; });
    estado.scanEditor = null;
    $('#tarea').value = datos.tarea;
  }
  if (datos.irc) {
    $('#ircDireccion').value = datos.irc.direccion;
    $('#ircPuntos').value = datos.irc.puntos;
    $('#ircPaso').value = datos.irc.paso;
  }
  mostrarOpcionesIRC();
  if (datos.mep) $('#mep').checked = true;
}

async function abrirArchivo(archivo) {
  if (!archivo) return;
  try {
    if (archivo.size > 300000) throw new Error('El archivo es demasiado grande (máx. 300 kB).');
    let texto = await archivo.text();
    let nombre = archivo.name;
    const extra = [];
    if (/\.xyz$/i.test(nombre)) {
      // Un .xyz sólo trae coordenadas: se arma una entrada con las opciones del formulario
      const x = leerXYZ(texto);
      nombre = nombre.replace(/\.xyz$/i, '.in');
      texto = generarEntradaPsi4({
        titulo: x.titulo || archivo.name.replace(/\.[^.]+$/, ''), xyz: x.xyz, carga: 0, multiplicidad: 1,
        metodo: $('#metodo').value || 'b3lyp', base: $('#base').value || '6-31g*', tarea: tareaEfectiva() || 'energia',
        memoria: estado.opciones?.memoria || '2 GB', mep: $('#mep').checked, irc: opcionesIRCForm(), scan: opcionesScanForm(true),
      });
      extra.push('Un .xyz no indica carga, multiplicidad ni método: se armó la entrada con carga 0, multiplicidad 1 y las opciones del formulario. Corríjalas en el código si hace falta.');
    }
    abrirEditor(texto, nombre);
    await aplicarEditor(extra);
  } catch (e) {
    // El consejo de corregir el código sólo aplica si el error está en el código (no, p. ej., en la clave)
    const errorDelCodigo = editorAbierto() && !validarEditor();
    mostrarAvisos([`No se pudo usar ${archivo.name}: ${e.message}`, ...(errorDelCodigo ? ['Corrija el código en el editor «Entrada de Psi4» y pulse «Aplicar cambios» o «Ejecutar cálculo».'] : [])], true);
    $('#infoMolecula').textContent = 'El archivo no se pudo usar.';
  } finally {
    $('#archivoEntrada').value = '';
  }
}

// ---------- Scan relajado en el formulario (casillas excluyentes: un tipo por cálculo) ----------
const SCAN_UI = {
  distancia: { natom: 2, simbolo: 'R', unidad: 'Å', paso: 0.1, min: 0.5, max: 6, nombre: 'distancia' },
  angulo: { natom: 3, simbolo: 'θ', unidad: '°', paso: 5, min: 20, max: 179, nombre: 'ángulo' },
  diedro: { natom: 4, simbolo: 'φ', unidad: '°', paso: 15, min: -360, max: 360, nombre: 'diedro' },
};
const tipoScan = () => $('.scan-tipo:checked')?.value || null;
const modoCoordenada = () => $('input[name="scanModo"]:checked')?.value || 'scan';
// Con una casilla marcada, el cálculo es un scan (cada punto, una optimización restringida) o una
// sola optimización con la coordenada congelada en un valor
const tareaEfectiva = () => (tipoScan() ? (modoCoordenada() === 'congelar' ? 'congelar' : 'scan') : $('#tarea').value);
const CAMPOS_ATOMOS = ['#scanI', '#scanJ', '#scanK', '#scanL'];
const atomosScanForm = () => CAMPOS_ATOMOS.slice(0, SCAN_UI[tipoScan() || 'distancia'].natom).map((s) => parseInt($(s).value, 10));
const firmaScan = () => [tipoScan(), modoCoordenada(), ...CAMPOS_ATOMOS, '#scanDesde', '#scanHasta', '#scanPaso', '#scanValor'].map((s) => (s && s.startsWith('#') ? $(s).value : s)).join('|');

// Valor actual de la coordenada (distancia, ángulo o diedro) en la geometría cargada
function valorActualScan(tipo, atomos) {
  const c = leerCoordenadas(estado.geom?.xyz || '');
  if (atomos.some((a) => !c[a - 1]) || new Set(atomos).size !== atomos.length) return null;
  const P = atomos.map((a) => ({ x: c[a - 1].p[0], y: c[a - 1].p[1], z: c[a - 1].p[2] }));
  return { v: calcularMedida(P), etq: atomos.map((a) => `${c[a - 1].e}${a}`).join('–') };
}

// Lista de valores: la del .in aplicado si el formulario no cambió, o desde/hasta/paso
function opcionesScanForm(silencioso = false) {
  const tipo = tipoScan() || 'distancia';
  const c = SCAN_UI[tipo];
  const atomos = atomosScanForm();
  if (modoCoordenada() === 'congelar') {
    const v = parseFloat($('#scanValor').value);
    if (!Number.isFinite(v)) {
      if (silencioso) return { tipo, atomos, valores: [] };
      throw new Error(`Coordenada congelada: indique el valor (${c.unidad}).`);
    }
    return { tipo, atomos, valores: [+v.toFixed(4)] };
  }
  if (estado.scanEditor && estado.scanEditor.firma === firmaScan()) return { tipo, atomos, valores: estado.scanEditor.valores };
  const desde = parseFloat($('#scanDesde').value); const hasta = parseFloat($('#scanHasta').value);
  const paso = Math.abs(parseFloat($('#scanPaso').value)) || c.paso;
  if (!Number.isFinite(desde) || !Number.isFinite(hasta)) {
    if (silencioso) return { tipo, atomos, valores: [] };
    throw new Error(`Scan: indique «Desde» y «Hasta» (${c.unidad}).`);
  }
  const n = Math.round(Math.abs(hasta - desde) / paso) + 1;
  const signo = hasta >= desde ? 1 : -1;
  const valores = Array.from({ length: Math.min(n, 40) }, (_, k) => +(desde + signo * k * paso).toFixed(4));
  return { tipo, atomos, valores, recortado: n > 40 };
}

// Rango inicial razonable alrededor del valor actual
function rangoInicialScan(tipo, v) {
  if (tipo === 'distancia') return [Math.max(0.5, v - 0.2).toFixed(2), Math.min(6, v + 0.8).toFixed(2)];
  if (tipo === 'angulo') return [Math.max(20, Math.round(v) - 20), Math.min(179, Math.round(v) + 20)];
  const a = Math.round(v);
  return a + 360 <= 360 ? [a, a + 360] : [a - 360, a];
}

function ponerScanEnFormulario(scan, congelar = false) {
  $$('.scan-tipo').forEach((c) => { c.checked = c.value === scan.tipo; });
  $$('input[name="scanModo"]').forEach((r) => { r.checked = r.value === (congelar ? 'congelar' : 'scan'); });
  scan.atomos.forEach((a, k) => { $(CAMPOS_ATOMOS[k]).value = a; });
  const v = scan.valores;
  if (congelar) {
    $('#scanValor').value = v[0];
    delete $('#scanValor').dataset.auto;
    estado.scanEditor = null;
    actualizarScanUI();
    return;
  }
  $('#scanDesde').value = v[0]; $('#scanHasta').value = v[v.length - 1];
  if (v.length > 1) $('#scanPaso').value = +Math.abs(v[1] - v[0]).toFixed(4);
  estado.scanEditor = { valores: v, firma: firmaScan() }; // conserva listas no uniformes del .in
  actualizarScanUI();
}

// Al marcar una casilla se desmarcan las otras (un solo tipo de scan por cálculo)
function elegirTipoScan(casilla) {
  if (casilla.checked) $$('.scan-tipo').forEach((c) => { if (c !== casilla) c.checked = false; });
  const tipo = tipoScan();
  estado.scanEditor = null;
  if (tipo) {
    $('#scanDesde').value = ''; $('#scanHasta').value = ''; $('#scanValor').value = '';
    $('#scanPaso').value = SCAN_UI[tipo].paso;
    const sel = estado.seleccion || [];
    if (sel.length === SCAN_UI[tipo].natom) sel.forEach((i, k) => { $(CAMPOS_ATOMOS[k]).value = i + 1; });
  }
  actualizarScanUI();
}

// Copia los átomos elegidos con «📏 Medir»
function scanDesdeMedida() {
  const sel = estado.seleccion || [];
  const tipo = { 2: 'distancia', 3: 'angulo', 4: 'diedro' }[sel.length];
  if (!tipo) {
    $('#scanInfo').textContent = 'Seleccione 2, 3 o 4 átomos con «📏 Medir» en el visor 3D y vuelva a pulsar el botón.';
    return;
  }
  $$('.scan-tipo').forEach((c) => { c.checked = c.value === tipo; });
  sel.forEach((i, k) => { $(CAMPOS_ATOMOS[k]).value = i + 1; });
  $('#scanDesde').value = ''; $('#scanHasta').value = ''; $('#scanValor').value = '';
  $('#scanPaso').value = SCAN_UI[tipo].paso;
  estado.scanEditor = null;
  actualizarScanUI();
  programarSincronizacion();
}

function actualizarScanUI() {
  const tipo = tipoScan();
  $('#scanCampos').hidden = !tipo;
  $('#scanModo').hidden = !tipo;
  $('#scanInfo').hidden = !tipo;
  const congelar = modoCoordenada() === 'congelar';
  $$('.solo-scan').forEach((el) => { el.hidden = congelar; });
  $$('.solo-congelar').forEach((el) => { el.hidden = !congelar; });
  $('#tarea').disabled = !!tipo;
  $$('.solo-irc').forEach((el) => { el.hidden = tareaEfectiva() !== 'irc'; });
  if (!tipo) return;
  const c = SCAN_UI[tipo];
  const nat = estado.geom?.natomos || 0;
  CAMPOS_ATOMOS.forEach((s) => { $(s).max = nat || ''; });
  $('#scanKCaja').hidden = c.natom < 3;
  $('#scanLCaja').hidden = c.natom < 4;
  $('#scanJTexto').textContent = { distancia: 'Átomo j (se mueve)', angulo: 'Átomo j (vértice)', diedro: 'Átomo j' }[tipo];
  $('#scanKTexto').textContent = tipo === 'angulo' ? 'Átomo k (se mueve)' : 'Átomo k (gira su lado)';
  $$('.scan-u').forEach((u) => { u.textContent = c.unidad; });
  const actual = valorActualScan(tipo, atomosScanForm());
  if (actual && !congelar && !$('#scanDesde').value && !$('#scanHasta').value) {
    [$('#scanDesde').value, $('#scanHasta').value] = rangoInicialScan(tipo, actual.v);
  }
  // El valor propuesto (el actual) sigue a los átomos elegidos mientras no se escriba a mano
  const campoValor = $('#scanValor');
  if (actual && congelar && (!campoValor.value || campoValor.dataset.auto)) {
    campoValor.value = +actual.v.toFixed(tipo === 'distancia' ? 3 : 1);
    campoValor.dataset.auto = '1';
  }
  const fmt = (v) => (tipo === 'distancia' ? `${v.toFixed(3)} Å` : `${v.toFixed(1)}°`);
  let txt = actual ? `${c.simbolo}(${actual.etq}) actual = ${fmt(actual.v)}. ` : `Elija ${c.natom} átomos distintos entre 1 y ${nat || '?'} (active «Etiquetas» o use «📏 Medir» en el visor para ver la numeración). `;
  if (congelar) {
    const v = parseFloat($('#scanValor').value);
    if (Number.isFinite(v) && (v < c.min || v > c.max)) txt += `⚠ El valor debe estar entre ${c.min} y ${c.max} ${c.unidad}. `;
    txt += `Se coloca ${tipo === 'distancia' ? 'la' : 'el'} ${c.nombre} en el valor indicado (el último átomo se mueve con todo lo que cuelga de él), se congela y se optimiza el resto de la molécula: una sola optimización, sin scan. Reemplaza al «Tipo de cálculo».`;
    $('#scanInfo').textContent = txt;
    return;
  }
  try {
    const o = opcionesScanForm();
    txt += `${o.valores.length} punto(s): ${o.valores.slice(0, 7).join(', ')}${o.valores.length > 7 ? ', …' : ''} ${c.unidad}${o.recortado ? ' (máximo 40 puntos)' : ''}. `;
    if (o.valores.some((v) => v < c.min || v > c.max)) txt += `⚠ Los valores deben estar entre ${c.min} y ${c.max} ${c.unidad}. `;
  } catch { /* faltan valores */ }
  txt += `En cada punto se fija ${tipo === 'distancia' ? 'la' : 'el'} ${c.nombre} (el último átomo se mueve con todo lo que cuelga de él) y se optimiza el resto; el scan reemplaza al «Tipo de cálculo».`;
  $('#scanInfo').textContent = txt;
}
const actualizarInfoScan = actualizarScanUI;

// ---------- Opciones del IRC en el formulario ----------
function opcionesIRCForm() {
  const puntos = Math.min(60, Math.max(3, parseInt($('#ircPuntos').value, 10) || 20));
  const paso = Math.min(0.5, Math.max(0.05, parseFloat($('#ircPaso').value) || 0.2));
  return { direccion: $('#ircDireccion').value || 'ambas', puntos, paso };
}

function mostrarOpcionesIRC() {
  actualizarScanUI();
}

// ---------- Código sincronizado con el formulario y un solo botón «Ejecutar» ----------
// Lo que se ejecuta es el código de la ventana «Código de entrada». Mientras no se edite a mano,
// se regenera al generar la geometría 3D y al cambiar el formulario. Al lanzar (o abrir) un
// cálculo, la ventana muestra el código de ese trabajo, tal como lo recibió el servidor.
const editadoAMano = () => !!textoEditor() && editor.aplicado !== null && textoEditor() !== editor.aplicado;

// Código .in con la geometría actual y las opciones del formulario (sin pedir nada al servidor)
function codigoDesdeFormulario() {
  const g = estado.geom;
  const titulo = $('#titulo').value.trim() || g.formula || 'molecula';
  const tarea = tareaEfectiva();
  const texto = generarEntradaPsi4({
    titulo, xyz: g.xyz, carga: parseInt($('#carga').value, 10) || 0, multiplicidad: parseInt($('#multiplicidad').value, 10) || 1,
    metodo: $('#metodo').value, base: $('#base').value, tarea,
    memoria: estado.opciones?.memoria || '2 GB', mep: $('#mep').checked, irc: opcionesIRCForm(),
    scan: tarea === 'scan' || tarea === 'congelar' ? opcionesScanForm() : null,
  });
  return { texto, nombre: `${nombreSeguro(titulo)}.in` };
}

function sincronizarCodigo({ forzar = false, desplazar = false } = {}) {
  estado.errorFormulario = null;
  if (!estado.geom || !estado.opciones || estado.modificada) return false;
  if (editadoAMano() && !forzar) { validarEditor(); return false; }
  let r; let datos;
  try {
    r = codigoDesdeFormulario();
    datos = leerEntradaPsi4(r.texto);
  } catch (e) {
    estado.errorFormulario = e.message; // p. ej. un scan sin «Desde»/«Hasta»: se conserva el código anterior
    if (textoEditor()) validarEditor();
    return false;
  }
  if (textoEditor() !== r.texto || editor.trabajo) abrirEditor(r.texto, r.nombre, { desplazar });
  marcarAplicado(r.texto, datos);
  return true;
}

let temporizadorCodigo = null;
function programarSincronizacion() {
  clearTimeout(temporizadorCodigo);
  temporizadorCodigo = setTimeout(() => sincronizarCodigo(), 250);
}

async function regenerarEditor() {
  if (estado.modificada || !estado.geom) {
    try { await generar3D(); } catch (e) { alert(e.message); return; }
  }
  if (editadoAMano() && !confirm('El código fue editado a mano. ¿Reemplazarlo con la molécula y las opciones del formulario?')) return;
  if (!sincronizarCodigo({ forzar: true }) && estado.errorFormulario) alert(estado.errorFormulario);
}

async function aplicarDesdeEditor(boton) {
  if (!validarEditor()) { $('#editorTexto').focus(); return false; }
  boton.disabled = true;
  try {
    await aplicarEditor();
    return true;
  } catch (e) {
    validarEditor();
    alert(e.message);
    return false;
  } finally {
    boton.disabled = false;
  }
}

// El único botón para calcular: ejecuta el código de la ventana
async function ejecutar() {
  const boton = $('#calcular');
  if (boton.disabled) return;
  boton.disabled = true;
  try {
    if (!estado.geom || estado.modificada) {
      // Dibujo nuevo o editado: se genera la geometría 3D y, con ella, el código
      const usarDibujo = !editadoAMano() || confirm('Cambió el dibujo, pero el código fue editado a mano. ¿Generar la geometría del dibujo y regenerar el código? (Cancelar ejecuta el código tal como está.)');
      if (usarDibujo) {
        await generar3D();
        sincronizarCodigo({ forzar: true });
      }
    }
    if (!textoEditor() && !sincronizarCodigo({ forzar: true })) throw new Error(estado.errorFormulario || 'No hay código para ejecutar.');
    const datos = validarEditor();
    if (!datos) { $('#editorTexto').focus(); throw new Error('Corrija el código antes de ejecutar (vea el mensaje bajo el código).'); }
    // Si el código no coincide con la molécula y el formulario, se aplica primero (el código manda)
    if (editadoAMano() || formularioDistinto(datos)) await aplicarEditor();
    await lanzarCalculo();
    $('#seccionResultados').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    alert(e.message);
  } finally {
    boton.disabled = false;
  }
}

// Muestra en la ventana el código del trabajo que se sigue (el .in que guardó el servidor)
async function mostrarCodigoTrabajo(id) {
  let texto;
  try { texto = await api(`/api/calculos/${id}/archivo/entrada.in`); } catch { return; }
  if (estado.trabajo !== id) return; // mientras tanto se abrió otro cálculo
  let datos;
  try { datos = leerEntradaPsi4(texto); } catch { return; }
  const info = historial().find((h) => h.id === id) || {};
  const coords = leerCoordenadas(datos.xyz);
  const g = estado.geom || {};
  const mismaMolecula = leerCoordenadas(g.xyz || '').map((a) => a.e).join() === coords.map((a) => a.e).join();
  // La geometría del trabajo pasa a ser la actual (para regenerar el código o volver a ejecutarlo)
  estado.geom = { ...(mismaMolecula ? g : {}), xyz: datos.xyz, natomos: coords.length, formula: info.formula || g.formula || datos.titulo, smiles: mismaMolecula ? g.smiles : '' };
  if (!mismaMolecula) estado.seleccion = [];
  estado.modificada = false;
  abrirEditor(texto, `${nombreSeguro(info.titulo || datos.titulo)}.in`, { desplazar: false, trabajo: { id, titulo: info.titulo || datos.titulo } });
  if (info.titulo) $('#titulo').value = info.titulo;
  ponerFormulario(datos, info.titulo || datos.titulo);
  marcarAplicado(texto, datos);
  actualizarEstimacion();
}

function teclasEditor(e) {
  const ta = e.target;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ejecutar(); return; }
  if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
    e.preventDefault();
    ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
}

// Descarga archivos de un cálculo: la salida de Psi4 se guarda como .out
async function guardarArchivoTrabajo(cual) {
  const t = estado.infoTrabajo; const r = estado.resultado;
  if (!t) return;
  const nombre = nombreSeguro(t.titulo);
  try {
    if (cual === 'out') {
      descargar(await api(`/api/calculos/${t.id}/archivo/salida.dat`), `${nombre}.out`);
    } else if (cual === 'in') {
      let texto;
      try {
        texto = await api(`/api/calculos/${t.id}/archivo/entrada.in`);
      } catch (e) {
        if (e.status !== 404) throw e;
        // Cálculos anteriores a esta función: se arma con la geometría final
        texto = `# Nota: cálculo anterior a la exportación de entradas; se usa la geometría final.\n${generarEntradaPsi4({
          titulo: t.titulo, xyz: r.geometria_xyz, carga: r.carga, multiplicidad: r.multiplicidad,
          metodo: r.metodo, base: r.base, tarea: r.tarea, memoria: estado.opciones?.memoria || '2 GB', mep: (r.cubos || []).includes('mep'),
        })}`;
      }
      descargar(texto, `${nombre}.in`);
    } else if (cual === 'xyz') {
      descargar(await api(`/api/calculos/${t.id}/archivo/geometria.xyz`), `${nombre}_final.xyz`);
    } else if (cual === 'molden') {
      descargar(await api(`/api/calculos/${t.id}/archivo/orbitales.molden`), `${nombre}.molden`);
    } else if (cual === 'naturales') {
      descargar(await api(`/api/calculos/${t.id}/archivo/naturales.molden`), `${nombre}_naturales_MP2.molden`);
    } else if (cual === 'ibo-irc') {
      await descargarBinario(`/api/calculos/${t.id}/archivo/irc_iboview.zip`, `${nombre}_IRC_IboView.zip`);
    } else if (cual === 'ibo-scan') {
      await descargarBinario(`/api/calculos/${t.id}/archivo/scan_iboview.zip`, `${nombre}_scan_IboView.zip`);
    } else if (cual === 'molden-puntos') {
      abrirDialogoMolden();
    }
  } catch (e) {
    alert(e.message);
  }
}

// ---------- Cálculos ----------
// Envía al servidor la molécula del visor con las opciones del formulario
async function lanzarCalculo() {
  if (estado.modificada || !estado.geom) await generar3D();
  const g = estado.geom;
  const cuerpo = {
    xyz: g.xyz, formula: g.formula, smiles: g.smiles,
    titulo: $('#titulo').value.trim() || g.formula,
    metodo: $('#metodo').value, base: $('#base').value, tarea: tareaEfectiva(),
    carga: parseInt($('#carga').value, 10), multiplicidad: parseInt($('#multiplicidad').value, 10),
    mep: $('#mep').checked,
    irc: tareaEfectiva() === 'irc' ? opcionesIRCForm() : undefined,
    scan: ['scan', 'congelar'].includes(tareaEfectiva()) ? opcionesScanForm() : undefined,
  };
  const t = await api('/api/calculos', { method: 'POST', body: JSON.stringify(cuerpo) });
  // En un IRC los enlaces cambian a lo largo del camino: no se fijan los del dibujo
  if (g.molblock && !['irc', 'scan', 'congelar'].includes(cuerpo.tarea)) estado.molblocks.set(t.id, g.molblock);
  guardarEnHistorial(t);
  seguir(t.id);
  return t;
}

function pildora(t) {
  const p = $('#pildoraEstado');
  const txt = { en_cola: t.posicion_cola ? `En cola (#${t.posicion_cola})` : 'En cola', ejecutando: 'Calculando', terminado: 'Terminado', error: 'Error' }[t.estado];
  p.textContent = txt;
  p.className = `pildora ${t.estado === 'error' ? 'error' : t.estado === 'en_cola' ? 'cola' : ''}`;
}

function cronometro() {
  if (!estado.inicio) { $('#cronometro').textContent = 'esperando turno'; return; }
  const s = Math.max(0, Math.round((Date.now() - estado.inicio) / 1000));
  $('#cronometro').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function seguir(id) {
  const token = ++estado.token;
  estado.trabajo = id;
  mostrarCodigoTrabajo(id); // la ventana de código muestra el .in de este trabajo (IRC, frecuencias, historial…)
  estado.resultado = null;
  estado.vivo = null;
  detenerVivo();
  $('#vivoOpt').hidden = true;
  $('#barraVib').hidden = true;
  const sec = $('#seccionResultados');
  sec.hidden = false;
  $('#resultados').hidden = true;
  $('#errorCalculo').hidden = true;
  $('#progreso').hidden = false;
  $('#registro').textContent = '';
  $('#etapa').textContent = 'Consultando…';
  clearInterval(estado.reloj);
  estado.inicio = null;
  estado.reloj = setInterval(cronometro, 1000);
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  let vioCalcular = false; // sólo si el trabajo terminó mientras se seguía (no al abrir uno viejo)
  const ciclo = async () => {
    if (token !== estado.token) return;
    let t;
    try {
      // ?desde=N: sólo los pasos de la optimización que aún no se han mostrado
      const desde = estado.vivoCola?.id === id ? `?desde=${estado.vivoCola.ultimo}` : '';
      t = await api(`/api/calculos/${id}${desde}`);
    } catch (e) {
      if (e.status === 404) { finSeguimiento(); mostrarError({ error: e.message }); quitarDelHistorial(id); return; }
      setTimeout(ciclo, 5000);
      return;
    }
    if (token !== estado.token) return;
    pildora(t);
    actualizarHistorial(t);
    $('#cancelar').hidden = !(t.estado === 'en_cola' || t.estado === 'ejecutando');
    if (t.estado === 'en_cola' || t.estado === 'ejecutando') {
      vioCalcular = true;
      estado.inicio = t.inicio ? Date.parse(t.inicio) : null;
      $('#etapa').textContent = t.estado === 'en_cola' ? `En cola${t.posicion_cola ? ` (posición ${t.posicion_cola})` : ''}` : (t.etapa || 'Calculando');
      if (t.registro) {
        const pre = $('#registro');
        const abajo = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
        pre.textContent = t.registro;
        if (abajo) pre.scrollTop = pre.scrollHeight;
      }
      if (t.vivo) mostrarVivo(t, id);
      cronometro();
      setTimeout(ciclo, 2000);
    } else {
      finSeguimiento();
      if (t.estado === 'terminado' && t.resultado) {
        mostrarResultado(t);
        if (vioCalcular && t.resultado.iboview?.puntos_molden?.length) abrirDialogoMolden({ alTerminar: true });
      } else mostrarError(t);
    }
  };
  ciclo();
}

// ---------- Geometría en vivo durante la optimización ----------
// Psi4 informa la geometría de cada paso; el visor pasa suavemente de un paso al siguiente.
function leerCoordenadas(xyz) {
  return String(xyz || '').trim().split(/\r?\n/).map((l) => {
    const [e, x, y, z] = l.trim().split(/\s+/);
    return { e, p: [+x, +y, +z] };
  }).filter((a) => a.e && a.p.every(Number.isFinite));
}

// Molfile del cálculo con coordenadas nuevas: conserva los enlaces dobles y triples del dibujo
function molblockCon(molblock, coords) {
  if (!molblock || !coords.length) return null;
  const l = molblock.replace(/\r\n/g, '\n').split('\n');
  if (!/V2000/.test(l[3] || '') || parseInt(l[3].slice(0, 3), 10) !== coords.length) return null;
  for (let i = 0; i < coords.length; i++) {
    const a = l[4 + i] || '';
    if (a.slice(31, 34).trim().toLowerCase() !== coords[i].e.toLowerCase()) return null;
    l[4 + i] = coords[i].p.map((v) => v.toFixed(4).padStart(10)).join('') + a.slice(30);
  }
  return l.join('\n');
}

function dibujarCoordenadas(coords, molblock) {
  const v = estado.visor;
  const sdf = molblockCon(molblock, coords);
  v.removeAllModels();
  if (sdf) v.addModel(sdf, 'sdf');
  else v.addModel(xyzCompleto(coords.map((c) => `${c.e} ${c.p.join(' ')}`).join('\n')), 'xyz');
  aplicarEstilo();
}

function graficoVivo(energias) {
  const E = energias.filter(Number.isFinite);
  const svg = $('#vivoGrafico');
  if (E.length < 2) { svg.innerHTML = ''; return; }
  const W = 240; const H = 70; const m = { i: 30, d: 6, s: 6, b: 16 };
  const min = Math.min(...E); const max = Math.max(...E); const rango = max - min || 1e-9;
  const px = (i) => m.i + (i / (E.length - 1)) * (W - m.i - m.d);
  const py = (e) => m.s + (1 - (e - min) / rango) * (H - m.s - m.b);
  const puntos = E.map((e, i) => `${px(i).toFixed(1)},${py(e).toFixed(1)}`).join(' ');
  const dif = ((max - min) * HARTREE_KCAL).toFixed(2);
  svg.innerHTML = `<line class="eje" x1="${m.i}" y1="${H - m.b}" x2="${W - m.d}" y2="${H - m.b}"/>
    <line class="eje" x1="${m.i}" y1="${m.s}" x2="${m.i}" y2="${H - m.b}"/>
    <polyline class="linea" points="${puntos}"/>
    <circle cx="${px(E.length - 1)}" cy="${py(E[E.length - 1])}" r="3"/>
    <text x="${m.i - 3}" y="${m.s + 7}" text-anchor="end">+${dif}</text>
    <text x="${m.i - 3}" y="${H - m.b}" text-anchor="end">0</text>
    <text x="${(m.i + W) / 2}" y="${H - 3}" text-anchor="middle">paso de optimización (E en kcal/mol)</text>`;
}

// Recibe los pasos nuevos del servidor y los pone en cola: se muestran todos, en orden
function mostrarVivo(t, id) {
  const v = t.vivo;
  if (!v) return;
  if (estado.vivoCola?.id !== id) estado.vivoCola = { id, lista: [], ultimo: 0, ocupado: false };
  const cola = estado.vivoCola;
  const nuevos = (Array.isArray(v.pasos) ? v.pasos : [v]).filter((p) => p && p.xyz && p.paso > cola.ultimo);
  for (const p of nuevos) { cola.lista.push(p); cola.ultimo = Math.max(cola.ultimo, p.paso); }
  // Si se abre un cálculo ya avanzado, no se reproducen decenas de pasos atrasados
  if (cola.lista.length > 6) cola.lista = cola.lista.slice(-3);
  cola.energias = v.energias || [];
  cola.formula = t.formula || '';
  if (!cola.ocupado) reproducirPaso();
}

function reproducirPaso() {
  const cola = estado.vivoCola;
  if (!cola) return;
  const v = cola.lista.shift();
  if (!v) { cola.ocupado = false; return; }
  cola.ocupado = true;
  const nuevas = leerCoordenadas(v.xyz);
  if (!nuevas.length) { reproducirPaso(); return; }
  const molblock = estado.molblocks.get(cola.id) || null;
  if (!estado.vivo) {
    // Primer paso: se quitan superficies y vibraciones del cálculo anterior
    detenerAnimacion();
    prepararSuperficies([]);
    $('#barraVib').hidden = true;
    $('#ctrlCargas').hidden = true;
  }
  const actuales = estado.vivo?.coords
    || (estado.visor.getModel()?.selectedAtoms({}) || []).map((a) => ({ e: a.elem, p: [a.x, a.y, a.z] }));
  const interpolar = actuales.length === nuevas.length
    && actuales.every((a, i) => String(a.e).toLowerCase() === nuevas[i].e.toLowerCase());
  estado.vivo = { paso: v.paso, coords: nuevas };
  cancelAnimationFrame(estado.vivoAnim);
  const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  const dur = cola.lista.length > 1 ? 400 : 700; // con pasos pendientes, transición más rápida
  const cuadro = (ahoraMs) => {
    const f = interpolar && !reducido ? Math.min(1, Math.max(0, (ahoraMs - t0) / dur)) : 1;
    const k = f * f * (3 - 2 * f); // suavizado
    dibujarCoordenadas(nuevas.map((c, i) => ({ e: c.e, p: interpolar ? c.p.map((x, j) => actuales[i].p[j] + (x - actuales[i].p[j]) * k) : c.p })), molblock);
    if (f < 1) estado.vivoAnim = requestAnimationFrame(cuadro);
    else estado.vivoTimer = setTimeout(reproducirPaso, cola.lista.length ? 250 : 0);
  };
  estado.vivoAnim = requestAnimationFrame(cuadro);

  // energias[i] corresponde al paso i + 1
  const E = (cola.energias || []).slice(0, v.paso);
  const previa = v.paso > 1 ? E[v.paso - 2] : null;
  const dE = Number.isFinite(previa) && Number.isFinite(v.energia) ? (v.energia - previa) * HARTREE_KCAL : null;
  $('#vivoTexto').innerHTML = [
    `Paso ${v.paso}`,
    Number.isFinite(v.energia) ? `E = ${v.energia.toFixed(6)} Eh` : '',
    dE != null ? `ΔE = ${dE >= 0 ? '+' : ''}${dE.toFixed(3)} kcal/mol` : '',
    Number.isFinite(v.grad_max) ? `gradiente máx. = ${v.grad_max.toExponential(2)} Eh/bohr` : '',
  ].filter(Boolean).join(' · ');
  graficoVivo(E);
  $('#vivoOpt').hidden = false;
  $('#etiquetaModelo').textContent = `${cola.formula} · optimizando: paso ${v.paso}`;
}

function detenerVivo() {
  cancelAnimationFrame(estado.vivoAnim);
  clearTimeout(estado.vivoTimer);
  estado.vivoCola = null;
}

function finSeguimiento() {
  clearInterval(estado.reloj);
  detenerVivo();
  $('#vivoOpt').hidden = true;
  $('#progreso').hidden = true;
  $('#cancelar').hidden = true;
}

function mostrarError(t) {
  const caja = $('#errorCalculo');
  caja.hidden = false;
  caja.innerHTML = `<strong>El cálculo no terminó.</strong>\n${esc(t.error || t.resultado?.error || 'Error desconocido.')}` +
    (t.registro ? `<details><summary>Últimas líneas de la salida de Psi4</summary><pre class="registro">${esc(t.registro)}</pre></details>` : '');
  pildora({ estado: 'error' });
}

// ---------- Resultados ----------
function etiquetaModeloResultado() {
  const t = estado.infoTrabajo;
  if (!t) return;
  const tipo = { energia: 'geometría de entrada', ts: 'estado de transición', irc: 'estado de transición (inicio del IRC)', scan: 'punto de menor energía del scan' }[t.tarea] || 'geometría optimizada';
  $('#etiquetaModelo').textContent = `${t.titulo} · ${nombreDe('metodos', t.metodo)}/${nombreDe('bases', t.base)} · ${tipo}`;
}

function mostrarResultado(t) {
  const r = t.resultado;
  estado.resultado = r;
  estado.infoTrabajo = t;
  estado.asignaciones = r.frecuencias && window.asignarModos ? asignarModos(r.geometria_xyz, r.frecuencias.modos) : new Map();
  $('#resultados').hidden = false;
  $('#errorCalculo').hidden = true;
  pildora(t);

  prepararSuperficies(r.cubos || []);
  const sdf = molblockCon(estado.molblocks.get(t.id), leerCoordenadas(r.geometria_xyz));
  if (sdf) cargarModelo(sdf, 'sdf'); else cargarModelo(r.geometria_xyz, 'xyz');
  etiquetaModeloResultado();
  $('#ctrlCargas').hidden = !r.cargas_mulliken;

  panelResumen(t, r);
  panelOrbitales(r);
  panelCargas(r);
  panelVibraciones(r);
  // La pestaña «Optimización» muestra el camino de reacción cuando el cálculo es un IRC
  if (r.irc?.puntos?.length) {
    $('#tabOpt').textContent = 'Camino IRC';
    panelIRC(t, r);
  } else if (r.scan?.puntos?.length) {
    $('#tabOpt').textContent = 'Scan';
    panelScan(t, r);
  } else {
    $('#tabOpt').textContent = 'Optimización';
    panelOptimizacion(r);
  }
  panelArchivos(t, r);
  $('#tabVib').disabled = false;
  prepararVibraciones(r);
  $('#tabOpt').disabled = !(r.trayectoria?.length || r.irc?.puntos?.length || r.scan?.puntos?.length);
  abrirPestana('resumen');
}

function abrirPestana(nombre) {
  $$('.pestanas button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pestana === nombre)));
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== nombre; });
}

function cifra(nombre, valor, extra = '') {
  return `<div class="cifra"><div class="nombre">${nombre}</div><div class="valor">${valor}</div>${extra ? `<div class="extra">${extra}</div>` : ''}</div>`;
}

// Qué significa el número de frecuencias imaginarias según el tipo de cálculo
function interpretarImaginarias(tarea, n) {
  if (tarea === 'ts') {
    if (n === 1) return 'Estado de transición confirmado: anime el modo imaginario para ver la coordenada de reacción';
    if (n === 0) return 'No es un TS: la búsqueda llegó a un mínimo. Parta de una geometría más cercana al TS';
    return `Punto de silla de orden ${n}: no es un TS simple. Desplace la geometría a lo largo de los modos imaginarios sobrantes`;
  }
  if (!n) return 'Mínimo de energía confirmado';
  return 'No es un mínimo: la optimización terminó en un punto de silla (el gradiente es ~0 por simetría). '
    + 'Si es un estado de transición, use el tipo «Estado de transición (TS)»; si busca un mínimo, rompa la simetría de la geometría';
}

function panelResumen(t, r) {
  const e = r.energia || {};
  const d = r.dipolo_debye;
  const o = r.orbitales || {};
  const f = r.frecuencias;
  const th = f?.termoquimica_hartree;
  let html = `<div class="grupo-btn barra-guardar">
    <button class="btn sec chico" type="button" data-guardar="out">Guardar salida (.out)</button>
    <button class="btn sec chico" type="button" data-guardar="in">Guardar entrada (.in)</button>
    ${r.iboview?.orbitales ? '<button class="btn sec chico" type="button" data-guardar="molden" title="Función de onda en formato Molden (IboView, Avogadro, Jmol…)">Descargar .molden</button>' : ''}
    ${r.iboview?.puntos_molden?.length ? `<button class="btn chico" type="button" data-guardar="molden-puntos" title="Un .molden por punto, con un nombre base y numeración en la carpeta que elija">Guardar ${r.iboview.puntos_molden.length} .molden numerados…</button>` : ''}
    ${r.tarea === 'ts' && f?.n_imaginarias === 1 ? '<button class="btn chico" type="button" id="lanzarIRC" title="Sigue el camino de mínima energía desde este TS hacia reactivos y productos">Calcular IRC desde este TS</button>' : ''}
  </div><div class="cifras">`;
  html += cifra({ irc: 'Energía del TS', scan: 'Energía en el mínimo del scan', congelar: 'Energía (coordenada congelada)' }[r.tarea] || 'Energía total', `${fx(e.hartree, 8)} E<sub>h</sub>`, `${fx(e.kcal_mol, 2)} kcal/mol · ${fx(e.ev, 3)} eV`);
  const cg = r.congelado;
  if (cg) {
    const dec = cg.unidad === 'Å' ? 3 : 1;
    const nombreTipo = { distancia: 'Distancia congelada', angulo: 'Ángulo congelado', diedro: 'Diedro congelado' }[cg.tipo] || 'Coordenada congelada';
    html += cifra(nombreTipo, `${cg.simbolo}(${esc(cg.etiqueta)}) = ${fx(cg.valor_final, dec)} ${cg.unidad}`,
      `pedido ${fx(cg.valor, dec)} ${cg.unidad} · ${cg.convergio ? (cg.nota ? esc(cg.nota) : 'optimización convergida') : `no convergió${cg.nota ? `: ${esc(cg.nota)}` : ''}`}`);
  }
  const sc = r.scan;
  if (sc) {
    const S = sc.simbolo || 'R'; const U = sc.unidad || 'Å'; const dec = U === 'Å' ? 3 : 1;
    const v = sc.puntos.map((p) => p.valor ?? p.r);
    const nombreTipo = { distancia: 'distancia', angulo: 'ángulo', diedro: 'diedro' }[sc.tipo || 'distancia'];
    html += cifra(`Scan de ${nombreTipo} ${S}(${esc(sc.etiqueta)})`, `${v.length} punto(s)`, `de ${fx(v[0], dec)} a ${fx(v[v.length - 1], dec)} ${U}`);
    html += cifra('Mínimo del scan', `${S} = ${fx(sc.valor_minimo ?? sc.r_minimo, dec)} ${U}`, 'Geometría usada para orbitales, cargas y superficies');
    html += cifra('Máximo del scan', `${S} = ${fx(sc.valor_maximo ?? sc.r_maximo, dec)} ${U}`, `${fx(sc.rango_kcal, 2)} kcal/mol por encima del mínimo`);
    if (sc.no_convergidos) html += cifra('Puntos sin converger', String(sc.no_convergidos), 'Marcados en naranja en la pestaña «Scan»');
  }
  const irc = r.irc;
  if (irc) {
    const extremos = { '−': irc.barrera_desde_atras_kcal, '+': irc.barrera_desde_adelante_kcal };
    for (const [lado, v] of Object.entries(extremos)) {
      if (v != null) html += cifra(`Barrera desde el extremo ${lado}`, `${fx(v, 2)} kcal/mol`, `E(TS) − E(último punto ${lado} del IRC)`);
    }
    if (irc.energia_reaccion_kcal != null) html += cifra('Energía de reacción (− → +)', `${fx(irc.energia_reaccion_kcal, 2)} kcal/mol`, 'Entre los dos extremos del IRC (aprox.: optimice cada extremo para el valor exacto)');
    html += cifra('Puntos del IRC', String(irc.puntos.length), `${irc.direccion === 'ambas' ? 'ambas direcciones' : `sólo ${irc.direccion}`} · paso ${irc.paso} bohr·amu½`);
  }
  if (d) html += cifra('Momento dipolar', `${fx(d.total, 3)} D`, `x ${fx(d.x, 3)} · y ${fx(d.y, 3)} · z ${fx(d.z, 3)}`);
  if (o.homo_ev != null) html += cifra('HOMO / LUMO', `${fx(o.homo_ev, 3)} / ${fx(o.lumo_ev, 3)} eV`, o.gap_ev != null ? `Brecha HOMO–LUMO: ${fx(o.gap_ev, 3)} eV` : '');
  if (f) html += cifra('Frecuencias imaginarias', String(f.n_imaginarias), interpretarImaginarias(r.tarea, f.n_imaginarias));
  if (th?.zpve != null) html += cifra('Energía de punto cero', `${fx(th.zpve * HARTREE_KCAL, 2)} kcal/mol`, `${fx(th.zpve, 6)} E<sub>h</sub>`);
  if (th?.entalpia != null) html += cifra('Entalpía H (298 K)', `${fx(th.entalpia, 6)} E<sub>h</sub>`);
  if (th?.energia_libre_gibbs != null) html += cifra('Energía libre G (298 K)', `${fx(th.energia_libre_gibbs, 6)} E<sub>h</sub>`);
  html += cifra('Nivel de teoría', `${esc(nombreDe('metodos', r.metodo))}/${esc(nombreDe('bases', r.base))}`, `${esc(nombreDe('tareas', r.tarea))}`);
  html += cifra('Sistema', `${esc(t.formula || '')}`, `carga ${r.carga} · multiplicidad ${r.multiplicidad} · ${o.n_funciones_base ?? '?'} funciones de base`);
  html += cifra('Tiempo de cálculo', `${fx(r.tiempo_s, 1)} s`, `Psi4 ${esc(r.psi4_version || '')}`);
  html += '</div>';
  const comp = e.componentes || {};
  if (Object.keys(comp).length) {
    html += '<table><thead><tr><th>Componente de energía</th><th class="num">E<sub>h</sub></th></tr></thead><tbody>';
    const nombres = { repulsion_nuclear: 'Repulsión nuclear', scf_total: 'Energía SCF total', correlacion_mp2: 'Correlación MP2' };
    for (const [k, v] of Object.entries(comp)) html += `<tr><td>${nombres[k] || esc(k)}</td><td class="num">${fx(v, 8)}</td></tr>`;
    html += '</tbody></table>';
  }
  for (const n of [r.aviso, r.nota_propiedades, r.aviso_cubos, r.aviso_propiedades, ...(r.irc?.avisos || [])]) if (n) html += `<p class="nota">${esc(n)}</p>`;
  $('[data-panel="resumen"]').innerHTML = html;
}

function panelOrbitales(r) {
  const o = r.orbitales;
  const panel = $('[data-panel="orbitales"]');
  if (!o) { panel.innerHTML = '<p class="nota">Sin información de orbitales.</p>'; return; }
  const lista = o.lista;
  const W = 260; const H = 360; const m = 30;
  const es = lista.map((x) => x.energia_ev);
  const min = Math.min(...es); const max = Math.max(...es);
  const y = (e) => H - m - ((e - min) / (max - min || 1)) * (H - 2 * m);
  let svg = `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Diagrama de niveles de energía de los orbitales"><line class="eje" x1="40" y1="${m - 10}" x2="40" y2="${H - m + 10}"/>`;
  svg += `<text x="6" y="14">E (eV)</text>`;
  for (const x of lista) {
    const yy = y(x.energia_ev).toFixed(1);
    svg += `<line class="nivel ${x.ocupacion ? 'ocupado' : 'vacio'}" x1="70" x2="150" y1="${yy}" y2="${yy}"><title>${x.etiqueta}: ${x.energia_ev.toFixed(3)} eV</title></line>`;
    svg += `<text x="36" y="${(+yy + 4).toFixed(1)}" text-anchor="end">${x.energia_ev.toFixed(1)}</text>`;
    if (x.etiqueta === 'HOMO' || x.etiqueta === 'LUMO') svg += `<text x="158" y="${(+yy + 4).toFixed(1)}">${x.etiqueta}</text>`;
    if (x.ocupacion) {
      const flechas = x.ocupacion === 2 ? '↑↓' : '↑';
      svg += `<text x="110" y="${(+yy - 4).toFixed(1)}" text-anchor="middle">${flechas}</text>`;
    }
  }
  svg += '</svg>';
  let tabla = '<div class="tabla-scroll"><table><thead><tr><th>Orbital</th><th class="num">N.º</th><th class="num">Ocupación</th><th class="num">E (E<sub>h</sub>)</th><th class="num">E (eV)</th></tr></thead><tbody>';
  for (const x of [...lista].reverse()) {
    tabla += `<tr class="${x.etiqueta === 'HOMO' || x.etiqueta === 'LUMO' ? 'destacada' : ''}"><td>${x.etiqueta}</td><td class="num">${x.indice}</td><td class="num">${x.ocupacion}</td><td class="num">${fx(x.energia_hartree, 5)}</td><td class="num">${fx(x.energia_ev, 3)}</td></tr>`;
  }
  tabla += '</tbody></table></div>';
  const botones = (r.cubos || []).filter((c) => c === 'homo' || c === 'lumo')
    .map((c) => `<button class="btn sec chico" data-ver-sup="${c}" type="button">Ver ${c.toUpperCase()} en 3D</button>`).join(' ');
  panel.innerHTML = `<div class="dos-col"><div>${svg}</div><div>${tabla}
    <p class="nota">${o.capa_cerrada ? 'Capa cerrada (RHF/RKS)' : 'Capa abierta (UHF/UKS): se muestran los orbitales α'} · ${o.n_alfa} e<sup>−</sup> α, ${o.n_beta} e<sup>−</sup> β · ${o.n_funciones_base} funciones de base.</p>
    <div class="grupo-btn">${botones}</div></div></div>`;
}

function panelCargas(r) {
  const panel = $('[data-panel="cargas"]');
  const q = r.cargas_mulliken;
  if (!q) { panel.innerHTML = '<p class="nota">No se obtuvieron cargas de Mulliken.</p>'; return; }
  const suma = q.reduce((s, x) => s + x.carga, 0);
  let html = '<div class="tabla-scroll"><table><thead><tr><th>Átomo</th><th>Elemento</th><th class="num">Carga de Mulliken (e)</th><th></th></tr></thead><tbody>';
  for (const x of q) {
    const ancho = Math.min(60, Math.abs(x.carga) * 100);
    const color = x.carga < 0 ? 'var(--rojo)' : 'var(--azul)';
    html += `<tr><td>${x.atomo}</td><td>${esc(x.elemento)}</td><td class="num">${x.carga >= 0 ? '+' : ''}${x.carga.toFixed(4)}</td><td><span style="display:inline-block;height:8px;width:${ancho}px;background:${color};border-radius:2px"></span></td></tr>`;
  }
  html += `</tbody></table></div><p class="nota">Suma de cargas: ${suma.toFixed(4)} e. Active «Color por carga» y «Etiquetas» en el visor para verlas sobre la molécula (rojo = negativa, azul = positiva). Las cargas de Mulliken dependen mucho de la base.</p>`;
  html += '<button class="btn sec chico" type="button" id="verCargas">Mostrar cargas en el visor</button>';
  panel.innerHTML = html;
}

// ---------- Espectro IR simulado con asignaciones ----------
const SVG_ESTILO = `<style>
  text { font-family: var(--sans, "Segoe UI", Arial, sans-serif); font-size: 12px; fill: var(--gris, #5b6660); }
  .eje { stroke: var(--gris, #5b6660); stroke-width: 1; }
  .rejilla { stroke: var(--borde, #d9e2d5); stroke-width: 1; }
  .curva { fill: none; stroke: var(--verde, #299100); stroke-width: 1.8; }
  .barra { stroke: var(--rojo, #c41237); stroke-width: 1.4; }
  .barra.activa { stroke: var(--azul, #1d4ed8); stroke-width: 3; }
  .guia { fill: none; stroke: var(--gris, #5b6660); stroke-width: .7; stroke-dasharray: 2 2; }
  .etq text { fill: var(--texto, #16201a); }
  .etq .num { font-weight: 700; }
  .etq.activa text { fill: var(--azul, #1d4ed8); }
  .etq, .barra-clic { cursor: pointer; }
  .barra-clic { fill: transparent; }
  .titulo { font-weight: 700; fill: var(--texto, #16201a); }
</style>`;

// Agrupa modos casi degenerados (|Δν| < 2 cm⁻¹) en una sola banda
function bandasIR(modos, escala) {
  const reales = modos.filter((x) => !x.imaginaria).map((x) => ({ ...x, nu: x.frecuencia_cm * escala })).sort((a, b) => a.nu - b.nu);
  const bandas = [];
  for (const m of reales) {
    const b = bandas[bandas.length - 1];
    if (b && Math.abs(m.nu - b.nu) < 2) { b.modos.push(m); b.I += m.intensidad_ir || 0; } else bandas.push({ nu: m.nu, modos: [m], I: m.intensidad_ir || 0 });
  }
  return bandas;
}

function espectroIR(modos, op) {
  const { escala = 1, fwhm = 20, transmitancia = false, todas = false, titulo = '' } = op;
  const asig = estado.asignaciones || new Map();
  const W = 900; const H = 500;
  const banda = 160; // franja superior para las etiquetas
  const m = { l: 58, r: 16, t: banda + 14, b: 46 };
  const reales = modos.filter((x) => !x.imaginaria);
  if (!reales.length) return '<p class="nota">No hay modos reales que dibujar.</p>';
  const conI = reales.some((x) => x.intensidad_ir != null);
  const I = (x) => (conI ? Math.max(0, x.intensidad_ir || 0) : 1);
  const fmax = Math.max(...reales.map((x) => x.frecuencia_cm * escala));
  const fmin = Math.min(...reales.map((x) => x.frecuencia_cm * escala));
  const xmax = Math.max(4000, Math.ceil((fmax + 200) / 500) * 500);
  const xmin = Math.max(0, Math.min(400, Math.floor((fmin - 60) / 100) * 100));
  const X = (f) => m.l + ((xmax - f) / (xmax - xmin)) * (W - m.l - m.r);
  const alto = H - m.t - m.b;
  // v ∈ [0,1] de absorbancia relativa → coordenada y
  const Y = (v) => (transmitancia ? m.t + v * 0.92 * alto : H - m.b - v * 0.92 * alto);
  const g = fwhm / 2;
  const imax = Math.max(...reales.map(I)) || 1;
  const pts = [];
  let cmax = 0;
  for (let f = xmin; f <= xmax; f += 2) {
    let s = 0;
    for (const x of reales) { const d = f - x.frecuencia_cm * escala; s += I(x) * g * g / (d * d + g * g); }
    pts.push([f, s]); cmax = Math.max(cmax, s);
  }
  const curva = (f) => { let s = 0; for (const x of reales) { const d = f - x.frecuencia_cm * escala; s += I(x) * g * g / (d * d + g * g); } return s / (cmax || 1); };

  let svg = `<svg class="grafico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Espectro infrarrojo simulado con asignaciones">${SVG_ESTILO}`;
  if (titulo) svg += `<text class="titulo" x="${m.l}" y="16">${esc(titulo)}</text>`;
  // Rejilla y ejes
  for (let f = Math.ceil(xmin / 500) * 500; f <= xmax; f += 500) {
    svg += `<line class="rejilla" x1="${X(f)}" x2="${X(f)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(f)}" y="${H - m.b + 17}" text-anchor="middle">${f}</text>`;
  }
  // Marcas del eje Y: absorbancia relativa 0–1, o transmitancia T = 100 − 92·A (%)
  const marcas = transmitancia ? [100, 80, 60, 40, 20].map((t) => [(100 - t) / 92, String(t)]) : [0, 0.25, 0.5, 0.75, 1].map((v) => [v, v.toFixed(2)]);
  for (const [v, txt] of marcas) {
    svg += `<line class="rejilla" x1="${m.l - 4}" x2="${m.l}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${m.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${txt}</text>`;
  }
  svg += `<line class="eje" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/><line class="eje" x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}"/>`;
  svg += `<text x="${(W + m.l) / 2}" y="${H - 8}" text-anchor="middle">Número de onda (cm⁻¹)</text>`;
  const ymid = (m.t + H - m.b) / 2;
  svg += `<text x="14" y="${ymid}" text-anchor="middle" transform="rotate(-90 14 ${ymid})">${transmitancia ? 'Transmitancia (%)' : (conI ? 'Absorbancia relativa' : 'Modos (sin intensidad)')}</text>`;
  // Curva (lorentzianas)
  if (conI) svg += `<path class="curva" d="M${pts.map(([f, s]) => `${X(f).toFixed(1)},${Y(s / cmax).toFixed(1)}`).join('L')}"/>`;
  // Barras de cada modo (zona de clic ancha)
  for (const x of reales) {
    const xx = X(x.frecuencia_cm * escala).toFixed(1);
    const v = I(x) / imax;
    const tip = `Modo ${x.numero}: ${(x.frecuencia_cm * escala).toFixed(1)} cm⁻¹${x.intensidad_ir != null ? ` · ${x.intensidad_ir.toFixed(1)} km/mol` : ''}${asig.get(x.numero) ? ` · ${asig.get(x.numero).larga}` : ''}`;
    svg += `<rect class="barra-clic" data-modo="${x.numero}" x="${xx - 5}" y="${m.t}" width="10" height="${alto}"><title>${esc(tip)}</title></rect>`;
    svg += `<line class="barra${estado.modoActivo === x.numero ? ' activa' : ''}" data-barra="${x.numero}" x1="${xx}" x2="${xx}" y1="${Y(0).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
  }
  // Etiquetas: número de onda + asignación corta
  let bandas = bandasIR(modos, escala);
  const bmax = Math.max(...bandas.map((b) => b.I)) || 1;
  if (!todas && conI) bandas = bandas.filter((b) => b.I / bmax >= 0.02);
  const sep = 14;
  const ancho = W - m.l - m.r - 12;
  const maxEtq = Math.floor(ancho / sep);
  if (bandas.length > maxEtq) bandas = [...bandas].sort((a, b) => b.I - a.I).slice(0, maxEtq).sort((a, b) => a.nu - b.nu);
  // De mayor a menor número de onda = de izquierda a derecha
  bandas.sort((a, b) => b.nu - a.nu);
  const pos = bandas.map((b) => X(b.nu));
  const L = m.l + 8; const R = W - m.r - 4;
  for (let i = 0; i < pos.length; i++) pos[i] = Math.max(pos[i], i ? pos[i - 1] + sep : L);
  if (pos.length && pos[pos.length - 1] > R) {
    pos[pos.length - 1] = R;
    for (let i = pos.length - 2; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - sep);
  }
  bandas.forEach((b, i) => {
    const px = X(b.nu);
    const lx = pos[i];
    const tope = transmitancia ? m.t : Y(curvaOStick(b));
    const a = asig.get(b.modos[0].numero);
    const corta = a ? a.corta : '';
    const corto = corta.length > 25 ? `${corta.slice(0, 24)}…` : corta;
    const activa = b.modos.some((x) => x.numero === estado.modoActivo);
    svg += `<path class="guia" d="M${lx.toFixed(1)},${banda + 4} L${lx.toFixed(1)},${banda + 8} L${px.toFixed(1)},${(tope - 4).toFixed(1)}"/>`;
    svg += `<g class="etq${activa ? ' activa' : ''}" data-modo="${b.modos[0].numero}"><title>${esc(b.modos.map((x) => `Modo ${x.numero}`).join(', '))} · ${b.nu.toFixed(1)} cm⁻¹${a ? ` · ${esc(a.larga)}` : ''}</title>`;
    svg += `<text transform="translate(${(lx + 4).toFixed(1)},${banda}) rotate(-90)"><tspan class="num">${Math.round(b.nu)}${b.modos.length > 1 ? ` (×${b.modos.length})` : ''}</tspan>${corto ? ` ${esc(corto)}` : ''}</text></g>`;
  });
  return `${svg}</svg>`;

  function curvaOStick(b) {
    return conI ? Math.max(curva(b.nu), Math.max(...b.modos.map(I)) / imax) : 1;
  }
}

function panelVibraciones(r) {
  const panel = $('[data-panel="vibraciones"]');
  const f = r.frecuencias;
  if (!f) {
    const n = (r.geometria_xyz || '').trim().split('\n').length;
    panel.innerHTML = n < 2
      ? '<p class="nota">Un átomo aislado no tiene modos de vibración.</p>'
      : `<p class="nota">Este cálculo no incluyó frecuencias, por eso no hay espectro IR ni modos de vibración.</p>
         <button class="btn" type="button" id="calcFrecuencias">Calcular frecuencias de esta molécula (${esc(nombreDe('metodos', r.metodo))}/${esc(nombreDe('bases', r.base))})</button>
         <p class="nota">Se parte de la geometría ${r.tarea === 'energia' ? 'de este cálculo' : 'ya optimizada'}; Psi4 la reoptimiza (pocos pasos) y calcula el hessiano. Los resultados se abren aquí al terminar.</p>`;
    panel.onclick = (ev) => { if (ev.target.id === 'calcFrecuencias') calcularFrecuencias(ev.target); };
    return;
  }
  const asig = estado.asignaciones || new Map();
  const sugerido = { hf: 0.90, b3lyp: 0.96, pbe0: 0.95, 'wb97x-d': 0.95, 'm06-2x': 0.95, mp2: 0.95 }[r.metodo] || 1;
  let html = `<div class="controles-fila">
    <label>Factor de escala <input type="number" id="escalaIR" min="0.8" max="1.1" step="0.005" value="1"></label>
    <button class="btn sec chico" type="button" id="usarSugerido">Usar ${sugerido} (sugerido para ${esc(nombreDe('metodos', r.metodo))})</button>
    <label>Ancho de banda <input type="number" id="anchoIR" min="4" max="80" step="2" value="20"> cm⁻¹</label>
    <label>Mostrar <select id="modoIR"><option value="a">Absorbancia</option><option value="t">Transmitancia</option></select></label>
    <label class="chk"><input type="checkbox" id="todasIR"> Rotular todos los modos</label>
  </div>
  <div id="espectro"></div>
  <div class="controles-fila">
    <button class="btn sec chico" type="button" id="bajarSVG">Espectro SVG</button>
    <button class="btn sec chico" type="button" id="bajarPNG">Espectro PNG</button>
    <button class="btn sec chico" type="button" id="bajarCSV">Tabla CSV</button>
  </div>
  <p class="nota">Cada banda lleva su número de onda (cm⁻¹) y su asignación: <b>ν</b> estiramiento, <b>δ</b> flexión o deformación, <b>ρ</b> balanceo, <b>γ</b> flexión fuera del plano, <b>τ</b> torsión; subíndice ₛ simétrico, ₐₛ asimétrico. La asignación se calcula a partir del vector de cada modo (contribución aproximada de cada coordenada interna) y es orientativa. Haga clic en un pico, una etiqueta o una fila para animar el modo en el visor 3D. Frecuencias armónicas${f.modos.some((x) => x.intensidad_ir != null) ? '; intensidades IR en km/mol' : ''}.</p>
  <div class="tabla-scroll"><table><thead><tr><th>Modo</th><th class="num">ν calculada (cm⁻¹)</th><th class="num">ν escalada</th><th class="num">Intensidad IR (km/mol)</th><th>Asignación</th></tr></thead><tbody id="tablaModos">`;
  for (const x of f.modos) {
    const a = asig.get(x.numero);
    html += `<tr class="clic${estado.modoActivo === x.numero ? ' activa' : ''}" data-modo="${x.numero}"><td>${x.numero}</td>
      <td class="num">${x.imaginaria ? `${Math.abs(x.frecuencia_cm).toFixed(1)} i` : x.frecuencia_cm.toFixed(1)}</td>
      <td class="num" data-escalada="${x.frecuencia_cm}">${x.imaginaria ? '—' : x.frecuencia_cm.toFixed(1)}</td>
      <td class="num">${x.intensidad_ir != null ? x.intensidad_ir.toFixed(2) : '—'}</td>
      <td class="asig">${a ? `<b>${esc(a.corta)}</b><span>${esc(a.larga)}</span>` : '—'}</td></tr>`;
  }
  html += '</tbody></table></div>';
  panel.innerHTML = html;
  const opciones = () => ({
    escala: parseFloat($('#escalaIR').value) || 1,
    fwhm: Math.min(80, Math.max(4, parseFloat($('#anchoIR').value) || 20)),
    transmitancia: $('#modoIR').value === 't',
    todas: $('#todasIR').checked,
  });
  const dibujar = () => {
    const op = opciones();
    $('#espectro').innerHTML = espectroIR(f.modos, op);
    $$('[data-escalada]').forEach((td) => { td.textContent = (parseFloat(td.dataset.escalada) * op.escala).toFixed(1); });
  };
  estado.redibujarIR = dibujar;
  dibujar();
  ['#escalaIR', '#anchoIR'].forEach((s) => $(s).addEventListener('input', dibujar));
  ['#modoIR', '#todasIR'].forEach((s) => $(s).addEventListener('change', dibujar));
  $('#usarSugerido').addEventListener('click', () => { $('#escalaIR').value = sugerido; dibujar(); });
  const nombre = (estado.infoTrabajo?.titulo || 'molecula').replace(/\s+/g, '_');
  const svgDescargable = () => espectroIR(f.modos, { ...opciones(), titulo: `${estado.infoTrabajo?.titulo || ''} · ${nombreDe('metodos', r.metodo)}/${nombreDe('bases', r.base)} · IR simulado` })
    .replace('class="grafico" ', '').replace('<svg ', '<svg width="1800" height="1000" style="background:#fff" ');
  $('#bajarSVG').addEventListener('click', () => descargar(svgDescargable(), `${nombre}_IR.svg`, 'image/svg+xml'));
  $('#bajarPNG').addEventListener('click', () => {
    const img = new Image();
    img.onload = () => {
      const c = Object.assign(document.createElement('canvas'), { width: 1800, height: 1000 });
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      descargar(c.toDataURL('image/png'), `${nombre}_IR.png`);
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDescargable())}`;
  });
  $('#bajarCSV').addEventListener('click', () => {
    const esc_ = opciones().escala;
    const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
    const filas = [['modo', 'frecuencia_cm-1', 'escalada_cm-1', 'intensidad_IR_km/mol', 'asignacion', 'descripcion'].join(',')];
    for (const x of f.modos) {
      const a = asig.get(x.numero);
      filas.push([x.numero, x.frecuencia_cm.toFixed(2), x.imaginaria ? '' : (x.frecuencia_cm * esc_).toFixed(2),
        x.intensidad_ir != null ? x.intensidad_ir.toFixed(3) : '', q(a ? a.corta : ''), q(a ? a.larga : '')].join(','));
    }
    descargar(`﻿${filas.join('\r\n')}\r\n`, `${nombre}_modos_IR.csv`, 'text/csv');
  });
  panel.onclick = (ev) => {
    const el = ev.target.closest('[data-modo]');
    if (!el) return;
    animarModo(parseInt(el.dataset.modo, 10));
    $('#visor').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}

// ---------- Animación de los modos normales ----------
const textoFrecuencia = (m) => (m.imaginaria ? `${Math.abs(m.frecuencia_cm).toFixed(1)}i` : m.frecuencia_cm.toFixed(1));
const modosAnimables = () => (estado.resultado?.frecuencias?.modos || []).filter((m) => m.desplazamientos);

function atomosBase() {
  return String(estado.resultado.geometria_xyz).trim().split(/\r?\n/).map((l) => {
    const [el, x, y, z] = l.trim().split(/\s+/);
    return { el, x: +x, y: +y, z: +z };
  });
}

// Cuadros XYZ de un ciclo completo: x(t) = x0 + A·sen(2πt)·d
function xyzAnimado(modo, amp, cuadros = 24) {
  const base = atomosBase();
  let texto = '';
  for (let k = 0; k < cuadros; k++) {
    const s = amp * Math.sin((2 * Math.PI * k) / cuadros);
    texto += `${base.length}\nModo ${modo.numero} ${textoFrecuencia(modo)} cm-1 cuadro ${k + 1}\n`;
    base.forEach((a, i) => {
      const d = modo.desplazamientos[i] || [0, 0, 0];
      texto += `${a.el} ${(a.x + s * d[0]).toFixed(5)} ${(a.y + s * d[1]).toFixed(5)} ${(a.z + s * d[2]).toFixed(5)}\n`;
    });
  }
  return texto;
}

function animarModo(numero) {
  const modo = modosAnimables().find((x) => x.numero === numero);
  if (!modo) return;
  detenerAnimacion();
  const v = estado.visor;
  const amp = parseFloat($('#vibAmplitud').value) || 0.6;
  const vel = parseFloat($('#vibVelocidad').value) || 5;
  estado.modoActivo = numero;
  v.removeAllModels();
  v.removeAllLabels();
  v.addModelsAsFrames(xyzAnimado(modo, amp), 'xyz');
  aplicarEstilo();
  if ($('#vibFlechas').checked) {
    atomosBase().forEach((a, i) => {
      const d = modo.desplazamientos[i] || [0, 0, 0];
      const largo = Math.hypot(...d) * amp;
      if (largo < 0.06) return;
      const k = 2 * amp;
      estado.flechas.push(v.addArrow({
        start: { x: a.x, y: a.y, z: a.z },
        end: { x: a.x + k * d[0], y: a.y + k * d[1], z: a.z + k * d[2] },
        radius: 0.05, radiusRatio: 2.2, mid: 0.75, color: '#c41237',
      }));
    });
  }
  v.animate({ loop: 'forward', interval: Math.round(110 / vel) });
  v.render();
  $('#modoVib').value = String(numero);
  $('#vibPlay').textContent = '■ Detener';
  $$('[data-barra]').forEach((b) => b.classList.toggle('activa', b.dataset.barra === String(numero)));
  $$('.etq').forEach((g) => g.classList.toggle('activa', g.dataset.modo === String(numero)));
  $$('#tablaModos tr').forEach((tr) => tr.classList.toggle('activa', tr.dataset.modo === String(numero)));
  const asignacion = estado.asignaciones?.get(numero);
  $('#etiquetaModelo').textContent = `Modo ${numero} de ${modosAnimables().length}: ${textoFrecuencia(modo)} cm⁻¹${modo.imaginaria ? ' (imaginaria)' : ''}${asignacion ? ` · ${asignacion.corta}` : ''}`;
  $('#etiquetaModelo').title = asignacion ? asignacion.larga : '';
}

function detenerVibracion() {
  if (!estado.resultado) return;
  cargarModelo(estado.resultado.geometria_xyz, 'xyz', { zoom: false });
  etiquetaModeloResultado();
}

function prepararVibraciones(r) {
  const modos = (r.frecuencias?.modos || []).filter((m) => m.desplazamientos);
  $('#barraVib').hidden = !modos.length;
  const asig = estado.asignaciones || new Map();
  $('#modoVib').innerHTML = modos.map((m) => `<option value="${m.numero}">Modo ${m.numero} · ${textoFrecuencia(m)} cm⁻¹${asig.get(m.numero) ? ` · ${esc(asig.get(m.numero).corta)}` : ''}${m.intensidad_ir != null ? ` · IR ${m.intensidad_ir.toFixed(1)}` : ''}</option>`).join('');
}

function pasarModo(paso) {
  const modos = modosAnimables();
  if (!modos.length) return;
  const actual = parseInt($('#modoVib').value, 10);
  const i = Math.max(0, modos.findIndex((m) => m.numero === actual));
  animarModo(modos[(i + paso + modos.length) % modos.length].numero);
}

async function calcularFrecuencias(boton) {
  const t = estado.infoTrabajo;
  const r = estado.resultado;
  boton.disabled = true;
  try {
    const nuevo = await api('/api/calculos', {
      method: 'POST',
      body: JSON.stringify({
        xyz: r.geometria_xyz, formula: t.formula, smiles: t.smiles || '',
        titulo: `${t.titulo} (frecuencias)`.slice(0, 80),
        metodo: r.metodo, base: r.base, tarea: 'frecuencias',
        carga: r.carga, multiplicidad: r.multiplicidad, mep: (r.cubos || []).includes('mep'),
      }),
    });
    guardarEnHistorial(nuevo);
    seguir(nuevo.id);
  } catch (e) {
    alert(e.message);
    boton.disabled = false;
  }
}

function panelOptimizacion(r) {
  const panel = $('[data-panel="optimizacion"]');
  const tr = (r.trayectoria || []).filter((p) => p.energia != null);
  if (!tr.length) { panel.innerHTML = '<p class="nota">Este cálculo no incluyó optimización de geometría.</p>'; return; }
  const W = 760; const H = 260; const m = { l: 60, r: 14, t: 14, b: 40 };
  const efin = tr[tr.length - 1].energia;
  const rel = tr.map((p) => (p.energia - efin) * HARTREE_KCAL);
  const ymax = Math.max(...rel, 1e-6); const ymin = Math.min(...rel, 0);
  const X = (i) => m.l + (tr.length === 1 ? 0.5 : i / (tr.length - 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - ymin) / (ymax - ymin || 1)) * (H - m.t - m.b);
  let svg = `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Energía durante la optimización">`;
  for (let k = 0; k <= 4; k++) {
    const v = ymin + (k / 4) * (ymax - ymin);
    svg += `<line class="rejilla" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`;
  }
  svg += `<line class="eje" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  tr.forEach((p, i) => { svg += `<text x="${X(i)}" y="${H - m.b + 16}" text-anchor="middle">${p.paso}</text>`; });
  svg += `<text x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle">Paso de optimización</text>`;
  svg += `<text x="14" y="${(H - m.b + m.t) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(H - m.b + m.t) / 2})">ΔE (kcal/mol)</text>`;
  svg += `<path class="curva" d="M${tr.map((p, i) => `${X(i).toFixed(1)},${Y(rel[i]).toFixed(1)}`).join('L')}"/>`;
  tr.forEach((p, i) => { svg += `<circle class="punto" data-paso="${i}" cx="${X(i)}" cy="${Y(rel[i])}" r="5" style="cursor:pointer"><title>Paso ${p.paso}: ${p.energia.toFixed(8)} Eh (ΔE ${rel[i].toFixed(3)} kcal/mol)</title></circle>`; });
  svg += '</svg>';
  panel.innerHTML = `${svg}
    <div class="controles-fila">
      <button class="btn sec chico" type="button" id="reproducirOpt">▶ Reproducir</button>
      <label>Paso <input type="range" id="pasoOpt" min="0" max="${tr.length - 1}" value="${tr.length - 1}"></label>
      <span id="infoPaso" class="nota"></span>
    </div>
    <p class="nota">${tr.length} pasos. La energía baja hasta converger en el mínimo. Diferencia total: ${(rel[0]).toFixed(3)} kcal/mol respecto a la geometría inicial (MMFF).</p>`;
  const verPaso = (i) => {
    i = Math.max(0, Math.min(tr.length - 1, i));
    $('#pasoOpt').value = i;
    $('#infoPaso').textContent = `Paso ${tr[i].paso}: E = ${tr[i].energia.toFixed(8)} Eh · ΔE = ${rel[i].toFixed(3)} kcal/mol`;
    $$('[data-paso]').forEach((c) => c.classList.toggle('activo', c.dataset.paso === String(i)));
    const v = estado.visor;
    v.stopAnimate();
    quitarFlechas();
    estado.modoActivo = null;
    $('#vibPlay').textContent = '▶ Animar';
    v.removeAllModels();
    v.addModel(xyzCompleto(tr[i].xyz), 'xyz');
    aplicarEstilo();
    $('#etiquetaModelo').textContent = `Optimización · paso ${tr[i].paso} de ${tr.length}`;
  };
  $('#pasoOpt').addEventListener('input', (e) => { detenerReproduccion(); verPaso(parseInt(e.target.value, 10)); });
  panel.querySelector('svg').addEventListener('click', (e) => {
    const c = e.target.closest('[data-paso]');
    if (c) { detenerReproduccion(); verPaso(parseInt(c.dataset.paso, 10)); }
  });
  const detenerReproduccion = () => { clearInterval(estado.reproductor); estado.reproductor = null; $('#reproducirOpt').textContent = '▶ Reproducir'; };
  $('#reproducirOpt').addEventListener('click', () => {
    if (estado.reproductor) { detenerReproduccion(); return; }
    estado.visor.stopAnimate();
    let i = 0;
    $('#reproducirOpt').textContent = '■ Detener';
    verPaso(0);
    estado.reproductor = setInterval(() => {
      i++;
      if (i >= tr.length) { detenerReproduccion(); return; }
      verPaso(i);
    }, 450);
  });
  $('#infoPaso').textContent = `Paso ${tr[tr.length - 1].paso}: E = ${efin.toFixed(8)} Eh (final)`;
}

// ---------- Camino de reacción (IRC) ----------
// Perfil de energía relativo al TS frente a la coordenada de reacción s, y animación del camino
function panelIRC(t, r) {
  const panel = $('[data-panel="optimizacion"]');
  const pts = [...r.irc.puntos].sort((a, b) => a.s - b.s);
  const W = 760; const H = 280; const m = { l: 62, r: 16, t: 28, b: 44 };
  const xs = pts.map((p) => p.s); const ys = pts.map((p) => p.de_kcal);
  const xmin = Math.min(...xs); const xmax = Math.max(...xs);
  const ymin = Math.min(...ys, 0); const ymax = Math.max(...ys, 0) > ymin ? Math.max(...ys, 0) : ymin + 0.1;
  const X = (s) => m.l + ((s - xmin) / (xmax - xmin || 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - ymin) / (ymax - ymin || 1)) * (H - m.t - m.b);
  const its = pts.findIndex((p) => Math.abs(p.s) < 1e-9);
  let svg = `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Perfil de energía del IRC">`;
  for (let k = 0; k <= 4; k++) {
    const v = ymin + (k / 4) * (ymax - ymin);
    svg += `<line class="rejilla" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`;
  }
  for (let k = 0; k <= 4; k++) {
    const s = xmin + (k / 4) * (xmax - xmin);
    svg += `<text x="${X(s)}" y="${H - m.b + 16}" text-anchor="middle">${s.toFixed(2)}</text>`;
  }
  svg += `<line class="eje" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  svg += `<text x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle">Coordenada de reacción s (bohr·amu½) · − hacia atrás · + hacia adelante</text>`;
  svg += `<text x="14" y="${(H - m.b + m.t) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(H - m.b + m.t) / 2})">E − E(TS) (kcal/mol)</text>`;
  svg += `<path class="curva" d="M${pts.map((p) => `${X(p.s).toFixed(1)},${Y(p.de_kcal).toFixed(1)}`).join('L')}"/>`;
  pts.forEach((p, i) => {
    const ts = i === its;
    svg += `<circle class="punto${ts ? ' ts' : ''}" data-paso="${i}" cx="${X(p.s)}" cy="${Y(p.de_kcal)}" r="${ts ? 7 : 5}" style="cursor:pointer"><title>${ts ? 'TS · ' : ''}s = ${p.s.toFixed(3)} · E = ${p.energia.toFixed(8)} Eh · ΔE = ${p.de_kcal.toFixed(2)} kcal/mol</title></circle>`;
  });
  if (its >= 0) svg += `<text x="${X(0)}" y="${Y(pts[its].de_kcal) - 12}" text-anchor="middle" class="etq-ts">TS</text>`;
  svg += '</svg>';
  panel.innerHTML = `${svg}
    <div class="controles-fila">
      <button class="btn sec chico" type="button" id="reproducirOpt">▶ Reproducir reacción</button>
      <label>Punto <input type="range" id="pasoOpt" min="0" max="${pts.length - 1}" value="${Math.max(its, 0)}"></label>
      <button class="btn sec chico" type="button" id="bajarIRC" title="Todos los puntos del camino como XYZ de varios cuadros (Avogadro, Jmol, VMD)">IRC como XYZ animado</button>
      ${r.iboview?.puntos_molden?.length ? '<button class="btn chico" type="button" data-guardar="molden-puntos" title="Un .molden por punto del IRC, con nombre base y numeración, en la carpeta que elija">Guardar .molden numerados…</button>' : ''}
      ${r.iboview?.irc_zip ? '<button class="btn sec chico" type="button" data-guardar="ibo-irc" title="Un .molden por punto del IRC para animar los IBO en IboView">IRC para IboView (.zip)</button>' : ''}
      <span id="infoPaso" class="nota"></span>
    </div>
    <p class="nota">${pts.length} puntos del camino de mínima energía (coordenadas ponderadas por masa). El TS está en s = 0; los extremos se acercan a los mínimos de reactivos y productos. Para energías exactas de reactivos y productos, optimice la geometría de cada extremo.</p>`;
  const verPaso = (i) => {
    i = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[i];
    $('#pasoOpt').value = i;
    $('#infoPaso').textContent = `${i === its ? 'TS · ' : ''}s = ${p.s.toFixed(3)} · E = ${p.energia.toFixed(8)} Eh · ΔE = ${p.de_kcal.toFixed(2)} kcal/mol`;
    $$('[data-panel="optimizacion"] [data-paso]').forEach((c) => c.classList.toggle('activo', c.dataset.paso === String(i)));
    const v = estado.visor;
    v.stopAnimate();
    quitarFlechas();
    estado.modoActivo = null;
    $('#vibPlay').textContent = '▶ Animar';
    v.removeAllModels();
    v.addModel(xyzCompleto(p.xyz), 'xyz'); // enlaces por distancia: se ven formarse y romperse
    aplicarEstilo();
    $('#etiquetaModelo').textContent = `IRC · punto ${i + 1} de ${pts.length}${i === its ? ' (TS)' : ''} · s = ${p.s.toFixed(2)}`;
  };
  const detener = () => { clearInterval(estado.reproductor); estado.reproductor = null; $('#reproducirOpt').textContent = '▶ Reproducir reacción'; };
  $('#pasoOpt').addEventListener('input', (e) => { detener(); verPaso(parseInt(e.target.value, 10)); });
  panel.querySelector('svg').addEventListener('click', (e) => {
    const c = e.target.closest('[data-paso]');
    if (c) { detener(); verPaso(parseInt(c.dataset.paso, 10)); }
  });
  $('#reproducirOpt').addEventListener('click', () => {
    if (estado.reproductor) { detener(); return; }
    estado.visor.stopAnimate();
    // De un extremo al otro y de vuelta, hasta que se detenga
    let i = 0; let sentido = 1;
    $('#reproducirOpt').textContent = '■ Detener';
    verPaso(0);
    estado.reproductor = setInterval(() => {
      if (i + sentido < 0 || i + sentido >= pts.length) sentido = -sentido;
      i += sentido;
      verPaso(i);
    }, 220);
  });
  $('#bajarIRC').addEventListener('click', () => {
    const marcos = pts.map((p, i) => {
      const lineas = p.xyz.trim().split(/\r?\n/);
      return `${lineas.length}\nIRC punto ${i + 1} s=${p.s.toFixed(4)} E=${p.energia.toFixed(8)}${i === its ? ' TS' : ''}\n${lineas.join('\n')}`;
    });
    descargar(`${marcos.join('\n')}\n`, `${nombreSeguro(t.titulo)}_IRC.xyz`);
  });
  $('#infoPaso').textContent = 'Pulse un punto o «Reproducir reacción».';
}

// ---------- Scan relajado ----------
function panelScan(t, r) {
  const panel = $('[data-panel="optimizacion"]');
  const sc = r.scan;
  const S = sc.simbolo || 'R'; const U = sc.unidad || 'Å'; const dec = U === 'Å' ? 3 : 1;
  const nombreTipo = { distancia: 'la distancia', angulo: 'el ángulo', diedro: 'el diedro' }[sc.tipo || 'distancia'];
  const todos = sc.puntos.map((p) => ({ ...p, v: p.valor ?? p.r, vf: p.valor_final ?? p.r_final }));
  const pts = todos.filter((p) => p.energia != null);
  const W = 760; const H = 280; const m = { l: 62, r: 16, t: 18, b: 44 };
  const xs = pts.map((p) => p.v); const ys = pts.map((p) => p.de_min_kcal);
  const xmin = Math.min(...xs); const xmax = Math.max(...xs);
  const ymin = 0; const ymax = Math.max(...ys, 0.1);
  const X = (s) => (xmax > xmin ? m.l + ((s - xmin) / (xmax - xmin)) * (W - m.l - m.r) : (W + m.l) / 2);
  const Y = (v) => H - m.b - ((v - ymin) / (ymax - ymin)) * (H - m.t - m.b);
  let svg = `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Energía del scan relajado">`;
  for (let k = 0; k <= 4; k++) {
    const v = ymin + (k / 4) * (ymax - ymin);
    svg += `<line class="rejilla" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`;
  }
  pts.forEach((p) => { svg += `<text x="${X(p.v)}" y="${H - m.b + 16}" text-anchor="middle">${p.v.toFixed(U === 'Å' ? 2 : 0)}</text>`; });
  svg += `<line class="eje" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  svg += `<text x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle">${S}(${esc(sc.etiqueta)}) (${U})</text>`;
  svg += `<text x="14" y="${(H - m.b + m.t) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(H - m.b + m.t) / 2})">E − E(mín) (kcal/mol)</text>`;
  if (pts.length > 1) svg += `<path class="curva" d="M${pts.map((p) => `${X(p.v).toFixed(1)},${Y(p.de_min_kcal).toFixed(1)}`).join('L')}"/>`;
  pts.forEach((p, i) => {
    svg += `<circle class="punto${p.convergio ? '' : ' sin-converger'}" data-paso="${i}" cx="${X(p.v)}" cy="${Y(p.de_min_kcal)}" r="5.5" style="cursor:pointer"><title>${S} = ${p.v.toFixed(dec)} ${U} · E = ${p.energia.toFixed(8)} Eh · ΔE(mín) = ${p.de_min_kcal.toFixed(2)} kcal/mol${p.convergio ? '' : ' · no convergió'}</title></circle>`;
  });
  svg += '</svg>';
  panel.innerHTML = `${svg}
    <div class="controles-fila">
      <button class="btn sec chico" type="button" id="reproducirOpt">▶ Reproducir scan</button>
      ${r.iboview?.puntos_molden?.length ? '<button class="btn chico" type="button" data-guardar="molden-puntos" title="Un .molden por punto del scan, con nombre base y numeración, en la carpeta que elija">Guardar .molden numerados…</button>' : ''}
      <label>Punto <input type="range" id="pasoOpt" min="0" max="${pts.length - 1}" value="0"></label>
      <button class="btn sec chico" type="button" id="bajarScanCSV">Tabla CSV</button>
      <button class="btn sec chico" type="button" id="bajarScanXYZ" title="Todas las geometrías del scan como XYZ de varios cuadros (Avogadro, Jmol, VMD)">XYZ animado</button>
      <span id="infoPaso" class="nota"></span>
    </div>
    <div class="tabla-scroll"><table><thead><tr><th class="num">${S} (${U})</th><th class="num">${S} final (${U})</th><th class="num">E (E<sub>h</sub>)</th><th class="num">ΔE vs. 1.º (kcal/mol)</th><th class="num">ΔE vs. mín (kcal/mol)</th><th></th></tr></thead><tbody>
      ${todos.map((p, i) => `<tr data-fila="${i}"><td class="num">${p.v.toFixed(dec)}</td><td class="num">${fx(p.vf, dec + 1)}</td><td class="num">${fx(p.energia, 8)}</td><td class="num">${fx(p.de_kcal, 3)}</td><td class="num">${fx(p.de_min_kcal, 3)}</td><td>${p.convergio ? (p.nota ? `<span class="info" title="${esc(p.nota)}">≈ convergió en energía</span>` : '') : `<span class="aviso-chico" title="${esc(p.nota)}">no convergió</span>`}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="nota">En cada punto ${nombreTipo} ${esc(sc.etiqueta)} queda fijo y el resto de la molécula se optimiza. La misma tabla está al final de la salida de Psi4 (.out), en «SCAN RELAJADO».</p>`;
  const verPaso = (i) => {
    i = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[i];
    $('#pasoOpt').value = i;
    $('#infoPaso').textContent = `${S} = ${p.v.toFixed(dec)} ${U} · E = ${p.energia.toFixed(8)} Eh · ΔE(mín) = ${p.de_min_kcal.toFixed(2)} kcal/mol`;
    $$('[data-panel="optimizacion"] [data-paso]').forEach((c) => c.classList.toggle('activo', c.dataset.paso === String(i)));
    const v = estado.visor;
    v.stopAnimate();
    quitarFlechas();
    estado.modoActivo = null;
    $('#vibPlay').textContent = '▶ Animar';
    v.removeAllModels();
    v.addModel(xyzCompleto(p.xyz), 'xyz');
    aplicarEstilo();
    $('#etiquetaModelo').textContent = `Scan · punto ${i + 1} de ${pts.length} · ${S}(${sc.etiqueta}) = ${p.v.toFixed(dec)} ${U}`;
  };
  const detener = () => { clearInterval(estado.reproductor); estado.reproductor = null; $('#reproducirOpt').textContent = '▶ Reproducir scan'; };
  $('#pasoOpt').addEventListener('input', (e) => { detener(); verPaso(parseInt(e.target.value, 10)); });
  panel.querySelector('svg').addEventListener('click', (e) => {
    const c = e.target.closest('[data-paso]');
    if (c) { detener(); verPaso(parseInt(c.dataset.paso, 10)); }
  });
  $('#reproducirOpt').addEventListener('click', () => {
    if (estado.reproductor) { detener(); return; }
    estado.visor.stopAnimate();
    let i = 0; let sentido = 1;
    $('#reproducirOpt').textContent = '■ Detener';
    verPaso(0);
    estado.reproductor = setInterval(() => {
      if (i + sentido < 0 || i + sentido >= pts.length) sentido = -sentido;
      i += sentido;
      verPaso(i);
    }, 450);
  });
  $('#bajarScanCSV').addEventListener('click', () => {
    const filas = [[U === 'Å' ? 'R_A' : `${sc.tipo}_grados`, U === 'Å' ? 'R_final_A' : `${sc.tipo}_final_grados`, 'E_Eh', 'dE_primero_kcal_mol', 'dE_minimo_kcal_mol', 'convergio']];
    todos.forEach((p) => filas.push([p.v.toFixed(4), fx(p.vf, 5), fx(p.energia, 10), fx(p.de_kcal, 4), fx(p.de_min_kcal, 4), p.convergio ? 'si' : 'no']));
    descargar(filas.map((f) => f.join(',')).join('\n') + '\n', `${nombreSeguro(t.titulo)}_scan.csv`, 'text/csv');
  });
  $('#bajarScanXYZ').addEventListener('click', () => {
    const marcos = pts.map((p) => {
      const l = p.xyz.trim().split(/\r?\n/);
      return `${l.length}\nScan ${S}(${sc.etiqueta}) = ${p.v.toFixed(4)} ${U === 'Å' ? 'A' : 'grados'}  E = ${p.energia.toFixed(8)}\n${l.join('\n')}`;
    });
    descargar(`${marcos.join('\n')}\n`, `${nombreSeguro(t.titulo)}_scan.xyz`);
  });
  $('#infoPaso').textContent = 'Pulse un punto o «Reproducir scan».';
}

// Lanza un IRC desde la geometría del TS de este resultado
async function calcularIRC(boton) {
  const t = estado.infoTrabajo;
  const r = estado.resultado;
  boton.disabled = true;
  try {
    const nuevo = await api('/api/calculos', {
      method: 'POST',
      body: JSON.stringify({
        xyz: r.geometria_xyz, formula: t.formula, smiles: t.smiles || '',
        titulo: `${t.titulo} (IRC)`.slice(0, 80),
        metodo: r.metodo, base: r.base, tarea: 'irc', irc: opcionesIRCForm(),
        carga: r.carga, multiplicidad: r.multiplicidad, mep: false,
      }),
    });
    guardarEnHistorial(nuevo);
    seguir(nuevo.id);
  } catch (e) {
    alert(e.message);
    boton.disabled = false;
  }
}

// Botones e instrucciones para IboView (orbitales intrínsecos de enlace)
function bloqueIboView(r) {
  const ib = r.iboview;
  if (!ib) return r.aviso_iboview ? `<p class="nota">${esc(r.aviso_iboview)}</p>` : '';
  const nPuntos = ib.puntos_molden?.length || 0;
  const delQue = ib.puntos_tipo === 'irc' ? 'del IRC' : 'del scan';
  return `<h3 class="sub-iboview">Función de onda en formato Molden (IboView)</h3>
    <div class="grupo-btn">
      <button class="btn sec" type="button" data-guardar="molden">Descargar .molden</button>
      ${ib.naturales ? '<button class="btn sec" type="button" data-guardar="naturales">Orbitales naturales MP2 (.molden)</button>' : ''}
      ${nPuntos ? `<button class="btn" type="button" data-guardar="molden-puntos">Guardar los ${nPuntos} .molden ${delQue} numerados…</button>` : ''}
      ${ib.irc_zip ? `<button class="btn sec" type="button" data-guardar="ibo-irc">IRC para IboView (.zip, ${ib.irc_puntos} archivos .molden)</button>` : ''}
      ${ib.scan_zip ? `<button class="btn sec" type="button" data-guardar="ibo-scan">Scan para IboView (.zip, ${nPuntos} archivos .molden)</button>` : ''}
    </div>
    <p class="nota">IboView lee la función de onda (base y orbitales) y construye él mismo los IBO a partir de los orbitales ocupados.
    ${nPuntos ? `«Guardar … numerados» pide un nombre base y una carpeta y escribe base_001.molden … base_${String(nPuntos).padStart(3, '0')}.molden en el orden ${ib.puntos_tipo === 'irc' ? 'del camino (reactivo → TS → producto)' : 'del scan'}; ábralos todos a la vez en IboView para verlos como cuadros de una trayectoria.` : ''}
    ${ib.irc_zip ? 'Para el mecanismo: descomprima el .zip y abra en IboView <b>todos</b> los <code>irc_*.molden</code> a la vez; se cargan como cuadros de una trayectoria (reactivo → TS → producto) y los IBO se alinean entre cuadros, de modo que se ve el flujo de electrones. Las instrucciones están en <code>LEAME.txt</code>.' : ''}
    ${ib.naturales ? ' Los orbitales naturales MP2 vienen de la densidad MP2 relajada; sus ocupaciones (≈2, ≈0 y valores intermedios) indican la correlación electrónica.' : (r.metodo !== 'mp2' ? ' Con HF o DFT, los orbitales naturales coinciden con los canónicos (ocupaciones 2 y 0).' : '')}
    ${ib.aviso_naturales ? `<br>${esc(ib.aviso_naturales)}` : ''}</p>`;
}

// ---------- .molden numerados (IRC y scan): nombre base y carpeta ----------
const nombreNumerado = (base, k, n) => `${base}_${String(k).padStart(Math.max(3, String(n).length), '0')}.molden`;
function baseMolden() {
  return $('#dlgMoldenBase').value.trim().replace(/\.molden$/i, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'molden';
}
function vistaMolden() {
  const n = estado.resultado?.iboview?.puntos_molden?.length || 0;
  const b = baseMolden();
  $('#dlgMoldenVista').textContent = n > 2 ? `${nombreNumerado(b, 1, n)}, ${nombreNumerado(b, 2, n)} … ${nombreNumerado(b, n, n)}` : [1, 2].slice(0, n).map((k) => nombreNumerado(b, k, n)).join(', ');
}
function abrirDialogoMolden({ alTerminar = false } = {}) {
  const t = estado.infoTrabajo; const ib = estado.resultado?.iboview;
  const n = ib?.puntos_molden?.length || 0;
  if (!t || !n) return;
  const irc = ib.puntos_tipo === 'irc';
  $('#dlgMoldenTexto').textContent = `${alTerminar ? `Terminó el ${irc ? 'IRC' : 'scan'} «${t.titulo}». ` : ''}Hay ${n} archivos .molden, uno por punto ${irc ? 'del IRC (reactivo → TS → producto)' : 'del scan, en su orden'}. Escriba el nombre base y elija la carpeta donde guardarlos con numeración secuencial.`;
  $('#dlgMoldenBase').value = `${nombreSeguro(t.titulo)}_${irc ? 'irc' : 'scan'}`;
  const conCarpeta = typeof window.showDirectoryPicker === 'function';
  $('#dlgMoldenGuardar').textContent = conCarpeta ? 'Elegir carpeta y guardar' : `Descargar los ${n} archivos`;
  $('#dlgMoldenNota').hidden = conCarpeta;
  $('#dlgMoldenEstado').textContent = '';
  $('#dlgMoldenGuardar').disabled = false;
  vistaMolden();
  const dlg = $('#dlgMolden');
  if (!dlg.open) dlg.showModal();
  $('#dlgMoldenBase').select();
}
async function guardarMoldenNumerados() {
  const t = estado.infoTrabajo; const nombres = estado.resultado?.iboview?.puntos_molden || [];
  const n = nombres.length;
  if (!t || !n) return;
  const base = baseMolden();
  const boton = $('#dlgMoldenGuardar'); const info = $('#dlgMoldenEstado');
  boton.disabled = true;
  try {
    let carpeta = null;
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        carpeta = await window.showDirectoryPicker({ id: 'psi4-molden', mode: 'readwrite' });
      } catch (e) {
        if (e.name === 'AbortError') return; // eligió «Cancelar»
        throw e;
      }
      const existentes = [];
      for (let k = 1; k <= n; k++) {
        try { await carpeta.getFileHandle(nombreNumerado(base, k, n)); existentes.push(nombreNumerado(base, k, n)); } catch { /* no existe */ }
      }
      if (existentes.length && !confirm(`La carpeta «${carpeta.name}» ya tiene ${existentes.length} archivo(s) con ese nombre (p. ej. ${existentes[0]}). ¿Reemplazarlos?`)) return;
    }
    for (let k = 1; k <= n; k++) {
      info.textContent = `Guardando ${k} de ${n}…`;
      const texto = await api(`/api/calculos/${t.id}/archivo/${nombres[k - 1]}`);
      const nombre = nombreNumerado(base, k, n);
      if (carpeta) {
        const archivo = await carpeta.getFileHandle(nombre, { create: true });
        const w = await archivo.createWritable();
        await w.write(texto);
        await w.close();
      } else {
        descargar(texto, nombre);
        await new Promise((ok) => { setTimeout(ok, 300); });
      }
    }
    info.textContent = `✓ ${n} archivos guardados ${carpeta ? `en la carpeta «${carpeta.name}»` : 'en la carpeta de descargas'}: ${nombreNumerado(base, 1, n)} … ${nombreNumerado(base, n, n)}.`;
  } catch (e) {
    info.textContent = `No se pudieron guardar los archivos: ${e.message}`;
  } finally {
    boton.disabled = false;
  }
}

function panelArchivos(t, r) {
  const panel = $('[data-panel="archivos"]');
  panel.innerHTML = `<div class="grupo-btn">
      <button class="btn sec" type="button" data-guardar="out">Salida de Psi4 (.out)</button>
      <button class="btn sec" type="button" data-guardar="in">Entrada de Psi4 (.in)</button>
      <button class="btn sec" type="button" data-guardar="xyz">Geometría final (.xyz)</button>
      <button class="btn sec" type="button" id="verSalida">Mostrar salida completa</button>
    </div>
    ${bloqueIboView(r)}
    <p class="nota">El archivo <b>.out</b> es la salida completa de Psi4 (energías, iteraciones, geometrías, frecuencias, termoquímica). El <b>.in</b> reproduce este cálculo: puede ejecutarlo en su computadora con <code>psi4 ${esc(nombreSeguro(t.titulo))}.in</code> o volver a abrirlo aquí. Identificador del cálculo: <code>${esc(t.id)}</code>. Los resultados se guardan en el servidor durante un tiempo limitado.</p>
    <pre class="salida-completa" id="salidaCompleta" hidden></pre>`;
  panel.onclick = async (ev) => {
    try {
      if (ev.target.id === 'verSalida') {
        const pre = $('#salidaCompleta');
        if (pre.hidden) { pre.textContent = await api(`/api/calculos/${t.id}/archivo/salida.dat`); pre.hidden = false; ev.target.textContent = 'Ocultar salida'; } else { pre.hidden = true; ev.target.textContent = 'Mostrar salida completa'; }
      }
    } catch (e) { alert(e.message); }
  };
}

// ---------- Historial (en este navegador) ----------
function historial() { return leerLS(LS_HIST, []); }
function guardarEnHistorial(t) {
  const h = historial().filter((x) => x.id !== t.id);
  h.unshift({ id: t.id, titulo: t.titulo, formula: t.formula, metodo: t.metodo, base: t.base, tarea: t.tarea, estado: t.estado, creado: t.creado });
  escribirLS(LS_HIST, h.slice(0, 40));
  pintarHistorial();
}
function actualizarHistorial(t) {
  const h = historial();
  const x = h.find((y) => y.id === t.id);
  if (x && x.estado !== t.estado) { x.estado = t.estado; escribirLS(LS_HIST, h); pintarHistorial(); }
}
function quitarDelHistorial(id) { escribirLS(LS_HIST, historial().filter((x) => x.id !== id)); pintarHistorial(); }
function pintarHistorial() {
  const ul = $('#historial');
  const h = historial();
  if (!h.length) { ul.innerHTML = '<li class="vacio">Aún no hay cálculos en este navegador.</li>'; return; }
  const txt = { en_cola: 'en cola', ejecutando: 'calculando', terminado: 'terminado', error: 'error' };
  ul.innerHTML = h.map((x) => `<li data-id="${esc(x.id)}" tabindex="0">
      <span class="h-titulo">${esc(x.titulo)}</span>
      <span class="h-detalle">${esc(x.formula || '')} · ${esc(nombreDe('metodos', x.metodo))}/${esc(nombreDe('bases', x.base))} · ${esc(nombreDe('tareas', x.tarea))} · ${new Date(x.creado).toLocaleString()}</span>
      <span class="pildora ${x.estado === 'error' ? 'error' : x.estado === 'en_cola' ? 'cola' : ''}">${txt[x.estado] || esc(x.estado)}</span></li>`).join('');
}

// ---------- Eventos ----------
function eventos() {
  const sel = $('#ejemplos');
  sel.innerHTML += EJEMPLOS.map(([n, s]) => `<option value="${esc(s)}">${esc(n)}</option>`).join('');
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    leerEnJSME(sel.value);
    $('#titulo').value = sel.options[sel.selectedIndex].text;
    sel.value = '';
    generar3D().catch((e) => { $('#infoMolecula').textContent = e.message; });
  });
  $('#leerSmiles').addEventListener('click', () => {
    const s = $('#smiles').value.trim();
    if (!s) return;
    leerEnJSME(s);
    generar3D().catch((e) => { $('#infoMolecula').textContent = e.message; });
  });
  $('#smiles').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#leerSmiles').click(); } });
  $('#generar3d').addEventListener('click', () => generar3D({ explicito: true }).catch((e) => { $('#infoMolecula').textContent = e.message; }));
  $('#formCalculo').addEventListener('submit', (e) => e.preventDefault());
  $('#calcular').addEventListener('click', ejecutar);
  // Editor de la entrada
  const ta = $('#editorTexto');
  let temporizador = null;
  ta.addEventListener('input', () => { pintarLineas(); clearTimeout(temporizador); temporizador = setTimeout(validarEditor, 250); });
  ta.addEventListener('scroll', () => { $('#editorLineas').scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', teclasEditor);
  $('#editorAplicar').addEventListener('click', (e) => aplicarDesdeEditor(e.currentTarget));
  $('#editorDesdeForm').addEventListener('click', regenerarEditor);
  $('#editorGuardar').addEventListener('click', () => descargar(textoEditor(), editor.nombre || `${nombreSeguro($('#titulo').value)}.in`));
  // El código sigue al formulario (salvo que se haya editado a mano)
  ['input', 'change'].forEach((ev) => $('#formCalculo').addEventListener(ev, programarSincronizacion));
  $$('.scan-tipo').forEach((c) => c.addEventListener('change', () => elegirTipoScan(c)));
  $('#scanDeMedida').addEventListener('click', scanDesdeMedida);
  $$('input[name="scanModo"]').forEach((r) => r.addEventListener('change', () => { actualizarScanUI(); actualizarEstimacion(); }));
  $('#scanValor').addEventListener('input', (e) => { delete e.target.dataset.auto; actualizarEstimacion(); });
  $('#dlgMoldenBase').addEventListener('input', vistaMolden);
  $('#dlgMoldenForm').addEventListener('submit', (e) => { e.preventDefault(); guardarMoldenNumerados(); });
  $('#dlgMoldenCerrar').addEventListener('click', () => $('#dlgMolden').close());
  $('#abrirArchivo').addEventListener('click', () => $('#archivoEntrada').click());
  $('#archivoEntrada').addEventListener('change', (e) => abrirArchivo(e.target.files[0]));
  const tarjeta = $('#tarjetaMolecula');
  tarjeta.addEventListener('dragover', (e) => { e.preventDefault(); tarjeta.classList.add('arrastrando'); });
  tarjeta.addEventListener('dragleave', (e) => { if (!tarjeta.contains(e.relatedTarget)) tarjeta.classList.remove('arrastrando'); });
  tarjeta.addEventListener('drop', (e) => {
    e.preventDefault();
    tarjeta.classList.remove('arrastrando');
    if (e.dataTransfer.files.length) abrirArchivo(e.dataTransfer.files[0]);
  });
  ['#metodo', '#base', '#tarea', '#ircDireccion', '#ircPuntos'].forEach((s) => $(s).addEventListener('change', actualizarEstimacion));
  $('#tarea').addEventListener('change', mostrarOpcionesIRC);
  ['#scanI', '#scanJ', '#scanK', '#scanL', '#scanDesde', '#scanHasta', '#scanPaso'].forEach((s) => $(s).addEventListener('input', actualizarEstimacion));

  $('#estilo').addEventListener('change', () => {
    if (estado.modoActivo) animarModo(estado.modoActivo); else aplicarEstilo();
  });
  $('#etiquetas').addEventListener('change', aplicarEstilo);
  $('#colorCargas').addEventListener('change', aplicarEstilo);
  $('#superficie').addEventListener('change', () => { ajustarDeslizador(); mostrarSuperficie(); });
  $('#isovalor').addEventListener('input', () => { $('#isoSalida').textContent = parseFloat($('#isovalor').value).toFixed(3); });
  $('#isovalor').addEventListener('change', mostrarSuperficie);
  $('#centrar').addEventListener('click', () => { estado.visor.zoomTo(); estado.visor.render(); });
  $('#girar').addEventListener('click', () => { estado.girando = !estado.girando; estado.visor.spin(estado.girando ? 'y' : false); });
  $('#png').addEventListener('click', () => descargar(estado.visor.pngURI(), 'molecula.png'));
  $('#medir').addEventListener('click', alternarMedir);
  $('#medirLimpiar').addEventListener('click', reiniciarMedida);

  // Barra «Vibración» del visor
  $('#vibPlay').addEventListener('click', () => {
    if (estado.modoActivo) detenerVibracion(); else animarModo(parseInt($('#modoVib').value, 10));
  });
  $('#modoVib').addEventListener('change', () => animarModo(parseInt($('#modoVib').value, 10)));
  $('#vibAnterior').addEventListener('click', () => pasarModo(-1));
  $('#vibSiguiente').addEventListener('click', () => pasarModo(1));
  ['#vibAmplitud', '#vibVelocidad', '#vibFlechas'].forEach((s) => $(s).addEventListener('change', () => {
    if (estado.modoActivo) animarModo(estado.modoActivo);
  }));
  $('#vibXYZ').addEventListener('click', () => {
    const modo = modosAnimables().find((m) => m.numero === parseInt($('#modoVib').value, 10));
    if (!modo) return;
    const nombre = (estado.infoTrabajo?.titulo || 'molecula').replace(/\s+/g, '_');
    descargar(xyzAnimado(modo, parseFloat($('#vibAmplitud').value) || 0.6, 20), `${nombre}_modo${modo.numero}.xyz`);
  });

  $('.pestanas').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pestana]');
    if (b && !b.disabled) abrirPestana(b.dataset.pestana);
  });
  $('#resultados').addEventListener('click', (e) => {
    const guardar = e.target.closest('[data-guardar]');
    if (guardar) { guardarArchivoTrabajo(guardar.dataset.guardar); return; }
    if (e.target.id === 'lanzarIRC') { calcularIRC(e.target); return; }
    const b = e.target.closest('[data-ver-sup]');
    if (b) { $('#superficie').value = b.dataset.verSup; ajustarDeslizador(); mostrarSuperficie(); $('#visor').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (e.target.id === 'verCargas') {
      $('#colorCargas').checked = true; $('#etiquetas').checked = true;
      cargarModelo(estado.resultado.geometria_xyz, 'xyz', { zoom: false });
      $('#visor').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  $('#cancelar').addEventListener('click', async () => {
    if (!estado.trabajo || !confirm('¿Cancelar este cálculo?')) return;
    try { await api(`/api/calculos/${estado.trabajo}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
  });

  const abrir = (li) => li?.dataset.id && seguir(li.dataset.id);
  $('#historial').addEventListener('click', (e) => abrir(e.target.closest('li')));
  $('#historial').addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(e.target.closest('li')); });
  $('#borrarHistorial').addEventListener('click', () => { if (confirm('¿Quitar todos los cálculos de esta lista? (no se borran del servidor)')) { escribirLS(LS_HIST, []); pintarHistorial(); } });

  // Al guardar la clave se genera la geometría 3D de la molécula del editor (así se comprueba la clave)
  const entrarConClave = () => {
    const clave = $('#clave').value.trim();
    if (!clave) { $('#clave').focus(); return; }
    escribirLS(LS_CLAVE, clave);
    $('#panelClave').hidden = true;
    cargarOpciones();
    if (estado.jsme) generar3D().catch((e) => { $('#infoMolecula').textContent = e.message; });
  };
  $('#guardarClave').addEventListener('click', entrarConClave);
  $('#clave').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); entrarConClave(); } });
}

// ---------- Inicio ----------
iniciarVisor();
eventos();
pintarHistorial();
cargarOpciones();
