"""R10.7 / H173: the Planner is the fourth view of Work. The Work section renders it from the same snapshot, old
planner routes redirect to it, and a hostile plan (parent cycles, duplicate ids, a self parent) neither throws nor
hangs. Runs in node (no DOM). Skipped when node is not installed."""

import json
import os
import shutil
import subprocess
import unittest
import urllib.parse
from pathlib import Path

TESTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(TESTS)
WEB = os.path.join(REPO, "web")

NODE_CODE = """
const web = process.argv[1];
const state = await import(web + "/js/state.js");
const work = await import(web + "/js/views/work.js");
const planner = await import(web + "/js/views/planner.js");
const routes = await import(web + "/js/routes.js");
const rows = JSON.parse(process.argv[2]);
const now = Date.parse("2026-10-13T12:00:00Z");
const snap = { project: { id: "demo", title: "demo" }, tasks: [], features: { rows: rows, uncovered: [], orphans: [],
  counts: {} } };
const store = state.createStore();
store.projects = [{ id: "demo", name: "demo" }];
store.snapshots.demo = state.normalizeSnapshot(snap, now);
const route = { name: "project", id: "demo", section: "work", view: "planner", item: null, filters: {} };
const vm = state.buildViewModel(store, route, { mode: null, open: {} }, now);
const t0 = Date.now();
const html = work.sectionView(vm);
const plan = planner.plannerHtml(vm.project.snapshot, { status: "", open: {}, edit: null, pick: null, project: "demo",
  focus: "" });
console.log(JSON.stringify({ html: html, plan: plan, ms: Date.now() - t0,
  ids: routes.SECTIONS.map((s) => s.id),
  legacy: [routes.legacyPlannerHash("#/p/demo/planner"), routes.legacyPlannerHash("#/p/demo/planner?f=F5"),
    routes.legacyPlannerHash("#/p/demo/planner?f=bad"), routes.legacyPlannerHash("#/all/planner"),
    routes.legacyPlannerHash("#/p/demo/work/planner")] }));
"""


FOCUS_CODE = """
const state = await import(process.argv[1] + "/js/state.js");
const work = await import(process.argv[1] + "/js/views/work.js");
const store_ = {};
globalThis.window = { localStorage: { getItem: (k) => (k in store_ ? store_[k] : null),
  setItem: (k, v) => { store_[k] = String(v); } } };
state.updateUi((ui) => { ui.filters["work.demo"] = "f=kind%3Abug&s=n%3Aasc&c=todo&v=board"; });
const snap = { project: { id: "demo", title: "demo" }, tasks: [], features: { rows: [], uncovered: [], orphans: [],
  counts: {} } };
const now = Date.parse("2026-10-13T12:00:00Z");
const s = state.createStore();
s.projects = [{ id: "demo", name: "demo" }];
s.snapshots.demo = state.normalizeSnapshot(snap, now);
const route = { name: "project", id: "demo", section: "work", view: "planner", item: null,
  filters: { f: "F5" } };
const vm = state.buildViewModel(s, route, { mode: null, open: {} }, now);
work.sectionView(vm);
console.log(JSON.stringify(state.loadUi().filters["work.demo"]));
"""

STATE_CODE = """
const state = await import(process.argv[1] + "/js/state.js");
const raw = { project: { id: "demo", title: "demo" }, tasks: [], features: { rows: [], uncovered: [], orphans: [],
  counts: {} }, jobs: [{ id: "j1", status: "claimed", task: "R1" }, { id: "j2", status: "running", task: "R2" },
  { id: "j3", status: "queued", task: "R3" }], summary: { running_count: 2 } };
const snap = state.normalizeSnapshot(raw, Date.parse("2026-10-13T12:00:00Z"));
console.log(JSON.stringify(snap.running.map((j) => j.id)));
"""


def row(fid, parent=None):
    return {"id": fid, "label": fid, "title": "Item " + fid, "phase": None, "done": 0, "total": 0, "blocked": 0,
            "state": "todo", "parent": parent}


def run_node(code, *args):
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed")
    proc = subprocess.run([node, "--input-type=module", "-e", code, Path(WEB).as_uri()] + list(args),
                          capture_output=True, text=True, check=False, timeout=30)
    if proc.returncode != 0:
        raise AssertionError("web module failed in node: " + proc.stderr[-800:])
    return proc.stdout


def render(rows):
    return json.loads(run_node(NODE_CODE, json.dumps(rows)))


class WorkPlannerTest(unittest.TestCase):
    def test_work_renders_the_planner_view_with_the_view_switch(self):
        out = render([row("F1"), row("F2", "F1")])
        html = out["html"]
        self.assertIn('data-section="planner"', html)
        self.assertIn('data-tb-view="planner"', html)
        self.assertIn('aria-pressed="true" data-tb-view="planner"', html)
        self.assertIn("2 plan items", html)
        self.assertEqual(html.count('<h2 class="page-title">Work</h2>'), 0)
        self.assertNotIn("planner", out["ids"])

    def test_old_planner_routes_redirect_to_work_planner(self):
        legacy = render([])["legacy"]
        self.assertEqual(legacy, ["#/p/demo/work/planner", "#/p/demo/work/planner?f=F5", "#/p/demo/work/planner",
                                  "#/all/work", None])

    def test_claimed_jobs_are_in_the_client_running_list(self):
        out = run_node(STATE_CODE)
        self.assertEqual(json.loads(out), ["j1", "j2"])

    def test_planner_focus_does_not_overwrite_saved_tag_filters(self):
        saved = urllib.parse.parse_qs(json.loads(run_node(FOCUS_CODE)))
        self.assertEqual(saved.get("f"), ["kind:bug"])

    def test_hostile_plan_does_not_throw_or_hang(self):
        rows = [row("F1", "F2"), row("F2", "F1"), row("F3", "F3"), row("F4"), row("F4"), row("F5", "F9")]
        out = render(rows)
        self.assertLess(out["ms"], 2000)
        self.assertIn("pl-feat-F4", out["plan"])


if __name__ == "__main__":
    unittest.main()
