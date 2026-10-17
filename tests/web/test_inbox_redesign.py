"""The Inbox redesign (R7.111): one unified list of open questions, Head asks, rule proposals and blocking tasks,
blocking questions first and newest first within a kind. Each row is one compact line (kind chip, one-line title with
the project, age, one action); the body opens on click or Enter. Keys: j and k move, Enter opens, 1 to 6 answer, Esc
closes. The render check runs inboxBody() in node (skipped when node is not installed). Static checks read inbox.js:
no inline styles or handlers, no CSS, lines within 120 characters, no innerHTML writes."""

import json
import os
import re
import shutil
import subprocess
import sys
import unittest

TESTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(TESTS)
sys.path.insert(0, REPO)

WEB = os.path.join(REPO, "web")
INBOX = os.path.join(WEB, "js", "views", "inbox.js")
MAX_LINE = 120
INLINE = re.compile(r'\sstyle\s*=|\son[a-z]{3,}\s*=|<script', re.IGNORECASE)

NODE_CHECK = r"""
const web = process.argv[1];
const inbox = await import(web + "/js/views/inbox.js");
const now = Date.now();
const q1 = { id: "Q1", task: "P0.8", text: "Ship now?", opts: ["yes", "no (recommended): safer"], def: "yes",
  block: true, timeoutS: 60, askedMs: now - 120000 };
const q2 = { id: "Q2", task: "", text: "Keep the old file?", opts: [], def: null, block: false, timeoutS: null,
  askedMs: now - 3 * 3600000 };
const snap = { id: "alpha", title: "Alpha", fetchedAt: new Date(now).toISOString(), questions: [q2, q1],
  tasks: [], needsYou: [{ kind: "task", id: "P1.2", title: "Check the hardware" }],
  head: { rows: [{ id: "H3", kind: "ask", sum: "Pick the database", status: "needs-you", age: 90 }] },
  rulesProposals: [{ id: "RP1", text: "Keep small things", sources: ["H12"] }] };
const vm = { route: { name: "project", id: "alpha", section: "inbox" }, snapshotList: [snap],
  project: { snapshot: snap }, meterRows: [] };
const html = inbox.inboxBody(vm);
const keys = [...html.matchAll(/data-key="([^"]+)"/g)].map(function (m) { return m[1]; })
  .filter(function (k) { return k.indexOf(":") > 0; });
const empty = { ...vm, snapshotList: [{ ...snap, questions: [], head: { rows: [] }, rulesProposals: [],
  needsYou: [] }] };
const emptyHtml = inbox.inboxBody(empty);
const row = html.slice(html.indexOf('data-key="q:alpha:Q1"'), html.indexOf('data-key="q:alpha:Q2"'));
console.log(JSON.stringify({
  order: keys,
  summary: html.indexOf("5 need you: 2 questions, 1 head asks, 1 rule proposals, 1 blockers") >= 0,
  filters: ["All 5", "Questions 2", "Head asks 1", "Rules 1", "Blockers 1"].every(function (t) {
    return html.indexOf(t) >= 0;
  }),
  rowGrid: (html.match(/class="row-grid rg-fin ib-row"/g) || []).length,
  roleButtons: (html.match(/class="ib-hit"/g) || []).length,
  collapsed: (html.match(/class="ib-hit"[^>]*aria-expanded="false"/g) || []).length,
  bodiesHidden: (html.match(/class="ib-body" id="[^"]+" hidden>/g) || []).length,
  questionsOpen: (html.match(/class="ib-hit"[^>]*aria-expanded="true"/g) || []).length,
  rowHasProject: row.indexOf('class="chip ib-task"') >= 0,
  rowHasAge: /rg-num qc-foot">2m</.test(row),
  rowHasAction: row.indexOf('class="ib-c ib-chev"') >= 0,
  bodyOptionsVertical: row.indexOf('class="nz-list ib-opts" role="group"') >= 0 && row.indexOf("safer") >= 0,
  bodyOther: row.indexOf('data-form="inbox-question-answer"') >= 0,
  ruleAction: html.indexOf('data-action="rule-accept" data-project="alpha" data-id="RP1"') >= 0,
  taskLink: html.indexOf('href="#/p/alpha/work/i/P1.2"') >= 0,
  emptyText: emptyHtml.indexOf("Nothing needs you.") >= 0 && emptyHtml.indexOf("ib-item") < 0,
  openSomething: inbox.inboxBody({ ...vm }).indexOf("is-open") < 0,
}));
"""


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class InboxRedesignRender(unittest.TestCase):
    def setUp(self):
        result = subprocess.run(["node", "--input-type=module", "-e", NODE_CHECK, WEB], cwd=REPO,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.got = json.loads(result.stdout.strip().splitlines()[-1])

    def test_one_list_blocking_questions_then_questions_asks_rules_tasks(self):
        self.assertEqual(self.got["order"],
                         ["q:alpha:Q1", "q:alpha:Q2", "a:alpha:H3", "r:alpha:RP1", "t:alpha:P1.2"])

    def test_summary_line_and_filter_bar(self):
        self.assertTrue(self.got["summary"])
        self.assertTrue(self.got["filters"])

    def test_each_row_is_one_grid_row_with_a_keyboard_hit(self):
        self.assertEqual(self.got["rowGrid"], 5)
        self.assertEqual(self.got["roleButtons"], 5)
        self.assertEqual(self.got["collapsed"], 3)
        self.assertEqual(self.got["bodiesHidden"], 3)
        self.assertEqual(self.got["questionsOpen"], 2)
        self.assertTrue(self.got["rowHasProject"])
        self.assertTrue(self.got["rowHasAge"])
        self.assertTrue(self.got["rowHasAction"])

    def test_expanded_body_has_vertical_options_and_other_box(self):
        self.assertTrue(self.got["bodyOptionsVertical"])
        self.assertTrue(self.got["bodyOther"])

    def test_rule_accept_and_task_link_keep_their_paths(self):
        self.assertTrue(self.got["ruleAction"])
        self.assertTrue(self.got["taskLink"])

    def test_empty_state_is_calm(self):
        self.assertTrue(self.got["emptyText"])


class InboxRedesignSource(unittest.TestCase):
    def setUp(self):
        self.src = read(INBOX)

    def test_keys_j_k_enter_esc_and_digits(self):
        # Enter/Space on a row is no longer handled in JS: the row's hit target (ib-hit) is a real <button>, so the
        # browser activates it natively on Enter or Space, the same way Head's own row toggle (.hd-hit) does.
        self.assertIn('bindKey("j", moveFocus(1));', self.src)
        self.assertIn('bindKey("k", moveFocus(-1));', self.src)
        self.assertIn('class="ib-hit"', self.src)
        self.assertIn('event.key === "Escape"', self.src)
        self.assertIn("for (let n = 1; n <= KEY_MAX; n++) bindKey(String(n), onDigit(n - 1));", self.src)

    def test_rows_update_in_place_without_innerhtml(self):
        self.assertIn("swapNode(item, parseOne(", self.src)
        self.assertIsNone(re.search(r"\.innerHTML|insertAdjacentHTML", self.src))

    def test_filter_and_expand_are_clicks_on_the_page(self):
        self.assertIn("toolbarHtml({ key: \"inbox\"", self.src)
        self.assertIn('document.addEventListener("click", onPageClick)', self.src)
        self.assertIn('document.addEventListener("rb:toolbar", onToolbar)', self.src)

    def test_no_new_css_or_inline_styles_or_handlers(self):
        self.assertIsNone(INLINE.search(self.src))
        self.assertNotIn("<style", self.src)

    def test_lines_within_limit(self):
        long = [n for n, line in enumerate(self.src.splitlines(), 1) if len(line) > MAX_LINE]
        self.assertEqual(long, [])


INBOX_CSS = os.path.join(WEB, "css", "inbox.css")


class InboxUxPass(unittest.TestCase):
    """R10.2: the tester's fixes. The expand glyph is centred, the copy button stays on the id line, the section head
    shares one row with its copy button, and the default option is not a solid block."""

    def setUp(self):
        self.src = read(INBOX)
        self.css = read(INBOX_CSS)

    def test_section_head_uses_the_ib_head_row(self):
        self.assertIn('<div class="page-head ib-head">', self.src)
        self.assertRegex(self.css, r"\.ib-head \{ display: flex; justify-content: flex-end")

    def test_expand_glyph_is_centred_and_turns_when_open(self):
        self.assertRegex(self.css, r"\.ib-row > \.btn \{[^}]*display: grid; place-items: center")
        self.assertRegex(self.css, r"\.ib-item\.is-open \.ib-chev \{ transform: rotate\(90deg\)")

    def test_copy_button_stays_on_the_id_line(self):
        self.assertRegex(self.css, r"\.ib-body \.qc-line \{ display: flex")
        self.assertIn('<p class="qc-line">', self.src)

    def test_default_option_is_marked_by_border_not_a_solid_block(self):
        self.assertIn("btn-primary is-default", self.src)
        self.assertRegex(self.css, r"\.qc-opt\.is-default \{ background: var\(--surface-2\)")

    def test_reduced_motion_stops_the_turn(self):
        self.assertIn("@media (prefers-reduced-motion: reduce) { .ib-chev { transition: none } }", self.css)


if __name__ == "__main__":
    unittest.main()
