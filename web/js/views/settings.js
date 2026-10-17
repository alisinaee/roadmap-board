// Settings (WP33): theme, density, what a phone may change, keyboard help, where the data lives and the debug log
// (R7.16 step 5a). Theme and density are kept in the UI preferences (state.js); nothing here writes to the project
// files. The log switch is kept in this browser (log.js); the log status and report are read-only GET requests.

import { esc } from "../dom.js";
import { csrfToken, getJson } from "../api.js";
import { helpRows, setSingleKeys, singleKeysOn } from "../keys.js";
import { setEnabled, status as logStatusNow } from "../log.js";
import { loadUi, saveTheme, updateUi } from "../state.js";
import { showToast } from "./toast.js";

const THEMES = [
  { id: "auto", label: "Match system" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];
const DENSITIES = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];
const DENSITY_IDS = DENSITIES.map(function (d) {
  return d.id;
});
const LOG_SWITCH = [
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];
const SINGLE_KEYS_SWITCH = [
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];
const LOG_STATUS_URL = "/api/v1/log/status";
const LOG_REPORT_URL = "/api/v1/log/report?n=30";
const LOG_STATUS_MS = 5000;

// The last status read from the server ({enabled, bytes, files}), or null when not read yet or not available.
let serverLog = null;
let serverLogFailed = false;
let serverLogAt = 0;

// Choice buttons form a radio group: role radiogroup, role radio with aria-checked, and a tick for the chosen one
// (not colour alone). Only the chosen radio takes the Tab stop; the arrow keys move between them (radioArrowKey).
// The blank icon keeps the other labels in the same place.
function choiceHtml(name, options, current, action) {
  return '<div class="rule-tabs" role="radiogroup" aria-label="' + esc(name) + '">' + options.map(function (o) {
    const on = o.id === current;
    return '<button type="button" class="btn btn-small" role="radio" aria-checked="' + (on ? "true" : "false") +
      '" tabindex="' + (on ? "0" : "-1") + '" data-action="' + esc(action) + '" data-value="' + esc(o.id) +
      '" data-focus="' + esc(action) + "-" + esc(o.id) + '"><svg class="ico" aria-hidden="true" focusable="false">' +
      '<use href="/icons.svg#' + (on ? "i-check" : "i-blank") + '"></use></svg>' + esc(o.label) + "</button>";
  }).join("") + "</div>";
}

// Arrow keys between the radios of one radiogroup: focus moves and the radio it lands on is chosen (WAI-ARIA radio
// group). The click goes through app.js like a mouse click, so the choice is saved and the page re-renders.
function radioArrowKey(event) {
  const key = event.key;
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return;
  const el = event.target;
  if (!el || !el.getAttribute || el.getAttribute("role") !== "radio") return;
  const group = el.closest ? el.closest('[role="radiogroup"]') : null;
  if (!group) return;
  const radios = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));
  const step = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  const next = radios[(radios.indexOf(el) + step + radios.length) % radios.length];
  event.preventDefault();
  next.focus();
  next.click();
}

if (typeof document !== "undefined") document.addEventListener("keydown", radioArrowKey);

// The single-key switch (keys.js reads it on every key). Off turns off the letters, ? and [ ] keys.
function singleKeysHtml() {
  const on = singleKeysOn() ? "on" : "off";
  return '<p class="lim-label">Single-key shortcuts</p>' +
    choiceHtml("Single-key shortcuts", SINGLE_KEYS_SWITCH, on, "set-single-keys") +
    '<p class="page-note">Keys such as ? [ ] and the letters for items. Turn them off if they get in the way. ' +
    "Ctrl+K and Esc still work.</p>";
}

// The shortcut list from keys.js, the same rows as the ? help: one line per shortcut, so it wraps on a phone.
function keysHtml() {
  return helpRows().map(function (row) {
    return '<p class="page-note"><span class="kbd">' + esc(row[0]) + "</span> " + esc(row[1]) + "</p>";
  }).join("");
}

function applyDensity(value) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", value);
}

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (Math.round(n / (1024 * 1024) * 10) / 10) + " MB";
}

// The status sentence under the switch. It names the browser switch and what the server holds (sizes only).
function logLine() {
  const here = logStatusNow().enabled ? "on" : "off";
  if (serverLogFailed) return "Recording in this browser: " + here + ". The log status is not available right now.";
  if (!serverLog) return "Recording in this browser: " + here + ". Checking the log.";
  const files = Number(serverLog.files) || 0;
  return "Recording in this browser: " + here + ". Log on this Mac: " + (serverLog.enabled ? "on" : "off") + ", " +
    sizeText(serverLog.bytes) + " in " + files + (files === 1 ? " file." : " files.");
}

function setLogLine() {
  if (typeof document === "undefined") return;
  const el = document.getElementById("set-log-status");
  if (el) el.textContent = logLine();
}

// Read the status at most every 5 s. Only the status line is updated; the page does not re-render.
async function refreshLogStatus() {
  serverLogAt = Date.now();
  try {
    const res = await getJson(LOG_STATUS_URL);
    if (res && res.data && typeof res.data === "object") {
      serverLog = res.data;
      serverLogFailed = false;
    } else {
      serverLogFailed = true;
    }
  } catch (err) {
    serverLogFailed = true;
  }
  setLogLine();
}

function maybeRefreshLogStatus() {
  if (Date.now() - serverLogAt < LOG_STATUS_MS) return;
  refreshLogStatus().catch(function () {});
}

function loggingHtml() {
  const on = logStatusNow().enabled ? "on" : "off";
  return '<section class="ov-card" aria-labelledby="set-log"><h3 id="set-log" class="lim-h">Logging</h3>' +
    '<p class="lim-label">Record what happens in this dashboard (stays on this Mac)</p>' +
    choiceHtml("Record what happens in this dashboard (stays on this Mac)", LOG_SWITCH, on, "set-log") +
    '<p class="page-note" id="set-log-status" aria-live="polite">' + esc(logLine()) + "</p>" +
    '<p class="page-note">It records errors, named actions and slow requests, never form values or passwords; ' +
    "agents can read it with roadmap logs.</p>" +
    '<button type="button" class="btn" data-action="log-report" data-focus="log-report" ' +
    'aria-label="Copy debug report">Copy debug report</button>' +
    "</section>";
}

export function sectionView() {
  const ui = loadUi();
  applyDensity(ui.density);
  // The phone page carries no CSRF value and records nothing, so it has no Logging section.
  const logging = typeof document !== "undefined" && csrfToken() ? loggingHtml() : "";
  if (logging) maybeRefreshLogStatus();
  return '<div class="page-head">' +
    '<p class="page-note">Browser preferences only; projects keep separate settings.</p></div>' +
    '<section class="ov-card" aria-labelledby="set-look"><h3 id="set-look" class="lim-h">Appearance</h3>' +
    '<p class="lim-label">Theme</p>' + choiceHtml("Theme", THEMES, ui.theme, "set-theme") +
    '<p class="lim-label">Density</p>' + choiceHtml("Density", DENSITIES, ui.density, "set-density") +
    "</section>" +
    '<section class="ov-card" aria-labelledby="set-phone"><h3 id="set-phone" class="lim-h">Phone</h3>' +
    '<p class="page-note">Read only on a phone: it can see every project and answer questions. It cannot change ' +
    "limits, overrides, rules, caps or approvals.</p></section>" +
    '<section class="ov-card" aria-labelledby="set-keys"><h3 id="set-keys" class="lim-h">Keyboard shortcuts</h3>' +
    '<p class="page-note">Press ? anywhere to see this list.</p>' + singleKeysHtml() + keysHtml() +
    '<button type="button" class="btn" data-action="help-open" data-focus="help-open">Show in a dialog</button>' +
    "</section>" +
    logging +
    '<section class="ov-card" aria-labelledby="set-data"><h3 id="set-data" class="lim-h">Data</h3>' +
    '<p class="page-note">Global limits, the usage ledger and the global config live in the roadmap home folder. ' +
    "Each project keeps its rules in docs/rules.txt and its budget in budget.json. Run roadmap doctor to see the " +
    "exact paths.</p></section>";
}

// Show the report text in a read-only field inside the toast, selected, when the clipboard is not available.
function reportFallback(text) {
  const id = showToast({ text: "Select the text and copy it" });
  const toast = document.querySelector('[data-toast="' + id + '"]');
  if (!toast) return;
  const field = document.createElement("textarea");
  field.readOnly = true;
  field.value = text;
  field.rows = 6;
  field.className = "ref-text";
  field.setAttribute("aria-label", "Debug report text");
  toast.appendChild(field);
  field.focus();
  field.select();
}

function copyReportText(text) {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== "function") {
    reportFallback(text);
    return;
  }
  nav.clipboard.writeText(text).then(function () {
    showToast({ text: "Copied" });
  }, function () {
    reportFallback(text);
  }).catch(function () {});
}

// Fetch the plain-text report (same-origin GET) and copy it. A failed fetch shows one sentence and never throws.
async function copyReport() {
  let text = "";
  try {
    const res = await fetch(LOG_REPORT_URL, {
      method: "GET",
      headers: { Accept: "text/plain" },
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("status " + res.status);
    text = await res.text();
  } catch (err) {
    showToast({ text: "The debug report could not be read. Check that Roadmap is running on this Mac." });
    return;
  }
  copyReportText(text);
}

// Theme, density, log switch and report actions. Returns true when handled (app.js re-renders).
export function settingsAction(action, el) {
  if (action === "set-theme") {
    const value = el.getAttribute("data-value");
    saveTheme(value);
    if (value === "auto") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", value);
    }
    return true;
  }
  if (action === "set-density") {
    const value = el.getAttribute("data-value");
    if (DENSITY_IDS.indexOf(value) < 0) return true;
    updateUi(function (ui) {
      ui.density = value;
    });
    applyDensity(value);
    return true;
  }
  if (action === "set-log") {
    setEnabled(el.getAttribute("data-value") === "on");
    return true;
  }
  if (action === "set-single-keys") {
    setSingleKeys(el.getAttribute("data-value") === "on");
    return true;
  }
  if (action === "log-report") {
    copyReport().catch(function () {});
    return true;
  }
  return false;
}
