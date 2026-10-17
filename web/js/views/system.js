// System (R10.33, docs/SYSTEM-VIEWS-SPEC.md): the selected project drawn the way engineers draw it. One switcher picks
// a view: Context, Containers, Components (the C4 levels), Modules (folders by dependency tier), Layers, Flows
// (sequence diagrams) and Data (stores and who reads or writes them). GET /api/v1/projects/<id>/system gives
// arch: {views, flows, details, stats}; graph/syslayout.js places it and graph/viewport.js pans and zooms
// (Cmd/Ctrl+wheel zooms at the cursor). The markup is a string with no inline styles or handlers: geometry and colour
// are SVG attributes (colours are token vars, so light and dark follow the theme). A tap on a node opens the side
// panel (system-panel.js) and dims what is not connected to it; Esc or Close shuts it.

import { getJson } from "../api.js";
import { run } from "../cmd.js";
import { copyButton, refOf } from "../ref.js";
import { bannerHtml, chipHtml, emptyHtml, esc, patch, skeletonHtml } from "../dom.js";
import { mountViewport } from "../graph/viewport.js";
import { clampSpace, SP_MIN, LABEL_MAX, layeredLayout, matrixLayout, MX_COL, MX_HEAD, MX_LEFT, MX_ROW, sequenceLayout,
  weak, labelWidth } from
  "../graph/syslayout.js";
import { human, panelHtml } from "./system-panel.js";
import { anchorShift, collapseGroups, subgraph } from "../graph/syslayout.js";
import { bindContextMenu, openMenu } from "./system-menu.js";
import { activitySvg, classModules, classSvg, deploymentSvg, erSvg, stateSvg,
  usecaseSvg } from "../graph/sysdiagrams.js";

export const VIEWS = [
  ["context", "Context", "Who uses the system and which outside systems it talks to (C4 level 1)."],
  ["containers", "Containers", "The parts that run separately and how they talk to each other (C4 level 2)."],
  ["components", "Components", "The building blocks inside each container; arrows are calls and imports (C4 level 3)."],
  ["modules", "Modules", "Every source folder by dependency tier: entry points on top, foundations at the bottom."],
  ["layers", "Layers", "Components in their layers. Red arrows point up a layer: a layering violation or a cycle."],
  ["flows", "Flows", "Step by step: who calls whom for one action, as a sequence diagram."],
  ["data", "Data", "Where state lives and which components read or write it."],
];
const TONES = ["--accent", "--info", "--success", "--warning", "--m-opus", "--m-haiku", "--m-cursor", "--defer",
  "--m-agy", "--m-sonnet"];
const EDGE = { call: "--text-2", import: "--text-3", data: "--info", event: "--accent", violation: "--danger",
  cycle: "--danger" };
// The v2 diagrams (drawn from arch.diagrams[id]); they show in the switcher only when the catalog lists them.
const DIAGRAMS = {
  classes: ["classes", "Classes", "Classes and modules with their relations.", classSvg, "nodes"],
  deployment: ["deployment", "Deployment", "Where each part runs and what it is deployed on.", deploymentSvg, "nodes"],
  usecases: ["usecases", "Use cases", "Who uses the system and what they can do.", usecaseSvg, "actors"],
  activity: ["activity", "Activity", "Step by step activity with decisions.", activitySvg, "items"],
  states: ["states", "States", "States and the transitions between them.", stateSvg, "items"],
  er: ["er", "ER", "Entities and how they relate.", erSvg, "entities"],
};
// The views this file can draw (id -> [id, label, note]).
const RENDERERS = Object.assign(Object.fromEntries(VIEWS.map((m) => [m[0], m])),
  Object.fromEntries(Object.keys(DIAGRAMS).map((k) => [k, DIAGRAMS[k].slice(0, 3)])));
const collapsed = new Set();
// Class modules the person collapsed (all start expanded); clsMods is the module list of the last class diagram.
const clsShut = new Set();
const EDGE_MODES = ["off", "selected", "all"];
let clsEdges = "selected";
let clsMods = [];
let drill = [];
let lastLay = null;
let anchorId = null;
let pendingShift = null;
const FAMILIES = [["structure", "Structure"], ["behaviour", "Behaviour"], ["data", "Data"]];
const REC_SCORE = 30;
const FIT_MIN = 0.2;
const FIT_MAX = 1.5;
const MATRIX_EDGES = 16;
const PAD = 12;
const store = new Map();
const reading = new Set();
let mounted = new WeakSet();
const taps = { last: null };
let lastVm = null;
let current = readPref("rb.sys.view", "components");
let flowId = null;
let selected = null;
let view = null;
let api = null;
let auto = true;
let watcher = null;

function readPref(key, dflt) {
  try {
    const v = globalThis.localStorage && globalThis.localStorage.getItem(key);
    return RENDERERS[v] ? v : dflt;
  } catch (err) {
    return dflt;
  }
}

// Spacing factor per view (gaps and padding only), kept in localStorage.
const SP_STEP = 0.2;
const SP_STEP_BIG = 0.5;
let keepCentre = null;

function spaceKey() {
  return "rb.sys.space." + current + (current === "flows" || DIAGRAMS[current] ? "." + (flowId || "") : "");
}

function spaceNow() {
  if (memSpace.has(spaceKey())) return memSpace.get(spaceKey());
  try {
    const v = globalThis.localStorage && globalThis.localStorage.getItem(spaceKey());
    return v == null ? 1 : clampSpace(v);
  } catch (err) {
    return 1;
  }
}

function spaceText(x) {
  return x.toFixed(1) + "×";
}

function setSpace(next) {
  const sp = Math.round(clampSpace(next) * 10) / 10;
  if (sp === spaceNow()) return;
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(spaceKey(), String(sp));
  } catch (err) {
    // Blocked storage: the factor lasts for this page only.
  }
  memSpace.set(spaceKey(), sp);
  const svg = typeof document !== "undefined" ? svgEl() : null;
  if (!auto && view && svg) {
    const w = Number(svg.getAttribute("data-w")) || 1;
    const h = Number(svg.getAttribute("data-h")) || 1;
    const r = svg.getBoundingClientRect();
    keepCentre = { fx: ((r.width / 2 - view.x) / view.k) / w, fy: ((r.height / 2 - view.y) / view.k) / h };
  }
  redraw();
}

function spaceStep(dir) {
  const cur = spaceNow();
  setSpace(Math.max(SP_MIN, cur + dir * ((dir > 0 ? cur >= 3 : cur > 3) ? SP_STEP_BIG : SP_STEP)));
}

const memSpace = new Map();

function writePref(key, value) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(key, value);
  } catch (err) {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

function v(name) {
  return "var(" + name + ")";
}

function clip(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function load(pid) {
  if (reading.has(pid)) return;
  reading.add(pid);
  getJson("/api/v1/projects/" + encodeURIComponent(pid) + "/system").then(function (reply) {
    store.set(pid, { data: reply.data || (store.get(pid) || {}).data || null, error: null, status: reply.status });
  }, function (err) {
    store.set(pid, { data: null, error: (err && err.message) || "Could not read the system map.",
      status: (err && err.status) || 0 });
  }).then(function () {
    reading.delete(pid);
    if (lastVm) redraw();
  });
}

function markers() {
  const kinds = { n: "--text-2", m: "--text-3", d: "--info", e: "--accent", x: "--danger" };
  return "<defs>" + Object.keys(kinds).map((k) => '<marker id="sys-a-' + k + '" viewBox="0 0 10 10" refX="9" ' +
    'refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">' +
    '<path d="M0 0L10 5L0 10z" fill="' + v(kinds[k]) + '"/></marker>').join("") + "</defs>";
}

function markerOf(kind) {
  if (kind === "data") return "d";
  if (kind === "event") return "e";
  if (kind === "violation" || kind === "cycle") return "x";
  if (kind === "import") return "m";
  return "n";
}

// Who is linked to the selection: the node itself and its direct neighbours (others are dimmed).
function nearSet(edges) {
  if (!selected) return null;
  const near = new Set([selected]);
  edges.forEach((e) => {
    if (e.from === selected) near.add(e.to);
    if (e.to === selected) near.add(e.from);
  });
  return near;
}

function nodeSvg(n, near, act) {
  const sel = selected === n.id;
  const dim = near && !near.has(n.id);
  const tone = v(TONES[(Number(n.tone) || 0) % TONES.length]);
  const w = n.w;
  const h = n.h;
  const stroke = sel ? v("--focus") : n.kind === "system" ? v("--accent") : v("--line");
  const sw = sel ? 2 : n.kind === "system" ? 1.5 : 1;
  let shape;
  let tx = 14;
  if (n.kind === "person") {
    shape = '<rect width="' + w + '" height="' + h + '" rx="' + h / 2 + '" fill="' + v("--surface-2") + '" stroke="' +
      stroke + '" stroke-width="' + sw + '"/><circle cx="24" cy="18" r="6" fill="none" stroke="' + v("--text-2") +
      '" stroke-width="1.5"/><path d="M14 36a10 9 0 0 1 20 0" fill="none" stroke="' + v("--text-2") +
      '" stroke-width="1.5"/>';
    tx = 44;
  } else if (n.kind === "store") {
    const e = 7;
    shape = '<path d="M0 ' + e + "a" + w / 2 + " " + e + " 0 0 1 " + w + " 0v" + (h - 2 * e) + "a" + w / 2 + " " + e +
      " 0 0 1 " + -w + " 0z" + '" fill="' + v("--surface-2") + '" stroke="' + stroke + '" stroke-width="' + sw +
      '"/><path d="M0 ' + e + "a" + w / 2 + " " + e + " 0 0 0 " + w + ' 0" fill="none" stroke="' + stroke +
      '" stroke-width="' + sw + '"/>';
  } else if (n.kind === "external") {
    shape = '<rect width="' + w + '" height="' + h + '" rx="6" fill="' + v("--surface-1") + '" stroke="' +
      (sel ? stroke : v("--text-3")) + '" stroke-width="' + sw + '" stroke-dasharray="5 3"/>';
  } else if (n.kind === "system") {
    shape = '<rect width="' + w + '" height="' + h + '" rx="8" fill="' + v("--sel") + '" stroke="' + stroke +
      '" stroke-width="' + sw + '"/>';
  } else {
    shape = '<rect width="' + w + '" height="' + h + '" rx="6" fill="' + v("--surface-2") + '" stroke="' + stroke +
      '" stroke-width="' + sw + '" stroke-opacity="' + (sel ? 1 : 0.55) + '"/><rect x="0.5" y="6" width="4" height="' +
      (h - 12) + '" rx="2" fill="' + tone + '"/>';
  }
  const ty = n.kind === "store" ? 25 : 21;
  const room = Math.floor((w - tx - 8) / 7);
  const a = act || {};
  const bar = a.max > 0 && a.commits > 0 ? '<rect x="' + tx + '" y="' + (h - 6) + '" width="' +
    Math.max(3, ((w - tx - 10) * a.commits) / a.max).toFixed(1) + '" height="2.5" rx="1" fill="' + v("--accent") +
    '" fill-opacity=".7"/>' : "";
  const run = a.running ? '<circle cx="' + (w - 10) + '" cy="10" r="4" fill="' + v("--success") + '"><title>' +
    a.running + " job(s) running</title></circle>" : "";
  const tip = n.label + (n.sub ? "\n" + n.sub : "") + (a.commits ? "\n" + a.commits + " commits in 30 days" : "");
  return '<g class="wfg-n' + (dim ? " wfg-dim" : "") + '" data-sys="' + esc(n.id) + '" data-wf-item="' + esc(n.id) +
    '" tabindex="-1" role="button" aria-pressed="' + sel + '" aria-label="' + esc(n.label) + '" transform="translate(' +
    n.x + " " + n.y + ')"><title>' + esc(tip) + "</title>" + shape +
    '<text x="' + tx + '" y="' + ty + '" font-size="13" font-weight="600" fill="' + v("--text-1") + '">' +
    esc(clip(n.label, room)) + '</text><text x="' + tx + '" y="' + (ty + 16) + '" font-size="11" fill="' +
    v("--text-2") + '">' + esc(clip(n.sub, room + 4)) + "</text>" + bar + run + "</g>";
}

// Tooltip of an edge; a bundle (several edges drawn as one, label "×N") lists every member.
function edgeTip(e) {
  if (e.bundle) {
    return e.bundle.length + " edges\n" + e.bundle.map((m) => m.from + " \u2192 " + m.to + (m.label ? ": " +
      m.label : "")).join("\n");
  }
  return e.label + (e.count ? " (" + e.count + " imports)" : "");
}

function edgeSvg(e, near) {
  const dim = near && !(near.has(e.from) && near.has(e.to) && (e.from === selected || e.to === selected));
  const color = v(EDGE[e.kind] || "--text-2");
  const width = (e.kind === "import" ? 1.1 : 1.4) + Math.min(1.6, Math.log2((e.count || 0) + 1) * 0.25);
  const dash = e.kind === "violation" || e.kind === "cycle" ? ' stroke-dasharray="6 4"' : e.kind === "event" ?
    ' stroke-dasharray="2 3"' : "";
  const faint = weak(e) ? ' stroke-opacity=".5"' : "";
  return '<path class="sys-e' + (dim ? " wfg-dim" : "") + '" d="' + esc(e.d) + '" fill="none" stroke="' + color +
    '" stroke-width="' + width.toFixed(2) + '"' + dash + faint + ' marker-end="url(#sys-a-' + markerOf(e.kind) + ')" ' +
    'data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '"><title>' + esc(e.label + (e.count ? " (" + e.count +
    " imports)" : "")) + "</title></path>";
}

function labelSvg(e, near) {
  if (!e.label) return "";
  const dim = near && !(e.from === selected || e.to === selected);
  // No room on the drawing: the label shows only for an edge of the selected node, at the middle of the edge.
  const shown = e.lx !== null;
  if (!shown && !(selected && (e.from === selected || e.to === selected))) return "";
  const lx = shown ? e.lx : e.mx;
  const ly = shown ? e.ly : e.my;
  const lw = shown ? e.lw : labelWidth(e.label);
  return '<g class="sys-l' + (dim ? " wfg-dim" : "") + '"><rect x="' + (lx - lw / 2) + '" y="' + (ly - 8) +
    '" width="' + lw + '" height="16" rx="3" fill="' + v("--surface-1") + '" stroke="' + v("--track") +
    '"/><text x="' + lx + '" y="' + (ly + 4) + '" font-size="11" text-anchor="middle" fill="' +
    v(e.kind === "violation" || e.kind === "cycle" ? "--danger" : "--text-2") + '">' +
    esc(clip(e.label, LABEL_MAX)) + "</text></g>";
}

function activity(details) {
  const out = {};
  let max = 0;
  Object.keys(details || {}).forEach((id) => {
    const d = details[id];
    if (d && d.kind === "component") {
      const commits = Number(d.commits30) || 0;
      out[id] = { commits: commits, running: (d.heat && Number(d.heat.runningJobs)) || 0 };
      max = Math.max(max, commits);
    }
  });
  Object.keys(out).forEach((id) => {
    out[id].max = max;
  });
  return out;
}

function svgWrap(inner, w, h, label) {
  return '<svg id="sys-svg" class="wfg-svg" role="group" aria-label="' + esc(label) + '" tabindex="0" data-w="' +
    Math.ceil(w) + '" data-h="' + Math.ceil(h) + '">' + markers() + '<g id="sys-vp">' + inner + "</g></svg>";
}

// The canvas: in full screen the one inside #full-view (the hidden shell may still hold another).
function svgEl() {
  return fullHost ? fullHost.querySelector("#sys-svg") : document.getElementById("sys-svg");
}

// Width over height of the canvas (the last one drawn, else the window less the bars), for the band columns.
function canvasAspect() {
  const svg = typeof document !== "undefined" && document.getElementById ? svgEl() : null;
  const r = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
  if (r && r.width > 0 && r.height > 0) return r.width / r.height;
  const w = globalThis.innerWidth || 0;
  const h = globalThis.innerHeight || 0;
  return w > 0 && h > 240 ? w / (h - 190) : 1.8;
}

// The view after the drill path (each level a subgraph) and the collapsed groups.
export function shownView(g) {
  let out = g;
  drill.forEach((id) => {
    out = subgraph(out, id);
  });
  return collapsed.size ? collapseGroups(out, collapsed) : out;
}

function togSvg(t, id, open, label) {
  return '<g class="sys-tog" data-sys-tog="' + esc(id) + '" tabindex="0" role="button" aria-expanded="' + open +
    '" aria-label="' + esc((open ? "Collapse " : "Expand ") + label) + '"><rect x="' + t.x + '" y="' + t.y +
    '" width="' + t.size + '" height="' + t.size + '" rx="4" fill="' + v("--surface-1") + '" stroke="' +
    v("--line") + '"/><path d="M' + (t.x + 5) + " " + (t.y + t.size / 2) + "h" + (t.size - 10) +
    (open ? "" : "M" + (t.x + t.size / 2) + " " + (t.y + 5) + "v" + (t.size - 10)) + '" stroke="' + v("--text-2") +
    '" stroke-width="1.5" fill="none"/></g>';
}

export function graphSvg(g, details, label) {
  const before = lastLay;
  g = shownView(g);
  const lay = layeredLayout(g, { aspect: canvasAspect(), space: spaceNow() });
  lastLay = lay;
  if (anchorId && before) {
    const mv = anchorShift(before, lay, anchorId);
    pendingShift = mv;
    anchorId = null;
  }
  const near = nearSet(lay.edges);
  const act = activity(details);
  const shift = PAD - lay.top;
  const bands = lay.groups.map((b) => '<g><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h +
    '" rx="8" fill="' + v("--surface-2") + '" fill-opacity=".35" stroke="' + v("--track") +
    '"/><text x="' + (b.toggle ? b.toggle.x + b.toggle.size + 6 : b.x + 10) + '" y="' +
    (b.y + 16) + '" font-size="11" font-weight="600" fill="' + v("--text-3") + '">' +
    esc(b.label) + "</text>" + (b.toggle ? togSvg(b.toggle, b.id, true, b.label) : "") + "</g>").join("");
  const edges = lay.edges.map((e) => edgeSvg(e, near)).join("");
  const nodes = lay.nodes.map((n) => nodeSvg(n, near, act[n.id]) + (n.toggle ? togSvg(n.toggle,
    String(n.id).replace(/^g:/, ""), !n.collapsed, n.label) : "")).join("");
  const labels = lay.edges.map((e) => labelSvg(e, near)).join("");
  return svgWrap('<g transform="translate(0 ' + shift + ')">' + bands + edges + nodes + labels + "</g>", lay.width,
    lay.height + shift + PAD, label);
}

export function flowSvg(flow) {
  const lay = sequenceLayout(flow, spaceNow());
  const heads = lay.heads.map((p) => {
    const sel = selected === p.id;
    return '<g class="wfg-n" data-sys="' + esc(p.id) + '" data-wf-item="' + esc(p.id) + '" tabindex="-1" ' +
      'role="button" aria-pressed="' + sel + '" aria-label="' + esc(p.label) + '"><title>' + esc(p.label) +
      '</title><line x1="' + p.cx + '" y1="' + p.h + '" x2="' + p.cx + '" y2="' + lay.height + '" stroke="' +
      v("--line") + '" stroke-opacity=".6" stroke-dasharray="4 4"/><rect x="' + p.x + '" y="0" width="' + p.w +
      '" height="' + p.h + '" rx="6" fill="' + v(p.id === "p:user" ? "--sel" : "--surface-2") + '" stroke="' +
      v(sel ? "--focus" : "--line") + '" stroke-width="' + (sel ? 2 : 1) + '"/><text x="' + p.cx + '" y="25" ' +
      'font-size="13" font-weight="600" text-anchor="middle" fill="' + v("--text-1") + '">' + esc(clip(p.label, 22)) +
      "</text></g>";
  }).join("");
  const rows = lay.rows.map((r) => '<g><path d="' + r.d + '" fill="none" stroke="' + v(r.reply ? "--text-3" :
    "--text-2") + '" stroke-width="1.4"' + (r.reply ? ' stroke-dasharray="5 4"' : "") + ' marker-end="url(#sys-a-' +
    (r.reply ? "m" : "n") + ')"/><text x="' + r.lx + '" y="' + r.ly + '" font-size="12" text-anchor="' + r.anchor +
    '" fill="' + v("--text-1") + '" paint-order="stroke" stroke="' + v("--surface-1") + '" stroke-width="4">' +
    '<tspan fill="' + v("--text-3") + '">' + r.n + ".</tspan> " + esc(clip(r.label, 34)) + "</text></g>").join("");
  return svgWrap('<g transform="translate(0 ' + PAD + ')">' + heads + rows + "</g>", lay.width, lay.height + 2 * PAD,
    "Sequence diagram " + (flow.name || ""));
}

export function matrixSvg(g) {
  const lay = matrixLayout(g);
  const rows = lay.rows.map((r, i) => '<g class="wfg-n" data-sys="' + esc(r.id) + '" data-wf-item="' + esc(r.id) +
    '" tabindex="-1" role="button" aria-label="' + esc(r.label) + '">' + (i % 2 ? "" : '<rect x="0" y="' + r.y +
    '" width="' + lay.width + '" height="' + MX_ROW + '" fill="' + v("--surface-2") + '" fill-opacity=".5"/>') +
    '<text x="8" y="' + (r.y + 19) + '" font-size="12" font-weight="' + (selected === r.id ? 700 : 600) + '" fill="' +
    v(selected === r.id ? "--accent" : "--text-1") + '">' + esc(clip(r.label, 26)) + "</text></g>").join("");
  const cols = lay.cols.map((c) => '<g class="wfg-n" data-sys="' + esc(c.id) + '" data-wf-item="' + esc(c.id) +
    '" tabindex="-1" role="button" aria-label="' + esc(c.label) + '"><title>' + esc(c.label + " · " + (c.sub || "")) +
    '</title><line x1="' + c.x + '" y1="' + (MX_HEAD - 6) + '" x2="' + c.x + '" y2="' + lay.height + '" stroke="' +
    v("--track") + '"/><text transform="translate(' + (c.x + MX_COL / 2 + 4) + " " + (MX_HEAD - 8) +
    ') rotate(-55)" font-size="11" fill="' + v(selected === c.id ? "--accent" : "--text-2") + '">' +
    esc(clip(c.label, 22)) + "</text></g>").join("");
  const cells = lay.cells.map((c) => '<circle cx="' + c.x + '" cy="' + c.y + '" r="6" fill="' +
    (c.write ? v("--info") : "none") + '" stroke="' + v("--info") + '" stroke-width="1.6"><title>' +
    esc(c.label) + "</title></circle>").join("");
  const key = '<text x="8" y="' + (MX_HEAD - 30) + '" font-size="11" fill="' + v("--text-3") + '">Code \\ store</text>';
  return svgWrap('<g transform="translate(' + PAD + " " + PAD + ')">' + key + cols + rows + cells + "</g>",
    Math.max(MX_LEFT, lay.width) + 2 * PAD, lay.height + 2 * PAD, "Data access matrix");
}

function legendHtml(kinds, extra) {
  const swatch = (k, label) => '<span class="wfg-chip"><svg width="22" height="8" aria-hidden="true">' +
    '<path d="M1 4H15" stroke="' + v(EDGE[k]) + '" stroke-width="1.6"' +
    (k === "violation" ? ' stroke-dasharray="4 2"' : k === "event" ? ' stroke-dasharray="2 2"' : "") +
    '/><path d="M14 0L21 4L14 8z" fill="' + v(EDGE[k]) + '"/></svg> ' +
    esc(label) + "</span>";
  const names = { call: "calls", import: "imports (derived)", data: "reads / writes", event: "event",
    violation: "up a layer / cycle" };
  return Object.keys(names).filter((k) => kinds.has(k) || (k === "violation" && kinds.has("cycle")))
    .map((k) => swatch(k, names[k])).join("") + (extra || "");
}

function viewOf(arch, id) {
  return arch && arch.views && arch.views[id] ? arch.views[id] : { groups: [], nodes: [], edges: [] };
}

function stage(pid, arch) {
  const mode = RENDERERS[current] || VIEWS[2];
  let svg = "";
  let legend = "";
  let flowBar = "";
  let note = mode[2];
  if (current === "flows") {
    const flows = Array.isArray(arch.flows) ? arch.flows : [];
    if (!flows.length) return { html: emptyHtml("No flows found. Add \"flows\" to docs/system.json."), note: note };
    const flow = flows.find((f) => f.id === flowId) || flows[0];
    flowId = flow.id;
    flowBar = '<span class="wfg-chips" role="group" aria-label="Flow">' + flows.map((f) => '<button type="button" ' +
      'class="btn btn-small" data-sys-flow="' + esc(f.id) + '" aria-pressed="' + (f.id === flow.id) + '">' +
      esc(f.name) + "</button>").join("") + "</span>";
    note = (flow.notes || note) + (flow.derived ? " (derived from imports)" : "");
    svg = flowSvg(flow);
    legend = legendHtml(new Set(["call"])) + '<span class="wfg-chip">- - reply</span>';
  } else if (DIAGRAMS[current]) {
    const spec = DIAGRAMS[current];
    const data = arch.diagrams && arch.diagrams[current];
    let item = data;
    if (data && spec[4] === "items") {
      const items = Array.isArray(data.items) ? data.items : [];
      item = items.find((i) => i.id === flowId) || items[0];
      if (item) {
        flowId = item.id;
        flowBar = '<span class="wfg-chips" role="group" aria-label="Item">' + items.map((f) => {
          const text = esc(f.name || f.label || f.id);
          return '<button type="button" class="btn btn-small" data-sys-flow="' + esc(f.id) + '" aria-pressed="' +
            (f.id === item.id) + '">' + text + "</button>";
        }).join("") + "</span>";
      }
    }
    const has = item && (spec[4] === "items" ? true : Array.isArray(item[spec[4]]) && item[spec[4]].length);
    if (!has) return { html: emptyHtml("Nothing found for " + spec[1] + ". Try another view."), note: note };
    if (spec[3] === classSvg) clsMods = classModules(item);
    const out = spec[3](item, { selected: selected, shut: clsShut, edges: clsEdges, aspect: canvasAspect(),
      space: spaceNow() });
    svg = svgWrap(out.inner, out.w + 2 * PAD, out.h + 2 * PAD, spec[1] + " diagram").replace('<g id="sys-vp">',
      '<g id="sys-vp"><g transform="translate(' + PAD + " " + PAD + ')">').replace(/<\/g><\/svg>$/, "</g></g></svg>");
  } else {
    const g = viewOf(arch, current);
    if (!g.nodes.length) {
      const msg = "Nothing to draw here: no py, js or ts source found. Try Context or Data.";
      return { html: emptyHtml(msg), note: note };
    }
    const kinds = new Set(g.edges.map((e) => e.kind));
    if (current === "data" && g.edges.length > MATRIX_EDGES) {
      svg = matrixSvg(g);
      note = "Which component touches which store. Filled: written near where the code names it; ring: read or named.";
      legend = "";
    } else {
      svg = graphSvg(g, arch.details, mode[1] + " view");
      legend = legendHtml(kinds);
    }
  }
  const d = selected && arch.details ? arch.details[selected] : null;
  return { html: flowBar ? flowBar : "", svg: svg, legend: legend, note: note, panel: panelHtml(pid, selected, d) };
}

function viewButton(id, label, note) {
  const text = esc(label);
  return '<button type="button" class="btn btn-small" data-sys-view="' + esc(id) + '" aria-pressed="' +
    (current === id) + '" title="' + esc(note || "") + '">' + text + "</button>";
}

function unavailableHtml(c) {
  const text = esc(c.label || c.id);
  return '<button type="button" class="btn btn-small" disabled title="' + esc(c.reason || "Not available") +
    '">' + text + "</button>";
}

// With a catalog: Structure / Behaviour / Data segments of recommended views and a More menu; else every view.
function switcherHtml(arch) {
  const cat = Array.isArray(arch.catalog) ? arch.catalog.filter((c) => c && RENDERERS[c.id]) : [];
  if (!cat.length) return '<span class="wfg-chips" role="group" aria-label="View">' +
    VIEWS.map((m) => viewButton(m[0], m[1], m[2])).join("") + "</span>";
  const rec = (c) => c.id === current || (c.available !== false && Number(c.score) >= REC_SCORE);
  const btn = (c) => viewButton(c.id, c.label || RENDERERS[c.id][1], c.reason || RENDERERS[c.id][2]);
  const segs = FAMILIES.map((f) => {
    const list = cat.filter((c) => c.family === f[0] && rec(c));
    return list.length ? '<span class="sys-seg" role="group" aria-label="' + f[1] + '"><span class="sys-seg-l">' +
      f[1] + "</span>" + list.map(btn).join("") + "</span>" : "";
  }).join("");
  const more = cat.filter((c) => !rec(c));
  return segs + (more.length ? '<details class="sys-more"><summary class="btn btn-small">More</summary>' +
    '<div class="sys-more-m">' + more.map((c) => c.available === false ? unavailableHtml(c) : btn(c)).join("") +
    "</div></details>" : "");
}

function copyIdHtml(pid, arch) {
  const sel = selected && selected !== "sys" ? selected : null;
  const node = sel ? (arch.details && arch.details[sel]) || {} : null;
  const mode = RENDERERS[current] || VIEWS[2];
  const label = node ? node.title || sel : mode[1];
  const kind = sel ? "component" : "view";
  const id = sel ? sel.replace(/^[a-z]:/, "") : "system." + current;
  const sum = sel ? "System component " + label + " (" + current + " view)" : "System " + mode[1] + " view of " + pid;
  return '<span class="sys-copy">' + copyButton(kind, id, label, { project: pid, sum: sum }) + "</span>";
}

// Returns {bar: view choice + stats, acts/tools: overlay clusters drawn inside the diagram box}.
function toolbarHtml(pid, arch) {
  const fs = fullHost !== null || nativeFs() !== null;
  const op = (name, label, text, cls) => '<button type="button" class="btn btn-small' + (cls ? " " + cls : "") +
    '" data-sys-op="' + name + '" aria-label="' + label + '">' + text + "</button>";
  const s = arch.stats || {};
  const count = s.sourceFiles ? '<span class="wfg-count">' + s.sourceFiles + " source files · " + human(s.lines) +
    " lines · " + (s.imports || 0) + " imports</span>" : "";
  const screen = fullHost !== null ? op("exit", "Close full screen (Esc)", "Close") : nativeFs() !== null ?
    op("full", "Exit full screen (Esc)", "Exit full screen") : op("full", "Open full screen", "Full screen");
  const stats = fs ? "" : count;
  const sp = spaceNow();
  const ico = (d) => '<svg class="sys-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + d +
    "</svg>";
  const icoSpace = ico('<path d="M2 3v10M14 3v10M5 8h6M5 8l2-2M5 8l2 2M11 8l-2-2M11 8l-2 2"/>');
  const icoZoom = ico('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>');
  const icoFit = ico('<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>');
  const icoFull = ico('<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M6 6l-3-3M10 6l3-3M10 10l3 3M6 10l-3 3"/>');
  const seg = (label, icon, inner, aria) => '<span class="sys-zg" role="group" aria-label="' + aria + '">' +
    '<span class="sys-seg-l">' + icon + label + "</span>" + inner + "</span>";
  const spacing = seg("Space", icoSpace, op("sp-less", "Less space", "−") +
    '<button type="button" class="btn btn-small sys-sp" data-sys-op="sp-val" aria-label="Reset space" ' +
    'title="Double-click to reset">' + spaceText(sp) + "</button>" + op("sp-more", "More space", "+"), "Space");
  const zoom = seg("Zoom", icoZoom, op("out", "Zoom out", "−") + op("actual", "Zoom to 100 percent", "100%",
    "sys-zoom") + op("in", "Zoom in", "+"), "Zoom");
  const sep = '<span class="sys-sep" aria-hidden="true"></span>';
  const tools = '<span class="sys-ov sys-ov-tr" role="group" aria-label="Space, zoom and screen">' + spacing + sep +
    zoom + sep + op("fit", "Fit to screen", icoFit + "Fit") + screen.replace(/>([^<]+)<\/button>$/,
    (m, t) => ">" + (t === "Full screen" || t === "Exit full screen" ? icoFull : "") + t + "</button>") + "</span>";
  const acts = '<span class="sys-ov sys-ov-tl" role="group" aria-label="Diagram actions">' +
    op("sys", "Show the system summary", "Summary") + copyIdHtml(pid, arch) +
    op("update", "Add a task to update and check the System diagrams", "Update diagrams") +
    (current === "classes" ? op("cls-shut", "Collapse all class modules", "Collapse all") +
      op("cls-open", "Expand all class modules", "Expand all") +
      op("cls-edges", "Class edges: " + clsEdges + " (click to change)", "Class edges: " + clsEdges) : "") + "</span>";
  return { bar: '<div class="wfg-bar" role="toolbar" aria-label="System views">' + switcherHtml(arch) + stats +
    "</div>", acts: acts, tools: tools };
}

function retryHtml() {
  return '<button type="button" class="btn btn-small" data-sys-op="retry">Retry</button>';
}

export function bodyHtml(pid, got) {
  if (!got) return skeletonHtml(["w-90", "w-60"]);
  if (got.error) {
    if (got.status === 404) return emptyHtml("System map needs the API", retryHtml());
    return bannerHtml("warning", "System map could not be read.", got.error) + "<p>" + retryHtml() + "</p>";
  }
  const sys = got.data || {};
  const warn = (Array.isArray(sys.warnings) ? sys.warnings : []).slice(0, 3).map((w) => chipHtml(String(w), "warning"))
    .join("");
  const arch = sys.arch;
  if (!arch || !arch.views) {
    return emptyHtml("No structure found. Restart the service to load the system views, or add docs/system.json.",
      retryHtml());
  }
  const st = stage(pid, arch);
  const note = current === "flows" ? '<span class="wfg-note">' + esc(st.note) + "</span>" : "";
  const tb = toolbarHtml(pid, arch);
  const head = (st.html && !st.svg ? "" : st.html) + note + warn;
  const leg = st.legend ? '<span class="sys-ov sys-ov-bl" role="group" aria-label="Legend">' + st.legend +
    "</span>" : "";
  return tb.bar + crumbsHtml() + (head ? '<div class="wfg-bar">' + head + "</div>" : "") +
    '<div class="sys-box">' + tb.acts + tb.tools + (st.svg ? '<div class="wfg-stage sys-canvas">' + st.svg + "</div>" :
    st.html) + leg + "</div>" + (st.panel || "");
}

// Breadcrumb of drill levels: the view, then each opened group; the last is the current level.
function crumbsHtml() {
  if (!drill.length) return "";
  const mode = RENDERERS[current] || VIEWS[2];
  const item = (label, i, last) => {
    const text = esc(label);
    return last ? '<span class="sys-crumb" aria-current="page">' + text + "</span>" :
      '<button type="button" class="btn btn-small" data-sys-crumb="' + i + '">' + text + "</button>";
  };
  const parts = [item(mode[1], -1, false)].concat(drill.map((id, i) => item(id.replace(/^[a-z]:/, ""), i,
    i === drill.length - 1)));
  return '<nav class="sys-crumbs" aria-label="Drill level">' + parts.join('<span aria-hidden="true">/</span>') +
    "</nav>";
}

function sectionHtml(vm) {
  if (vm.route.name !== "project") {
    return emptyHtml("Pick a project to see its system views.");
  }
  const pid = vm.route.id;
  const mode = RENDERERS[current] || VIEWS[2];
  return '<div class="sys" id="sys-root">' + sysInner(pid, mode) + "</div>";
}

function sysInner(pid, mode) {
  return '<div class="page-head"><p class="page-note">' +
    esc(mode[0] === "flows" ? "Sequence diagrams of key flows." : mode[2]) + "</p></div>" +
    bodyHtml(pid, store.get(pid));
}

// A7: "#/full/<pid>/system" shows the same module state alone in #full-view (no nav); Close or Esc goes back.
let fullHost = null;
let seq = 0;
export function fullHash(pid) {
  return "#/full/" + pid + "/system";
}

function redraw() {
  if (fullHost && lastVm) {
    const pid = lastVm.route.id;
    patch(fullHost.firstChild.id, '<div class="sys">' + bodyHtml(pid, store.get(pid)) + "</div>");
    mountSoon();
    return;
  }
  if (!lastVm) return;
  const fsEl = nativeFs();
  if (fsEl && fsEl.id === "sys-root" && lastVm.route.name === "project") {
    // Native full screen: keep the .sys element (replacing it would leave full screen), swap only what is inside.
    patch("sys-root", sysInner(lastVm.route.id, RENDERERS[current] || VIEWS[2]));
    mountSoon();
    return;
  }
  patch("main", sectionHtml(lastVm));
  mountSoon();
}

function arch() {
  const got = lastVm ? store.get(lastVm.route.id) : null;
  return got && got.data && got.data.arch ? got.data.arch : null;
}

// Selects a node; when it is not drawn in this view, the first view that has it is shown.
function select(id) {
  selected = id && selected !== id ? id : null;
  const a = arch();
  if (selected && selected !== "sys" && a && current !== "flows" &&
    !viewOf(a, current).nodes.some((n) => n.id === selected)) {
    const other = ["components", "modules", "containers", "data", "context", "layers"].find((k) =>
      viewOf(a, k).nodes.some((n) => n.id === selected));
    if (other) setView(other);
  }
  if (typeof document !== "undefined" && lastVm) {
    document.dispatchEvent(new CustomEvent("system:select", { detail: { pid: lastVm.route.id, id: selected } }));
  }
  redraw();
}

function setView(id) {
  current = id;
  writePref("rb.sys.view", id);
  auto = true;
  view = null;
  drill = [];
  collapsed.clear();
  lastLay = null;
}

// Space the overlay clusters take at the top and bottom of the canvas (+8px), so Fit keeps the drawing clear of them.
function overlayInset(svg, r) {
  const host = svg.parentElement && svg.parentElement.closest ? svg.parentElement.closest(".sys-box") : null;
  const out = { top: 0, bottom: 0 };
  if (!host || !host.querySelectorAll || !r) return out;
  host.querySelectorAll(".sys-ov").forEach((o) => {
    const b = o.getBoundingClientRect();
    if (!b.height) return;
    if (b.top - r.top < r.height / 2) out.top = Math.max(out.top, b.bottom - r.top + 8);
    else out.bottom = Math.max(out.bottom, r.bottom - b.top + 8);
  });
  return out;
}

// The true fit: the whole drawing inside the canvas, centred, scale clamped to 0.2..1.5.
export function openingView(box, size, inset) {
  const top = (inset && inset.top) || 0;
  const bot = (inset && inset.bottom) || 0;
  const free = Math.max(1, size.h - top - bot);
  const fit = Math.min((size.w - 2 * PAD) / Math.max(1, box.w), (free - 2 * PAD) / Math.max(1, box.h));
  const k = Math.max(FIT_MIN, Math.min(FIT_MAX, fit));
  return { k: k, x: (size.w - box.w * k) / 2, y: top + (free - box.h * k) / 2 };
}

function nativeFs() {
  if (typeof document === "undefined") return null;
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function zoomText(k) {
  return Math.round(k * 100) + "%";
}

function mountNow() {
  const svg = typeof document !== "undefined" ? svgEl() : null;
  if (!svg || mounted.has(svg)) return;
  mounted.add(svg);
  const box = { w: Number(svg.getAttribute("data-w")) || 1, h: Number(svg.getAttribute("data-h")) || 1 };
  const r = svg.getBoundingClientRect();
  const size = { w: r.width || box.w, h: r.height || box.h };
  const inset = overlayInset(svg, r);
  svg.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      e.stopImmediatePropagation();
      spaceStep(e.key === "]" ? 1 : -1);
      return;
    }
    if (e.key !== "0" && e.key !== "f" && e.key !== "F") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fitNow();
  }, true);
  if (pendingShift && !auto && view) {
    view = { k: view.k, x: view.x - pendingShift.dx * view.k, y: view.y - pendingShift.dy * view.k };
  }
  pendingShift = null;
  if (keepCentre && !auto && view) {
    view = { k: view.k, x: size.w / 2 - keepCentre.fx * box.w * view.k,
      y: size.h / 2 - keepCentre.fy * box.h * view.k };
  }
  keepCentre = null;
  api = mountViewport(svg, svg.querySelector("#sys-vp"), {
    view: auto || !view ? openingView(box, size, inset) : view, box: box, taps: taps, fit: false,
    onTap: (el) => select(el.getAttribute("data-sys")),
    onClear: () => {
      if (selected) select(null);
    },
    onView: (nv) => {
      view = { k: nv.k, x: nv.x, y: nv.y };
      const root = svg.closest ? svg.closest(".sys") : null;
      const z = root ? root.querySelector(".sys-zoom") : null;
      if (z) z.textContent = zoomText(nv.k);
    },
  });
  if (watcher) watcher.disconnect();
  if (typeof ResizeObserver === "function") {
    let last = size.w + "x" + size.h;
    watcher = new ResizeObserver(() => {
      const rr = svg.getBoundingClientRect();
      const now = rr.width + "x" + rr.height;
      if (now === last || !auto || !svg.isConnected) return;
      last = now;
      mounted.delete(svg);
      redraw();
    });
    watcher.observe(svg);
  }
  const manual = () => {
    auto = false;
  };
  bindMenu(svg);
  svg.addEventListener("pointerdown", manual);
  svg.addEventListener("wheel", manual);
}

function mountSoon() {
  if (typeof setTimeout === "function") setTimeout(mountNow, 0);
}

function onKey(event) {
  if (!lastVm) return;
  const t = event.target;
  if ((event.key === "Enter" || event.key === " ") && t && t.getAttribute && t.getAttribute("data-sys-tog")) {
    event.preventDefault();
    toggleGroup(t.getAttribute("data-sys-tog"));
  } else if ((event.key === "Enter" || event.key === " ") && t && t.getAttribute && t.getAttribute("data-sys")) {
    event.preventDefault();
    select(t.getAttribute("data-sys"));
  } else if (event.key === "Escape") {
    if (selected) select(null);
    else if (fullHost) closeFull();
  }
}

function closeFull() {
  const pid = lastVm ? lastVm.route.id : "";
  const prev = fullHost && fullHost.getAttribute("data-from");
  window.location.hash = prev || "#/p/" + pid + "/system";
}

function openFull() {
  if (!lastVm || lastVm.route.name !== "project") return;
  from = window.location.hash;
  window.location.hash = fullHash(lastVm.route.id);
}

// Called by app.js on every render of the full route; the section's state (view, selection, zoom) carries over.
export function mountFull(host, pid) {
  if (!lastVm || lastVm.route.id !== pid) lastVm = { route: { name: "project", id: pid } };
  if (!bound) bindDoc();
  if (!store.has(pid) && !reading.has(pid)) load(pid);
  if (fullHost !== host || !host.firstChild) {
    host.textContent = "";
    const box = document.createElement("div");
    box.id = "sys-full-" + (seq += 1);
    box.style.height = "calc(100vh - 16px)";
    host.appendChild(box);
    host.style.setProperty("--h-top", "0px");
    host.style.padding = "8px";
    host.style.minHeight = "100vh";
    host.style.boxSizing = "border-box";
    host.style.background = "var(--surface-0)";
    host.setAttribute("data-from", from);
    fullHost = host;
    if (api) api.destroy();
    api = null;
  }
  redraw();
}

// Leaves full-screen mode (app.js calls it when the hash is no longer the full route).
export function leaveFull() {
  if (!fullHost) return;
  fullHost = null;
  if (api) api.destroy();
  api = null;
  mounted = new WeakSet();
  redraw();
}

function onClick(event) {
  const t = event.target && event.target.closest ?
    event.target.closest("[data-sys-view],[data-sys-op],[data-sys-flow],[data-sys-go],[data-sys-tog]," +
      "[data-sys-crumb]") : null;
  if (!t || !lastVm) return;
  if (t.hasAttribute("data-sys-view")) {
    setView(t.getAttribute("data-sys-view"));
    const a = arch();
    if (selected && selected !== "sys" && a && !viewOf(a, current).nodes.some((n) => n.id === selected)) {
      selected = null;
    }
    redraw();
    return;
  }
  if (t.hasAttribute("data-sys-tog")) {
    toggleGroup(t.getAttribute("data-sys-tog"));
    return;
  }
  if (t.hasAttribute("data-sys-crumb")) {
    drill = drill.slice(0, Number(t.getAttribute("data-sys-crumb")) + 1);
    lastLay = null;
    fitNow();
    return;
  }
  if (t.hasAttribute("data-sys-flow")) {
    flowId = t.getAttribute("data-sys-flow");
    auto = true;
    redraw();
    return;
  }
  if (t.hasAttribute("data-sys-go")) {
    event.preventDefault();
    selected = null;
    select(t.getAttribute("data-sys-go"));
    return;
  }
  const op = t.getAttribute("data-sys-op");
  if (op === "close") select(null);
  else if (op === "sys") {
    selected = null;
    select("sys");
  } else if (op === "retry") {
    store.delete(lastVm.route.id);
    load(lastVm.route.id);
    redraw();
  } else if (op === "full") toggleFull(t);
  else if (op === "exit") closeFull();
  else if (op === "sp-less") spaceStep(-1);
  else if (op === "sp-more") spaceStep(1);
  else if (op === "fit") fitNow();
  else if (op === "cls-shut") setAllModules(true);
  else if (op === "cls-open") setAllModules(false);
  else if (op === "cls-edges") {
    clsEdges = EDGE_MODES[(EDGE_MODES.indexOf(clsEdges) + 1) % EDGE_MODES.length];
    redraw();
  }
  else if (api && op === "actual") {
    auto = false;
    api.actual();
  } else if (api && (op === "in" || op === "out")) {
    auto = false;
    api.zoom(op === "in" ? 1.25 : 0.8);
  } else if (op === "update") updateDiagrams(lastVm.route.id);
  else if (op === "ask") askHead(lastVm.route.id, t.getAttribute("data-sys-id"), t.getAttribute("data-sys-label"));
}

// Collapse (shut) or expand every class module at once; the per-module toggles keep working after it.
function setAllModules(shut) {
  clsShut.clear();
  if (shut) clsMods.forEach((g) => clsShut.add(g));
  redraw();
}

function toggleGroup(id) {
  if (String(id).startsWith("cls:")) {
    const g = String(id).slice(4);
    if (clsShut.has(g)) clsShut.delete(g);
    else clsShut.add(g);
    redraw();
    return;
  }
  anchorId = id;
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  redraw();
}

function drillInto(id) {
  const g = String(id).replace(/^g:/, "");
  collapsed.delete(g);
  drill = drill.concat([g]);
  lastLay = null;
  fitNow();
}

function menuTarget(node) {
  const id = node.getAttribute("data-sys");
  const a = arch();
  const d = a && a.details ? a.details[id] : null;
  const n = (a ? viewOf(a, current).nodes : []).find((x) => x.id === id) || {};
  return { id: id, label: n.label || (d && d.title) || id, kind: n.kind || (d && d.kind) || "node",
    group: n.kind === "group" };
}

function menuAction(action, id) {
  if (!lastVm) return;
  const pid = lastVm.route.id;
  if (action === "details") {
    selected = null;
    select(id);
  } else if (action === "work") window.location.hash = "#/p/" + encodeURIComponent(pid) + "/work";
  else if (action === "copy") {
    const text = refOf(pid, "component", String(id).replace(/^[a-z]:/, ""));
    if (globalThis.navigator && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => null);
  } else if (action === "ask") askHead(pid, id, "");
  else if (action === "toggle") toggleGroup(String(id).replace(/^g:/, ""));
  else if (action === "drill") drillInto(id);
  else if (action === "views") {
    selected = null;
    select(id);
  }
}

function bindMenu(svg) {
  const host = svg.closest ? svg.closest(".sys") : null;
  if (!host) return;
  bindContextMenu(svg, menuTarget, (t, at) => {
    const a = arch();
    const d = a && a.details ? a.details[t.id] : null;
    const gid = String(t.id).replace(/^g:/, "");
    openMenu(host, at, t, d, { pid: lastVm.route.id, expanded: !collapsed.has(gid) && !t.id.startsWith("g:"),
      canDrill: t.group || t.kind === "container", returnFocus: svg }, menuAction);
  });
}

// Fit button and key: always the true fit of the whole drawing.
function fitNow() {
  auto = true;
  view = null;
  redraw();
}

// Full screen: the Fullscreen API on the .sys element; without it (or when refused) the #/full/<pid>/system route.
function toggleFull(btn) {
  if (nativeFs()) {
    const out = document.exitFullscreen || document.webkitExitFullscreen;
    if (out) out.call(document);
    return;
  }
  const el = btn && btn.closest ? btn.closest(".sys") : null;
  const ask = el && (el.requestFullscreen || el.webkitRequestFullscreen);
  if (!ask) {
    openFull();
    return;
  }
  try {
    const res = ask.call(el);
    if (res && typeof res.catch === "function") res.catch(() => openFull());
  } catch (err) {
    openFull();
  }
}

async function updateDiagrams(pid) {
  const made = await run("task.add", { title: "Update System diagrams and check them (" + pid + ")" },
    { project: pid, label: "Task added: update System diagrams" });
  if (!made || !made.id) return;
  await run("head.log", { text: "Update the System diagrams of " + pid + " and check them", kind: "ask",
    sum: "update System diagrams", refs: ["task:" + made.id] },
  { project: pid, label: "Head asked to update the diagrams" });
}

function askHead(pid, id, label) {
  const name = label || id || "component";
  const ref = refOf(pid, "component", String(id || "").replace(/^[a-z]:/, ""));
  return run("head.log", { text: "Question about System component " + name + " (" + ref + "): please review it",
    kind: "question", sum: "System: " + name, refs: ["doc:docs/system.json"] },
  { project: pid, label: "Question sent to Head" });
}

let bound = false;
let from = "";
function bindDoc() {
  bound = true;
  document.addEventListener("click", onClick);
  document.addEventListener("dblclick", (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-sys-op="sp-val"]')) setSpace(1);
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", redraw);
  document.addEventListener("webkitfullscreenchange", redraw);
}

export function sectionView(vm) {
  if (lastVm && lastVm.route.id !== vm.route.id) {
    selected = null;
    flowId = null;
    auto = true;
    view = null;
  }
  lastVm = vm;
  if (!bound && typeof document !== "undefined" && document.addEventListener) {
    bindDoc();
  }
  if (vm.route.name === "project" && !store.has(vm.route.id) && !reading.has(vm.route.id)) load(vm.route.id);
  mountSoon();
  return sectionHtml(vm);
}
