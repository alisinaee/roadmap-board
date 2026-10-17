// Head screen (R7.31 H8, docs/HEAD-SPEC.md sections 5 and 10). One row per logged message on the shared row grid
// (UI rule 0): the header sits above the list on the same tracks, numbers are right-aligned, and the copy button
// stays at the right edge. A row is toggled by a stretched button that covers the whole row (keyboard: Enter/Space,
// aria-expanded); the buttons and links in the row sit above it. An open row shows the verbatim text (fetched once
// per row from the read route with full=H.., cached), the history, and a footer with the status, the bound-to chips
// and the actions. The screen paints the snapshot head.rows first, then pages older rows in from GET
// .../head?offset&limit (a
// Load more button, and the list end when it scrolls into view), deduped by id. A filter only
// selects among those rows. Filters and the deep-linked open row live in the page hash (#head?f=open&id=H12).
// Every value goes through esc() or textContent; the commands are head.accept, head.set, head.bind, head.split,
// head.merge and the copy button.

import { esc } from "../dom.js";
import { chipHtml } from "../dom.js";
import { emptyHtml as pageEmpty, parseOne, swapNode } from "../dom.js";
import { fmtPercent } from "../format.js";
import { copyButton } from "../ref.js";
import { pendingValue, run } from "../cmd.js";
import { getJson } from "../api.js";
import { buildHash } from "../router.js";
import { showToast } from "./toast.js";
import { toolbarHtml } from "../toolbar.js";
import { collect, pageState, questionCardHtml, questionKey, watchCountdowns } from "./inbox.js";

export const FILTERS = [["open", "Open"], ["queue", "Queue"], ["doing", "Doing"], ["done", "Done"],
  ["failed", "Failed"], ["needs", "Needs you"], ["blocked", "Blocked"], ["closed", "Closed"], ["all", "All"]];
const KINDS = ["ask", "decision", "rule", "bug", "preference", "question", "review", "info"];
// Each ledger status shows as one state: [filter key, label, chip tone]. Tones are the existing token chips, distinct
// per state; the kind chips use their own tones (KIND_TONE). Queue is new or understood, Doing is bound or doing.
const STATE_OF = { new: ["queue", "Queue", "neutral"], understood: ["queue", "Queue", "neutral"],
  bound: ["doing", "Doing", "sonnet"], doing: ["doing", "Doing", "sonnet"], done: ["done", "Done", "success"],
  failed: ["failed", "Failed", "danger"], "needs-you": ["needs", "Needs you", "warning"],
  blocked: ["blocked", "Blocked", "opus"], declined: ["closed", "Closed", "defer"],
  merged: ["closed", "Closed", "defer"] };
const KIND_TONE = { ask: "haiku", bug: "danger", rule: "opus", decision: "success", preference: "agy",
  question: "cursor", review: "warning", info: "defer" };
const CLOSED = ["done", "declined", "merged"];
const UNHANDLED = ["new", "understood"];
const BOUND_MAX = 2;
const FULL_CONCURRENCY = 3;
const FULL_ID = /^H\d{1,4}$/;
const SORTS = ["new", "old"];
const SUM_SHOW = 240;
const PAGE_SIZE = 50;

// Client state: the verbatim texts fetched so far (key "project\nid@rev"), the requests in flight, the open row ids,
// and the hash row already opened once (so a re-render does not reopen a row the person closed). fullRev is the
// revision of the snapshot on screen; a cached text is used only while its revision is the current one.
const fullCache = new Map();
let fullRev = "";
const inflight = new Map();
const openSet = new Set();
const queue = [];
let active = 0;
let seededId = "";
// Paged rows of the full ledger per project and scope ("open" or "all"): rows, offset, total, counts, loading, error.
const pages = new Map();
let observer = null;

function rowsOf(vm) {
  const head = vm && vm.head ? vm.head : {};
  return Array.isArray(head.rows) ? head.rows : [];
}

// The state of a ledger status: its filter key, label and chip tone (an unknown status shows as itself).
function stateOf(status) {
  return STATE_OF[status] || [String(status), String(status), "neutral"];
}

function passes(row, opts) {
  const f = opts.f || "all";
  const st = row.status;
  if (f === "open" && CLOSED.indexOf(st) >= 0) return false;
  if (f !== "open" && f !== "all" && stateOf(st)[0] !== f) return false;
  if (opts.kind && row.kind !== opts.kind) return false;
  if (opts.sid && String(row.acct || row.sid || "") !== opts.sid) return false;
  if (opts.q) {
    const text = (String(row.id) + " " + String(row.sum || "")).toLowerCase();
    if (text.indexOf(String(opts.q).toLowerCase()) < 0) return false;
  }
  return true;
}

// A server count is used only when it is not larger than the matching rows. A bigger unhandled or needs count
// falls back to those rows; a bigger doneUnacc falls back to done rows that are not accepted.
function countsOf(head, rows) {
  const c = head.counts || {};
  // A ledger count (from a paged read) is the whole log, so it is used as it is.
  if (head.ledger) return { unhandled: c.unhandled || 0, needs: c.needs || 0, doneUnacc: c.doneUnacc || 0 };
  const count = function (test) {
    return rows.filter(test).length;
  };
  const unhandled = count(function (r) {
    return UNHANDLED.indexOf(r.status) >= 0;
  });
  const needs = count(function (r) {
    return r.status === "needs-you";
  });
  const done = count(function (r) {
    return r.status === "done";
  });
  const doneUnacc = count(function (r) {
    return r.status === "done" && !r.acc;
  });
  return {
    unhandled: c.unhandled != null && c.unhandled <= unhandled ? c.unhandled : unhandled,
    needs: c.needs != null && c.needs <= needs ? c.needs : needs,
    doneUnacc: c.doneUnacc != null && c.doneUnacc <= doneUnacc ? c.doneUnacc : doneUnacc,
  };
}

// Local HH:MM of an ISO time, or "" when it does not parse.
function hm(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!isFinite(ms)) return "";
  const d = new Date(ms);
  return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
}

// The model chip of the header: "Opus 5.5 · since 09:23"; acct, usage and the previous models sit in its tooltip.
function nowHtml(head) {
  const now = head.now || {};
  const usage = now.usage || {};
  if (!now.model) {
    return '<span class="chip chip-neutral hd-model hd-badge-off">Head: not claimed (run roadmap head claim)</span>';
  }
  const at = hm(now.since) || String(now.since || "").slice(0, 16);
  const tip = [now.acct ? "acct " + now.acct : null, now.since ? "since " + now.since : null,
    usage.h5 != null ? "5h " + fmtPercent(usage.h5) : null, usage.wk != null ? "week " + fmtPercent(usage.wk) : null]
    .filter(Boolean).join(" · ");
  const prev = (head.prev || []).slice(0, 5).map(function (p) {
    return [p.model, p.acct ? "acct " + p.acct : null, p.until ? "until " + p.until : null]
      .filter(Boolean).join(" ");
  });
  const title = [tip].concat(prev.length ? ["Previous: " + prev.join("; ")] : []).filter(Boolean).join("\n");
  return '<span class="chip chip-success hd-model" tabindex="0" title="' + esc(title) + '">' + esc(now.model) +
    (at ? " · since " + esc(at) : "") + "</span>";
}

function alertsHtml(counts) {
  const items = [];
  if (counts.unhandled > 0) {
    items.push('<a class="hd-alert" href="#head?f=queue">' + esc(counts.unhandled + " queued") +
      " <span>Show</span></a>");
  }
  if (counts.needs > 0) {
    items.push('<a class="hd-alert" href="#head?f=needs">' + esc(counts.needs + " needs you") +
      " <span>Show</span></a>");
  }
  if (counts.doneUnacc > 0) {
    items.push('<a class="hd-alert" href="#head?f=done">' + esc(counts.doneUnacc + " done, not accepted") +
      " <span>Review</span></a>");
  }
  return items.length ? '<nav class="hd-alerts" aria-label="Needs attention">' + items.join("") + "</nav>" : "";
}

// The page hash for one filter state. Empty values are left out, so the hash stays short; the default order
// (sort=new) is left out too.
export function hashOf(state) {
  const keys = ["f", "q", "kind", "sid", "sort", "id", "view"];
  const parts = [];
  for (const key of keys) {
    if (state[key] && !(key === "sort" && state[key] === "new")) {
      parts.push(key + "=" + encodeURIComponent(String(state[key])));
    }
  }
  return "#head" + (parts.length ? "?" + parts.join("&") : "");
}

// The Head bar (R11.119): one toolbar row. The view switch (List | Cards) and search sit in the row; Status, Kind,
// Session and Order are the Filters popover, and the applied chips show under the row. The state stays in the hash.
function barHtml(vm, opts) {
  const accts = [];
  for (const row of rowsOf(vm)) {
    const label = String(row.acct || row.sid || "");
    if (label && accts.indexOf(label) < 0) accts.push(label);
  }
  const cur = opts.f || "all";
  const groups = [
    { id: "status", label: "Status", options: FILTERS.filter(function (p) {
      return p[0] !== "all";
    }).map(function (p) {
      return { token: "status:" + p[0], label: p[1], on: cur === p[0] };
    }) },
    { id: "kind", label: "Kind", options: KINDS.map(function (k) {
      return { token: "kind:" + k, label: k, on: opts.kind === k };
    }) },
    { id: "session", label: "Session", options: accts.map(function (a) {
      return { token: "sid:" + a, label: a, on: opts.sid === a };
    }) },
    { id: "order", label: "Order", options: [{ token: "sort:old", label: "Oldest first", on: opts.sort === "old" }] },
  ].filter(function (g) {
    return g.options.length > 0;
  });
  const bar = toolbarHtml({
    key: "head", label: "Head toolbar",
    views: [{ id: "list", label: "List", current: opts.view !== "cards" },
      { id: "cards", label: "Cards", current: opts.view === "cards" }],
    search: { value: opts.q || "", placeholder: "/ search", label: "Search the log" },
    groups: groups,
    actions: [{ id: "log", label: "+ Log", primary: true }],
  });
  return '<div class="hd-bar" data-f="' + esc(cur) + '" data-view="' +
    (opts.view === "cards" ? "cards" : "list") + '">' + bar + countHtml(opts.pager) + "</div>";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The local date and time of an entry's ts: "15 Oct 14:32" (full: "15 Oct 2026 14:32"), or MISSING without a ts.
export function whenText(iso, full) {
  const ms = Date.parse(String(iso || ""));
  if (!isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = function (n) {
    return (n < 10 ? "0" : "") + n;
  };
  return d.getDate() + " " + MONTHS[d.getMonth()] + (full ? " " + d.getFullYear() : "") + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function ageText(minutes) {
  if (typeof minutes !== "number" || !isFinite(minutes)) return "";
  if (minutes < 60) return Math.max(0, Math.round(minutes)) + "m";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h";
  return Math.floor(minutes / 1440) + "d";
}

// Age, amber and stale of a row, from its ts at paint time (a 304 keeps the stored snapshot, so the build-time age
// would stay old). Amber after 30 minutes and stale after 120, for unhandled rows only (head.fold rule).
function rowAge(row) {
  const at = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
  if (!isFinite(at)) return { age: row.age, amber: !!row.amber, stale: !!row.stale };
  const minutes = Math.max(0, (Date.now() - at) / 60000);
  const unhandled = UNHANDLED.indexOf(row.status) >= 0;
  return { age: Math.floor(minutes), amber: unhandled && minutes > 30, stale: unhandled && minutes > 120 };
}

// The section that shows each linked kind; the ref's id is the item selected there. Other kinds stay plain chips.
const LINK_SECTION = { task: "work", issue: "issues", job: "agents", rule: "rules" };
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

// The hash a bound-to chip opens: the item in its section (ask: this screen, on that entry), or "" for no link.
function refHref(ref, pid) {
  const at = String(ref).indexOf(":");
  const kind = at > 0 ? String(ref).slice(0, at) : "";
  const id = at > 0 ? String(ref).slice(at + 1) : "";
  if (!ITEM_ID.test(id)) return "";
  if (kind === "ask") return hashOf({ id: id });
  const section = LINK_SECTION[kind];
  if (!section) return "";
  return pid ? buildHash({ name: "project", id: pid, section: section, item: id }) : "#/all/" + section;
}

// A bound ref is "kind:id" (a plain string) or the snapshot object {ref, title, status, jobs}; both read the same way.
function linkOf(ref) {
  const obj = ref && typeof ref === "object" ? ref : { ref: ref };
  return { ref: String(obj.ref || ""), title: obj.title ? String(obj.title) : "",
    status: obj.status ? String(obj.status) : "", jobs: Array.isArray(obj.jobs) ? obj.jobs : [] };
}

// The chip tone of a bound task's status: a running or done task is good, a blocked one needs a look.
function taskTone(st) {
  if (st === "done" || st === "doing") return "success";
  return st === "blocked" || st === "hold" ? "warning" : "neutral";
}

// The bound-to chips: at most max of them (the closed row shows two), each with its status when the snapshot has
// one, then +n for the rest. An entry with no bound task says so in words.
function boundHtml(links, pid, max) {
  const list = Array.isArray(links) ? links.map(linkOf) : [];
  const limit = max == null ? BOUND_MAX : max;
  if (!list.length) return '<span class="hd-none">Not bound yet</span>';
  const chips = list.slice(0, limit).map(function (link) {
    const label = link.ref.split(":").pop();
    const href = refHref(link.ref, pid);
    const chip = href ? '<a class="chip chip-neutral" href="' + esc(href) + '" title="' + esc(link.ref) + '">' +
      esc(label) + "</a>" : '<span class="chip chip-neutral" title="' + esc(link.ref) + '">' + esc(label) + "</span>";
    const st = link.status ? '<span class="chip chip-' + esc(taskTone(link.status)) + '">' + esc(link.status) +
      "</span>" : "";
    return chip + st;
  });
  if (list.length > limit) chips.push('<span class="chip chip-neutral">+' + (list.length - limit) + "</span>");
  return chips.join("");
}

function statusHtml(row) {
  if (row.status === "done" && row.auto) {
    return '<span class="chip chip-neutral hd-outline" title="Auto-done: waiting for the person">done?</span>';
  }
  const state = stateOf(row.status);
  return '<span class="chip chip-' + esc(state[2]) + '" data-state="' + esc(state[0]) + '">' + esc(state[1]) +
    "</span>";
}

// The kind chip: one tone per kind (KIND_TONE), neutral for any other kind.
function kindHtml(kind) {
  const tone = KIND_TONE[kind] || "neutral";
  return '<span class="chip chip-' + esc(tone) + '">' + esc(kind || "") + "</span>";
}

// The rule state chip on a rule row (R7.103): in rules, proposed, kept as context, or to review. Empty for other kinds.
const RULE_STATE_TONE = { "in rules": "success", "proposed": "haiku", "kept as context": "neutral",
  "to review": "warning" };
function ruleStateHtml(row) {
  if (row.kind !== "rule" || !row.ruleState) return "";
  return " " + chipHtml(row.ruleState, RULE_STATE_TONE[row.ruleState] || "neutral");
}

// One history line as text. The route sends objects ({ts, by, set|link|note}); a plain string passes through.
function historyLine(h) {
  if (typeof h === "string") return h;
  if (!h || typeof h !== "object") return "";
  const parts = [];
  const when = whenText(h.ts, true);
  if (when) parts.push(when);
  if (h.by) parts.push(String(h.by));
  for (const key of ["set", "link", "note"]) {
    if (h[key]) parts.push(key + " " + (typeof h[key] === "object" ? JSON.stringify(h[key]) : String(h[key])));
  }
  return parts.join(" ");
}

// The whole history of a row as one line, lines joined with a dot.
function historyText(list) {
  return (Array.isArray(list) ? list : []).map(historyLine).filter(Boolean).join(" · ");
}

// The text, history, reply and attachments of one row, as the view keeps them (the text is null on the phone).
function normFull(f) {
  return { text: typeof f.text === "string" ? f.text : null, history: Array.isArray(f.history) ? f.history : [],
    reply: typeof f.reply === "string" && f.reply.trim() ? f.reply : null, assets: assetsOf(f.assets) };
}

// The attachments of one entry: names or paths, as strings or {name|path} objects. Capped at 20; [] when absent.
function assetsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function (a) {
    return String(a && typeof a === "object" ? a.name || a.path || "" : a || "");
  }).filter(Boolean).slice(0, 20);
}

// The revision of the snapshot in vm (snap.rev, else fetchedAt). A new revision drops every cached text of the old one,
// so an open row shows the same generation as the rest of the screen.
function setRev(vm) {
  const snap = vm && vm.project && vm.project.snapshot ? vm.project.snapshot : null;
  const rev = snap ? String(snap.rev || snap.fetchedAt || "") : "";
  if (rev === fullRev) return rev;
  fullRev = rev;
  for (const key of Array.from(fullCache.keys())) {
    if (!key.endsWith("@" + rev)) fullCache.delete(key);
  }
  return rev;
}

function fullKey(pid, id) {
  return (pid || "") + "\n" + id + "@" + fullRev;
}

// The verbatim text of one row: the seeded vm.head.full when it is this row, else the fetched cache, else null.
function fullOf(vm, pid, id) {
  setRev(vm);
  const seeded = vm && vm.head && vm.head.full && vm.head.full.id === id ? vm.head.full : null;
  if (seeded) return normFull(seeded);
  return fullCache.get(fullKey(pid, id)) || null;
}

// The summary cell: the stored sum, or the first 140 characters of the verbatim text when the stored sum is only a
// short cut of it (older imports kept one clause).
function summaryText(sum, full) {
  const text = full && typeof full.text === "string" ? full.text.split(/\s+/).filter(Boolean).join(" ") : "";
  const stem = String(sum || "").replace(/…$/, "");
  if (!text || text.length <= stem.length) return String(sum || "");
  if (stem.length >= SUM_SHOW || text.indexOf(stem) !== 0) return String(sum || "");
  return text.slice(0, SUM_SHOW) + (text.length > SUM_SHOW ? "…" : "");
}

// Newest first by default (the entry's ts, then its id number); sort "old" reverses it.
function sortRows(rows, sort) {
  const when = function (row) {
    const ms = Date.parse(String(row.ts || ""));
    return isFinite(ms) ? ms : 0;
  };
  const num = function (row) {
    return parseInt(String(row.id).replace(/\D/g, ""), 10) || 0;
  };
  const sorted = rows.slice().sort(function (a, b) {
    return (when(a) - when(b)) || (num(a) - num(b));
  });
  return sort === "old" ? sorted : sorted.reverse();
}

// What the "You wrote" box says: the text, or why there is none (loading, or the phone listener gets no text).
function textNote(full) {
  if (!full) return "Loading the text…";
  if (full.text == null) return "The full text is only on this computer.";
  return full.text;
}

// What the "Head replied" box says: the captured reply, or the placeholder while loading or when none was captured.
function replyNote(full) {
  if (!full) return "Loading the reply…";
  return full.reply || "No reply captured yet";
}

// Why the row is in its state, in words. The snapshot may send a reason; otherwise it is worked out from the status.
function stateReason(row) {
  if (row.reason) return String(row.reason);
  if (row.status === "done") {
    if (row.auto) return "All bound tasks are done; waiting for you to confirm";
    return row.acc ? "Confirmed by you" : "Done; waiting for you to confirm";
  }
  const words = { doing: "A bound task or job is running", "needs-you": "The head asked for you",
    bound: "Bound to a task; not started", declined: "Declined", merged: "Merged into another entry",
    failed: "A bound job failed", blocked: "A bound task is on hold or blocked" };
  return words[row.status] || "Not triaged yet";
}

// The "Bound to" block: each bound task with its id (a link to Work), title, status chip and running job model.
function boundBlockHtml(row, pid) {
  const items = (Array.isArray(row.links) ? row.links.map(linkOf) : []).map(function (link) {
    const label = link.ref.split(":").pop();
    const href = refHref(link.ref, pid);
    const idHtml = href ? '<a class="chip chip-neutral" href="' + esc(href) + '" title="' + esc(link.ref) + '">' +
      esc(label) + "</a>" : '<span class="chip chip-neutral">' + esc(label) + "</span>";
    const title = link.title ? '<span class="hd-title">' + esc(link.title) + "</span>" : "";
    const st = link.status ? '<span class="chip chip-' + esc(taskTone(link.status)) + '">' + esc(link.status) +
      "</span>" : "";
    const models = link.jobs.filter(function (j) {
      return j && j.model && j.state !== "done";
    }).map(function (j) {
      return esc(j.model);
    });
    const job = models.length ? '<span class="hd-job">running: ' + models.join(", ") + "</span>" : "";
    return '<li class="hd-link">' + idHtml + title + st + job + "</li>";
  });
  return '<div class="hd-blk"><p class="hd-lbl">Bound to</p>' + (items.length ? '<ul class="hd-links">' +
    items.join("") + "</ul>" : '<p class="hd-none">Not bound yet. Use Bind below.</p>') + "</div>";
}

// The attachments list: shown only when the row has attachments (filled by loadText when the text arrives).
function assetsHtml(full) {
  const list = full ? full.assets : [];
  return '<ul class="hd-assets" data-role="assets"' + (list.length ? "" : " hidden") + ">" +
    list.map(function (name) {
      return '<li class="hd-asset">' + esc(name) + "</li>";
    }).join("") + "</ul>";
}

// The closed row: one line on the fixed tracks (chevron, id, summary, state, bound tasks, age, added, copy).
function rowHtml(vm, row, opts) {
  const id = String(row.id);
  const eid = esc(id);
  const open = (opts.open || []).indexOf(id) >= 0;
  const pid = opts.project || null;
  const carried = row.carried ? ' <span class="hd-carried" title="Carried over">↺</span>' : "";
  const shown = summaryText(row.sum, fullOf(vm, pid, id));
  const ra = rowAge(row);
  const line = '<div class="row-grid hd-row" data-id="' + eid + '">' +
    '<button type="button" class="hd-hit" data-action="head-toggle" data-id="' + eid + '" aria-expanded="' +
    (open ? "true" : "false") + '" aria-controls="hd-p-' + eid + '" aria-label="' +
    esc((open ? "Hide " : "Show ") + id) + '"></button>' +
    '<span class="hd-c hd-chev" aria-hidden="true">▸</span>' +
    '<span class="hd-c hd-id">' + eid + carried + "</span>" +
    '<span class="hd-c hd-sum rg-t" data-sum="' + esc(row.sum || "") + '" title="' + esc(shown) + '">' +
    esc(shown) + "</span>" +
    '<span class="hd-c hd-copy">' + copyButton("ask", id, id, { project: pid, sum: row.sum || "" }) + "</span>" +
    '<span class="hd-meta">' +
    '<span class="hd-c hd-status">' + statusHtml(row) + "</span>" +
    '<span class="hd-c hd-bound">' + boundHtml(row.links, pid, BOUND_MAX) + "</span>" +
    '<span class="hd-c hd-age rg-num' + (ra.stale ? " hd-stale" : ra.amber ? " hd-amber" : "") + '"' +
    (ra.stale ? ' title="Stale"' : "") + ">" + esc(ageText(ra.age)) + "</span>" +
    '<span class="hd-c hd-when rg-num" title="' + esc(row.ts || "") + '">' + esc(whenText(row.ts)) + "</span>" +
    "</span></div>";
  return '<li class="hd-item' + (open ? " is-open" : "") + '">' + line + panelHtml(vm, row, opts, open) + "</li>";
}

// The opened row: four labelled blocks (You wrote, Head replied, State, Bound to) and the action footer. Hidden until
// the row opens; loadText fills the text, the reply and the attachments once the full route answers.
function panelHtml(vm, row, opts, open) {
  const id = String(row.id);
  const eid = esc(id);
  const pid = opts.project || null;
  const full = fullOf(vm, pid, id);
  const hist = full ? historyText(full.history) : "";
  const wrote = '<div class="hd-blk"><p class="hd-lbl">You wrote</p>' +
    '<pre class="hd-text" data-state="' + (full ? "ready" : "loading") + '">' + esc(textNote(full)) + "</pre>" +
    assetsHtml(full) + "</div>";
  const reply = '<div class="hd-blk"><p class="hd-lbl">Head replied</p><pre class="hd-reply">' +
    esc(replyNote(full)) + "</pre></div>";
  const state = '<div class="hd-blk"><p class="hd-lbl">State</p><div class="hd-state">' + statusHtml(row) +
    '<span class="hd-reason">' + esc(stateReason(row)) + "</span></div>" +
    '<p class="hd-added" title="' + esc(row.ts || "") + '">Added ' + esc(whenText(row.ts, true)) + "</p>" +
    '<p class="hd-hist">' + esc(hist) + "</p></div>";
  const acts = [];
  if (!opts.readOnly && row.status === "done" && !row.acc) {
    acts.push('<button type="button" class="btn" data-action="head-accept" data-id="' + eid +
      '">Confirm done</button>');
  }
  if (!opts.readOnly && row.status === "done") {
    acts.push('<button type="button" class="btn" data-action="head-reopen" data-id="' + eid +
      '">Reopen</button>');
  }
  if (!opts.readOnly && row.status !== "needs-you") {
    acts.push('<button type="button" class="btn" data-action="head-set" data-id="' + eid +
      '" data-status="needs-you">Needs you</button>');
  }
  if (!opts.readOnly && row.status !== "declined") {
    acts.push('<button type="button" class="btn" data-action="head-set" data-id="' + eid +
      '" data-status="declined">Decline</button>');
  }
  // Suggestions from the snapshot: a duplicate (row.dup = {id, score}) and up to two bind refs (row.suggest).
  if (!opts.readOnly && row.dup && row.dup.id) {
    acts.push('<button type="button" class="btn" data-action="head-merge" data-id="' + eid +
      '" data-into="' + esc(row.dup.id) + '">Merge into ' + esc(row.dup.id) + " (dup " + esc(row.dup.score) +
      ")</button>");
  }
  if (!opts.readOnly && Array.isArray(row.suggest)) {
    row.suggest.slice(0, 2).forEach(function (ref) {
      acts.push('<button type="button" class="btn" data-action="head-bind-sug" data-id="' + eid +
        '" data-ref="' + esc(ref) + '">Bind ' + esc(ref) + "</button>");
    });
  }
  if (!opts.readOnly) {
    for (const name of ["bind", "split", "merge"]) {
      acts.push('<button type="button" class="btn" data-action="head-form" data-form="' + name + '" data-id="' +
        eid + '">' + esc(name[0].toUpperCase() + name.slice(1)) + "...</button>");
    }
  }
  const foot = acts.length ? '<div class="hd-foot"><div class="hd-acts">' + acts.join("") + "</div></div>" : "";
  const forms = opts.readOnly ? "" : formsHtml(id);
  return '<div class="hd-panel" id="hd-p-' + eid + '"' + (open ? "" : " hidden") + ">" + wrote + reply + state +
    boundBlockHtml(row, pid) + foot + forms + "</div>";
}

// The Bind, Split and Merge forms. Hidden until the footer opens one; the submit listener sends them.
function formsHtml(id) {
  const eid = esc(id);
  return '<form class="hd-form" data-op="head.bind" data-id="' + eid + '" data-form="bind" hidden>' +
    '<label><span class="hd-lbl">Bind to</span><input name="refs" placeholder="task:R7.31" required></label>' +
    '<button type="submit" class="btn">Bind</button></form>' +
    '<form class="hd-form" data-op="head.split" data-id="' + eid + '" data-form="split" hidden>' +
    '<label><span class="hd-lbl">Part 1</span><input name="a" required></label>' +
    '<label><span class="hd-lbl">Part 2</span><input name="b" required></label>' +
    '<button type="submit" class="btn">Split</button></form>' +
    '<form class="hd-form" data-op="head.merge" data-id="' + eid + '" data-form="merge" hidden>' +
    '<label><span class="hd-lbl">Merge into</span><input name="into" placeholder="H9" required></label>' +
    '<button type="submit" class="btn">Merge</button></form>';
}

// The list view: one table row per entry (columns: # Kind Summary State Bound to Age Added Acc Copy). Each entry is a
// tbody, so the row and its full-width detail row (colspan 9, the same panel as the card) open and close together.
const LIST_COLS = [["#", "hd-n"], ["Kind", "hd-kind"], ["You wrote", "hd-sumc"], ["Head replied", "hd-rpc"],
  ["State", "hd-stc"], ["Bound to", "hd-bnd"], ["Age", "hd-age"], ["Added", "hd-when"], ["Acc", "hd-acc"],
  ["Copy", "hd-cp"]];

// The reply cell text: the loaded reply, else the row's reply preview (sent with the rows), else a dash while the row
// has no preview (the phone listener, and snapshot rows before their page arrives). "No reply yet" when known empty.
function replyText(full, row) {
  if (full) return full.reply || "No reply yet";
  if (row && typeof row.replyPreview === "string") return row.replyPreview;
  if (row && "replyPreview" in row) return "No reply yet";
  return "\u2014";
}

function listRowHtml(vm, row, opts) {
  const id = String(row.id);
  const eid = esc(id);
  const open = (opts.open || []).indexOf(id) >= 0;
  const pid = opts.project || null;
  const full = fullOf(vm, pid, id);
  const hasText = typeof row.preview === "string";
  const shown = hasText ? row.preview : summaryText(row.sum, full);
  const muted = hasText && row.sum && row.sum !== row.preview ? String(row.sum) : "";
  const reply = replyText(full, row);
  const cell = function (cls, html, attrs) {
    return '<td class="' + cls + '"' + (attrs || "") + ">" + html + "</td>";
  };
  const ra = rowAge(row);
  const age = cell("hd-age rg-num" + (ra.stale ? " hd-stale" : ra.amber ? " hd-amber" : ""),
    esc(ageText(ra.age)), ' title="' + (ra.stale ? "Stale · " : "") + esc(row.ts || "") + '"');
  const when = cell("hd-when rg-num", esc(whenText(row.ts)), ' title="' + esc(row.ts || "") + '"');
  const tr = '<tr class="hd-row" data-id="' + eid + '">' +
    cell("hd-n", '<button type="button" class="hd-hit" data-action="head-toggle" data-id="' + eid +
      '" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="hd-p-' + eid + '" aria-label="' +
      esc((open ? "Hide " : "Show ") + id) + '">' + eid + "</button>") +
    cell("hd-kind", kindHtml(row.kind) + ruleStateHtml(row)) +
    cell("hd-sumc", '<span class="hd-sum"' + (hasText ? ' data-preview="1"' : "") + ' data-sum="' + esc(row.sum || "") +
      '" title="' + esc(full && full.text ? full.text : shown) + '">' + esc(shown) + "</span>" +
      (muted ? '<span class="hd-sum2" title="' + esc(muted) + '">' + esc(muted) + "</span>" : "") +
      '<span class="hd-rep-inline">' + esc(reply) + "</span>") +
    cell("hd-rpc", '<span class="hd-rep" title="' + esc(reply) + '">' + esc(reply) + "</span>") +
    cell("hd-stc", statusHtml(row)) +
    cell("hd-bnd", row.links && row.links.length ? boundHtml(row.links, pid, BOUND_MAX) :
      '<span class="hd-none" title="Not bound yet">—</span>') +
    age + when +
    cell("hd-acc", row.acc ? '<span aria-label="Accepted" title="Accepted">✓</span>' : "") +
    cell("hd-cp", copyButton("ask", id, id, { project: pid, sum: row.sum || "" })) + "</tr>";
  const detail = '<tr class="hd-detail"><td colspan="10">' + panelHtml(vm, row, opts, open) + "</td></tr>";
  return '<tbody class="hd-item' + (open ? " is-open" : "") + '">' + tr + detail + "</tbody>";
}

function listHtml(vm, rows, opts) {
  const head = LIST_COLS.map(function (col) {
    return '<th scope="col" class="' + col[1] + '">' + esc(col[0]) + "</th>";
  }).join("");
  return '<div class="hd-list"><table class="hd-tbl" aria-label="Logged messages"><thead><tr>' +
    head + "</tr></thead>" + rows.map(function (row) {
      return listRowHtml(vm, row, opts);
    }).join("") + "</table></div>";
}

function emptyHtml(vm, opts) {
  const none = rowsOf(vm).length === 0;
  if (none) {
    return '<div class="hd-empty"><p>Nothing logged yet. Every message you type is logged here.</p>' +
      '<button type="button" class="btn" data-action="head-log">+ Log</button></div>';
  }
  return '<div class="hd-empty"><p>Nothing in this view.</p><a class="btn" href="' +
    esc(hashOf({ f: "all" })) + '">Show all</a></div>';
}

// The agents' questions, in the Questions tab, newest first. Each card is the Inbox
// question card (its option buttons and the one "Other" answer box, which the Inbox answer path handles). A question
// asked more than 24 hours ago is marked "old". tabNow keeps the active tab across repaints.
const OLD_QUESTION_MS = 24 * 60 * 60 * 1000;
let tabNow = "chat";

// Sets the active tab ("chat" or "q"); the click handler and the tests use it.
export function setHeadTab(tab) {
  tabNow = tab === "q" ? "q" : "chat";
}

function askedMs(entry) {
  return typeof entry.q.askedMs === "number" && isFinite(entry.q.askedMs) ? entry.q.askedMs : null;
}

function sortedQs(list) {
  return (list || []).slice().sort(function (a, b) {
    return (askedMs(b) || 0) - (askedMs(a) || 0);
  });
}

function questionsHtml(list) {
  const sorted = sortedQs(list);
  if (!sorted.length) return "";
  const now = Date.now();
  return '<div class="hd-qs" data-role="questions" role="tabpanel" aria-label="Questions">' + sorted.map(function (e) {
    const card = questionCardHtml(e, now, false);
    if (pendingValue(questionKey(e.pid, e.q.id), e.snap.fetchedAt, now) !== undefined) return card;
    const at = askedMs(e);
    const old = at !== null && now - at > OLD_QUESTION_MS;
    const mark = old ? '<p class="hd-old">old, asked ' + esc(ageText((now - at) / 60000)) + " ago</p>" : "";
    return '<div class="hd-q' + (old ? " is-old" : "") + '">' + mark + card + "</div>";
  }).join("") + "</div>";
}

// The Chat | Questions tabs (Questions only when there are open ones) and, on Chat, the banner that opens them.
function tabsHtml(chatCount, qCount, tab) {
  const tabBtn = function (name, label, n, badge) {
    return '<button type="button" role="tab" class="hd-tab" data-action="head-tab" data-tab="' + name +
      '" aria-selected="' + (tab === name ? "true" : "false") + '">' + label + ' <span class="hd-tn' +
      (badge ? " hd-tbadge" : "") + '">' + n + "</span></button>";
  };
  const tabs = '<div class="hd-tabs hd-seg" role="tablist" aria-label="Head">' +
    tabBtn("chat", "Chat", chatCount, false) +
    (qCount ? tabBtn("q", "Questions", qCount, true) : "") + "</div>";
  const banner = qCount && tab !== "q" ? '<p class="hd-qban" role="status">' + qCount +
    (qCount === 1 ? " question waits" : " questions wait") + ' for you · <button type="button" class="btn" ' +
    'data-action="head-tab" data-tab="q">Open</button></p>' : "";
  return [tabs, banner];
}

// The screen as ordered pieces (each one root element, or "" when absent). The list piece has build(), which makes its
// markup only when it is needed; paintScreen() patches the pieces in place, so headHtml() joins them for a string.
function piecesOf(vm, opts) {
  const o = opts || {};
  const head = vm && vm.head ? vm.head : {};
  const all = rowsOf(vm);
  const rows = sortRows(all.filter(function (row) {
    return passes(row, o);
  }), o.sort);
  const counts = countsOf(head, all);
  const qn = (o.questions || []).length;
  const tab = qn && tabNow === "q" ? "q" : "chat";
  const open = o.open || [];
  const allOpen = rows.length > 0 && rows.every(function (row) {
    return open.indexOf(String(row.id)) >= 0;
  });
  const top = '<div class="hd-top">' + nowHtml(head) +
    (rows.length && tab !== "q" ? '<button type="button" class="btn hd-all" data-action="head-expand-all">' +
      (allOpen ? "Collapse all" : "Expand all") + "</button>" : "") + "</div>";
  const cards = o.view === "cards";
  const list = {
    name: "list", kind: rows.length ? (cards ? "cards" : "list") : "empty", rows: rows, vm: vm, opts: o,
    build: function () {
      if (!rows.length) return emptyHtml(vm, o);
      if (!cards) return listHtml(vm, rows, o);
      return '<div class="hd-list"><ul class="hd-items" aria-label="Logged messages">' + rows.map(function (row) {
        return rowHtml(vm, row, o);
      }).join("") + "</ul></div>";
    },
  };
  // Header, tabs, then the active tab: Chat (filter bar, rows, load more) or Questions.
  const chat = tab !== "q";
  const tabsOf = tabsHtml(rows.length, qn, tab);
  return [
    { name: "top", html: top },
    { name: "tabs", html: tabsOf[0] },
    { name: "banner", html: tabsOf[1] },
    { name: "alerts", html: chat ? alertsHtml(counts) : "" },
    { name: "bar", html: chat ? barHtml(vm, o) : "" },
    chat ? list : { name: "none", html: "" },
    { name: "pager", html: chat ? pagerHtml(o.pager) : "" },
    { name: "questions", html: chat ? "" : questionsHtml(o.questions) },
  ];
}

// The whole screen for one view model. opts: {f, q, kind, sid, open (ids of the open rows), project, readOnly,
// questions (the open agent questions: collect() entries)}.
export function headHtml(vm, opts) {
  const o = opts || {};
  const inner = piecesOf(vm, o).map(function (piece) {
    return piece.build ? piece.build() : piece.html;
  }).join("");
  return '<section class="hd-screen" data-project="' + esc(o.project || "") + '" aria-label="Head">' +
    inner + "</section>";
}

function projectOf(el) {
  const screen = el.closest ? el.closest(".hd-screen") : null;
  return screen && screen.getAttribute("data-project") ? screen.getAttribute("data-project") : null;
}

function idOf(item) {
  const row = item.querySelector(".hd-row");
  return row ? row.getAttribute("data-id") || "" : "";
}

// Fetch the verbatim text of one row once: GET .../head?full=Hn (the server gives text only on the same-origin page).
function fetchFull(pid, id) {
  const key = fullKey(pid, id);
  if (fullCache.has(key)) return Promise.resolve(fullCache.get(key));
  if (!inflight.has(key)) {
    const url = "/api/v1/projects/" + encodeURIComponent(pid) + "/head?f=all&n=200&full=" + encodeURIComponent(id);
    const req = getJson(url).then(function (res) {
      const f = res && res.data && res.data.full ? res.data.full : {};
      const entry = normFull(f);
      if (key.endsWith("@" + fullRev)) fullCache.set(key, entry);
      return entry;
    }).finally(function () {
      inflight.delete(key);
    });
    inflight.set(key, req);
  }
  return inflight.get(key);
}

// Fill the attachments list of one open row with text nodes (no markup), and show it only when there are some.
function fillAssets(item, list) {
  const ul = item.querySelector(".hd-assets");
  if (!ul) return;
  ul.textContent = "";
  for (const name of list) {
    const li = document.createElement("li");
    li.className = "hd-asset";
    li.textContent = name;
    ul.appendChild(li);
  }
  ul.hidden = list.length === 0;
}

// Fill one open row's text box, reply, history and attachments from the cache (fetching when needed).
// Errors show in the box.
function loadText(item) {
  const id = idOf(item);
  const screen = item.closest ? item.closest(".hd-screen") : null;
  const pid = projectOf(item) || "";
  const pre = item.querySelector(".hd-text");
  const hist = item.querySelector(".hd-hist");
  if (!id || !pre || !screen) return Promise.resolve();
  const show = function (entry) {
    pre.textContent = textNote(entry);
    pre.setAttribute("data-state", entry.text == null ? "none" : "ready");
    if (hist) hist.textContent = historyText(entry.history);
    const reply = item.querySelector(".hd-reply");
    if (reply) reply.textContent = replyNote(entry);
    const rowText = replyText(entry);
    for (const sel of [".hd-rep", ".hd-rep-inline"]) {
      const el = item.querySelector(sel);
      if (el) el.textContent = rowText;
    }
    fillAssets(item, entry.assets || []);
    const sumEl = item.querySelector(".hd-sum");
    if (sumEl && !sumEl.hasAttribute("data-preview")) {
      sumEl.textContent = summaryText(sumEl.getAttribute("data-sum"), entry);
    }
  };
  if (!FULL_ID.test(id) || !pid) {
    pre.textContent = "The full text is only on this computer.";
    return Promise.resolve();
  }
  return fetchFull(pid, id).then(show, function () {
    pre.textContent = "Could not load the text. Close the row and open it again.";
    pre.setAttribute("data-state", "error");
  });
}

// The rows of the full ledger beyond the snapshot: the scope of a filter ("all" for All and Done, else "open").
function scopeOf(f) {
  return f === "all" || f === "done" || f === "closed" ? "all" : "open";
}

function inScope(row, scope) {
  return scope === "all" || CLOSED.indexOf(row.status) < 0;
}

// The snapshot rows first, then the paged rows not already painted (deduped by id).
function mergeRows(first, extra) {
  const seen = new Set();
  const paged = new Map(extra.map(function (row) { return [String(row.id), row]; }));
  const out = [];
  for (const row of first.concat(extra)) {
    const key = String(row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const twin = paged.get(key);
    const takes = twin && twin !== row && "replyPreview" in twin && !("replyPreview" in row);
    out.push(takes ? Object.assign({}, row, { preview: twin.preview, replyPreview: twin.replyPreview }) : row);
  }
  return out;
}

// A new snapshot is the newer state of the rows it holds: a paged row with the same id takes its status and links.
function refreshPaged(pid, snapRows) {
  const byId = new Map(snapRows.map(function (row) { return [String(row.id), row]; }));
  pages.forEach(function (pg, key) {
    if (key.indexOf(pid + "\n") !== 0) return;
    pg.rows.forEach(function (row) {
      const fresh = byId.get(String(row.id));
      if (!fresh) return;
      if (fresh.status !== undefined) row.status = fresh.status;
      if (fresh.links !== undefined) row.links = fresh.links;
    });
  });
}

// "Showing N of TOTAL" as a muted count at the end of the filter bar. pager: {pid, scope, shown, total, more, error};
// total is null until the first page is in.
function countHtml(pager) {
  if (!pager) return "";
  const total = pager.total == null ? "…" : String(pager.total);
  return '<span class="hd-count" aria-live="polite">Showing ' + esc(String(pager.shown)) +
    " of " + esc(total) + "</span>";
}

// The Load more button and the end marker the observer watches, under the list, only while there is more or an error.
function pagerHtml(pager) {
  if (!pager || !(pager.more || pager.error)) return "";
  const attrs = ' data-project="' + esc(pager.pid) + '" data-scope="' + esc(pager.scope) + '"';
  return '<div class="hd-pager">' +
    (pager.error ? '<p class="hd-error" role="alert">' + esc(pager.error) + "</p>" : "") +
    (pager.more ? '<button type="button" class="btn hd-more" data-action="head-more"' + attrs + ">Load more</button>" +
      '<span class="hd-end" aria-hidden="true"' + attrs + "></span>" : "") + "</div>";
}

// Fetches one page of the ledger after the rows already held. A page is requested only once at a time; auto is
// the observer, which does not retry a failed page (the Load more button does).
function loadMore(pid, scope, auto) {
  if (!pid) return;
  const key = pid + "\n" + scope;
  let pg = pages.get(key);
  if (!pg) {
    pg = { rows: [], offset: 0, total: null, counts: null, loading: false, error: "" };
    pages.set(key, pg);
  }
  if (pg.loading || (auto && pg.error) || (pg.total != null && pg.offset >= pg.total)) return;
  pg.loading = true;
  pg.error = "";
  const url = "/api/v1/projects/" + encodeURIComponent(pid) + "/head?f=" + scope + "&offset=" + pg.offset +
    "&limit=" + PAGE_SIZE;
  getJson(url).then(function (res) {
    const data = res && res.data;
    if (!res || res.status !== 200 || !data || !Array.isArray(data.rows)) throw new Error("page");
    pg.rows = pg.rows.concat(data.rows);
    pg.offset += data.rows.length;
    pg.total = typeof data.total === "number" ? data.total : pg.offset;
    if (!data.rows.length) pg.total = pg.offset;
    pg.counts = data.counts || pg.counts;
  }).catch(function () {
    pg.error = "Could not load more rows. Try Load more again.";
  }).finally(function () {
    pg.loading = false;
    document.dispatchEvent(new Event("rb:render"));
  });
}

// Watches the end marker of the list: when it scrolls into view the next page loads. Re-armed after each render.
function observeEnd() {
  if (typeof document === "undefined" || typeof IntersectionObserver !== "function") return;
  if (!observer) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        loadMore(el.getAttribute("data-project"), el.getAttribute("data-scope"), true);
      });
    });
  }
  observer.disconnect();
  const end = document.querySelector("#main .hd-end");
  if (end) observer.observe(end);
}

// Loads run a few at a time, so expanding many rows does not send a burst of requests.
function pump() {
  while (active < FULL_CONCURRENCY && queue.length) {
    const item = queue.shift();
    active += 1;
    loadText(item).then(done, done);
  }
  function done() {
    active -= 1;
    pump();
  }
}

function enqueue(item) {
  queue.push(item);
  pump();
}

// Open or close one row in place (no re-render): the panel, the aria-expanded state and the open set. A row whose
// text is not cached yet shows a loading note first and opens only once the text has arrived (or failed).
function setOpen(item, on) {
  const id = idOf(item);
  const hit = item.querySelector(".hd-hit");
  const panel = item.querySelector(".hd-panel");
  if (!id || !hit || !panel) return;
  const apply = function (state) {
    panel.hidden = !state;
    item.classList.toggle("is-open", state);
    hit.setAttribute("aria-expanded", state ? "true" : "false");
    hit.setAttribute("aria-label", (state ? "Hide " : "Show ") + id);
  };
  const note = item.querySelector(".hd-loading");
  if (note) note.remove();
  item.removeAttribute("data-loading");
  if (!on) {
    openSet.delete(id);
    apply(false);
    return;
  }
  openSet.add(id);
  const screen = item.closest ? item.closest(".hd-screen") : null;
  const pid = projectOf(item) || "";
  const cached = fullCache.has(fullKey(pid, id)) || !screen || !FULL_ID.test(id) || !pid;
  if (cached) {
    apply(true);
    enqueue(item);
    return;
  }
  item.setAttribute("data-loading", "1");
  hit.setAttribute("aria-busy", "true");
  const p = document.createElement("p");
  p.className = "page-note hd-loading";
  p.textContent = "Loading " + id + ".";
  panel.parentNode.insertBefore(p, panel);
  fetchFull(pid, id).catch(function () {}).then(function () {
    hit.removeAttribute("aria-busy");
    if (item.getAttribute("data-loading") !== "1") return;
    item.removeAttribute("data-loading");
    const n = item.querySelector(".hd-loading");
    if (n) n.remove();
    if (!openSet.has(id)) return;
    apply(true);
    enqueue(item);
  });
}

function loadOpenRows() {
  if (typeof document === "undefined") return;
  for (const item of document.querySelectorAll("#main .hd-item.is-open")) {
    enqueue(item);
  }
}

let listening = false;

// Wires the row toggles, the buttons, the forms and the search and select fields. Call once after the screen renders.
export function attachHeadListeners() {
  if (listening || typeof document === "undefined") return;
  const main = document.getElementById("main");
  if (!main) return;
  listening = true;
  main.addEventListener("click", function (event) {
    // Filter, alert and ask-chip links keep the project scope: their hash is rewritten before the browser follows it.
    const link = event.target && event.target.closest ? event.target.closest("a[href^='#head']") : null;
    if (link) {
      const pid = projectOf(link);
      if (pid) {
        event.preventDefault();
        window.location.hash = scopedHash(link.getAttribute("href"), pid);
      }
      return;
    }
    // A click on the list row (not on a button, link or field) opens or closes it, like its # button.
    const tr = event.target && event.target.closest ? event.target.closest("tr.hd-row") : null;
    if (tr && !event.target.closest("a, button, input, select, textarea, label, form")) {
      const entry = tr.closest(".hd-item");
      if (entry) setOpen(entry, !entry.classList.contains("is-open"));
      return;
    }
    const btn = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const id = btn.getAttribute("data-id");
    const project = projectOf(btn);
    if (action === "head-more") {
      loadMore(project, btn.getAttribute("data-scope") || "open", false);
    } else if (action === "head-toggle") {
      const item = btn.closest(".hd-item");
      if (item) setOpen(item, !item.classList.contains("is-open"));
    } else if (action === "head-tab") {
      tabNow = btn.getAttribute("data-tab") === "q" ? "q" : "chat";
      document.dispatchEvent(new Event("rb:render"));
    } else if (action === "head-expand-all") {
      const root = btn.closest(".hd-screen");
      const items = root ? Array.from(root.querySelectorAll(".hd-item")) : [];
      const allOpen = items.length > 0 && items.every(function (item) {
        return item.classList.contains("is-open");
      });
      if (allOpen) openSet.clear();
      items.forEach(function (item) {
        setOpen(item, !allOpen);
      });
      btn.textContent = allOpen ? "Expand all" : "Collapse all";
    } else if (action === "head-accept") {
      run("head.accept", { id: id }, { project: project, label: "Accepted " + id });
    } else if (action === "head-reopen") {
      run("head.set", { id: id, status: "open" }, { project: project, label: "Reopened " + id });
    } else if (action === "head-set") {
      const status = btn.getAttribute("data-status");
      run("head.set", { id: id, status: status }, { project: project, label: id + " " + status });
    } else if (action === "head-log") {
      showToast({ text: "Type in the chat. Every message is logged here." });
    } else if (action === "head-merge") {
      const into = btn.getAttribute("data-into");
      run("head.merge", { id: id, into: into }, { project: project, label: id + " merged into " + into });
    } else if (action === "head-bind-sug") {
      const ref = btn.getAttribute("data-ref");
      run("head.bind", { id: id, refs: [ref] }, { project: project, label: "Bound " + id + " to " + ref });
    } else if (action === "head-form") {
      // Opens the row and shows one form (a second click on the same action hides it).
      const name = btn.getAttribute("data-form");
      const panel = document.getElementById("hd-p-" + id);
      if (!panel) return;
      const item = panel.closest(".hd-item");
      if (panel.hidden && item) setOpen(item, true);
      for (const form of panel.querySelectorAll(".hd-form")) {
        const show = form.getAttribute("data-form") === name && form.hidden;
        form.hidden = !show;
        const input = show ? form.querySelector("input") : null;
        if (input) input.focus();
      }
    }
  });
  main.addEventListener("submit", function (event) {
    const form = event.target;
    const op = form && form.getAttribute ? form.getAttribute("data-op") : null;
    if (!op) return;
    event.preventDefault();
    const id = form.getAttribute("data-id");
    const project = projectOf(form);
    const field = function (name) {
      const el = form.elements.namedItem(name);
      return el ? String(el.value || "").trim() : "";
    };
    if (op === "head.bind") {
      const refs = field("refs").split(",").map(function (ref) {
        return ref.trim();
      }).filter(Boolean);
      run("head.bind", { id: id, refs: refs }, { project: project, label: "Bound " + id });
    } else if (op === "head.split") {
      run("head.split", { id: id, sums: [field("a"), field("b")] }, { project: project, label: "Split " + id });
    } else if (op === "head.merge") {
      run("head.merge", { id: id, into: field("into") }, { project: project, label: id + " merged" });
    }
  });
  // Search commits on change (Enter or blur), as the old field did; typing alone does not re-render the list.
  main.addEventListener("change", function (event) {
    const el = event.target;
    if (el && el.hasAttribute && el.hasAttribute("data-tb-search")) {
      go(el, Object.assign(hashState(), { q: el.value || "" }));
    }
  });
  main.addEventListener("rb:toolbar", function (event) {
    const d = event.detail || {};
    const el = event.target;
    if (d.key !== "head" || !el) return;
    const st = hashState();
    const value = String(d.value || "");
    const at = value.indexOf(":");
    if (d.type === "view") {
      go(el, Object.assign(st, { view: value }));
    } else if (d.type === "token" || d.type === "remove") {
      if (at < 0) return;
      // Status, Kind and Session are one choice each: a chosen option again clears it. Order is on or off.
      const kind = value.slice(0, at);
      const val = value.slice(at + 1);
      if (kind === "status") st.f = st.f === val ? "all" : val;
      else if (kind === "kind") st.kind = st.kind === val ? "" : val;
      else if (kind === "sid") st.sid = st.sid === val ? "" : val;
      else if (kind === "sort") st.sort = st.sort === "old" ? "new" : "old";
      go(el, st);
    } else if (d.type === "clear") {
      go(el, Object.assign(st, { f: "all", kind: "", sid: "", sort: "" }));
    } else if (d.type === "action" && d.value === "log") {
      showToast({ text: "Type in the chat. Every message is logged here." });
    }
  });
}

// The state of the page hash, with the defaults the bar shows; a toolbar choice changes one key of it.
function hashState() {
  const params = queryOf();
  return { f: params.get("f") || "all", q: params.get("q") || "", kind: params.get("kind") || "",
    sid: params.get("sid") || "", sort: params.get("sort") || "", view: params.get("view") || "list" };
}

function go(el, state) {
  window.location.hash = scopedHash(hashOf(state), projectOf(el));
}

// The Head hash is project-scoped in the app ("#/p/<id>/head?..."); hashOf() gives the bare "#head?..." form.
function scopedHash(hash, project) {
  return project ? hash.replace(/^#head/, "#/p/" + project + "/head") : hash;
}

// The query of the current page hash, read with the same keys hashOf() writes.
function queryOf() {
  const raw = String(window.location.hash || "");
  const at = raw.indexOf("?");
  return new URLSearchParams(at >= 0 ? raw.slice(at + 1) : "");
}

function pick(value, allowed, max) {
  const text = value == null ? "" : String(value);
  return text && text.length <= max && allowed.indexOf(text) >= 0 ? text : "";
}

// The screen for the project route. Head belongs to one project; the snapshot's head key is the only data it reads.
export function sectionView(vm) {
  if (vm.route.name !== "project") {
    return pageEmpty("Head belongs to one project.", '<a href="#/all/overview">Go to All projects</a>');
  }
  const state = pageState(vm);
  if (state) return state;
  attachHeadListeners();
  const params = queryOf();
  const text = params.get("q") || "";
  const sid = params.get("sid") || "";
  // f=unhandled is the old name of Queue (the Overview chip still links to it).
  const f = params.get("f") === "unhandled" ? "queue" : params.get("f");
  const id = params.get("id") || "";
  // A deep-linked row (#head?id=H12) opens once; after that the person's own open and close decide.
  if (ITEM_ID.test(id) && id !== seededId) {
    openSet.add(id);
    seededId = id;
  }
  const opts = {
    f: pick(f, FILTERS.map(function (pair) {
      return pair[0];
    }), 20) || "all",
    q: text.length <= 200 ? text : "",
    kind: pick(params.get("kind"), KINDS, 20),
    sid: sid.length <= 60 ? sid : "",
    sort: pick(params.get("sort"), SORTS, 3) || "new",
    view: pick(params.get("view"), ["cards", "list"], 5) || "list",
    open: Array.from(openSet),
    project: vm.route.id,
    readOnly: false,
  };
  // The snapshot head first (first paint), then the paged rows of this scope, merged by id.
  const snapHead = vm.project.snapshot.head || null;
  const scope = scopeOf(opts.f);
  refreshPaged(vm.route.id, rowsOf({ head: snapHead }));
  const pg = pages.get(vm.route.id + "\n" + scope) || null;
  const head = Object.assign({}, snapHead || {}, { rows: mergeRows(rowsOf({ head: snapHead }), pg ? pg.rows : []) });
  if (pg && pg.counts) {
    head.counts = pg.counts;
    head.ledger = true;
  }
  const shown = head.rows.filter(function (row) {
    return inScope(row, scope);
  }).length;
  const questions = collect([{ id: vm.route.id, name: vm.route.id, snap: vm.project.snapshot }]).questions;
  watchCountdowns();
  opts.pager = {
    pid: vm.route.id, scope: scope, shown: shown, total: pg ? pg.total : null, error: pg ? pg.error : "",
    more: !pg || pg.total == null || pg.offset < pg.total,
  };
  opts.questions = questions;
  // main gets an empty, stable screen element (so app.js never rewrites the rows); the pieces are painted after it.
  const key = JSON.stringify([vm.route.id, setRev(vm), opts.f, opts.q, opts.kind, opts.sid, opts.sort, opts.view,
    opts.open, opts.project, opts.pager, tabNow, head.rows.length, questions.map(function (e) {
      return e.pid + ":" + e.q.id;
    })]);
  latest = { vm: { head: head }, opts: opts, key: key };
  if (typeof setTimeout === "function") setTimeout(flushScreen, 0);
  return '<section class="hd-screen" data-project="' + esc(opts.project || "") + '" aria-label="Head"></section>';
}

// ---- In-place painting (R7.80). The screen element keeps its pieces; a piece is replaced only when its markup
// changed, and the list keeps its element: its rows are matched by data-id, and only changed rows are rebuilt.

let latest = null;
let builtFor = null;
let builtKey = "";
let pieceEls = new Map();
let liveItems = new Map();
let unitKeys = new Map();
let rowById = new Map();
let ageTimer = null;

// The key of one row's markup: its data, open state and the view. Its age text is not part of it (refreshAges).
function unitKeyOf(vm, row, opts) {
  const id = String(row.id);
  const pid = opts.project || null;
  const ra = rowAge(row);
  return [JSON.stringify(row), opts.view, pid, (opts.open || []).indexOf(id) >= 0, Boolean(fullOf(vm, pid, id)),
    ra.amber, ra.stale].join("\n");
}

function childItems(parent) {
  return Array.from(parent.children || []).filter(function (node) {
    return node.classList && node.classList.contains("hd-item");
  });
}

// The first item at or after node.
function nextItem(node) {
  let n = node;
  while (n && !(n.classList && n.classList.contains("hd-item"))) n = n.nextElementSibling;
  return n || null;
}

// Register the live rows of a freshly built list element.
function indexUnits(listEl, piece) {
  const parent = listEl.firstElementChild;
  liveItems = new Map();
  unitKeys = new Map();
  if (parent) {
    for (const item of childItems(parent)) {
      const row = item.querySelector(".hd-row");
      liveItems.set(row ? row.getAttribute("data-id") || "" : "", item);
    }
  }
  for (const row of piece.rows) unitKeys.set(String(row.id), unitKeyOf(piece.vm, row, piece.opts));
}

// Bring the live rows in line with the list piece: remove gone rows, replace changed ones, keep the order.
function reconcileUnits(listEl, piece) {
  const parent = listEl.firstElementChild;
  const wanted = new Set(piece.rows.map(function (row) {
    return String(row.id);
  }));
  for (const id of Array.from(liveItems.keys())) {
    if (wanted.has(id)) continue;
    parent.removeChild(liveItems.get(id));
    liveItems.delete(id);
    unitKeys.delete(id);
  }
  let cursor = nextItem(parent.firstElementChild);
  for (const row of piece.rows) {
    const id = String(row.id);
    const key = unitKeyOf(piece.vm, row, piece.opts);
    let item = liveItems.get(id) || null;
    if (!item || unitKeys.get(id) !== key) {
      const fresh = parseOne(piece.kind === "cards" ? rowHtml(piece.vm, row, piece.opts) :
        listRowHtml(piece.vm, row, piece.opts));
      if (item) {
        if (cursor === item) cursor = fresh;
        swapNode(item, fresh);
      }
      item = fresh;
      liveItems.set(id, item);
      unitKeys.set(id, key);
    }
    if (item === cursor) cursor = nextItem(cursor.nextElementSibling);
    else parent.insertBefore(item, cursor);
  }
}

// The list piece for the screen: the same element while its kind holds (list or cards with rows).
function listElement(screen, piece, rebuild) {
  const rec = pieceEls.get("list");
  if (!rebuild && rec && rec.kind === piece.kind && piece.kind !== "empty") {
    reconcileUnits(rec.el, piece);
    return rec.el;
  }
  const el = parseOne(piece.build());
  if (rec && rec.el.parentNode === screen) swapNode(rec.el, el);
  pieceEls.set("list", { el: el, kind: piece.kind });
  if (piece.kind !== "empty") indexUnits(el, piece);
  else {
    liveItems = new Map();
    unitKeys = new Map();
  }
  return el;
}

function registerRows(piece) {
  for (const row of piece.rows) rowById.set(String(row.id), row);
}

// Fill an empty screen piece by piece (first paint, or the screen element is new).
function buildAll(screen, pieces) {
  pieceEls = new Map();
  liveItems = new Map();
  unitKeys = new Map();
  rowById = new Map();
  while (screen.firstChild) screen.removeChild(screen.firstChild);
  for (const piece of pieces) {
    if (piece.name === "list") {
      registerRows(piece);
      screen.appendChild(listElement(screen, piece, true));
    } else if (piece.html) {
      const el = parseOne(piece.html);
      pieceEls.set(piece.name, { el: el, html: piece.html });
      screen.appendChild(el);
    }
  }
  builtFor = screen;
}

// Patch the pieces of a screen that is already on the page.
function updatePieces(screen, pieces) {
  const els = [];
  const seen = new Set();
  for (const piece of pieces) {
    if (piece.name === "list") {
      registerRows(piece);
      seen.add("list");
      els.push(listElement(screen, piece, false));
      continue;
    }
    if (!piece.html) continue;
    seen.add(piece.name);
    let rec = pieceEls.get(piece.name);
    if (!rec) {
      rec = { el: parseOne(piece.html), html: piece.html };
      pieceEls.set(piece.name, rec);
    } else if (rec.html !== piece.html) {
      rec.el = swapNode(rec.el, parseOne(piece.html));
      rec.html = piece.html;
    }
    els.push(rec.el);
  }
  for (const name of Array.from(pieceEls.keys())) {
    if (seen.has(name)) continue;
    const rec = pieceEls.get(name);
    if (rec.el.parentNode === screen) screen.removeChild(rec.el);
    pieceEls.delete(name);
  }
  // Order the pieces as the markup has them.
  let cursor = screen.firstElementChild;
  for (const el of els) {
    if (el === cursor) cursor = cursor.nextElementSibling;
    else screen.insertBefore(el, cursor);
  }
}

// The age labels: only their text (and the stale or amber class) changes; no row is rebuilt.
function refreshAges() {
  liveItems.forEach(function (item, id) {
    const row = rowById.get(id);
    const age = item.querySelector(".hd-age");
    if (!row || !age) return;
    const ra = rowAge(row);
    const text = ageText(ra.age);
    if (age.textContent !== text) age.textContent = text;
    age.classList.toggle("hd-stale", Boolean(ra.stale));
    age.classList.toggle("hd-amber", Boolean(ra.amber && !ra.stale));
  });
}

// Runs after main has the screen element. A repaint happens only when the key or the screen element changed.
function flushScreen() {
  const main = document.getElementById("main");
  const screen = main ? main.firstElementChild : null;
  if (!screen || !latest) return;
  if (screen !== builtFor || latest.key !== builtKey) {
    const pieces = piecesOf(latest.vm, latest.opts);
    if (screen !== builtFor) buildAll(screen, pieces);
    else updatePieces(screen, pieces);
    builtKey = latest.key;
    refreshAges();
    if (!ageTimer && typeof setInterval === "function") {
      ageTimer = setInterval(refreshAges, 60000);
      if (ageTimer && typeof ageTimer.unref === "function") ageTimer.unref();
    }
  }
  loadOpenRows();
  observeEnd();
}
