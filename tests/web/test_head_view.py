"""The Head screen (R7.31 H8, docs/HEAD-SPEC.md sections 5 and 10): web/js/views/head.js and web/css/head.css.

The view is rendered in node (render_head.mjs) from a view model built by folding the demo fixture
(fixtures/demo/alpha/docs/head.jsonl) with the H1 core fold. Checks: the row grid tracks (UI rule 0), the header on
the same tracks, text only through esc(), the empty state, the Review and Confirm actions, the phone cards, and the
CSS budget (head.css <= 1.2 KB and the web/css total <= CSS_TOTAL_MAX in test_shell.py, which is not edited here).
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

TESTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(TESTS)
sys.path.insert(0, REPO)

from roadmap.core.head import fold  # noqa: E402

WEB = os.path.join(REPO, "web")
SOURCE = os.path.join(WEB, "js", "views", "head.js")
CSS = os.path.join(WEB, "css", "head.css")
JS = SOURCE
CSS_DIR = os.path.join(WEB, "css")
SHELL_TEST = os.path.join(TESTS, "web", "test_shell.py")
RENDER = os.path.join(TESTS, "web", "render_head.mjs")
FIXTURE = os.path.join(REPO, "fixtures", "demo", "alpha", "docs", "head.jsonl")
HEAD_CSS_MAX = 7168  # raised 2026-10-15 for spec 13 (cards) and the List table view; again for R10.16 (reply column, questions group)
TRACKS = "20px 60px minmax(0,1fr) 32px"
ROW_ID = re.compile(r'<div class="row-grid hd-row" data-id="(H\d+)"')
INLINE = re.compile(r'\sstyle\s*=|\son[a-z]{3,}\s*=|<script', re.IGNORECASE)
OPS = re.compile(r'run\(\s*"([a-z.]+)"')
NOW = datetime(2026, 10, 15, 10, 0, tzinfo=timezone.utc)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def view_model():
    with open(FIXTURE, encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh if line.strip()]
    folded = fold(records, link_state={"task:R7.31": "doing", "job:j599": "done"}, now=NOW)
    accepted = {r["id"] for r in records if r.get("t") == "u" and (r.get("set") or {}).get("accepted")}
    rows = []
    for entry in folded:
        rows.append({
            "id": entry["id"], "kind": entry["kind"], "sum": entry["sum"], "status": entry["status"],
            "age": entry["age_min"], "stale": entry["stale"], "amber": entry["amber"],
            "carried": entry["carried"], "links": entry["links"], "more": 0, "acct": entry["acct"],
            "sid": entry["sid"], "acc": entry["id"] in accepted, "auto": entry["auto_done"],
            "ts": entry.get("ts"),
            "dup": {"id": "H1", "score": 0.72} if entry["id"] == "H4" else None,
            "suggest": ["task:R7.31"] if entry["id"] == "H4" else [],
        })
    return {"pinNow": NOW.isoformat(), "head": {
        "now": {"model": "Opus 5.5", "acct": "B", "since": "09:02 (1h)", "usage": {"h5": 41, "wk": 63}},
        "prev": [{"model": "Opus 5.5", "acct": "A", "until": "08:55"}],
        "counts": {},
        "rows": rows,
        "full": {"id": "H1", "text": "<img src=x onerror=alert(1)> tell opus: very important feature",
                 "history": ["09:12 hook new", "09:13 head triage"],
                 "reply": "Queued for Opus and bound to R7.31.", "assets": ["shot.png", "notes/spec.md"]},
    }}


class HeadSource(unittest.TestCase):
    def setUp(self):
        self.src = read(SOURCE)

    def test_exports_the_screen_and_the_listeners(self):
        for name in ("headHtml", "attachHeadListeners", "hashOf", "FILTERS"):
            self.assertRegex(self.src, r"export (function|const) " + name + r"\b", name)

    def test_text_goes_through_esc_and_never_through_innerhtml(self):
        self.assertNotIn("innerHTML", self.src)
        self.assertNotIn("outerHTML", self.src)
        self.assertNotIn("insertAdjacentHTML", self.src)
        self.assertIn('import { esc } from "../dom.js"', self.src)

    def test_no_inline_markup_or_script(self):
        self.assertIsNone(INLINE.search(self.src))

    def test_only_head_ops_and_the_copy_button_write(self):
        self.assertEqual(sorted(set(OPS.findall(self.src))),
                         ["head.accept", "head.bind", "head.merge", "head.set", "head.split"])

    def test_no_var_or_console_in_the_module(self):
        self.assertIsNone(re.search(r"\bvar\s|\bconsole\.log\b", self.src))

    def test_rows_and_header_share_the_grid_class(self):
        self.assertIn('class="row-grid hd-row"', self.src)
        self.assertNotIn("hd-head", self.src)

    def test_review_and_confirm_actions_exist(self):
        self.assertIn('data-action="head-accept"', self.src)
        self.assertIn('data-action="head-reopen"', self.src)
        self.assertIn("Confirm done", self.src)

    def test_head_set_sends_the_flat_status_the_op_reads(self):
        # headops._h_set reads a top-level status; the view sent {set: {status}} and Reopen, Needs you and Decline
        # failed. The call must be {id, status}.
        self.assertIn('run("head.set", { id: id, status: "open" }', self.src)
        self.assertIn('run("head.set", { id: id, status: status }', self.src)
        self.assertNotRegex(self.src, r"set:\s*\{\s*status")

    def test_header_sits_outside_the_list_and_the_list_holds_only_items(self):
        self.assertIn('<div class="hd-list">', self.src)
        self.assertNotIn("headerHtml", self.src)
        self.assertIn('<ul class="hd-items"', self.src)
        self.assertNotIn("hd-menu", self.src)

    def test_row_toggle_is_a_stretched_button_with_aria_expanded(self):
        self.assertIn('class="hd-hit" data-action="head-toggle"', self.src)
        self.assertIn('aria-expanded="', self.src)
        self.assertIn('data-action="head-expand-all"', self.src)

    def test_text_is_set_with_textcontent_and_the_when_helper_exists(self):
        self.assertIn("pre.textContent = textNote(entry)", self.src)
        self.assertIn("export function whenText(iso, full)", self.src)

    def test_bind_split_merge_menu_and_forms_exist(self):
        for name in ("bind", "split", "merge"):
            self.assertIn('data-form="' + name + '"', self.src)
            self.assertIn('data-op="head.' + name + '"', self.src)

    def test_list_view_is_a_table_with_the_ten_columns_in_order(self):
        self.assertIn('<table class="hd-tbl"', self.src)
        self.assertIn('["#", "hd-n"], ["Kind", "hd-kind"], ["You wrote", "hd-sumc"], ["Head replied", "hd-rpc"],', self.src)
        self.assertIn('["State", "hd-stc"], ["Bound to", "hd-bnd"], ["Age", "hd-age"], ["Added", "hd-when"],', self.src)
        self.assertIn('["Acc", "hd-acc"],', self.src)
        self.assertIn('["Copy", "hd-cp"]];', self.src)
        self.assertIn('<tr class="hd-detail"><td colspan="10">', self.src)

    def test_view_toggle_is_in_the_hash_and_defaults_to_the_list(self):
        self.assertIn('go(el, Object.assign(st, { view: value }))', self.src)
        self.assertIn('const cards = o.view === "cards";', self.src)
        self.assertIn('pick(params.get("view"), ["cards", "list"], 5) || "list"', self.src)

    def test_row_click_toggles_the_list_row_but_not_its_controls(self):
        self.assertIn('closest("tr.hd-row")', self.src)
        self.assertIn('closest("a, button, input, select, textarea, label, form")', self.src)

    def test_no_route_or_nav_wiring_in_this_step(self):
        self.assertNotIn("routes.js", self.src)
        self.assertNotIn("icons.svg", self.src)


class HeadCss(unittest.TestCase):
    def test_head_css_fits_its_budget(self):
        self.assertLessEqual(os.path.getsize(CSS), HEAD_CSS_MAX, "head.css is %d bytes" % os.path.getsize(CSS))

    def test_css_total_stays_under_the_shell_cap(self):
        cap = int(re.search(r"CSS_TOTAL_MAX = (\d+) \* 1024", read(SHELL_TEST)).group(1)) * 1024
        total = sum(os.path.getsize(os.path.join(CSS_DIR, name)) for name in os.listdir(CSS_DIR)
                    if name.endswith(".css"))
        self.assertLessEqual(total, cap, "web/css totals %d bytes" % total)

    def test_ten_fixed_tracks_on_the_shared_grid_and_summary_takes_the_rest(self):
        css = read(CSS)
        self.assertIn(".hd-row.row-grid{position:relative;align-items:center;grid-template-columns:" + TRACKS + "}", css)
        self.assertEqual(len(TRACKS.split(" ")), 4)
        self.assertEqual(TRACKS.split(" ")[2], "minmax(0,1fr)")
        self.assertRegex(css, r"\.hd-meta\{grid-column:2 / -1")

    def test_summary_wraps_to_two_lines_in_every_row(self):
        css = read(CSS)
        self.assertRegex(css, r"\.hd-row \.hd-sum\{[^}]*-webkit-line-clamp:3")
        self.assertNotIn("is-open .hd-sum", css)

    def test_numbers_right_aligned_and_actions_in_fixed_tracks(self):
        css = read(CSS)
        self.assertRegex(css, r"\.hd-age,\.hd-when\{text-align:right;font-variant-numeric:tabular-nums\}")

    def test_phone_turns_rows_into_cards_and_hides_the_header(self):
        css = read(CSS)
        self.assertIn("@media (max-width:599px)", css)
        self.assertRegex(css, r"@media \(max-width:599px\)\{[\s\S]*flex-wrap:wrap")

    def test_list_header_is_sticky_and_the_phone_keeps_summary_and_state_visible(self):
        css = read(CSS)
        self.assertRegex(css, r"\.hd-tbl th\{position:sticky;top:0")
        self.assertIn(".hd-list{flex:1 1 auto;min-height:0;min-width:0;overflow:auto}", css)
        self.assertRegex(css, r"@media \(max-width:599px\)\{[\s\S]*\.hd-kind\{display:none\}")
        self.assertRegex(css, r"\.hd-sumc\{left:72px[^}]*\}\.hd-stc\{left:222px\}")
        self.assertIn("font-variant-numeric:tabular-nums", css)

    def test_list_fills_the_height_and_the_page_has_no_bottom_band(self):
        css = read(CSS)
        self.assertRegex(css, r"\.hd-screen\{display:flex;flex-direction:column;[^}]*height:100%")
        self.assertRegex(css, r"\.hd-list\{flex:1 1 auto;min-height:0;")
        self.assertRegex(css, r"\.main:has\(>\.hd-screen\)\{padding-bottom:0\}")
        self.assertNotRegex(css, r"\.hd-tbl-wrap\{[^}]*border")

    def test_list_rows_are_tight_with_hairline_separators_and_no_outer_box(self):
        css = read(CSS)
        self.assertRegex(css, r"\.hd-tbl th,\.hd-tbl td\{padding:8px 10px;border-bottom:1px solid var\(--line\)")
        self.assertRegex(css, r"\.hd-n\{width:1%;")
        self.assertRegex(css, r"\.hd-age\{width:56px;min-width:56px;text-align:right;white-space:nowrap")
        self.assertRegex(css, r"\.hd-when\{width:112px;min-width:112px;[^}]*white-space:nowrap")
        self.assertRegex(css, r"\.hd-sumc\{width:60%;min-width:150px\}\.hd-rpc\{width:34%")

    def test_bound_column_shows_a_dash_and_the_list_drops_the_carried_icon(self):
        js = read(SOURCE)
        self.assertIn('<span class="hd-none" title="Not bound yet">—</span>', js)
        self.assertNotIn('hd-carried', js.split("function listRowHtml")[1].split("function listHtml")[0])

    def test_no_raw_colour_outside_tokens(self):
        self.assertNotRegex(read(CSS), r"#[0-9a-fA-F]{3,6}\b|rgb\(")


class HeadFixture(unittest.TestCase):
    def test_every_line_is_a_known_record(self):
        with open(FIXTURE, encoding="utf-8") as fh:
            lines = [json.loads(line) for line in fh if line.strip()]
        self.assertGreaterEqual(len(lines), 10)
        for rec in lines:
            self.assertEqual(rec["v"], 1)
            self.assertIn(rec["t"], ("e", "u", "s"))

    def test_one_entry_per_status_the_screen_shows(self):
        rows = {r["id"]: r for r in view_model()["head"]["rows"]}
        self.assertEqual(rows["H4"]["status"], "new")
        self.assertEqual(rows["H5"]["status"], "needs-you")
        self.assertIn("ts", rows["H1"])
        self.assertEqual(rows["H1"]["status"], "doing")
        self.assertEqual(rows["H3"]["status"], "done")
        self.assertTrue(rows["H3"]["acc"])
        self.assertTrue(rows["H7"]["auto"])


class HeadRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="head-view-")
        path = os.path.join(cls.tmp, "vm.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(view_model(), fh)
        proc = subprocess.run(
            [shutil.which("node"), "--experimental-default-type=module", RENDER, WEB, path],
            capture_output=True, text=True, check=False, timeout=60,
        )
        if proc.returncode != 0:
            raise AssertionError("render failed: " + proc.stderr[-800:])
        cls.out = json.loads(proc.stdout)

    def test_each_row_has_eight_cells_and_no_header(self):
        html = self.out["screen"]
        rows = html.count('<li class="hd-item')
        self.assertEqual(rows, 7)
        self.assertEqual(html.count('class="hd-c'), 8 * rows)

    def test_no_session_column_and_no_dash_in_empty_cells(self):
        html = self.out["screen"]
        self.assertNotIn('hd-s"', html)
        self.assertNotIn(">S</span>", html)
        self.assertEqual(re.findall(r'<span class="hd-c[^"]*">–</span>', html), [])

    def test_newest_first_by_default_and_oldest_on_request(self):
        newest = ROW_ID.findall(self.out["screen"])
        oldest = ROW_ID.findall(self.out["oldest"])
        self.assertEqual(len(newest), 7)
        self.assertEqual(newest, list(reversed(oldest)))
        self.assertEqual(newest[0], "H6")
        self.assertEqual(oldest[0], "H7")

    def test_summary_falls_back_to_the_text_when_the_stored_sum_is_a_cut(self):
        html = self.out["shortSum"]
        self.assertIn("very important feature", html)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", html)
        self.assertNotIn("<img src=x", html)

    def test_sort_is_kept_in_the_hash_only_when_oldest(self):
        self.assertEqual(self.out["hashOld"], "#head?f=all&sort=old")
        self.assertEqual(self.out["hashNew"], "#head?f=all")

    def test_no_header_row_and_no_row_outside_the_list(self):
        html = self.out["screen"]
        self.assertNotIn("hd-head", html)
        self.assertNotIn('<li class="row-grid', html)

    def test_added_column_shows_local_time_with_the_iso_title(self):
        html = self.out["screen"]
        match = re.search(r'<span class="hd-c hd-when rg-num" title="([^"]+)">([^<]+)</span>', html)
        self.assertIsNotNone(match)
        self.assertRegex(match.group(2), r"^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}:\d{2}$")
        self.assertRegex(match.group(1), r"^\d{4}-\d{2}-\d{2}T")
        self.assertIn('class="hd-added" title="', self.out["open"])
        self.assertRegex(self.out["open"], r"Added \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}")

    def test_open_row_footer_holds_status_all_chips_and_actions(self):
        html = self.out["open"]
        self.assertIn('<div class="hd-foot"><div class="hd-acts">', html)
        self.assertIn('data-action="head-set" data-id="H1" data-status="needs-you"', html)
        self.assertIn('data-action="head-set" data-id="H1" data-status="declined"', html)
        self.assertIn("Bind...", html)

    def test_whole_row_toggle_has_no_nested_buttons_inside_it(self):
        html = self.out["screen"]
        self.assertIn('<button type="button" class="hd-hit" data-action="head-toggle" data-id="H1"', html)
        self.assertIn('<span class="hd-c hd-chev" aria-hidden="true">', html)

    def test_numbers_and_summary_sit_in_their_own_cells(self):
        html = self.out["screen"]
        self.assertIn('class="hd-c hd-age rg-num hd-amber"', html)
        self.assertIn('<span class="hd-c hd-sum rg-t"', html)

    def test_user_text_is_escaped_not_injected(self):
        html = self.out["open"]
        self.assertNotIn("<img", html)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", html)
        self.assertNotIn("<img", html)
        self.assertNotIn("<script", html)

    def test_head_badge_names_the_model_first_on_the_now_line(self):
        html = self.out["screen"]
        self.assertIn('class="chip chip-success hd-model"', html)
        self.assertIn(">Opus 5.5 · since ", html)
        self.assertIn("acct B", html)

    def test_no_head_claim_says_how_to_claim(self):
        html = self.out["unclaimed"]
        self.assertIn('<span class="chip chip-neutral hd-model hd-badge-off">Head: not claimed (run roadmap head claim)</span>', html)

    def test_alerts_count_unhandled_needs_and_unaccepted_done(self):
        html = self.out["screen"]
        self.assertIn("1 queued", html)
        self.assertIn("1 needs you", html)
        self.assertIn("1 done, not accepted", html)
        self.assertIn('href="#head?f=done"', html)

    def test_done_rows_offer_confirm_and_reopen_in_the_panel(self):
        html = self.out["screen"]
        self.assertIn('data-action="head-accept" data-id="H7"', html)
        self.assertIn('data-action="head-reopen" data-id="H3"', html)
        self.assertIn('done?', html)
        self.assertIn('data-state="done">Done</span>', self.out["done"])

    def test_row_ids_and_copy_refs_use_the_project(self):
        self.assertIn("rb:alpha/ask/H1", self.out["screen"])
        self.assertIn('<a class="chip chip-neutral" href="#/p/alpha/work/i/R7.31" title="task:R7.31">R7.31</a>',
                      self.out["screen"])
        self.assertIn('<span class="hd-c hd-status">', self.out["screen"])

    def test_filter_views_show_only_their_rows(self):
        self.assertEqual(self.out["queue"].count('<li class="hd-item">'), 1)
        self.assertEqual(self.out["done"].count('<li class="hd-item'), 2)
        self.assertEqual(self.out["open"].count('<li class="hd-item'), 5)
        self.assertEqual(self.out["queue"].count('<li class="hd-item'), 1)

    def test_opened_row_has_four_labelled_blocks_in_order(self):
        html = self.out["open"]
        order = [html.index(label) for label in ("You wrote", "Head replied", "State", "Bound to")]
        self.assertEqual(order, sorted(order))
        self.assertIn('<pre class="hd-reply">Queued for Opus and bound to R7.31.</pre>', html)
        self.assertIn('<ul class="hd-assets" data-role="assets">', html)
        self.assertIn('<li class="hd-asset">shot.png</li>', html)
        self.assertIn('<span class="hd-reason">', html)

    def test_reply_placeholder_when_none_was_captured(self):
        self.assertIn("No reply captured yet", self.out["noReply"])

    def test_open_row_expands_and_the_others_stay_hidden(self):
        html = self.out["open"]
        self.assertIn('<li class="hd-item is-open">', html)
        self.assertIn('aria-expanded="true"', html)
        self.assertIn('id="hd-p-H1">', html)
        self.assertIn('id="hd-p-H4" hidden>', html)
        self.assertIn('<p class="hd-hist">09:12 hook new · 09:13 head triage</p>', html)

    def test_read_only_phone_listener_gets_no_write_controls(self):
        html = self.out["readOnly"]
        self.assertNotIn("head-accept", html)
        self.assertNotIn("head-reopen", html)
        self.assertNotIn("head-merge", html)
        self.assertNotIn("head-bind-sug", html)
        self.assertNotIn("head-form", html)
        self.assertNotIn('data-form="', html)
        self.assertNotIn('class="hd-c hd-more"', html)
        self.assertIn("rb:alpha/ask/H1", html)

    def test_empty_state_has_one_sentence_and_one_action(self):
        html = self.out["empty"]
        self.assertIn("Nothing logged yet. Every message you type is logged here.", html)
        self.assertIn('data-action="head-log"', html)
        self.assertNotIn("<li", html)

    def test_no_match_says_so_and_offers_all(self):
        html = self.out["noMatch"]
        self.assertIn("Nothing in this view.", html)
        self.assertIn('href="#head?f=all"', html)

    def test_row_menu_opens_bind_split_and_merge_forms(self):
        html = self.out["screen"]
        for name in ("bind", "split", "merge"):
            self.assertIn('data-action="head-form" data-form="' + name + '" data-id="H1"', html)
        self.assertIn('<form class="hd-form" data-op="head.split" data-id="H1" data-form="split" hidden>', html)
        self.assertIn('name="a" required', html)

    def test_dup_and_bind_suggestions_are_buttons_on_the_row_panel(self):
        html = self.out["screen"]
        self.assertIn('data-action="head-merge" data-id="H4" data-into="H1"', html)
        self.assertIn("Merge into H1 (dup 0.72)", html)
        self.assertIn('data-action="head-bind-sug" data-id="H4" data-ref="task:R7.31"', html)

    def test_list_is_the_default_and_has_one_tbody_per_entry(self):
        html = self.out["listDefault"]
        self.assertIn('<table class="hd-tbl"', html)
        self.assertEqual(html.count("<tbody class=\"hd-item"), 7)
        self.assertNotIn('<li class="hd-item', html)

    def test_list_columns_are_in_order_and_newest_first(self):
        html = self.out["list"]
        heads = re.findall(r'<th scope="col" class="[^"]+">([^<]+)</th>', html)
        self.assertEqual(heads, ["#", "Kind", "You wrote", "Head replied", "State", "Bound to", "Age", "Added", "Acc", "Copy"])
        rows = re.findall(r'<tr class="hd-row" data-id="(H\d+)">', html)
        self.assertEqual(rows, list(reversed(re.findall(r'<tr class="hd-row" data-id="(H\d+)">', self.out["listOldest"]))))
        self.assertEqual(rows[0], "H6")

    def test_list_cells_are_ten_per_row_with_numbers_right_aligned(self):
        html = self.out["list"]
        self.assertEqual(html.count('<tr class="hd-row"'), 7)
        self.assertEqual(html.count('<td colspan="10">'), 7)
        self.assertEqual(len(re.findall(r'<td class="hd-(?:n|kind|sumc|rpc|stc|bnd|age|when|acc|cp)', html)), 7 * 10)
        self.assertRegex(html, r'<td class="hd-age rg-num[^"]*"[^>]*>\d+[mhd]</td>')
        self.assertRegex(html, r'<td class="hd-when rg-num" title="\d{4}-\d{2}-\d{2}T[^"]*">\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}:\d{2}</td>')

    def test_list_row_hit_button_and_detail_panel_match_the_card_view(self):
        html = self.out["listOpen"]
        self.assertIn('<button type="button" class="hd-hit" data-action="head-toggle" data-id="H1" aria-expanded="true"', html)
        self.assertIn('<tbody class="hd-item is-open">', html)
        self.assertIn('<div class="hd-panel" id="hd-p-H1">', html)
        self.assertIn('id="hd-p-H4" hidden>', html)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", html)
        self.assertNotIn("<img", html)
        order = [html.index('<p class="hd-lbl">' + label + "</p>") for label in ("You wrote", "Head replied", "State", "Bound to")]
        self.assertEqual(order, sorted(order))

    def test_list_summary_wraps_and_the_sum_is_the_cell_text(self):
        html = self.out["list"]
        self.assertIn('<span class="hd-sum" data-sum="', html)
        self.assertIn('<td class="hd-acc"><span aria-label="Accepted"', html)

    def test_list_read_only_and_empty_states(self):
        self.assertNotIn("head-accept", self.out["listReadOnly"])
        self.assertNotIn("head-form", self.out["listReadOnly"])
        self.assertIn("Nothing logged yet.", self.out["listEmpty"])
        self.assertNotIn("<table", self.out["listEmpty"])

    def test_cards_view_stays_as_it_was(self):
        self.assertNotIn("<table", self.out["screen"])
        self.assertIn('<li class="hd-item', self.out["screen"])

    def test_view_toggle_links_and_the_hash_keep_the_view(self):
        html = self.out["list"]
        self.assertIn('aria-pressed="true" data-tb-view="list"', html)
        self.assertIn('aria-pressed="false" data-tb-view="cards"', html)
        self.assertIn('data-view="list"', html)
        self.assertIn('data-view="cards"', self.out["screen"])
        self.assertEqual(self.out["hashList"], "#head?f=all&view=list")
        self.assertEqual(self.out["hashCards"], "#head?f=all&view=cards")

    def test_hash_keeps_the_filter_state(self):
        self.assertEqual(self.out["hash"], "#head?f=queue&q=a%20b&kind=bug")


if __name__ == "__main__":
    unittest.main()
