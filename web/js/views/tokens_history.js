// Token history for the Tokens page (R11.6): the Overview tab (general tokens used, remaining estimate per phase) and
// the History tab (model usage charts). Data comes from GET /api/v1/tokens/history (services/tokenhist.py), read once
// per half minute while the page is open. State (tab, range, metric, model chips) lives in this module; a change
// re-renders through the app's rb:render event. All markup is built with esc(); charts come from tokens_charts.js.

import { getJson, postJson } from "../api.js";
import { esc } from "../dom.js";
import { refButtonHtml } from "../ref.js";
import { MISSING } from "../format.js";
import { donut, fmtN, hBars, lineChart, shareBar, stackedBars, tableHtml } from "./tokens_charts.js";

export const TABS = [["overview", "Overview"], ["history", "History"], ["by", "By task"], ["limits", "Limits"],
  ["account", "Account"]];
const RANGES = [["7", "7 days"], ["30", "30 days"], ["all", "All"]];
const METRICS = [["units", "Units"], ["out", "Output"], ["total", "All tokens"]];
const MODELS = ["haiku", "sonnet", "opus", "other"];
const METRIC_NOTE = { units: "weighted units (model price x tokens)", out: "output tokens",
  total: "all tokens including cache" };
const FRESH_MS = 30000;
const MAX_DAYS = 180;
const TOP_N = 10;

const ui = { tab: "limits", range: "30", metric: "units", off: new Set(), data: null, key: null, at: 0,
  loading: false, error: false };

function rerender() {
  if (typeof document !== "undefined") document.dispatchEvent(new Event("rb:render"));
}

function load(pid) {
  if (ui.loading || typeof fetch === "undefined") return;
  if (ui.data && ui.key === pid && Date.now() - ui.at < FRESH_MS) return;
  ui.loading = true;
  const url = "/api/v1/tokens/history" + (pid ? "?project=" + encodeURIComponent(pid) : "");
  getJson(url).then(function (res) {
    if (!res || res.status !== 200 || !res.data || !Array.isArray(res.data.days)) throw new Error("history");
    ui.data = res.data;
    ui.key = pid;
    ui.error = false;
  }).catch(function () {
    ui.error = true;
    ui.key = pid;
  }).finally(function () {
    ui.loading = false;
    ui.at = Date.now();
    rerender();
  });
}

// Called by the page after each render: reads the history when the page is not showing fresh data.
export function ensureHistory(pid) {
  if (ui.data && ui.key === pid && Date.now() - ui.at < FRESH_MS) return;
  if (ui.error && ui.key === pid && Date.now() - ui.at < FRESH_MS) return;
  setTimeout(function () {
    load(pid);
  }, 0);
}

export function activeTab() {
  return ui.tab;
}

// The header row above the tabs (R11.141): the active account, always, and the all-time measured tokens for the page's
// project (or all projects). Reads the same data the tabs use, so no extra request is made.
export function headerMetaHtml(pid, label) {
  ensureHistory(pid);
  ensureAccounts();
  const active = acct.data && Array.isArray(acct.data.accounts) ? acct.data.accounts.find(function (a) {
    return a.active;
  }) : null;
  let who = "";
  if (active) {
    const id = active.identity || {};
    const mail = id.email || id.emailMasked || "";
    who = esc(active.label) + (mail ? " · " + esc(mail) : "");
  }
  const d = ui.data;
  let total = "";
  if (d && ui.key === pid && d.totals && d.totals.all) {
    const t = d.totals.all;
    total = fmtN(t.in + t.out + t.cacheRead + t.cacheWrite);
  }
  return '<span class="tk-bar-who">' + (who || esc("No account")) + "</span>" +
    '<span class="tk-bar-total">' + esc(label) + ' <strong class="num">' + (total || MISSING) + "</strong></span>";
}

function cellValue(c, metric) {
  if (!c) return 0;
  if (metric === "out") return c.out;
  if (metric === "total") return c.in + c.out + c.cacheRead + c.cacheWrite;
  return c.units;
}

function wait(what) {
  if (ui.error) {
    return '<p class="page-note">' + esc(what + " could not be loaded. ") +
      '<button type="button" class="btn" data-tk="retry" data-focus="tk-retry">Retry</button></p>';
  }
  return '<p class="page-note" role="status">' + esc("Loading " + what.toLowerCase() + "…") + "</p>";
}

function card(id, title, note, body) {
  return '<section class="ov-card tk-card" aria-labelledby="' + id + '"><div class="lim-bar"><h3 id="' + id +
    '" class="lim-h">' + esc(title) + "</h3>" + (note ? '<span class="page-note">' + esc(note) + "</span>" : "") +
    "</div>" + body + "</section>";
}

// ------------------------------------------------------------------ Overview

function totalsHtml(d) {
  const t = d.totals;
  const rows = [["Jobs", "jobs"], ["Weighted units", "units"], ["Output", "out"], ["Input", "in"],
    ["Cache written", "cacheWrite"], ["Cache read", "cacheRead"]];
  const head = '<li class="row-grid tk-tot rg-head"><span class="rg-t">Measured tokens</span>' +
    '<span class="rg-num">Today</span><span class="rg-num">7 days</span><span class="rg-num">All time</span></li>';
  const body = rows.map(function (r) {
    const cell = function (scope) {
      return '<span class="rg-num num">' + esc(fmtN(t[scope][r[1]])) + "</span>";
    };
    return '<li class="row-grid tk-tot"><span class="rg-t">' + esc(r[0]) + "</span>" + cell("today") + cell("d7") +
      cell("all") + "</li>";
  }).join("");
  return '<ul class="spend-list" aria-label="Tokens used in total">' + head + body + "</ul>";
}

function projectsHtml(d) {
  if (d.projects.length < 2) return "";
  const head = '<li class="row-grid tk-proj rg-head"><span class="rg-t">Project</span>' +
    '<span class="rg-num">Jobs</span><span class="rg-num">Units today</span><span class="rg-num">Units 7 days</span>' +
    '<span class="rg-num">Units all</span><span class="rg-num">Output all</span></li>';
  const body = d.projects.map(function (p) {
    return '<li class="row-grid tk-proj"><span class="rg-t" title="' + esc(p.name) + '">' + esc(p.name) +
      '</span><span class="rg-num num">' + p.all.jobs + '</span><span class="rg-num num">' +
      esc(fmtN(p.today.units)) + '</span><span class="rg-num num">' + esc(fmtN(p.d7.units)) +
      '</span><span class="rg-num num">' + esc(fmtN(p.all.units)) + '</span><span class="rg-num num">' +
      esc(fmtN(p.all.out)) + "</span></li>";
  }).join("");
  return '<ul class="spend-list" aria-label="Tokens used per project">' + head + body + "</ul>";
}

function remainingHtml(d, many) {
  const head = '<li class="row-grid tk-rem rg-head"><span class="rg-t">Phase</span><span class="rg-num">Open</span>' +
    '<span class="rg-num">Estimate</span><span class="rg-num">Spent</span>' +
    '<span class="rg-num">≈ Remaining</span></li>';
  const k = function (v) {
    return fmtN(v * 1000);
  };
  const body = d.phases.map(function (p) {
    const label = p.id + " · " + p.name + (many ? " (" + p.projectName + ")" : "");
    return '<li class="row-grid tk-rem"><span class="rg-t" title="' + esc(label) + '">' + esc(label) +
      '</span><span class="rg-num num">' + p.open + '</span><span class="rg-num num">' + esc(k(p.estK)) +
      '</span><span class="rg-num num">' + esc(k(p.spentK)) + '</span><span class="rg-num num">≈ ' +
      esc(k(p.remainingK)) + "</span></li>";
  }).join("");
  const open = d.phases.reduce(function (a, p) {
    return a + p.open;
  }, 0);
  const sum = function (key) {
    return d.phases.reduce(function (a, p) {
      return a + p[key];
    }, 0);
  };
  const foot = '<li class="row-grid tk-rem tk-sum"><span class="rg-t">All phases</span><span class="rg-num num">' +
    open + '</span><span class="rg-num num">' + esc(k(sum("estK"))) + '</span><span class="rg-num num">' +
    esc(k(sum("spentK"))) + '</span><span class="rg-num num">≈ ' + esc(k(d.remainingK)) + "</span></li>";
  const rows = d.phases.length ? head + body + foot : '<li class="page-note">No open tasks with an estimate.</li>';
  return '<ul class="spend-list" aria-label="Remaining tokens per phase">' + rows + "</ul>";
}

export function overviewHtml(pid) {
  ensureHistory(pid);
  const d = ui.data;
  if (!d || ui.key !== pid) return card("tk-ov-used", "Tokens used", "", wait("Token totals"));
  const many = d.projects.length > 1;
  const used = card("tk-ov-used", "Tokens used", "Measured from finished jobs, all models.",
    totalsHtml(d) + projectsHtml(d));
  const rem = card("tk-ov-rem", "Remaining work ≈ estimate",
    "Task estimate minus tokens already spent on it, open tasks only.", remainingHtml(d, many));
  return '<div class="tk-two">' + used + rem + "</div>";
}

// ------------------------------------------------------------------ History

function daysOf(d) {
  const end = new Date(d.today + "T12:00:00");
  let n = ui.range === "7" ? 7 : ui.range === "30" ? 30 : MAX_DAYS;
  if (ui.range === "all" && d.firstDay) {
    const first = new Date(d.firstDay + "T12:00:00");
    n = Math.min(MAX_DAYS, Math.max(1, Math.round((end - first) / 86400000) + 1));
  }
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(end.getTime() - i * 86400000);
    const iso = day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" +
      String(day.getDate()).padStart(2, "0");
    out.push(iso);
  }
  return out;
}

function chipsHtml() {
  return MODELS.map(function (m) {
    const on = !ui.off.has(m);
    return '<button type="button" class="tk-chip" data-tk="chip" data-model="' + m + '" aria-pressed="' + on +
      '" data-focus="tk-chip-' + m + '"><span class="tk-sw tk-b-' + m + '" aria-hidden="true"></span>' + m +
      "</button>";
  }).join("");
}

function segHtml(kind, items, current) {
  return '<span class="hd-seg" role="group" aria-label="' + kind + '">' + items.map(function (it) {
    return '<button type="button" data-tk="' + kind + '" data-value="' + it[0] + '" aria-pressed="' +
      (it[0] === current) + '" data-focus="tk-' + kind + '-' + it[0] + '">' +
      esc(it[1]) + "</button>";
  }).join("") + "</span>";
}

function legendHtml(keys) {
  return '<ul class="tk-leg" aria-label="Models">' + keys.map(function (m) {
    return '<li><span class="tk-sw tk-b-' + m + '" aria-hidden="true"></span>' + m + "</li>";
  }).join("") + "</ul>";
}

function dayLabel(iso) {
  return iso.slice(5);
}

function topRows(rows, labelOf, tipOf) {
  return rows.filter(function (r) {
    return r.units > 0;
  }).slice(0, TOP_N).map(function (r) {
    const v = cellValue(r, ui.metric);
    return { label: labelOf(r), value: v, cls: "tk-m-sonnet", text: fmtN(v), tip: tipOf(r, v) };
  }).sort(function (a, b) {
    return b.value - a.value;
  });
}

export function historyHtml(pid) {
  ensureHistory(pid);
  const d = ui.data;
  const controls = '<div class="tk-ctl">' + segHtml("range", RANGES, ui.range) + segHtml("metric", METRICS, ui.metric) +
    '<span class="tk-chips" role="group" aria-label="Models shown">' + chipsHtml() + "</span></div>";
  if (!d || ui.key !== pid) return controls + wait("History");
  const keys = MODELS.filter(function (m) {
    return !ui.off.has(m);
  });
  const days = daysOf(d);
  const byDay = {};
  for (const row of d.days) byDay[row.d] = row.m;
  const metricNote = METRIC_NOTE[ui.metric];
  const slots = days.map(function (iso) {
    const parts = {};
    let total = 0;
    const bits = [];
    for (const m of keys) {
      const v = cellValue((byDay[iso] || {})[m], ui.metric);
      parts[m] = v;
      total += v;
      if (v > 0) bits.push(m + " " + fmtN(v));
    }
    return { iso: iso, label: dayLabel(iso), parts: parts,
      tip: iso + " · total " + fmtN(total) + (bits.length ? " · " + bits.join(" · ") : "") };
  });
  const perDay = card("tk-h-day", "Per day by model", metricNote, stackedBars(slots, keys, {
    label: "Tokens per day by model, " + metricNote }) + legendHtml(keys) + tableHtml("Per day by model",
    ["Day"].concat(keys), slots.map(function (s) {
      return [s.iso].concat(keys.map(function (m) {
        return fmtN(s.parts[m]);
      }));
    })));
  // Cumulative line: running total per model over the shown days.
  let top = 0;
  const lines = keys.map(function (m) {
    let acc = 0;
    const pts = slots.map(function (s, i) {
      acc += s.parts[m];
      top = Math.max(top, acc);
      return { x: i, y: acc, tip: s.iso + " · " + m + " running total " + fmtN(acc) };
    });
    return { name: m, cls: "tk-ln-" + m, pts: pts };
  });
  const cum = card("tk-h-cum", "Cumulative", metricNote, lineChart(lines, 0, Math.max(slots.length - 1, 1), top,
    xTicks(slots), { label: "Running total by model, " + metricNote }) + legendHtml(keys) +
    tableHtml("Cumulative by model", ["Model", "Total"], lines.map(function (l) {
      return [l.name, fmtN(l.pts.length ? l.pts[l.pts.length - 1].y : 0)];
    })));
  // Share: sum over the shown days.
  const share = keys.map(function (m) {
    let sum = 0;
    for (const s of slots) sum += s.parts[m];
    return { key: m, value: sum };
  });
  const shareTotal = share.reduce(function (a, p) {
    return a + p.value;
  }, 0);
  const pct = function (v) {
    return shareTotal > 0 ? Math.round((v / shareTotal) * 1000) / 10 + "%" : MISSING;
  };
  share.forEach(function (p) {
    p.tip = p.key + " · " + fmtN(p.value) + " · " + pct(p.value);
  });
  const shareCard = card("tk-h-share", "Model share", metricNote, '<div class="tk-share">' +
    donut(share, fmtN(shareTotal), { label: "Share by model, " + metricNote }) + '<ul class="tk-leg tk-leg-v">' +
    share.map(function (p) {
      return '<li><span class="tk-sw tk-b-' + p.key + '" aria-hidden="true"></span><span class="tk-lg-n">' + p.key +
        '</span><span class="num">' + esc(fmtN(p.value)) + '</span><span class="num">' + esc(pct(p.value)) +
        "</span></li>";
    }).join("") + "</ul></div>" + shareBar(share, { label: "Share by model as one bar" }) +
    tableHtml("Model share", ["Model", "Total", "Share"], share.map(function (p) {
      return [p.key, fmtN(p.value), pct(p.value)];
    })));
  // Jobs per day.
  const jobSlots = days.map(function (iso) {
    const parts = {};
    let total = 0;
    for (const m of keys) {
      parts[m] = ((byDay[iso] || {})[m] || { jobs: 0 }).jobs;
      total += parts[m];
    }
    return { label: dayLabel(iso), parts: parts, tip: iso + " · " + total + " jobs" };
  });
  const jobs = card("tk-h-jobs", "Jobs per day", "Every job, measured or not.", stackedBars(jobSlots, keys, {
    label: "Jobs per day by model", h: 150, fmt: fmtN }) + tableHtml("Jobs per day", ["Day", "Jobs"],
    jobSlots.map(function (s, i) {
      return [days[i], String(keys.reduce(function (a, m) {
        return a + s.parts[m];
      }, 0))];
    })));
  const phaseRows = topRows(d.phaseUse || [], function (r) {
    return r.id;
  }, function (r, v) {
    return r.id + " · " + fmtN(v) + " · " + r.jobs + " jobs";
  });
  const taskRows = topRows(d.tasks || [], function (r) {
    return r.id;
  }, function (r, v) {
    return r.id + " · " + fmtN(v) + " · " + r.jobs + " jobs";
  });
  const tops = card("tk-h-top", "Top phases and tasks", "All time, " + metricNote + "; model chips do not apply.",
    '<div class="tk-pair"><div><h4 class="tk-sub">Phases</h4>' + hBars(phaseRows, { label: "Top phases" }) +
    '</div><div><h4 class="tk-sub">Tasks</h4>' + hBars(taskRows, { label: "Top tasks" }) +
    "</div></div>" + tableHtml("Top phases and tasks", ["Name", "Total"], phaseRows.concat(taskRows).map(function (r) {
      return [r.label, r.text];
    })));
  // Weekly % samples inside the range.
  const first = days.length ? Date.parse(days[0] + "T00:00:00") / 1000 : 0;
  const last = days.length ? Date.parse(days[days.length - 1] + "T23:59:59") / 1000 : 1;
  const samples = (d.samples || []).filter(function (s) {
    return s.t >= first && s.t <= last;
  });
  const pts = samples.map(function (s) {
    return { x: s.t, y: s.wk, tip: new Date(s.t * 1000).toLocaleString() + " · weekly " + s.wk + "%" };
  });
  const weekly = card("tk-h-week", "Weekly limit used", "Readings of the weekly percent.", pts.length ?
    lineChart([{ name: "weekly", cls: "tk-ln-week", pts: pts }], first, last, 100, [
      { x: first, label: dayLabel(days[0]) }, { x: last, label: dayLabel(days[days.length - 1]), edge: true }],
    { label: "Weekly limit percent over time", fixedMax: 100, fmt: function (v) {
      return Math.round(v) + "%";
    } }) + tableHtml("Weekly readings", ["Time", "Weekly %"], samples.slice(-40).map(function (s) {
      return [new Date(s.t * 1000).toLocaleString(), s.wk + "%"];
    })) : '<p class="page-note">No readings in this range.</p>');
  return controls + '<div class="tk-grid">' + perDay + cum + shareCard + jobs + tops + weekly + "</div>";
}

function xTicks(slots) {
  const out = [];
  const every = Math.max(1, Math.ceil(slots.length / 8));
  slots.forEach(function (s, i) {
    if (i % every === 0) out.push({ x: i, label: s.label });
  });
  return out;
}


// ------------------------------------------------------------------ accounts (R11.8)
// GET /api/v1/usage/accounts -> services/usage_accounts.list_status(); POST /api/v1/usage/accounts/<id>/<action> with
// action connect | disconnect | switch | check | login (login opens Terminal; the person finishes it in the browser).
// Login and logout run the existing CLI flow; the page never sees a password or token. E-mails are masked on the
// phone listener only (it may be reached over a tunnel); the main listener shows the full address.
const ACCT_LOGIN_NOTE = "Added nothing yet: run this in a terminal, then click Add again:";
const acct = {
  data: null, at: 0, loading: false, error: false,
  busy: "", note: "", loginCmd: "",
  adding: false, advanced: false,
};

function loadAccounts() {
  if (acct.loading || typeof fetch === "undefined") return;
  acct.loading = true;
  getJson("/api/v1/usage/accounts").then(function (res) {
    if (!res || res.status !== 200 || !res.data || !Array.isArray(res.data.accounts)) throw new Error("accounts");
    acct.data = res.data;
    acct.error = false;
  }).catch(function () {
    acct.error = true;
  }).finally(function () {
    acct.loading = false;
    acct.at = Date.now();
    rerender();
  });
}

export function ensureAccounts() {
  if (acct.data && Date.now() - acct.at < FRESH_MS) return;
  if (acct.error && Date.now() - acct.at < FRESH_MS) return;
  setTimeout(loadAccounts, 0);
}

function acctAge(s) {
  if (typeof s !== "number") return MISSING;
  return s < 90 ? "now" : s < 5400 ? Math.round(s / 60) + "m ago" : s < 129600 ? Math.round(s / 3600) + "h ago" :
    Math.round(s / 86400) + "d ago";
}

function acctButton(id, action, label, extra) {
  const text = esc(label);
  return '<button type="button" class="btn" data-tk="acct" data-id="' + esc(id) + '" data-act="' + action +
    '" aria-label="' + esc(label + " " + (extra || "")) + '"' + (acct.busy ? " disabled" : "") + ">" +
    text + "</button>";
}

export function acctPanelHtml() {
  ensureAccounts();
  if (!acct.data) {
    return acct.error ? '<p class="page-note">Accounts could not be loaded. ' +
      '<button type="button" class="btn" data-tk="acct" data-act="reload">Retry</button></p>'
      : '<p class="page-note">Loading accounts.</p>';
  }
  // One table: the list owns the tracks (tokens.css --acct-cols); header and rows take them through subgrid.
  const cell = function (label, cls, body, title) {
    return '<span class="' + (cls ? "tk-acct-cell " + cls : "tk-acct-cell") + '" data-label="' + esc(label) + '"' +
      (title ? ' title="' + esc(title) + '"' : "") + ">" + body + "</span>";
  };
  const head = '<li class="tk-acct-head">' + cell("Account", "", "Account") + cell("Logged in as", "", "Logged in as") +
    cell("Status", "", "Status") + cell("Weekly", "tk-acct-num", "Weekly") + cell("5 hour", "tk-acct-num", "5 hour") +
    cell("Read", "tk-acct-num", "Read") + cell("Actions", "tk-acct-actions", "Actions") + "</li>";
  const pct = function (v) {
    return typeof v === "number" ? Math.round(v) + "%" : MISSING;
  };
  const rows = acct.data.accounts.map(function (a) {
    const who = a.identity || {};
    const name = who.loggedIn === false ? "not logged in" :
      [who.email || who.emailMasked, who.plan].filter(Boolean).join(" · ") || MISSING;
    const nameTitle = name === MISSING ? "Not known until the account is checked" : (who.orgName || "");
    const r = a.reading || {};
    const btns = [a.active ? "" : acctButton(a.id, "switch", "Use", a.label),
      acctButton(a.id, "login", "Log in", a.label),
      acctButton(a.id, "check", "Check", a.label),
      a.enabled ? acctButton(a.id, "disconnect", "Disconnect", a.label) :
        acctButton(a.id, "connect", "Connect", a.label),
      a.active ? "" : acctButton(a.id, "remove", "Remove", a.label)]
      .join("");
    return '<li class="tk-acct-row">' +
      cell("Account", "", esc(a.label) + (a.active ? " (active)" : ""), a.path || "") +
      cell("Logged in as", "", esc(name), nameTitle) +
      cell("Status", "", esc(a.status), a.reason || "") +
      cell("Weekly", "tk-acct-num", esc(pct(r.weeklyPercent))) +
      cell("5 hour", "tk-acct-num", esc(pct(r.fiveHourPercent))) +
      cell("Read", "tk-acct-num", esc(acctAge(r.ageS))) +
      cell("Actions", "tk-acct-actions", btns) + "</li>";
  }).join("");
  return '<ul class="spend-list tk-acct-list" aria-label="Claude accounts">' + head + rows + "</ul>" +
    acctAddForm() +
    '<p class="page-note" role="status">' + acctNoteHtml(acct.note || acct.data.note || "") + "</p>";
}

// The login hint gets a Copy button (the shared copy-ref action) next to its command; other notes are plain text.
function acctNoteHtml(note) {
  if (note !== ACCT_LOGIN_NOTE || !acct.loginCmd) return esc(note);
  return esc(note) + " <code>" + esc(acct.loginCmd) + "</code> " +
    refButtonHtml(acct.loginCmd, "login command", "");
}

function acctSlug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function acctAddForm() {
  if (!acct.adding) {
    return '<p><button type="button" class="btn" data-tk="acct" data-act="add-open">+ Add account</button></p>';
  }
  const slug = acctSlug(acct.lastLabel || "");
  const defaultPath = slug ? "~/.claude-" + slug : "";
  const advanced = acct.advanced ?
    '<label>Type <select name="source"><option value="config-dir">Config dir</option>' +
    '<option value="credentials-file">Credentials file</option></select></label> ' +
    '<label>Path <input type="text" name="path" placeholder="~/.claude-work" autocomplete="off" value="' +
    esc(defaultPath) + '" required></label> ' :
    '<button type="button" class="btn" data-tk="acct" data-act="advanced-toggle">Advanced</button>';
  return '<form class="tk-acct-add" data-act="add-form" autocomplete="off">' +
    '<label>Label <input type="text" name="label" required autocomplete="off" value="' +
      esc(acct.lastLabel || "") + '"></label>' +
    advanced +
    '<button type="submit" class="btn">Add</button> ' +
    '<button type="button" class="btn" data-tk="acct" data-act="add-cancel">Cancel</button></form>';
}

function acctAdd(form) {
  if (acct.busy) return;
  const f = form.elements;
  const label = f.label.value.trim();
  const id = acctSlug(label);
  const source = acct.advanced && f.source ? f.source.value : "config-dir";
  const path = acct.advanced && f.path ? f.path.value.trim() : "~/.claude-" + id;
  acct.lastLabel = label;
  acct.busy = "add";
  const payload = {id: id, label: label, source: source, path: path};
  postJson("/api/v1/usage/accounts", payload)
    .then(function () {
      acct.adding = false;
      acct.advanced = false;
      acct.lastLabel = "";
      acct.note = "Done: added " + label + ".";
    }).catch(function (err) {
      const msg = err && err.message ? err.message : "add";
      if (!acct.advanced && source === "config-dir" && /does not exist/.test(msg)) {
        acct.note = ACCT_LOGIN_NOTE;
        acct.loginCmd = "CLAUDE_CONFIG_DIR=" + path + " claude auth login";
      } else {
        acct.note = "Failed: " + msg;
      }
    }).finally(function () {
      acct.busy = "";
      acct.at = 0;
      rerender();
    });
}

function acctAction(el) {
  const act = el.getAttribute("data-act");
  const id = el.getAttribute("data-id");
  if (act === "add-open" || act === "add-cancel") {
    acct.adding = act === "add-open";
    acct.advanced = false;
    acct.lastLabel = "";
    rerender();
    return;
  }
  if (act === "advanced-toggle") {
    const form = el.closest("form");
    const labelEl = form && form.elements ? form.elements.label : null;
    acct.lastLabel = labelEl ? labelEl.value : "";
    acct.advanced = true;
    rerender();
    return;
  }
  if (act === "reload") {
    acct.at = 0;
    acct.error = false;
    rerender();
    return;
  }
  if (acct.busy || !/^(connect|disconnect|switch|check|login|remove)$/.test(act) || !id) return;
  acct.busy = act;
  postJson("/api/v1/usage/accounts/" + encodeURIComponent(id) + "/" + act, {}).then(function (res) {
    const d = res && res.data || {};
    acct.note = act === "login" ? (d.opened ? "Terminal opened: finish the login in the browser." :
      "Run in a terminal: " + (d.command || "claude auth login")) : "Done: " + act + ".";
  }).catch(function (err) {
    acct.note = "Failed: " + (err && err.message ? err.message : act);
  }).finally(function () {
    acct.busy = "";
    acct.at = 0;
    rerender();
  });
}

// ------------------------------------------------------------------ events

let tipEl = null;

function tip(event) {
  const el = event.target && event.target.closest ? event.target.closest("[data-tip]") : null;
  if (!el) {
    if (tipEl) tipEl.hidden = true;
    return;
  }
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tk-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = el.getAttribute("data-tip");
  tipEl.hidden = false;
  const box = tipEl.getBoundingClientRect();
  tipEl.style.left = Math.max(4, Math.min(event.clientX + 12, window.innerWidth - box.width - 4)) + "px";
  tipEl.style.top = Math.max(4, Math.min(event.clientY + 14, window.innerHeight - box.height - 4)) + "px";
}

function click(event) {
  const el = event.target && event.target.closest ? event.target.closest("[data-tk]") : null;
  if (!el) return;
  const kind = el.getAttribute("data-tk");
  const value = el.getAttribute("data-value");
  if (kind === "acct") return acctAction(el);
  if (kind === "tab" && TABS.some((t) => t[0] === value)) ui.tab = value;
  else if (kind === "range" && RANGES.some((r) => r[0] === value)) ui.range = value;
  else if (kind === "metric" && METRICS.some((m) => m[0] === value)) ui.metric = value;
  else if (kind === "chip") {
    const model = el.getAttribute("data-model");
    if (ui.off.has(model)) ui.off.delete(model);
    else if (ui.off.size < MODELS.length - 1) ui.off.add(model);
  } else if (kind === "retry") {
    ui.error = false;
    ui.at = 0;
  } else return;
  rerender();
}

function keys(event) {
  const el = event.target && event.target.closest ? event.target.closest('[role="tab"][data-tk="tab"]') : null;
  if (!el || (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End")) {
    return;
  }
  const at = TABS.findIndex((t) => t[0] === ui.tab);
  let next = at;
  if (event.key === "ArrowRight") next = (at + 1) % TABS.length;
  else if (event.key === "ArrowLeft") next = (at + TABS.length - 1) % TABS.length;
  else next = event.key === "Home" ? 0 : TABS.length - 1;
  event.preventDefault();
  ui.tab = TABS[next][0];
  rerender();
  setTimeout(function () {
    const btn = document.querySelector('[data-tk="tab"][data-value="' + ui.tab + '"]');
    if (btn) btn.focus();
  }, 0);
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("click", click);
  document.addEventListener("submit", function (event) {
    const form = event.target;
    if (form && form.getAttribute && form.getAttribute("data-act") === "add-form") {
      event.preventDefault();
      acctAdd(form);
    }
  });
  document.addEventListener("keydown", keys);
  document.addEventListener("pointerover", tip);
  document.addEventListener("pointermove", tip);
  document.addEventListener("pointerleave", function () {
    if (tipEl) tipEl.hidden = true;
  }, true);
}
