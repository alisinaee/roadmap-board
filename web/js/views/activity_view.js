// Activity markup (R11.4): the filter bar, the time scrubber, the day-grouped rows and the detail pane. Pure string
// builders over the state from activity_data.js; activity.js wires them to the page.

import { esc } from "../dom.js";
import { fmtTokens } from "../format.js";
import { copyButton } from "../ref.js";
import { toolbarHtml as sectionToolbar } from "../toolbar.js";
import { projectHash } from "../router.js";
import {
  ACTOR_WORD, ACTORS, KIND_WORD, KINDS, PRESETS, localInput, refText, stamp,
} from "./activity_data.js";

const ACTOR_ICON = { user: "inbox", head: "head", agent: "agents", system: "settings" };

export function icon(name) {
  return '<svg class="ico" aria-hidden="true" focusable="false">' +
    '<use href="/icons.svg#i-' + esc(name) + '"></use></svg>';
}

export function num(n) {
  return n == null ? "" : Number(n).toLocaleString("en-US");
}

// The Activity bar (R11.119): title and count, Live, then ONE shared toolbar row (range segmented, search, Filters
// popover with the Who and Kind groups, Copy as Markdown). The applied chips show under the row when a group is on.
export function toolbarHtml(st, opts) {
  const f = st.filt;
  const views = PRESETS.map(function (p) {
    return { id: p[0], label: p[1], current: f.preset === p[0] };
  });
  const who = { id: "actor", label: "Who", options: ACTORS.map(function (a) {
    return { token: "actor:" + a, label: ACTOR_WORD[a], on: f.actors.indexOf(a) >= 0,
      count: st.actors ? st.actors[a] : null };
  }) };
  const kind = { id: "kind", label: "Kind", options: KINDS.filter(function (k) {
    return !st.counts || st.counts[k] > 0 || f.kinds.indexOf(k) >= 0;
  }).map(function (k) {
    return { token: "kind:" + k, label: KIND_WORD[k], on: f.kinds.indexOf(k) >= 0,
      count: st.counts ? st.counts[k] : null };
  }) };
  const live = opts.live ? '<span class="hx-live" title="New events appear on their own">' +
    '<span class="hx-pulse" aria-hidden="true"></span>Live</span>' : "";
  return '<div class="hx-bar">' +
    '<span class="hx-total num" aria-live="polite">' + esc(opts.totalText) + "</span>" + live +
    sectionToolbar({
      key: "activity",
      label: "Activity filters",
      views: views,
      search: { value: f.q, placeholder: "Search ids, text, models", label: "Search history" },
      groups: [who, kind],
      actions: [{ id: "export", label: "Copy as Markdown" }],
    }) + "</div>";
}

// The custom range inputs (the keyboard path for picking a window); the timeline strip itself is in
// activity_timeline.js.
export function scrubberHtml(st) {
  const f = st.filt;
  if (f.preset !== "custom") return "";
  return '<div class="hx-scrub"><span class="hx-range">' +
    '<label><span class="hx-lbl">From</span><input type="datetime-local" class="input hx-dt" id="hx-from" ' +
    'data-hx="from" value="' + esc(localInput(f.from)) + '"></label>' +
    '<label><span class="hx-lbl">To</span><input type="datetime-local" class="input hx-dt" id="hx-to" ' +
    'data-hx="to" value="' + esc(localInput(f.to)) + '"></label></span></div>';
}

export function actorHtml(a) {
  return '<span class="hx-actor hx-a-' + esc(a) + '">' + icon(ACTOR_ICON[a] || "activity") + "<span>" +
    esc(ACTOR_WORD[a] || a) + "</span></span>";
}

export function kindHtml(e) {
  const bad = /\.(failed|error|stopped)$/.test(e.verb || "");
  return '<span class="hx-kind hx-k-' + esc(e.kind) + (bad ? " hx-bad" : "") + '"><span class="hx-dot" ' +
    'aria-hidden="true"></span>' + esc(KIND_WORD[e.kind] || e.kind) + "</span>";
}

export function hrefOf(e, fallbackPid) {
  const pid = e.project || fallbackPid;
  if (!e.link || !pid) return "";
  const cut = e.link.indexOf("?");
  const path = cut >= 0 ? e.link.slice(0, cut) : e.link;
  const parts = path.split("/");
  return projectHash(pid, parts[0]) + (parts.length > 1 ? "/" + parts.slice(1).map(encodeURIComponent).join("/") :
    "") + (cut >= 0 ? e.link.slice(cut) : "");
}

function field(name, valueHtml) {
  return valueHtml ? "<dt>" + esc(name) + "</dt><dd>" + valueHtml + "</dd>" : "";
}

function textBlock(name, text) {
  return text ? '<h4 class="hx-sub">' + esc(name) + '</h4><pre class="hx-pre">' + esc(text) + "</pre>" : "";
}

// The detail pane of the selected event: every field, the full text and reply of a head item, copy and open.
export function detailHtml(e, ctx) {
  if (!e) return "";
  const d = e.detail || {};
  const ref = refText(e);
  const kindWord = e.subject ? e.subject.split(":")[0] : "";
  const href = hrefOf(e, ctx.pid);
  const copy = ref && e.project ? copyButton(kindWord, ref, ref, { project: e.project, sum: e.summary }) : "";
  const extra = [];
  for (const key of ["task", "status", "effort", "engine", "durationS", "note", "reason", "answer", "headKind",
    "by", "weeklyPct", "dayPts", "author", "sha", "op", "source"]) {
    const v = d[key];
    if (v == null || v === "" || typeof v === "object") continue;
    extra.push(field(key === "durationS" ? "Duration" : key.charAt(0).toUpperCase() + key.slice(1),
      esc(key === "durationS" ? Math.round(v / 60) + " min" : String(v))));
  }
  const links = Array.isArray(d.links) && d.links.length ? field("Links", esc(d.links.join(", "))) : "";
  const options = Array.isArray(d.options) && d.options.length ? field("Options", esc(d.options.join(" · "))) : "";
  return '<aside class="hx-detail" aria-label="Event details"><div class="hx-dhead">' + kindHtml(e) +
    '<span class="hx-dtime num">' + esc(stamp(e.ms)) + "</span>" + copy +
    '<button type="button" class="hx-x" data-hx="close" aria-label="Close details">' +
    '<svg class="ico" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
    '<p class="hx-dsum">' + esc(e.summary) + "</p>" +
    '<dl class="hx-dl">' + field("Who", actorHtml(e.actor)) +
    (e.pname ? field("Project", esc(e.pname)) : "") +
    field("Ref", ref ? (href ? '<a href="' + esc(href) + '">' + esc(ref) + "</a>" : esc(ref)) : "") +
    field("Model", e.model ? esc(e.model) : "") +
    field("Tokens", e.tokensK == null ? "" : '<span class="num">' + esc(fmtTokens(e.tokensK)) + "</span>") +
    field("Event", esc(e.verb || "")) + extra.join("") + links + options +
    field("Undo", e.undo ? "Available on the row" : "") + "</dl>" +
    textBlock("Text", d.text) + textBlock("Reply", d.reply) +
    '<div class="hx-dact"><button type="button" class="btn btn-small" data-hx="copy-md" data-id="' + esc(e.id) +
    '">Copy as Markdown</button>' + (href ? '<a class="btn btn-small" href="' + esc(href) + '">Open</a>' : "") +
    "</div></aside>";
}
