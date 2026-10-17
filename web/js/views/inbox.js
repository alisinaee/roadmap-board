// Inbox (WP30, R7.111): one list of everything that needs you (open questions, Head asks, rule proposals and blocking
// tasks), blocking questions first and newest first within a kind. Each item is one compact row: kind chip, one-line
// title, project, age, and one action. A click or Enter on the row expands it to the full text and every action.
// An answer collapses the row in place with a one-line confirmation and it leaves the list. Keys: j and k move between
// rows, Enter expands, 1 to 6 answer the option in that position of the open row, Esc collapses.
// Every action goes through cmd.js run() with the same op as before.
// The helpers pageState, collect, questionCardHtml and inboxPreviewHtml are shared with Head, Overview and Activity.

import { bannerHtml, chipHtml, emptyHtml, esc, parseOne, skeletonHtml, swapNode } from "../dom.js";
import { fmtDuration } from "../format.js";
import { copyButton, refSummary } from "../ref.js";
import { bindKey } from "../keys.js";
import { pendingValue, run } from "../cmd.js";
import { currentRoute, projectHash } from "../router.js";
import { headSeenHtml } from "./headseen.js";
import { toolbarHtml } from "../toolbar.js";

const KEY_MAX = 6;
const REC_SUFFIX = " (recommended)";
const TIME_UP = "Time expired; applying default choice.";
const LEAVE_MS = 2400;
// The filter bar: key, label and the item kind it shows ("all" shows everything).
const FILTERS = [["all", "All"], ["questions", "Questions"], ["asks", "Head asks"], ["rules", "Rules"],
  ["blockers", "Blockers"]];
const FILTER_KIND = { questions: "question", asks: "ask", rules: "rule", blockers: "task" };
// Chip tones as on the Head screen (head.js KIND_TONE), so a kind reads the same on both pages.
const TONE = { question: "cursor", ask: "haiku", rule: "opus", decision: "success", bug: "danger",
  preference: "agy", review: "warning", info: "defer", blocker: "danger" };
// Priority of each kind (blocking questions first); ties sort newest first.
const RANK = { question: 1, ask: 2, rule: 3, task: 4 };
let counting = false;
let filter = "all";
// The open state of each row the person toggled, by row key; a re-render keeps it. A question starts open, because its
// options are answered on the row; every other row starts closed.
const openState = new Map();
function isOpen(item) {
  return openState.has(item.key) ? openState.get(item.key) : item.kind === "question";
}

// A stored option is "Label", "Label: description" or "Label (recommended): description" (services/questions.py).
export function optionParts(stored) {
  const text = String(stored || "");
  const cut = text.indexOf(": ");
  let label = (cut < 0 ? text : text.slice(0, cut)).trim();
  const recommended = label.endsWith(REC_SUFFIX);
  if (recommended) label = label.slice(0, -REC_SUFFIX.length).trim();
  return { label: label, desc: cut < 0 ? "" : text.slice(cut + 2).trim(), recommended: recommended };
}

export function questionKey(pid, qid) {
  return "question:" + pid + ":" + qid;
}

// The snapshots in view as {id, name, snap}: the project's one, or one per registered project in All projects.
export function scopeSnapshots(vm) {
  return (vm.snapshotList || []).map(function (snap) {
    return { id: snap.id, name: snap.title, snap: snap };
  });
}

// The hash of a task in the Work section, for links from questions, blockers and needs-you rows.
export function itemHash(pid, taskId) {
  return projectHash(pid, "work") + "/i/" + encodeURIComponent(taskId);
}

// The Head screen's entry for one ledger id (H1 ...), for the "Open in Head" links.
export function headHash(pid, id) {
  return projectHash(pid, "head") + "?id=" + encodeURIComponent(id);
}

// The answer key of a Head ask: a reply on it shows as "answered" until the next snapshot.
export function headAskKey(pid, id) {
  return "headask:" + pid + ":" + id;
}

// The Head ledger rows with status needs-you (snap.head.rows), across the scopes, in snapshot order.
export function headAsks(scopes) {
  const asks = [];
  for (const s of scopes) {
    const rows = s.snap.head && Array.isArray(s.snap.head.rows) ? s.snap.head.rows : [];
    for (const row of rows) {
      if (row && row.status === "needs-you") asks.push({ pid: s.id, pname: s.name, snap: s.snap, row: row });
    }
  }
  return asks;
}

// The Inbox link for the scope in view: the project's Inbox, or All projects' Inbox.
export function inboxHash(vm) {
  return vm.route.name === "project" ? projectHash(vm.route.id, "inbox") : "#/all/inbox";
}

// The page-level state shared by Overview, Inbox and Activity: a banner or an empty state, or null when the page has
// content to show.
export function pageState(vm) {
  if (vm.route.name === "project") {
    const p = vm.project;
    if (p.notFound) return emptyHtml("No project with that id.", '<a href="#/all/overview">Go to All projects</a>');
    if (!p.snapshot) {
      if (p.error) return bannerHtml("danger", "Could not load this project. Retrying.", p.error.message);
      return '<div aria-busy="true">' + skeletonHtml(["w-60", "w-90"]) + "</div>";
    }
    return null;
  }
  if (vm.projectsError && !vm.projects) {
    return bannerHtml("danger", "Could not load projects. Retrying.", vm.projectsError.message);
  }
  if (!vm.projects || vm.home.loading) return '<div aria-busy="true">' + skeletonHtml(["w-60", "w-90"]) + "</div>";
  if (!vm.projects.length) {
    return emptyHtml("No projects yet.", "Run <code class=\"code\">roadmap project add &lt;path&gt;</code>.");
  }
  if (!(vm.snapshotList || []).length) return '<div aria-busy="true">' + skeletonHtml(["w-60", "w-90"]) + "</div>";
  return null;
}

// Open questions and needs-you tasks across the scopes, in snapshot order.
export function collect(scopes) {
  const questions = [];
  const needs = [];
  for (const s of scopes) {
    for (const q of s.snap.questions) questions.push({ pid: s.id, pname: s.name, snap: s.snap, q: q });
    for (const item of s.snap.needsYou) {
      if (item.kind === "task") needs.push({ pid: s.id, pname: s.name, item: item });
    }
  }
  return { questions: questions, needs: needs, asks: headAsks(scopes) };
}

// The countdown line for a deadline. The text is filled in by tickCountdowns, so a poll does not re-render it.
function countdownText(deadlineMs, word, now) {
  const left = (deadlineMs - now) / 1000;
  return left <= 0 ? TIME_UP : word + fmtDuration(left);
}

export function tickCountdowns(root, now) {
  for (const el of root.querySelectorAll("[data-deadline-ms]")) {
    const text = countdownText(Number(el.getAttribute("data-deadline-ms")), el.getAttribute("data-word") || "", now);
    if (el.textContent !== text) el.textContent = text;
  }
}

// One ticker per page, and a redraw hook, so the countdown text is written after every render.
export function watchCountdowns() {
  if (counting || typeof document === "undefined") return;
  counting = true;
  window.setInterval(function () {
    tickCountdowns(document, Date.now());
  }, 1000);
  const main = document.getElementById("main");
  if (main && typeof MutationObserver === "function") {
    const observer = new MutationObserver(function () {
      tickCountdowns(main, Date.now());
    });
    observer.observe(main, { childList: true, subtree: true });
  }
}

// One option button: its key (1 to 6), label, description, and badges. The recommended option is listed first.
function optionHtml(pid, q, part, index) {
  const isDefault = part.label === q.def;
  const key = index < KEY_MAX ? '<span class="qc-key" aria-hidden="true">' + String.fromCharCode(97 + index) +
    "</span>" : "";
  const desc = part.desc ? ' <span class="qc-foot">' + esc(part.desc) + "</span>" : "";
  const rec = part.recommended ? ' <span class="qc-def">recommended</span>' : "";
  const dflt = isDefault ? ' <span class="qc-def">default</span>' : "";
  return '<button type="button" class="btn qc-opt' + (isDefault ? " btn-primary is-default" : "") +
    '" data-action="inbox-answer" data-project="' + esc(pid) + '" data-qid="' + esc(q.id) +
    '" data-value="' + esc(part.label) + '" aria-label="' + esc("Choose " + part.label + " for " + q.id) +
    '" data-focus="ans-' + esc(pid) + "-" + esc(q.id) + "-" + index + '">' +
    key + '<span class="qc-label">' + esc(part.label) + rec + dflt + desc + "</span></button>";
}

// The options as a vertical list (one button per row), then the free-text box that every question has.
function answerHtml(pid, q) {
  const parts = q.opts.map(optionParts);
  const order = parts.map(function (p, i) {
    return i;
  }).sort(function (a, b) {
    return (parts[b].recommended ? 1 : 0) - (parts[a].recommended ? 1 : 0) || a - b;
  });
  const buttons = order.map(function (i, n) {
    return optionHtml(pid, q, parts[i], n);
  }).join("");
  const list = buttons
    ? '<div class="nz-list ib-opts" role="group" aria-label="' + esc("Answers for " + q.id) + '">' + buttons + "</div>"
    : "";
  return '<div class="ib-ans">' + list + '<form class="nz-row ib-form" data-form="inbox-question-answer"' +
    ' data-project="' + esc(pid) +
    '" data-qid="' + esc(q.id) + '" aria-label="' + esc("Other answer for " + q.id) + '">' +
    '<input name="value" required autocomplete="off" placeholder="Or type an answer" aria-label="' +
    esc("Other answer for " + q.id) + '">' +
    '<button type="submit" class="btn btn-small ib-send" disabled aria-label="' + esc("Send answer for " + q.id) +
    '">Send</button></form></div>';
}

// One question card, as Head shows it (Head's own question list). A card answered in this page shows one line until
// the next snapshot drops it.
export function questionCardHtml(entry, now, showProject) {
  const pid = entry.pid;
  const q = entry.q;
  const answered = pendingValue(questionKey(pid, q.id), entry.snap.fetchedAt, now);
  if (answered !== undefined) {
    return '<article class="qc is-answered" data-pid="' + esc(pid) + '" data-qid="' + esc(q.id) + '">' +
      '<p class="qc-line">' + esc(q.id) + " answered: <strong>" + esc(answered) + "</strong></p></article>";
  }
  const task = q.task ? ' <a class="qc-task" href="' + esc(itemHash(pid, q.task)) + '" aria-label="' +
    esc("View task " + q.task) + '">' + esc(q.task) + "</a>" : "";
  const blocks = q.block ? chipHtml("Blocks work", "warning") : "";
  const copy = copyButton("question", q.id, q.id + " " + q.text, { project: pid, sum: refSummary("question", q) });
  const options = answerHtml(pid, Object.assign({}, q, { opts: Array.isArray(q.opts) ? q.opts : [] }));
  return '<article class="qc' + (q.block ? " is-blocking" : "") + '" data-pid="' + esc(pid) + '" data-qid="' +
    esc(q.id) + '"><header class="qc-head"><span class="qc-id">' + esc(q.id) + "</span>" +
    (showProject ? " " + chipHtml(entry.pname, "neutral") : "") + task + " " + blocks + copy + "</header>" +
    '<h3 class="qc-text">' + esc(q.text) + "</h3>" + options + "</article>";
}

function needRowHtml(entry, showProject) {
  return '<li class="nz-row"><span class="nz-kind">Needs you</span> <a href="' +
    esc(itemHash(entry.pid, entry.item.id)) + '" aria-label="' + esc("View task " + entry.item.id) + '">' +
    esc(entry.item.id) + "</a> " + esc(entry.item.title) +
    (showProject ? " " + chipHtml(entry.pname, "neutral") : "") + "</li>";
}

// The open rule proposals (snap.rulesProposals, R7.103) across the scopes, in snapshot order.
export function ruleProposals(scopes) {
  const out = [];
  for (const s of scopes) {
    const list = Array.isArray(s.snap.rulesProposals) ? s.snap.rulesProposals : [];
    for (const p of list) {
      if (p && p.id) out.push({ pid: s.id, pname: s.name, row: p });
    }
  }
  return out;
}

// Every open item across the scopes as one list: questions, Head asks, rule proposals and needs-you tasks. A question
// or Head ask answered on this page is left out until the next snapshot.
export function inboxItems(scopes, now) {
  const found = collect(scopes);
  const items = [];
  for (const e of found.questions) {
    if (pendingValue(questionKey(e.pid, e.q.id), e.snap.fetchedAt, now) !== undefined) continue;
    items.push({ kind: "question", rank: e.q.block ? 0 : RANK.question, at: numberOrNull(e.q.askedMs),
      key: "q:" + e.pid + ":" + e.q.id, pid: e.pid, pname: e.pname, id: String(e.q.id), title: e.q.text || "",
      entry: e });
  }
  for (const e of found.asks) {
    const id = String(e.row.id);
    if (pendingValue(headAskKey(e.pid, id), e.snap.fetchedAt, now) !== undefined) continue;
    const at = typeof e.row.age === "number" ? now - e.row.age * 60000 : null;
    items.push({ kind: "ask", rank: RANK.ask, at: at, key: "a:" + e.pid + ":" + id, pid: e.pid, pname: e.pname,
      id: id, title: e.row.sum || "", entry: e });
  }
  for (const e of ruleProposals(scopes)) {
    items.push({ kind: "rule", rank: RANK.rule, at: null, key: "r:" + e.pid + ":" + e.row.id, pid: e.pid,
      pname: e.pname, id: String(e.row.id), title: e.row.text || "", entry: e });
  }
  for (const e of found.needs) {
    items.push({ kind: "task", rank: RANK.task, at: null, key: "t:" + e.pid + ":" + e.item.id, pid: e.pid,
      pname: e.pname, id: String(e.item.id), title: e.item.title || "", entry: e });
  }
  return items.sort(function (a, b) {
    return a.rank - b.rank || (b.at || 0) - (a.at || 0);
  });
}

function numberOrNull(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

// The count of open items per filter key, and the total.
function countsOf(items) {
  const c = { all: items.length, questions: 0, asks: 0, rules: 0, blockers: 0 };
  for (const it of items) {
    if (it.kind === "question") c.questions += 1;
    else if (it.kind === "ask") c.asks += 1;
    else if (it.kind === "rule") c.rules += 1;
    else c.blockers += 1;
  }
  return c;
}

// The age of an item as a short word: minutes, hours or days. Empty when the item has no time.
function ageText(at, now) {
  if (at == null) return "";
  const sec = Math.max(0, (now - at) / 1000);
  if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + "m";
  if (sec < 172800) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

function summaryHtml(c) {
  let text = c.all + " need you: " + c.questions + " questions, " + c.asks + " head asks, " + c.rules +
    " rule proposals";
  if (c.blockers) text += ", " + c.blockers + " blockers";
  return '<p class="ib-sum" aria-label="Inbox summary">' + esc(text) + "</p>";
}

// The filter is the shared section toolbar's view switcher (R11.119): one segmented row, the count on each label.
function filterHtml(c) {
  return toolbarHtml({ key: "inbox", label: "Inbox filter", views: FILTERS.map(function (pair) {
    return { id: pair[0], label: pair[1] + " " + c[pair[0]], current: pair[0] === filter };
  }) });
}

function domKey(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, "_");
}

// The chip text and tone of a kind (a Head ask shows its Head kind).
function chipOf(item) {
  if (item.kind === "question") return chipHtml("question", TONE.question);
  if (item.kind === "ask") {
    const kind = item.entry.row.kind ? String(item.entry.row.kind) : "ask";
    return chipHtml(kind, TONE[kind] || "neutral");
  }
  if (item.kind === "rule") return chipHtml("rule", TONE.rule);
  return chipHtml("blocker", TONE.blocker);
}

// The one action of a row, in the fixed action column: a plain chevron for question/Head ask (the row itself is the
// hit target, see ib-hit below), Accept (rule), open the task.
function actionHtml(item) {
  if (item.kind === "question" || item.kind === "ask") {
    return '<span class="ib-c ib-chev" aria-hidden="true">›</span>';
  }
  if (item.kind === "rule") {
    return '<button type="button" class="btn" data-action="rule-accept" data-project="' + esc(item.pid) +
      '" data-id="' + esc(item.id) + '" aria-label="' + esc("Accept " + item.id) + '">✓</button>';
  }
  return '<a class="btn" href="' + esc(itemHash(item.pid, item.id)) + '" aria-label="' +
    esc("View task " + item.id) + '">↗</a>';
}

// The expanded question: the full text, the task link, the countdown, the option list and the free-text box.
function questionBody(item, now) {
  const e = item.entry;
  const q = e.q;
  const pid = e.pid;
  const blocks = q.block ? chipHtml("Blocks work", "warning") : "";
  const options = answerHtml(pid, Object.assign({}, q, { opts: Array.isArray(q.opts) ? q.opts : [] }));
  let timer = "";
  if (q.askedMs != null && q.timeoutS != null) {
    const deadline = q.askedMs + q.timeoutS * 1000;
    const word = q.def ? "Defaults to " + q.def + " in " : "Times out in ";
    timer = '<span class="qc-timer" data-deadline-ms="' + esc(deadline) + '" data-word="' + esc(word) + '">' +
      esc(countdownText(deadline, word, now)) + "</span>";
  }
  return (blocks || timer ? '<p class="qc-foot ib-st">' + blocks + timer + "</p>" : "") + options;
}

// A note that starts with a commit hash shows the hash as a ref chip, then the rest of the note.
function noteHtml(note) {
  const m = /^([0-9a-f]{7,40})\b[\s:,-]*/.exec(note);
  return m ? '<code class="chip ib-ref">' + esc(m[1]) + "</code>" + esc(note.slice(m[0].length)) : esc(note);
}

// The expanded Head ask: one status line (age, the head's note) and one form line: the reply box (head.set), Answer,
// and Open in Head. The row title above already shows the full summary, so it is not repeated.
function askBody(item) {
  const e = item.entry;
  const row = e.row;
  const pid = e.pid;
  const id = String(row.id);
  const age = typeof row.age === "number" ? "<span>Waiting " + esc(fmtDuration(row.age * 60)) + "</span>" : "";
  const note = typeof row.note === "string" && row.note.trim() ? row.note.trim() : "The head needs your answer.";
  return '<p class="qc-foot ib-st">' + age + "<span>" + noteHtml(note) + "</span></p>" +
    '<form class="ib-form" data-op="head.set" data-project="' + esc(pid) + '" data-id="' + esc(id) +
    '" data-form="inbox-head-ask" aria-label="' + esc("Answer " + id) + '">' +
    '<input name="note" required autocomplete="off" placeholder="Your answer" aria-label="' +
    esc("Your answer to " + id) + '"><button type="submit" class="btn btn-primary">Answer</button>' +
    '<a class="btn btn-ghost ib-link" href="' + esc(headHash(pid, id)) + '" aria-label="' +
    esc("Open " + id + " in Head") + '">Open in Head</a>' +
    '<button type="button" class="btn btn-ghost ib-link" data-action="head-dismiss" data-project="' + esc(pid) +
    '" data-id="' + esc(id) + '" aria-label="' + esc("Dismiss " + id) + '">Dismiss</button></form>';
}

// The expanded rule proposal: the Head ids it came from, then one form line: the rule text (rules.accept), Edit and
// accept, and Reject.
function ruleBody(item) {
  const e = item.entry;
  const row = e.row;
  const pid = e.pid;
  const id = String(row.id);
  const sources = (row.sources || []).map(function (src) {
    return '<a href="' + esc(headHash(pid, src)) + '">' + esc(src) + "</a>";
  });
  const from = sources.length ? "From " + sources.join(", ") : "No Head source";
  return '<p class="qc-foot ib-st">' + from + '</p><form class="ib-form" data-form="inbox-rule-edit" data-project="' +
    esc(pid) + '" data-id="' + esc(id) + '" aria-label="' + esc("Edit and accept " + id) + '">' +
    '<input name="text" required maxlength="160" autocomplete="off" aria-label="' + esc("Rule text for " + id) +
    '" value="' + esc(row.text || "") + '"><button type="submit" class="btn btn-primary">Edit and accept</button>' +
    '<button type="button" class="btn btn-ghost ib-link" data-action="rule-reject" data-project="' + esc(pid) +
    '" data-id="' + esc(id) + '">Reject</button></form>';
}

// The expanded needs-you task: the link to it (the row title already shows the full title).
function taskBody(item) {
  return '<p class="qc-foot ib-st"><a class="btn btn-ghost ib-link" href="' + esc(itemHash(item.pid, item.id)) +
    '" aria-label="' + esc("View task " + item.id) + '">View task ' + esc(item.id) + "</a></p>";
}

// One row and its expanded body. The row is a list item: the chip, a one-line title with the project, the age, and the
// action. The body is hidden until the row is open.
function itemHtml(item, now, open, showProject) {
  const dk = domKey(item.key);
  const bid = "ib-body-" + dk;
  let body;
  if (item.kind === "question") body = questionBody(item, now);
  else if (item.kind === "ask") body = askBody(item);
  else if (item.kind === "rule") body = ruleBody(item);
  else body = taskBody(item);
  const tid = item.kind === "question" && item.entry.q.task ? String(item.entry.q.task) : "";
  const task = tid ? '<a class="chip ib-task" href="' + esc(itemHash(item.pid, tid)) + '" aria-label="' +
    esc("View task " + tid) + '">' + esc(tid) + "</a>" : "<span></span>";
  const proj = showProject ? ' <span class="qc-foot">' + esc(item.pname) + "</span>" : "";
  // The whole row is the hit target (ib-hit), styled invisible/full-row like Head's row toggle (.hd-hit in
  // web/css/head.css): an absolutely positioned button under the row's text, so a click or Enter/Space anywhere on
  // the row expands or collapses it, while real links/buttons in the row (copy, task link, accept/open) sit above it
  // (z-index) and still get their own clicks.
  const hit = '<button type="button" class="ib-hit" aria-controls="' + bid + '" aria-expanded="' +
    (open ? "true" : "false") + '" data-focus="ib-' + esc(dk) + '" aria-label="' +
    esc((open ? "Hide " : "Show ") + item.id) + '"></button>';
  return '<li class="ib-item' + (open ? " is-open" : "") + (isOld(item.at, now) ? " is-old" : "") +
    '" data-key="' + esc(item.key) + '">' +
    '<div class="row-grid rg-fin ib-row">' + hit + '<span class="ib-kind">' + chipOf(item) + "</span>" +
    '<span class="rg-main ib-main" title="' + esc(item.title) + '">' +
    '<span class="rg-t"><span class="qc-id">' + esc(item.id) + "</span> " + esc(item.title) + proj + "</span></span>" +
    task + '<span class="rg-num qc-foot">' + esc(ageText(item.at, now)) + "</span>" + copyOf(item) +
    actionHtml(item) + '</div><div class="ib-body" id="' + bid + '"' + (open ? "" : " hidden") + ">" +
    body + "</div></li>";
}

function copyOf(item) {
  if (item.kind !== "question") return "<span></span>";
  const q = item.entry.q;
  return copyButton("question", q.id, q.id + " " + q.text, { project: item.pid, sum: refSummary("question", q) });
}

function isOld(at, now) {
  return at != null && now - at > 86400000;
}

// The full Inbox body: the summary, the filter bar, then the rows. Empty when nothing needs you.
export function inboxBody(vm) {
  const now = Date.now();
  const items = inboxItems(scopeSnapshots(vm), now);
  if (!items.length) return emptyHtml("Nothing needs you.");
  const c = countsOf(items);
  const shown = items.filter(function (it) {
    return filter === "all" || it.kind === FILTER_KIND[filter];
  });
  const rows = shown.length ? '<ul class="ib-list">' + shown.map(function (it) {
    return itemHtml(it, now, isOpen(it), vm.route.name !== "project");
  }).join("") + "</ul>" : '<p class="placeholder">Nothing in this filter.</p>';
  return summaryHtml(c) + filterHtml(c) + rows;
}

// The Overview preview: up to limit rows, questions first, with no answer buttons. Links go to the Inbox.
export function inboxPreviewHtml(vm, limit) {
  const scopes = scopeSnapshots(vm);
  const showProject = vm.route.name !== "project";
  const c = collect(scopes);
  const rows = [];
  for (const e of c.questions) {
    rows.push('<li class="nz-row"><span class="nz-kind">Question</span> <a href="' + esc(inboxHash(vm)) +
      '" aria-label="' + esc("View question " + e.q.id) + '">' +
      esc(e.q.id) + "</a> " + esc(e.q.text) + (showProject ? " " + chipHtml(e.pname, "neutral") : "") + "</li>");
  }
  for (const e of c.asks) {
    rows.push('<li class="nz-row"><span class="nz-kind">Head ask</span> <a href="' + esc(headHash(e.pid, e.row.id)) +
      '" aria-label="' + esc("Open " + e.row.id + " in Head") + '">' + esc(e.row.id) + "</a> " +
      esc(e.row.sum || "") + (showProject ? " " + chipHtml(e.pname, "neutral") : "") + "</li>");
  }
  for (const e of c.needs) rows.push(needRowHtml(e, showProject));
  if (!rows.length) return '<p class="placeholder">Inbox empty. No actions pending.</p>';
  const more = rows.length > limit
    ? '<p class="ov-more"><a href="' + esc(inboxHash(vm)) + '">Open Inbox (' + (rows.length - limit) +
      " more)</a></p>"
    : "";
  return '<ul class="nz-list">' + rows.slice(0, limit).join("") + "</ul>" + more;
}

// A reply on a Head ask: the form's note goes through cmd.js run() as head.set (the same op as the Head screen's
// status and note writes), with no status change, so the head still decides what the ask becomes.
function onAskSubmit(event) {
  const form = event.target;
  if (form && form.getAttribute && form.getAttribute("data-form") === "inbox-question-answer") {
    onQuestionTextSubmit(event, form);
    return;
  }
  if (form && form.getAttribute && form.getAttribute("data-form") === "inbox-rule-edit") {
    event.preventDefault();
    const field = form.elements.namedItem("text");
    const text = field ? String(field.value || "").trim() : "";
    if (text) ruleOp("rules.accept", form, { text: text });
    return;
  }
  if (!form || !form.getAttribute || form.getAttribute("data-form") !== "inbox-head-ask") return;
  event.preventDefault();
  const pid = form.getAttribute("data-project");
  const id = form.getAttribute("data-id");
  const field = form.elements.namedItem("note");
  const value = field ? String(field.value || "").trim() : "";
  if (!value) return;
  run("head.set", { id: id, note: value }, {
    project: pid,
    key: headAskKey(pid, id),
    value: value,
    label: id + " answered: " + value,
  });
  leaveItem(form, id + " answered: " + value);
}

if (typeof document !== "undefined") document.addEventListener("submit", onAskSubmit);

// Send stays disabled until the Other box has text (R10.14).
function onAnswerInput(event) {
  const input = event.target;
  const form = input && input.form;
  if (!form || input.name !== "value" || form.getAttribute("data-form") !== "inbox-question-answer") return;
  const send = form.querySelector('button[type="submit"]');
  if (send) send.disabled = !input.value.trim();
}
if (typeof document !== "undefined") document.addEventListener("input", onAnswerInput);

// The "Other…" box of a question row: free text goes through the same question.answer op as an option button.
function onQuestionTextSubmit(event, form) {
  event.preventDefault();
  const pid = form.getAttribute("data-project");
  const qid = form.getAttribute("data-qid");
  const field = form.elements.namedItem("value");
  const value = field ? String(field.value || "").trim() : "";
  if (!value) return;
  sendAnswer(pid, qid, value, form);
}

function onAnswerPage() {
  const section = currentRoute().section;
  return section === "inbox" || section === "overview";
}

function sendAnswer(pid, qid, value, el) {
  run("question.answer", { id: qid, value: value }, {
    project: pid,
    key: questionKey(pid, qid),
    value: value,
    label: qid + " answered: " + value,
  });
  leaveItem(el, qid + " answered: " + value);
}

function answerButton(el) {
  sendAnswer(el.getAttribute("data-project"), el.getAttribute("data-qid"), el.getAttribute("data-value"), el);
}

// Set a row open or closed in place (no re-render). Its hit target, action and body follow the same state.
function setOpen(item, on) {
  if (!item) return;
  item.classList.toggle("is-open", on);
  for (const el of item.querySelectorAll("[aria-expanded]")) el.setAttribute("aria-expanded", on ? "true" : "false");
  const body = item.querySelector(".ib-body");
  if (body) body.hidden = !on;
  const key = item.getAttribute("data-key");
  if (key) openState.set(key, !!on);
}

// After an answer or an accept: the row is swapped for a one-line confirmation, focus moves to the next row, and the
// confirmation leaves the list after a moment (the next snapshot drops the item for good).
function leaveItem(el, text) {
  const item = el && el.closest ? el.closest(".ib-item") : null;
  if (!item || !item.parentNode) return;
  openState.delete(item.getAttribute("data-key"));
  const next = item.nextElementSibling || item.previousElementSibling;
  const hadFocus = item.contains(document.activeElement);
  const fresh = swapNode(item, parseOne('<li class="qc is-answered ib-item" role="status"><p class="qc-line">' +
    esc(text) + "</p></li>"));
  if (hadFocus && next && next.querySelector) {
    const hit = next.querySelector(".ib-hit");
    if (hit) hit.focus();
  }
  window.setTimeout(function () {
    if (fresh.parentNode) fresh.parentNode.removeChild(fresh);
  }, LEAVE_MS);
}

// Click entry point for the page's buttons (app.js sends these data-action values here): an answer, an accept or
// reject of a rule, an Undo on an activity line, and the one-hour Override from the limit banner.
export function pageAction(action, el) {
  const pid = el.getAttribute("data-project");
  if (action === "inbox-answer") {
    answerButton(el);
  } else if (action === "undo-line") {
    const label = el.closest(".act-row") ? el.closest(".act-row").querySelector(".act-sum") : null;
    run("undo", { activity: el.getAttribute("data-activity") }, {
      project: pid,
      label: "Undone: " + (label ? label.textContent : "change"),
    });
  } else if (action === "override") {
    run("control.override", { hours: 1 }, { project: pid, label: "Override set for 1 hour" });
  } else if (action === "rule-accept") {
    ruleOp("rules.accept", el, {});
  } else if (action === "rule-reject") {
    ruleOp("rules.reject", el, {});
  } else if (action === "head-dismiss") {
    headDismiss(el);
  }
}

// Decline a Head ask without answering it (head.set status=declined). Asks for a confirm first, since it changes
// ledger state.
function headDismiss(el) {
  if (!window.confirm("Dismiss this? It won't need an answer.")) return;
  const pid = el.getAttribute("data-project");
  const id = el.getAttribute("data-id");
  run("head.set", { id: id, status: "declined", note: "declined from Inbox" }, {
    project: pid,
    key: headAskKey(pid, id),
    label: id + " dismissed",
  });
  leaveItem(el, id + " dismissed");
}

// Accept or reject a rule proposal (person-only ops): the proposal id comes from the element's data-id.
function ruleOp(op, el, extra) {
  const pid = el.getAttribute("data-project");
  const id = el.getAttribute("data-id");
  const args = Object.assign({ id: id }, extra);
  const verb = op === "rules.accept" ? "accepted" : "rejected";
  run(op, args, { project: pid, label: id + " " + verb });
  leaveItem(el, id + " " + verb);
}

// The row that keys 1 to 6 act on: the open row that holds focus. Null when no open row has focus.
function openRowWithFocus() {
  const active = document.activeElement;
  const near = active && active.closest ? active.closest(".ib-item") : null;
  return near && near.classList.contains("is-open") ? near : null;
}

// The keys 1 to 6 answer the open row's option in that position (the list order, recommended first).
function onDigit(index) {
  return function () {
    if (!onAnswerPage()) return;
    const item = openRowWithFocus();
    const button = item ? item.querySelectorAll(".ib-body .qc-opt")[index] : null;
    if (button) answerButton(button);
  };
}

// The keys a to c pick the option in that position of the question that holds focus.
function onLetter(index) {
  return function () {
    if (currentRoute().section !== "inbox") return;
    const active = document.activeElement;
    if (active && active.closest && active.closest("input, textarea")) return;
    onDigit(index)();
  };
}

// j and k move focus to the next or previous row (on the Inbox page only).
function moveFocus(step) {
  return function () {
    if (currentRoute().section !== "inbox") return;
    const rows = Array.from(document.querySelectorAll("#main .ib-item .ib-hit"));
    if (!rows.length) return;
    const active = document.activeElement;
    const own = active && active.closest ? active.closest(".ib-item") : null;
    const at = own ? rows.indexOf(own.querySelector(".ib-hit")) : -1;
    let next;
    if (at < 0) next = step > 0 ? 0 : rows.length - 1;
    else next = Math.min(rows.length - 1, Math.max(0, at + step));
    rows[next].focus();
  };
}

// Clicks on the page: a filter button, the Answer or Reply button, and a click on the row's full-row hit button
// (ib-hit, see itemHtml). Real links/buttons in the row sit above ib-hit (CSS z-index), so they get their own click
// and never also toggle the row.
function onPageClick(event) {
  const t = event.target;
  if (!t || !t.closest) return;
  const hit = t.closest(".ib-hit");
  if (hit && hit.closest("#main")) {
    const item = hit.closest(".ib-item");
    setOpen(item, !item.classList.contains("is-open"));
  }
}

// Esc closes the open row that holds focus (also from its text box). Enter/Space on the row's own hit button already
// toggles it natively, since ib-hit is a real button element, so only Esc needs handling here.
function onPageKey(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const t = event.target;
  if (!t || !t.closest || !t.closest("#main .ib-item")) return;
  const item = t.closest(".ib-item");
  if (event.key === "Escape" && item.classList.contains("is-open")) {
    event.preventDefault();
    setOpen(item, false);
    const hit = item.querySelector(".ib-hit");
    if (hit) hit.focus();
  }
}

// The shared toolbar's view switcher (rb:toolbar, key inbox) picks the filter.
function onToolbar(event) {
  const d = event.detail || {};
  if (d.key !== "inbox" || d.type !== "view") return;
  filter = d.value;
  document.dispatchEvent(new Event("rb:render"));
}

if (typeof document !== "undefined") {
  document.addEventListener("click", onPageClick);
  document.addEventListener("keydown", onPageKey);
  document.addEventListener("rb:toolbar", onToolbar);
}

for (let n = 1; n <= KEY_MAX; n++) bindKey(String(n), onDigit(n - 1));
for (let n = 0; n < 3; n++) bindKey(String.fromCharCode(97 + n), onLetter(n));
bindKey("j", moveFocus(1));
bindKey("k", moveFocus(-1));

export function sectionView(vm) {
  const state = pageState(vm);
  if (state) return state;
  watchCountdowns();
  const open = inboxItems(scopeSnapshots(vm), Date.now()).length;
  const sectionCopy = copyButton("section", "inbox.questions", "open questions",
    { project: vm.route.id, sum: refSummary("section", { count: open }) });
  return '<div class="page-head ib-head">' + sectionCopy + "</div>" +
    (vm.route.name === "project" ? headSeenHtml(vm.route.id) : "") + inboxBody(vm);
}
