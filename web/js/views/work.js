// Work section (WP31): the Board, List and Tree views of one project's tasks. This module reads the route and the saved
// preferences, builds one context for the view, and handles the section's clicks, changes and bulk actions. Filters (f)
// and grouping (g) ride in the hash, so a link can carry them. The view, sort and phone column are kept per project in
// rb.ui.v2 under ui.filters["work.<id>"], so they survive a reload. Every write goes through cmd.js.

import { bannerHtml, emptyHtml, esc, skeletonHtml } from "../dom.js";
import { run, runBatch } from "../cmd.js";
import { buildHash, currentRoute } from "../router.js";
import { loadUi, updateUi } from "../state.js";
import { boardView, COLUMNS, filterGroups, finePointer, matchesFilters, parseFilters, setStatus, toggleToken,
  matchesIssue, workIssues, workTasks } from "./board.js";
import { clearSelection, groupBarHtml, GROUPS, listView, nextSort, parseSort, setAllSelected, setSelected } from
  "./list.js";
import { subtaskToggle, treeView } from "./tree.js";
import { bind as bindPlanner, filterGroups as plannerFilterGroups, screenHtml as plannerScreen,
  setStatusFilter as setPlannerStatus } from "./planner.js";
import { toolbarHtml } from "../toolbar.js";

// R10.7: the Planner is the fourth view of Work. It reads the same snapshot (tasks and features) as the other three.
const VIEWS = ["board", "list", "tree", "planner"];
const VIEW_LABEL = { board: "Board", list: "List", tree: "Tree", planner: "Planner" };
const PREF_PREFIX = "work.";
const COLUMN_KEYS = COLUMNS.map(function (c) {
  return c.key;
});

function savedParams(pid) {
  const raw = loadUi().filters[PREF_PREFIX + pid];
  return new URLSearchParams(typeof raw === "string" ? raw : "");
}

// The effective preferences: the route wins for view, f and g when it carries them; the saved values fill the rest.
function readPrefs(pid, route) {
  const saved = savedParams(pid);
  const filters = route.filters || {};
  // In the Planner, route f is a plan item focus (F5), not a tag filter: the tag filter stays the saved one.
  const onPlanner = route.view === "planner";
  const f = (onPlanner ? "" : filters.f) || saved.get("f") || "";
  const g = filters.g || saved.get("g") || "";
  const view = VIEWS.indexOf(route.view) >= 0 ? route.view : (VIEWS.indexOf(saved.get("v")) >= 0
    ? saved.get("v") : "board");
  const col = COLUMN_KEYS.indexOf(saved.get("c")) >= 0 ? saved.get("c") : "todo";
  return {
    view: view,
    f: f,
    g: GROUPS.indexOf(g) >= 0 ? g : "",
    s: parseSort(saved.get("s")),
    sRaw: saved.get("s") || "",
    c: col,
  };
}

// The plan item scope rides in f as a feat:<FeatureId> token (from the Planner). The board's filter helpers ignore it,
// so it is split off here and kept apart from the tag filters. It is never saved as a preference.
const FEAT_TOKEN = /^feat:(F[1-9][0-9]?)$/;

function splitFeat(text) {
  let feat = "";
  const rest = [];
  for (const raw of String(text || "").split(",")) {
    const token = raw.trim();
    const m = FEAT_TOKEN.exec(token);
    if (m) feat = m[1];
    else if (token) rest.push(token);
  }
  return { feat: feat, rest: rest.join(",") };
}

function joinFeat(feat, rest) {
  const parts = [];
  if (feat) parts.push("feat:" + feat);
  if (rest) parts.push(rest);
  return parts.join(",");
}

// The plan item and all its descendants (child items at any depth), as a set of feature ids.
function subtreeIds(snap, feat) {
  const ids = {};
  ids[feat] = true;
  const rows = snap.features && snap.features.rows ? snap.features.rows : [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parent && ids[row.parent] && !ids[row.id]) {
        ids[row.id] = true;
        grew = true;
      }
    }
  }
  return ids;
}

function featChipHtml(snap, feat) {
  const row = ((snap.features && snap.features.rows) || []).find(function (r) {
    return r.id === feat;
  });
  const text = row ? "Plan item: " + (row.label || row.id) + " " + (row.title || "") : "Plan item: " + feat;
  return '<div class="wk-chips" role="group" aria-label="Plan item filter">' +
    '<button type="button" class="wk-chip" aria-pressed="true" data-wk="feat-clear" data-focus="wk-feat-clear"' +
    ' aria-label="Remove filter ' + esc(text.trim()) + '">' + esc(text.trim()) +
    ' <span aria-hidden="true">&times;</span></button></div>';
}

function persist(pid, prefs) {
  const params = new URLSearchParams();
  params.set("v", prefs.view);
  // In the Planner view f carries a plan item focus (F5), not a tag filter: the saved filters stay as they were.
  const keep = prefs.view === "planner" ? savedParams(pid) : null;
  const tags = keep ? (keep.get("f") || "") : splitFeat(prefs.f).rest;
  const group = keep ? (keep.get("g") || "") : prefs.g;
  if (tags) params.set("f", tags);
  if (group) params.set("g", group);
  params.set("s", prefs.sRaw || "n:asc");
  params.set("c", prefs.c);
  const text = params.toString();
  if (savedParams(pid).toString() === text) return;
  updateUi(function (ui) {
    ui.filters[PREF_PREFIX + pid] = text;
  });
}

function cleanFilters(f, g) {
  const out = {};
  if (f) out.f = f;
  if (g) out.g = g;
  return out;
}

function dispatchRender() {
  window.dispatchEvent(new Event("hashchange"));
}

// Keep the URL and the saved preferences in step, then show the result. Changing the hash re-renders by itself.
function goWork(pid, changes) {
  const route = currentRoute();
  const prefs = Object.assign(readPrefs(pid, route), changes);
  persist(pid, prefs);
  const hash = buildHash({ name: "project", id: pid, section: "work", view: prefs.view, item: route.item || null,
    filters: prefs.view === "planner" ? {} : cleanFilters(prefs.f, prefs.g) });
  if (window.location.hash === hash) {
    dispatchRender();
  } else {
    window.location.hash = hash;
  }
}

function saveOnly(pid, changes) {
  const prefs = Object.assign(readPrefs(pid, currentRoute()), changes);
  persist(pid, prefs);
  dispatchRender();
}

function focusLater(selector) {
  window.setTimeout(function () {
    const el = document.querySelector(selector);
    if (el) el.focus({ preventScroll: true });
  }, 0);
}

function planNote(snap) {
  const rows = (snap.features && snap.features.rows) || [];
  return rows.length ? rows.length + (rows.length === 1 ? " plan item" : " plan items") : "No plan yet";
}

function headHtml(ctx) {
  const total = ctx.all.length;
  let note = "No tasks yet";
  if (ctx.view === "planner") note = planNote(ctx.snap);
  else if (total) {
    note = ctx.shown.length === total ? total + (total === 1 ? " task" : " tasks")
      : "Showing " + ctx.shown.length + " of " + total + " tasks";
  }
  // One toolbar row (R11.119): the four views, the Filters popover (the Planner's status in its view), no action.
  const groups = ctx.view === "planner" ? plannerFilterGroups() : (ctx.F ? filterGroups(ctx) : []);
  const bar = toolbarHtml({ key: "work", label: "Work toolbar", groups: groups,
    views: VIEWS.map(function (v) {
      return { id: v, label: VIEW_LABEL[v], current: ctx.view === v };
    }) });
  return '<div class="page-head"><p class="page-note">' + esc(note) + "</p></div>" +
    bar;
}

// The issue cards that pass the filters (the Board shows them; none inside a feature scope).
function issuesShown(ctx) {
  if (ctx.feat) return [];
  return workIssues(ctx.snap, ctx.pid, Date.now()).filter(function (i) {
    return matchesIssue(i, ctx.F);
  });
}

function bodyHtml(ctx) {
  const issues = issuesShown(ctx);
  if (!ctx.all.length && !issues.length) {
    return emptyHtml("No tasks in this project yet.", "<span>Tasks load from the project plan.</span>");
  }
  if (!ctx.shown.length) {
    // Filters can leave no task while issue cards still match: those show on the Board, not a "no match" line.
    if (!issues.length) {
      return emptyHtml("No tasks match these filters.",
        '<button type="button" class="btn btn-small" data-wk="clear" data-focus="wk-clear">Clear filters</button>');
    }
    return boardView(ctx);
  }
  if (ctx.view === "list") return groupBarHtml(ctx) + listView(ctx);
  if (ctx.view === "tree") return treeView(ctx);
  return boardView(ctx);
}

export function sectionView(vm) {
  const route = vm.route;
  if (route.name !== "project" || !vm.project) {
    return emptyHtml("Select a project to view work.", '<a href="#/all/overview">Go to All projects</a>');
  }
  if (vm.project.notFound) {
    return emptyHtml("Project not found.", '<a href="#/all/overview">Go to All projects</a>');
  }
  const snap = vm.project.snapshot;
  if (!snap) {
    if (vm.project.error) {
      return bannerHtml("danger", "Failed loading project; retrying automatically.", vm.project.error.message);
    }
    return '<div aria-busy="true">' + skeletonHtml(["w-60", "w-90"]) + "</div>";
  }
  const pid = route.id;
  const prefs = readPrefs(pid, route);
  persist(pid, prefs);
  if (prefs.view === "planner") {
    // The planner paints into its own screen element after this render (planner.js flush) and listens on <main>.
    if (typeof document !== "undefined") bindPlanner(document.getElementById("main"));
    const stub = { snap: snap, view: "planner", all: workTasks(snap, vm.now) };
    return '<div class="wk" data-project="' + esc(pid) + '">' + headHtml(stub) + plannerScreen(vm) + "</div>";
  }
  const scope = splitFeat(prefs.f);
  const F = parseFilters(scope.rest);
  const all = workTasks(snap, vm.now);
  const members = scope.feat ? subtreeIds(snap, scope.feat) : null;
  const ctx = {
    pid: pid,
    snap: snap,
    view: prefs.view,
    all: all,
    shown: all.filter(function (t) {
      if (members && !(t.feats || []).some(function (f) {
        return members[f] === true;
      })) return false;
      return matchesFilters(t, F);
    }),
    F: F,
    feat: scope.feat,
    filters: cleanFilters(prefs.f, prefs.g),
    group: prefs.g,
    sort: prefs.sRaw || "n:asc",
    col: prefs.c,
    open: vm.prefsOpen || {},
    fine: finePointer(),
  };
  const chip = ctx.feat ? featChipHtml(snap, ctx.feat) : "";
  return '<div class="wk" data-project="' + esc(pid) + '">' + headHtml(ctx) + chip + bodyHtml(ctx) + "</div>";
}

// Bulk actions run one batch: the selected visible tasks, with the status or the run request from the bar.
function bulk(pid, root, el) {
  const op = el.getAttribute("data-op");
  const bar = el.closest(".wk-bulk");
  const ids = bar ? (bar.getAttribute("data-ids") || "").split(",").filter(Boolean) : [];
  if (op === "clear") {
    clearSelection(pid);
    dispatchRender();
    return;
  }
  if (!ids.length) return;
  let items;
  let done;
  if (op === "status") {
    const picked = root.querySelector("#wk-bulk-status");
    const to = picked ? picked.value : "";
    if (COLUMNS.every(function (c) {
      return c.state !== to;
    })) return;
    items = ids.map(function (id) {
      return { op: "task.status", args: { id: id, status: to }, key: "task:" + id, value: to };
    });
    done = "tasks updated";
  } else if (op === "start") {
    items = ids.map(function (id) {
      return { op: "task.start", args: { id: id } };
    });
    done = "tasks queued to run";
  } else {
    items = ids.map(function (id) {
      return { op: "task.stop", args: { id: id } };
    });
    done = "stop requests sent";
  }
  clearSelection(pid);
  runBatch(items, { project: pid, done: done });
}

function onClick(event) {
  const el = event.target && event.target.closest ? event.target.closest("[data-wk]") : null;
  if (!el) return;
  const root = el.closest(".wk");
  if (!root) return;
  const pid = root.getAttribute("data-project");
  const kind = el.getAttribute("data-wk");
  const route = currentRoute();
  const prefs = readPrefs(pid, route);
  if (kind === "view") {
    goWork(pid, { view: el.getAttribute("data-view") });
  } else if (kind === "filter") {
    const scope = splitFeat(prefs.f);
    goWork(pid, { f: joinFeat(scope.feat, toggleToken(scope.rest, el.getAttribute("data-token"))) });
  } else if (kind === "clear") {
    goWork(pid, { f: joinFeat(splitFeat(prefs.f).feat, "") });
  } else if (kind === "feat-clear") {
    goWork(pid, { f: splitFeat(prefs.f).rest });
  } else if (kind === "tab") {
    saveOnly(pid, { c: el.getAttribute("data-col") });
  } else if (kind === "sort") {
    const next = nextSort(prefs.sRaw, el.getAttribute("data-key"));
    saveOnly(pid, { sRaw: next });
  } else if (kind === "status") {
    setStatus(pid, el.getAttribute("data-task"), el.getAttribute("data-to"), el.getAttribute("data-from"));
  } else if (kind === "run-start") {
    const id = el.getAttribute("data-task");
    run("task.start", { id: id }, { project: pid, label: id + " queued to run" });
  } else if (kind === "run-stop") {
    const id = el.getAttribute("data-task");
    run("task.stop", { id: id }, { project: pid, label: id + " stop requested" });
  } else if (kind === "bulk") {
    bulk(pid, root, el);
  }
}

// The section toolbar (rb:toolbar, toolbar.js): the view switch, filter tokens toggle in the route f, Clear resets f.
// In the Planner view the Status options are the Planner's own filter, not a tag filter.
function onToolbar(event) {
  const d = event.detail || {};
  const root = event.target && event.target.closest ? event.target.closest(".wk") : null;
  if (!root || d.key !== "work") return;
  const pid = root.getAttribute("data-project");
  const prefs = readPrefs(pid, currentRoute());
  if (d.type === "view") {
    goWork(pid, { view: d.value });
  } else if (prefs.view === "planner") {
    // The Planner's Status is one choice: a chosen option again turns it off (back to All).
    if (d.type === "token" || d.type === "remove") {
      setPlannerStatus(String(d.value).slice(3), true);
      dispatchRender();
      focusLater('[data-tb-token="' + d.value + '"]');
    } else if (d.type === "clear") {
      setPlannerStatus("", false);
      dispatchRender();
    }
  } else if (d.type === "token" || d.type === "remove") {
    const scope = splitFeat(prefs.f);
    goWork(pid, { f: joinFeat(scope.feat, toggleToken(scope.rest, d.value)) });
  } else if (d.type === "clear") {
    goWork(pid, { f: joinFeat(splitFeat(prefs.f).feat, "") });
  }
}

function onChange(event) {
  const el = event.target;
  const root = el && el.closest ? el.closest(".wk") : null;
  if (!root) return;
  const pid = root.getAttribute("data-project");
  const kind = el.getAttribute("data-wk");
  if (kind === "select") {
    const id = el.getAttribute("data-task");
    setSelected(pid, id, el.checked);
    el.blur();
    dispatchRender();
    focusLater('[data-focus="wk-sel-' + id + '"]');
  } else if (kind === "select-all") {
    const ids = (el.getAttribute("data-ids") || "").split(",").filter(Boolean);
    setAllSelected(pid, ids, el.checked);
    el.blur();
    dispatchRender();
    focusLater('[data-focus="wk-select-all"]');
  } else if (kind === "sub") {
    subtaskToggle(pid, el.getAttribute("data-addr"), el.checked);
  } else if (kind === "group") {
    el.blur();
    goWork(pid, { g: el.value });
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("rb:toolbar", onToolbar);
}
