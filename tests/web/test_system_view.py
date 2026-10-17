"""The System views (R10.33): web/js/views/system.js renders the view switcher, layered diagrams (bands, shaped nodes,
edges with arrowheads and labels), sequence diagrams, the data matrix, and the empty/error states."""

import json
import os
import re
import shutil
import subprocess
import unittest

TESTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(TESTS)
WEB = os.path.join(REPO, "web")
RENDER = os.path.join(TESTS, "web", "render_system.mjs")
INLINE = re.compile(r'\sstyle\s*=|\son[a-z]{3,}\s*=|<script|innerHTML', re.IGNORECASE)


def read(*parts):
    with open(os.path.join(WEB, *parts), encoding="utf-8") as fh:
        return fh.read()


def render():
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed")
    proc = subprocess.run([node, "--experimental-default-type=module", RENDER, WEB],
                          capture_output=True, text=True, check=False, timeout=60)
    if proc.returncode != 0:
        raise AssertionError(proc.stderr)
    return json.loads(proc.stdout)


class SystemViewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = render()

    def test_switcher_has_every_view_and_components_is_the_default(self):
        self.assertEqual(self.out["views"], ["context", "containers", "components", "modules", "layers", "flows",
                                             "data"])
        html = self.out["ok"]
        self.assertIn("aria-busy", self.out["okLoading"])
        for label in ("Context", "Containers", "Components", "Modules", "Layers", "Flows", "Data"):
            self.assertIn(">%s</button>" % label, html)
        self.assertIn('data-sys-view="components" aria-pressed="true"', html)
        self.assertIn("12 source files · 3.4k lines · 40 imports", html)
        self.assertIn("system.json: bad", html)
        self.assertIn("C4 level 3", html)

    def test_components_are_drawn_in_bands_with_labelled_arrows(self):
        html = self.out["ok"]
        self.assertEqual(len(re.findall(r'class="wfg-n[" ]', html)), 3)
        self.assertIn(">Web app [browser]</text>", html)
        self.assertIn('data-sys="c:api"', html)
        self.assertEqual(html.count('marker-end="url(#sys-a-'), 3)
        self.assertIn('<marker id="sys-a-x"', html)
        self.assertIn(">GET snapshot</text>", html)
        self.assertIn('stroke-dasharray="6 4"', html)  # the cycle edge
        self.assertIn("<title>Web UI with a very long component name", html)
        self.assertNotIn(">Web UI with a very long component name</text>", html)
        self.assertIn('fill="var(--surface-2)"', html)  # colours are token vars

    def test_activity_marks_from_details(self):
        html = self.out["ok"]
        self.assertIn("1 job(s) running", html)
        self.assertIn("4 commits in 30 days", html)

    def test_shapes_for_people_stores_and_externals(self):
        svg = self.out["containers"]
        self.assertIn('rx="25"', svg)  # person pill
        self.assertRegex(svg, r'<path d="M0 7a94 7 0 0 1 188 0v36')  # store cylinder
        self.assertIn('stroke-dasharray="5 3"', svg)  # external system
        self.assertIn('marker-end="url(#sys-a-d)"', svg)

    def test_sequence_diagram(self):
        svg = self.out["flow"]
        self.assertEqual(svg.count("<line "), 3)  # one lifeline per participant
        for n in range(1, 5):
            self.assertIn(">%d.</tspan>" % n, svg)
        self.assertIn('stroke-dasharray="5 4"', svg)  # the reply
        self.assertIn("h34v14h-30", svg)  # the self call loop

    def test_data_matrix(self):
        svg = self.out["matrix"]
        self.assertEqual(svg.count("<circle "), 20)
        self.assertEqual(svg.count('fill="none" stroke="var(--info)"'), 8)
        self.assertIn("rotate(-55)", svg)

    def test_opening_view_is_a_true_fit_clamped_to_20_and_150_percent(self):
        small, big = self.out["open"]
        self.assertEqual(small["k"], 1.5)
        self.assertEqual(small["x"], 300)
        self.assertAlmostEqual(big["k"], 776 / 3000)
        self.assertAlmostEqual(big["x"], (1200 - 4000 * 776 / 3000) / 2)
        wide, huge = self.out["fit"]
        self.assertAlmostEqual(wide["k"], 1176 / 1200 if 1176 / 1200 < 776 / 400 else 776 / 400)
        self.assertAlmostEqual(wide["y"], (800 - 400 * wide["k"]) / 2)
        self.assertEqual(huge["k"], 0.2)

    def test_toolbar_has_zoom_readout_copy_id_and_update(self):
        html = self.out["ok"]
        self.assertRegex(html, r'data-sys-op="out"[^>]*>[^<]*</button><button[^>]*data-sys-op="actual"[^>]*>100%</button>'
                               r'<button[^>]*data-sys-op="in"')
        self.assertIn("sys-zoom", html)
        self.assertIn('data-action="copy-ref"', html)
        self.assertIn('data-ref="rb:ok/view/system.components"', html)
        self.assertIn('data-sys-op="update"', html)
        self.assertIn(">Update diagrams</button>", html)
        self.assertIn('class="sys" id="sys-root"', html)

    def test_catalog_groups_views_by_family_and_puts_the_rest_in_more(self):
        html = self.out["cat"]
        for fam in ("Structure", "Behaviour", "Data"):
            self.assertIn('aria-label="%s"' % fam, html)
        self.assertIn('<details class="sys-more"><summary class="btn btn-small">More</summary>', html)
        more = html.split('<details class="sys-more">')[1].split("</details>")[0]
        self.assertIn('data-sys-view="context"', more)
        self.assertIn("disabled", more)  # modules is not available
        self.assertNotIn('data-sys-view="containers"', more)
        self.assertIn("classes", html)  # R11.110: the v2 diagrams are drawn
        self.assertIn('data-sys-view="flows"', html.split('<details')[0])
        self.assertNotIn("sys-more", self.out["ok"])

    def test_layout_css_fills_the_space_and_docks_the_panel(self):
        css = read("css", "system.css")
        self.assertIn(".main:has(>.sys){overflow:hidden", css)
        self.assertRegex(css, r"\.sys\{[^}]*height:100%[^}]*min-height:0")
        self.assertRegex(css, r"\.sys-canvas\{flex:1;min-height:0")
        self.assertRegex(css, r"\.sys-canvas>\.wfg-svg\{[^}]*height:100%")
        # R11.152: the panel docks as a real flex child of .sys-row beside .sys-box, not an absolute overlay on top of it.
        self.assertRegex(css, r"\.sys-row\{display:flex;flex:1;min-height:0")
        self.assertRegex(css, r"\.sys-box\{position:relative;flex:1;min-height:0;min-width:0")
        self.assertRegex(css, r"\.sys-panel\{position:static;flex:none;width:min\(400px,100%\)[^}]*overflow:auto")
        for cls in (".sys-menu{", ".sys-menu-h{", ".sys-menu-i{", ".sys-menu-sep{", ".sys-menu-list{", ".sys-crumbs{",
                    ".sys-tog{"):
            self.assertIn(cls, css)
        self.assertNotIn("100vh - 190px", css)

    def test_missing_api_old_service_and_errors(self):
        self.assertIn("System map needs the API", self.out["missing"])
        self.assertIn('data-sys-op="retry"', self.out["missing"])
        self.assertIn("could not be read", self.out["broken"])
        self.assertNotIn("aria-busy", self.out["broken"])
        self.assertIn("Restart the service", self.out["old"])
        self.assertIn("Pick a project", self.out["global"])

    def test_source_rules(self):
        for path in (("js", "views", "system.js"), ("js", "graph", "syslayout.js"), ("css", "system.css")):
            text = read(*path)
            self.assertIsNone(INLINE.search(text), path)
            if path[0] == "js":
                self.assertTrue(all(len(line) <= 120 for line in text.splitlines()), path)
        self.assertLessEqual(len(read("css", "system.css").encode()), 8192)
        self.assertIn("/css/system.css", read("index.html"))
        self.assertIn('id: "system"', read("js", "routes.js"))


class SystemFullScreenTest(unittest.TestCase):
    """A7: #/full/<pid>/system shows the diagram alone (no nav) with a slim bar; Close or Esc returns."""

    def test_route_is_parsed_and_distinct_from_the_workflow_one(self):
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node is not installed")
        routes = "file://" + os.path.join(WEB, "js", "routes.js")
        hashes = ["#/full/rb-site/system", "#/full/p1/system?x=1", "#/full/a/workflow", "#/p/a/system", "#/full/Bad/system"]
        script = ("import { fullSystemOf, fullRouteOf } from " + json.dumps(routes) + ";\n"
                  "process.stdout.write(JSON.stringify(" + json.dumps(hashes) +
                  ".map((h) => [fullSystemOf(h), fullRouteOf(h)])));\n")
        proc = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True,
                              check=False, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr[-400:])
        self.assertEqual([["rb-site", None], ["p1", None], [None, "a"], [None, None], [None, None]],
                         json.loads(proc.stdout))

    def test_app_hides_the_shell_and_mounts_the_system(self):
        src = read("js", "app.js")
        self.assertIn("fullSystemOf(window.location.hash)", src)
        self.assertIn("mod.mountFull(host, pid);", src)
        self.assertIn("mod.leaveFull();", src)

    def test_bar_has_full_screen_and_close_and_esc_leaves(self):
        src = read("js", "views", "system.js")
        self.assertIn('op("full", "Open full screen", "Full screen")', src)
        self.assertIn('op("exit", "Close full screen (Esc)", "Close")', src)
        self.assertIn('return "#/full/" + pid + "/system";', src)
        self.assertIn("else if (fullHost) closeFull();", src)
        self.assertIn("export function mountFull(host, pid)", src)

    def test_native_full_screen_with_route_fallback(self):
        src = read("js", "views", "system.js")
        self.assertIn("requestFullscreen", src)
        self.assertIn("webkitRequestFullscreen", src)
        self.assertIn('document.addEventListener("fullscreenchange"', src)
        self.assertIn("Exit full screen", src)


if __name__ == "__main__":
    unittest.main()
