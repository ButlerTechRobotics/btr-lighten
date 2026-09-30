import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

const $ = (id) => document.getElementById(id);
const IN = 25.4;
const APP_VERSION = "2.0.0";   // 1.x was Lighten Desktop (Python); 2.x runs in the browser
// Feedback goes to the team Google Form (same form as BTR Blockout; the "App details" field says which app).
const FEEDBACK_FORM = { url: "https://docs.google.com/forms/d/e/1FAIpQLSfihwn0PhqjO7_eB-7FL9mABb6EAt8gyWebTeqDKisLRPVrhw/viewform",
  fields: { type: "entry.1585987477", message: "entry.1619535286", name: "entry.1839315041", details: "entry.1766221737" } };

// ------------------------------------------------------------------ theme colours (CSS tokens, light and dark)
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const C = {};
function readTheme() {
  for (const k of ["viewport", "sk-material", "sk-pocket", "sk-line", "sk-pocket-line", "sk-off", "sk-label", "btr-orange", "btr-blue"]) C[k] = css("--" + k);
}
readTheme();

// ------------------------------------------------------------------ state
const DEFAULTS_MM = {
  outerWall: 0.15 * IN, ribWidth: 0.10 * IN, holeWall: 0.10 * IN, filletRadius: 0.0625 * IN,
  roundReflex: true, pattern: "isogrid", cellSize: 1.25 * IN, angle: 0, offsetX: 0, offsetY: 0,
  islandSpokes: 2, cleanup: 0.04 * IN, minArea: 0.06 * IN * IN,
};
const LENGTH_PARAMS = new Set(["outerWall", "ribWidth", "holeWall", "filletRadius", "cellSize", "offsetX", "offsetY", "cleanup"]);
const AREA_PARAMS = new Set(["minArea"]);

const S = {
  unit: "in",
  params: { ...DEFAULTS_MM },
  faceId: null,
  faces: [],
  profile: null,
  pockets: [],
  autoRibs: [],
  customRibs: [],          // [[x1,y1,x2,y2]] in mm, face frame
  haloOff: new Set(),
  depthMode: "through",
  depthCustom: null,
  hasResult: false,
  showingResult: false,
};

function toUnit(mm, area = false) { return S.unit === "in" ? (area ? mm / (IN * IN) : mm / IN) : mm; }
function fromUnit(v, area = false) { return S.unit === "in" ? (area ? v * IN * IN : v * IN) : v; }
function fmt(mm, area = false) {
  const v = toUnit(mm, area);
  return S.unit === "in" ? v.toFixed(area ? 3 : 3) : v.toFixed(area ? 1 : 2);
}

// ------------------------------------------------------------------ 3D viewer
const view = $("view3d");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(C.viewport || "#2d3440");
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(1, -1.5, 2); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-2, 1, -1); scene.add(fill);

let partMesh = null, faceIdsPerTri = [], hoverFace = -1;
const COL_BASE = new THREE.Color(0xb9c0c9), COL_HOVER = new THREE.Color(0xdfe5ec),
      COL_SEL = new THREE.Color(0xf26a1b), COL_RESULT = new THREE.Color(0x8fb4ff), COL_NONPLANAR = new THREE.Color(0x8a919a);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readTheme(); scene.background = new THREE.Color(C.viewport); drawSketch(); });

function setMesh(mesh, isResult) {
  if (partMesh) { scene.remove(partMesh); partMesh.geometry.dispose(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions instanceof Float32Array ? mesh.positions : new Float32Array(mesh.positions), 3));
  geo.computeVertexNormals();
  const colors = new Float32Array(mesh.positions.length);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  faceIdsPerTri = mesh.faceIds;
  S.faces = mesh.faces;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, flatShading: true });
  partMesh = new THREE.Mesh(geo, mat);
  scene.add(partMesh);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x1c2129, transparent: true, opacity: 0.55 }));
  partMesh.add(edges);
  S.showingResult = !!isResult;
  recolor();
  if (!isResult) fitCamera(geo);
}

function recolor() {
  if (!partMesh) return;
  const colAttr = partMesh.geometry.getAttribute("color");
  const arr = colAttr.array;
  for (let t = 0; t < faceIdsPerTri.length; t++) {
    const fid = faceIdsPerTri[t];
    const f = S.faces[fid];
    let c = S.showingResult ? COL_RESULT : (f && !f.planar ? COL_NONPLANAR : COL_BASE);
    if (!S.showingResult) {
      if (fid === S.faceId) c = COL_SEL;
      else if (fid === hoverFace && f && f.planar) c = COL_HOVER;
    }
    for (let k = 0; k < 3; k++) { const i = (t * 3 + k) * 3; arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
  }
  colAttr.needsUpdate = true;
}

function fitCamera(geo) {
  geo.computeBoundingSphere();
  const s = geo.boundingSphere;
  controls.target.copy(s.center);
  const d = s.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
  camera.position.set(s.center.x + d * 0.6, s.center.y - d * 0.7, s.center.z + d * 0.6);
  camera.near = d / 100; camera.far = d * 100; camera.updateProjectionMatrix();
  controls.update();
}

function resize3d() {
  const w = view.clientWidth || 1, h = view.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener("resize", () => { resize3d(); resizeSketch(); });
resize3d();
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

const ray = new THREE.Raycaster();
function pick(ev) {
  if (!partMesh || S.showingResult) return -1;
  const r = renderer.domElement.getBoundingClientRect();
  const m = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(m, camera);
  const hit = ray.intersectObject(partMesh, false)[0];
  return hit ? faceIdsPerTri[hit.faceIndex] : -1;
}
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointermove", (e) => {
  const fid = pick(e);
  if (fid !== hoverFace) { hoverFace = fid; recolor(); renderer.domElement.style.cursor = fid >= 0 && S.faces[fid].planar ? "pointer" : "default"; }
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const fid = pick(e);
  if (fid >= 0 && S.faces[fid].planar) selectFace(fid);
});

// ------------------------------------------------------------------ API
// The geometry engine (OpenCascade + GEOS, compiled to WebAssembly) runs in a worker, so nothing is uploaded anywhere.
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let nextId = 1, engineReady = false;
const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") { engineReady = true; busy(false); status("Load a STEP file to begin — or try the demo plate."); return; }
  if (m.type === "fatal") { busy(true, "The geometry engine could not start", m.error + " — try reloading the page, or use Chrome or Edge."); return; }
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error)); else p.resolve(m.data);
};
worker.onerror = (e) => { busy(true, "The geometry engine could not start", (e.message || "Worker error") + " — try reloading the page."); };
const ROUTES = { "/api/load": "load", "/api/test-part": "testPart", "/api/face": "face", "/api/preview": "preview", "/api/generate": "generate", "/api/keep": "keep", "/api/discard": "discard", "/api/export": "exportStep" };
function api(path, body) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd: ROUTES[path], args: body || {} });
  });
}
// Previews are debounced and only the newest one matters.
let previewSeq = 0;
function busy(on, title = "Working…", sub = "") {
  $("loading").classList.toggle("hidden", !on);
  if (on) { $("loadingTitle").textContent = title; $("loadingSub").textContent = sub; }
}
busy(true, "Loading the geometry engine", "First visit downloads about 25 MB; after that it opens straight away.");
function message(text, kind) {
  const el = $("msg");
  el.innerHTML = text ? `<div class="msg ${kind || ""}">${text}</div>` : "";
}
function status(html) { $("statusText").innerHTML = html; }
$("version").textContent = "BTR Lighten v" + APP_VERSION;

// ------------------------------------------------------------------ loading parts
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await loadPart(f.name, await f.arrayBuffer());
  e.target.value = "";
});
$("demoBtn").addEventListener("click", async () => {
  busy(true);
  try { afterLoad(await api("/api/test-part", {})); message(""); }
  catch (err) { message(err.message, "err"); }
  busy(false);
});
async function loadPart(name, buf) {
  busy(true, "Reading " + name); message("");
  try {
    const data = await api("/api/load", { name, bytes: buf });
    afterLoad(data);
  } catch (err) { message(err.message, "err"); status(`<span class="warn">${err.message}</span>`); }
  busy(false);
}
function afterLoad(data) {
  $("fileName").textContent = data.filename;
  S.faceId = null; S.profile = null; S.pockets = []; S.customRibs = []; S.haloOff = new Set(); S.hasResult = false; S.autoRibs = [];
  setMesh(data.mesh, false);
  showTab("3d");
  $("facePick").textContent = "No face selected"; $("facePick").classList.remove("set");
  lockSections(true);
  $("afterGen").style.display = "none";
  $("exportBtn").disabled = false;
  const planar = data.mesh.faces.filter(f => f.planar).length;
  status(`Loaded <b>${data.filename}</b> — ${planar} flat faces. Click the face you want to pocket.`);
}

function lockSections(lock) {
  for (const id of ["secWalls", "secPattern", "secHoles", "secDepth", "secGo"]) $(id).classList.toggle("locked", lock);
  $("secFace").classList.toggle("done", !lock);
}

async function selectFace(fid) {
  busy(true); message("");
  try {
    S.profile = await api("/api/face", { faceId: fid });
    S.faceId = fid; S.customRibs = []; S.haloOff = new Set(); S.autoRibs = [];
    recolor();
    selectFaceLabel();
    $("facePick").classList.add("set");
    lockSections(false);
    S.depthCustom = S.profile.throughDepth;
    renderDepth();
    SK.fitted = false;
    await preview();
  } catch (err) { message(err.message, "err"); }
  busy(false);
}

// ------------------------------------------------------------------ parameters panel
const inputs = [...document.querySelectorAll("[data-p]")];
function renderParams() {
  for (const el of inputs) {
    const k = el.dataset.p, v = S.params[k];
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.tagName === "SELECT") el.value = v;
    else if (LENGTH_PARAMS.has(k)) el.value = (+toUnit(v)).toFixed(S.unit === "in" ? 3 : 2);
    else if (AREA_PARAMS.has(k)) el.value = (+toUnit(v, true)).toFixed(S.unit === "in" ? 3 : 1);
    else el.value = v;
  }
  $("areaUnit").textContent = S.unit + "²";
  const grid = ["isogrid", "hex", "square", "diamond"].includes(S.params.pattern);
  document.querySelector(".grid-only").style.display = grid ? "" : "none";
  renderDepth();
}
function renderDepth() {
  $("depthMode").value = S.depthMode;
  $("depthRow").style.display = S.depthMode === "custom" ? "" : "none";
  if (S.profile) {
    $("depthVal").value = (+toUnit(S.depthCustom ?? S.profile.throughDepth)).toFixed(3);
    $("depthNote").textContent = S.depthMode === "through"
      ? `Cuts ${fmt(S.profile.throughDepth)} ${S.unit} — the full thickness behind this face.`
      : `Leaves a floor. Anything deeper than ${fmt(S.profile.throughDepth)} ${S.unit} goes through.`;
  }
}
let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 200); }
for (const el of inputs) {
  el.addEventListener("input", () => {
    const k = el.dataset.p;
    if (el.type === "checkbox") S.params[k] = el.checked;
    else if (el.tagName === "SELECT") S.params[k] = el.value;
    else {
      const v = parseFloat(el.value); if (isNaN(v)) return;
      S.params[k] = LENGTH_PARAMS.has(k) ? fromUnit(v) : AREA_PARAMS.has(k) ? fromUnit(v, true) : v;
    }
    if (k === "pattern") renderParams();
    schedulePreview();
  });
}
$("depthMode").addEventListener("change", () => { S.depthMode = $("depthMode").value; renderDepth(); });
$("depthVal").addEventListener("input", () => { const v = parseFloat($("depthVal").value); if (!isNaN(v)) S.depthCustom = fromUnit(v); });
$("unitIn").addEventListener("click", () => setUnit("in"));
$("unitMm").addEventListener("click", () => setUnit("mm"));
function setUnit(u) {
  S.unit = u; $("unitIn").classList.toggle("on", u === "in"); $("unitMm").classList.toggle("on", u === "mm");
  renderParams(); drawSketch();
  selectFaceLabel();
}
function selectFaceLabel() {
  if (S.faceId === null) return;
  const f = S.faces[S.faceId];
  $("facePick").innerHTML = `Face #${S.faceId} — ${fmt(f.area, true)} ${S.unit}² &nbsp;·&nbsp; ${S.profile.holes.length} hole${S.profile.holes.length === 1 ? "" : "s"} &nbsp;·&nbsp; through depth ${fmt(S.profile.throughDepth)} ${S.unit}`;
}
$("resetParamsBtn").addEventListener("click", () => { S.params = { ...DEFAULTS_MM }; renderParams(); schedulePreview(); });
renderParams();

function paramsPayload() {
  const halo = S.profile ? S.profile.holes.map(h => h.id).filter(id => !S.haloOff.has(id)) : null;
  return { ...S.params, customRibs: S.customRibs, haloHoles: halo };
}

// ------------------------------------------------------------------ preview + generate
async function preview() {
  if (S.faceId === null || S.hasResult) return;
  try {
    const seq = ++previewSeq;
    const data = await api("/api/preview", { faceId: S.faceId, params: paramsPayload() });
    if (seq !== previewSeq || S.hasResult) return;
    S.pockets = data.pockets; S.autoRibs = data.stats.autoRibs || [];
    const pct = data.stats.faceArea ? (100 * data.stats.removedArea / data.stats.faceArea) : 0;
    const warn = (data.stats.warnings || []).map(w => `<span class="warn">${w}</span>`).join(" ");
    status(`Preview: <b>${data.stats.pockets}</b> pockets · <b>${pct.toFixed(0)}%</b> of the face removed ${warn}`);
    drawSketch();
  } catch (err) { status(`<span class="warn">${err.message}</span>`); }
}

$("generateBtn").addEventListener("click", async () => {
  if (S.faceId === null) return;
  busy(true, "Cutting pockets", "Big parts can take a few seconds."); message("");
  try {
    const depth = S.depthMode === "custom" ? S.depthCustom : null;
    const data = await api("/api/generate", { faceId: S.faceId, params: paramsPayload(), depth });
    setMesh(data.mesh, true);
    S.hasResult = true;
    const st = data.stats;
    const pct = 100 * (1 - st.volumeAfter / st.volumeBefore);
    const pctAll = 100 * (1 - st.volumeAfter / st.volumeOriginal);
    message(`Cut ${st.pockets} pockets. Mass down <b>${pct.toFixed(1)}%</b> this step` + (Math.abs(pctAll - pct) > 0.05 ? ` (${pctAll.toFixed(1)}% total)` : "") + `. Export when you're happy, or keep going on another face.`, "ok");
    status(`<span class="ok">Generated</span> · <b>${st.pockets}</b> pockets · mass −<b>${pct.toFixed(1)}%</b>` + (Math.abs(pctAll - pct) > 0.05 ? ` (−${pctAll.toFixed(1)}% total)` : ""));
    $("afterGen").style.display = "";
    showTab("3d");
  } catch (err) { message(err.message, "err"); }
  busy(false);
});
$("undoBtn").addEventListener("click", async () => {
  busy(true);
  try { const d = await api("/api/discard", {}); setMesh(d.mesh, false); S.hasResult = false; $("afterGen").style.display = "none"; message(""); recolor(); await preview(); }
  catch (err) { message(err.message, "err"); }
  busy(false);
});
$("keepBtn").addEventListener("click", async () => {
  busy(true);
  try {
    const d = await api("/api/keep", {});
    S.hasResult = false; S.faceId = null; S.profile = null; S.pockets = []; S.customRibs = []; S.haloOff = new Set();
    setMesh(d.mesh, false);
    $("afterGen").style.display = "none";
    $("facePick").textContent = "No face selected"; $("facePick").classList.remove("set");
    lockSections(true); message("");
    status("Kept. Pick another face to pocket, or export.");
  } catch (err) { message(err.message, "err"); }
  busy(false);
});
$("exportBtn").addEventListener("click", async () => {
  busy(true, "Writing STEP");
  try {
    const { name, bytes } = await api("/api/export", {});
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/step" }));
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status(`Saved <b>${name}</b> to your downloads. In SolidWorks: Insert › Features › Imported, or File › Open.`);
  } catch (err) { message(err.message, "err"); }
  busy(false);
});

// ------------------------------------------------------------------ tabs
function showTab(which) {
  const sk = which === "sketch";
  $("tab3d").classList.toggle("active", !sk); $("tabSketch").classList.toggle("active", sk);
  $("view3d").classList.toggle("hidden", sk);
  for (const id of ["sketch", "sketchLegend", "sketchTools"]) $(id).classList.toggle("hidden", !sk);
  $("tabHint").textContent = sk ? "Scroll to zoom · right-drag or middle-drag to pan · Esc cancels a rib" : "Drag to orbit · scroll to zoom · right-drag to pan";
  if (sk) { resizeSketch(); if (!SK.fitted) fitSketch(); else drawSketch(); } else resize3d();
}
$("tab3d").addEventListener("click", () => showTab("3d"));
$("tabSketch").addEventListener("click", () => { if (S.faceId === null) { status(`<span class="warn">Pick a face first.</span>`); return; } showTab("sketch"); });

// ------------------------------------------------------------------ sketch editor
const canvas = $("sketch"), ctx = canvas.getContext("2d");
const SK = { scale: 3, ox: 0, oy: 0, tool: "select", ribStart: null, mouse: null, panning: null };
function resizeSketch() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, r.width * devicePixelRatio); canvas.height = Math.max(1, r.height * devicePixelRatio);
}
function w2s(x, y) { return [SK.ox + x * SK.scale, SK.oy - y * SK.scale]; }
function s2w(px, py) { return [(px - SK.ox) / SK.scale, (SK.oy - py) / SK.scale]; }
function fitSketch() {
  if (!S.profile) return;
  resizeSketch();
  const xs = S.profile.outer.map(p => p[0]), ys = S.profile.outer.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const W = canvas.width / devicePixelRatio, H = canvas.height / devicePixelRatio;
  SK.scale = 0.85 * Math.min(W / (maxx - minx || 1), H / (maxy - miny || 1));
  SK.ox = W / 2 - (minx + maxx) / 2 * SK.scale; SK.oy = H / 2 + (miny + maxy) / 2 * SK.scale;
  SK.fitted = true;
  drawSketch();
}
$("fitSketch").addEventListener("click", fitSketch);

function drawSketch() {
  if (canvas.classList.contains("hidden")) return;
  const W = canvas.width / devicePixelRatio, H = canvas.height / devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!S.profile) return;
  const path = (pts) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = w2s(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };

  // material
  path(S.profile.outer); ctx.fillStyle = C["sk-material"]; ctx.fill(); ctx.strokeStyle = C["sk-line"]; ctx.lineWidth = 1.2; ctx.stroke();
  // pockets
  for (const q of S.pockets) {
    path(q.outer); ctx.fillStyle = C["sk-pocket"]; ctx.fill(); ctx.strokeStyle = C["sk-pocket-line"]; ctx.lineWidth = 0.8; ctx.stroke();
    for (const h of q.holes) { path(h); ctx.fillStyle = C["sk-material"]; ctx.fill(); ctx.stroke(); }
  }
  // holes
  for (const h of S.profile.holes) {
    const off = S.haloOff.has(h.id);
    path(h.points); ctx.fillStyle = off ? C["sk-off"] : C["sk-pocket"]; ctx.fill();
    ctx.strokeStyle = off ? C["btr-orange"] : C["sk-line"]; ctx.lineWidth = off ? 1.8 : 1; ctx.stroke();
    if (h.circle && !off && S.params.holeWall > 0) {
      const [cx, cy] = w2s(h.circle.cx, h.circle.cy);
      ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.arc(cx, cy, (h.circle.r + S.params.holeWall) * SK.scale, 0, Math.PI * 2);
      ctx.strokeStyle = C["sk-pocket-line"]; ctx.lineWidth = 0.7; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // ribs
  const ribLine = (r, color, dash) => {
    const [a, b] = [w2s(r[0], r[1]), w2s(r[2], r[3])];
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, S.params.ribWidth * SK.scale * 0.35); ctx.stroke(); ctx.setLineDash([]);
  };
  for (const r of S.autoRibs) ribLine(r, "#3d6bff", [4, 3]);
  for (const r of S.customRibs) ribLine(r, C["btr-orange"]);
  // rib in progress
  if (SK.tool === "rib" && SK.ribStart && SK.mouse) {
    const end = snapPoint(SK.mouse, SK.ribStart);
    ribLine([SK.ribStart[0], SK.ribStart[1], end[0], end[1]], C["btr-orange"], [6, 4]);
    const [sx, sy] = w2s(end[0], end[1]); ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fillStyle = C["btr-orange"]; ctx.fill();
  } else if (SK.tool === "rib" && SK.mouse) {
    const p = snapPoint(SK.mouse, null); const [sx, sy] = w2s(p[0], p[1]);
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.strokeStyle = C["btr-orange"]; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // scale bar
  const unitLen = S.unit === "in" ? IN : 10, label = S.unit === "in" ? "1 in" : "10 mm";
  ctx.fillStyle = C["sk-label"]; ctx.fillRect(W - 20 - unitLen * SK.scale, H - 18, unitLen * SK.scale, 2);
  ctx.font = "12px Barlow, system-ui"; ctx.textAlign = "right"; ctx.fillText(label, W - 20, H - 24);
}

function snapPoint(p, from) {
  // snap to hole centres, then to 15° increments from the start point (with Shift) / axis alignment
  const snapR = 8 / SK.scale;
  for (const h of S.profile.holes) {
    const c = h.circle ? [h.circle.cx, h.circle.cy] : h.center;
    if (Math.hypot(c[0] - p[0], c[1] - p[1]) < snapR + (h.circle ? h.circle.r : 0)) return c;
  }
  if (from) {
    const dx = p[0] - from[0], dy = p[1] - from[1], L = Math.hypot(dx, dy);
    if (L > 0 && SK.shift) {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      return [from[0] + L * Math.cos(a), from[1] + L * Math.sin(a)];
    }
  }
  return p;
}

function setTool(t) {
  SK.tool = t; SK.ribStart = null;
  $("toolSelect").classList.toggle("on", t === "select"); $("toolRib").classList.toggle("on", t === "rib"); $("toolErase").classList.toggle("on", t === "erase");
  canvas.style.cursor = t === "select" ? "pointer" : "crosshair";
  drawSketch();
}
$("toolSelect").addEventListener("click", () => setTool("select"));
$("toolRib").addEventListener("click", () => setTool("rib"));
$("toolErase").addEventListener("click", () => setTool("erase"));
$("clearRibs").addEventListener("click", () => { S.customRibs = []; schedulePreview(); drawSketch(); });
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "Shift") SK.shift = true;
  if (canvas.classList.contains("hidden")) return;
  if (e.key === "Escape") { SK.ribStart = null; drawSketch(); }
  if (e.key.toLowerCase() === "r") setTool("rib");
  if (e.key.toLowerCase() === "s") setTool("select");
  if (e.key.toLowerCase() === "e") setTool("erase");
});
window.addEventListener("keyup", (e) => { if (e.key === "Shift") SK.shift = false; });

function canvasPoint(e) { const r = canvas.getBoundingClientRect(); return s2w(e.clientX - r.left, e.clientY - r.top); }
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const f = Math.exp(-e.deltaY * 0.0015);
  SK.ox = px - (px - SK.ox) * f; SK.oy = py - (py - SK.oy) * f; SK.scale *= f; drawSketch();
}, { passive: false });
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 1 || e.button === 2) { SK.panning = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); return; }
  if (!S.profile || S.hasResult) return;
  const p = canvasPoint(e);
  if (SK.tool === "select") {
    const h = hitHole(p);
    if (h) { S.haloOff.has(h.id) ? S.haloOff.delete(h.id) : S.haloOff.add(h.id); schedulePreview(); drawSketch(); }
  } else if (SK.tool === "rib") {
    if (!SK.ribStart) SK.ribStart = snapPoint(p, null);
    else {
      const end = snapPoint(p, SK.ribStart);
      if (Math.hypot(end[0] - SK.ribStart[0], end[1] - SK.ribStart[1]) > 0.5) S.customRibs.push([SK.ribStart[0], SK.ribStart[1], end[0], end[1]]);
      SK.ribStart = e.shiftKey ? end : null;   // shift-click chains ribs
      schedulePreview();
    }
    drawSketch();
  } else if (SK.tool === "erase") {
    const i = nearestRib(p);
    if (i >= 0) { S.customRibs.splice(i, 1); schedulePreview(); drawSketch(); }
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (SK.panning) { SK.ox += e.clientX - SK.panning[0]; SK.oy += e.clientY - SK.panning[1]; SK.panning = [e.clientX, e.clientY]; drawSketch(); return; }
  SK.mouse = canvasPoint(e);
  if (SK.tool === "rib") drawSketch();
  else if (SK.tool === "select") canvas.style.cursor = hitHole(SK.mouse) ? "pointer" : "default";
});
canvas.addEventListener("pointerup", (e) => { if (SK.panning) { SK.panning = null; canvas.releasePointerCapture(e.pointerId); } });
function hitHole(p) {
  for (const h of S.profile.holes) {
    if (h.circle) { if (Math.hypot(p[0] - h.circle.cx, p[1] - h.circle.cy) <= h.circle.r + S.params.holeWall) return h; }
    else if (pointInPoly(p, h.points)) return h;
  }
  return null;
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function nearestRib(p) {
  let best = -1, bd = 10 / SK.scale;
  S.customRibs.forEach((r, i) => {
    const d = segDist(p, [r[0], r[1]], [r[2], r[3]]);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// drag & drop a STEP onto the window
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) await loadPart(f.name, await f.arrayBuffer());
});

// ------------------------------------------------------------------ feedback (opens the team Google Form, pre-filled)
let fbType = "Idea";
for (const b of document.querySelectorAll("#fbTypes button")) b.addEventListener("click", () => {
  fbType = b.dataset.v;
  for (const o of document.querySelectorAll("#fbTypes button")) o.setAttribute("aria-pressed", String(o === b));
});
$("feedbackBtn").addEventListener("click", () => { try { $("fbName").value = localStorage.getItem("btr.name") || ""; } catch (e) {} $("fbDialog").showModal(); $("fbMsg").focus(); });
$("fbCancel").addEventListener("click", () => $("fbDialog").close());
$("fbSend").addEventListener("click", () => {
  const f = FEEDBACK_FORM, name = $("fbName").value.trim();
  try { localStorage.setItem("btr.name", name); } catch (e) {}
  const details = [`BTR Lighten ${APP_VERSION}`, $("fileName").textContent, S.faceId === null ? "no face picked" : `face #${S.faceId}, ${S.params.pattern}`, navigator.userAgent].join(" · ");
  const q = new URLSearchParams({ usp: "pp_url", [f.fields.type]: fbType, [f.fields.message]: $("fbMsg").value, [f.fields.name]: name, [f.fields.details]: details });
  window.open(f.url + "?" + q.toString(), "_blank", "noopener");
  $("fbDialog").close(); $("fbMsg").value = "";
});
