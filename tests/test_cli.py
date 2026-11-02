"""Focused regression tests for cli.py (stdlib unittest only).

Run:  .venv/bin/python -m unittest discover -s tests -t .
"""
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

import cli


class TestSamBound(unittest.TestCase):
    def test_dense_gravel_call_bound(self):
        # First live run: depth-2 recursion exploded 70 patches into 3,913
        # SAM calls (~$9.78). Single-split depth bounds the worst case.
        self.assertLessEqual(cli.max_sam_calls(4000, 3000), 700)


class TestCapPool(unittest.TestCase):
    def _seg(self, box):
        return cli.Segment(box, (0.0, 0.0, 0.0), 0.0, 0.0)

    def test_keeps_highest_z_in_order(self):
        pool = [(self._seg((0, 0, 10, 10)), 1.0, ["color"]),
                (self._seg((0, 0, 20, 20)), 5.0, ["brightness"]),
                (self._seg((0, 0, 30, 30)), 3.0, ["texture"])]
        capped = cli.cap_pool(pool, 2)
        self.assertEqual([z for _, z, _ in capped], [5.0, 3.0])

    def test_top_n_floor_is_one(self):
        pool = [(self._seg((0, 0, 10, 10)), 1.0, ["color"])]
        self.assertEqual(len(cli.cap_pool(pool, 0)), 1)
        self.assertEqual(len(cli.cap_pool([], 300)), 0)


class TestSuppressCovered(unittest.TestCase):
    def _seg(self, box):
        return cli.Segment(box, (0.0, 0.0, 0.0), 0.0, 0.0)

    def test_boundary_drops_at_90_keeps_below(self):
        boxes = [(0, 0, 9, 10),    # keeper: covers 90 of the next box
                 (0, 0, 10, 10),   # exactly 90% covered -> dropped
                 (20, 0, 8, 10),   # keeper: covers 80 of the next box
                 (20, 0, 10, 10)]  # 80% covered -> kept
        self.assertEqual(cli.suppress_covered(boxes), [0, 2, 3])

    def test_union_of_keepers_counts(self):
        # Pairwise max is 45%, but the union covers 90% -> dropped.
        boxes = [(0, 0, 9, 5), (0, 5, 9, 5), (0, 0, 10, 10)]
        self.assertEqual(cli.suppress_covered(boxes), [0, 1])
        # Same shape at 40 + 40 + 9 = 89% -> kept.
        boxes = [(0, 0, 8, 5), (0, 5, 8, 5), (8, 0, 1, 9),
                 (0, 0, 10, 10)]
        self.assertEqual(cli.suppress_covered(boxes), [0, 1, 2, 3])

    def test_rank_order_top_down(self):
        # Fragment listed first survives: nothing outranks it.
        # (Live #0 outranks its whole stone #2 the same way.)
        self.assertEqual(cli.suppress_covered([(0, 0, 59, 26),
                                              (0, 0, 102, 121)]), [0, 1])
        # Whole first, fragment fully inside -> fragment dropped.
        self.assertEqual(cli.suppress_covered([(0, 0, 102, 121),
                                              (10, 10, 59, 26)]), [0])

    def test_degenerate_and_empty(self):
        self.assertEqual(cli.suppress_covered([]), [])
        self.assertEqual(cli.suppress_covered([(0, 0, 0, 10)]), [0])
        self.assertEqual(cli.suppress_covered([(5, 5, 10, 0)]), [0])

    def test_suppress_pool_ranks_and_refills_cap(self):
        stitched = [(self._seg((60, 60, 10, 10)), 2.0, ["texture"]),
                    (self._seg((0, 0, 10, 10)), 4.0, ["color"]),
                    (self._seg((50, 50, 10, 10)), 3.0, ["brightness"]),
                    (self._seg((0, 0, 10, 10)), 5.0, ["color"])]
        kept = cli.suppress_pool(stitched)
        self.assertEqual([z for _, z, _ in kept], [5.0, 3.0, 2.0])
        pool = cli.cap_pool(kept, 3)
        self.assertEqual([z for _, z, _ in pool], [5.0, 3.0, 2.0])

    def test_dry_run_wiring_suppresses_before_cap(self):
        # End-to-end dry run ($0, no API) with outputs redirected to tmp:
        # proves the suppression stage executes inside run_photo.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            with mock.patch.object(cli, "REPORTS", tmp / "reports"), \
                 mock.patch.object(cli, "ANNOTATED", tmp / "annotated"), \
                 mock.patch.object(cli, "DAY1_LOG", tmp / "day1-log.md"):
                cands, annotated, report, _, sent = asyncio.run(
                    cli.run_photo(None, Path("assets/testbed/dry.jpg"),
                                  True, "unittest", 5, [512], None, 1))
                self.assertEqual(sent, 0)
                self.assertLessEqual(len(cands), 5)
                self.assertTrue(report.is_file())
                self.assertTrue(annotated.is_file())
                scores = [c.score for c in cands]
                self.assertEqual(scores, sorted(scores, reverse=True))


class TestTiling(unittest.TestCase):
    def test_covers_whole_photo(self):
        w, h = 4000, 3000
        tiles = cli.tiles_for(w, h)
        covered_w = max(x + pw for x, _y, pw, _ph in tiles)
        covered_h = max(y + ph for _x, y, _pw, ph in tiles)
        self.assertEqual((covered_w, covered_h), (w, h))

    def test_tiles_stay_in_bounds(self):
        for x, y, pw, ph in cli.tiles_for(4000, 3000):
            self.assertGreaterEqual(x, 0)
            self.assertGreaterEqual(y, 0)
            self.assertLessEqual(x + pw, 4000)
            self.assertLessEqual(y + ph, 3000)


class TestDedupe(unittest.TestCase):
    def test_merges_overlap_duplicates(self):
        merged = cli.dedupe_boxes([((0, 0, 100, 100), 1.0),
                                   ((10, 10, 100, 100), 2.0),
                                   ((500, 500, 50, 50), 3.0)])
        self.assertEqual(len(merged), 2)
        box, score, members = merged[0]
        self.assertEqual(box, (0, 0, 110, 110))
        self.assertEqual(score, 2.0)
        self.assertEqual(len(members), 2)


class TestParser(unittest.TestCase):
    def test_top_n_defaults(self):
        args = cli.build_parser().parse_args(["dry.jpg"])
        self.assertEqual(args.top_n, cli.RANK_TOP_N)

    def test_region_scales_defaults(self):
        args = cli.build_parser().parse_args(["dry.jpg"])
        self.assertIsNone(args.region)
        self.assertEqual(args.scales, [cli.PATCH_SIZE])

    def test_region_scales_parsing(self):
        args = cli.build_parser().parse_args(
            ["dry.jpg", "--region", "1305,2175,512,512", "--scales", "512,256"])
        self.assertEqual(args.region, (1305, 2175, 512, 512))
        self.assertEqual(args.scales, [512, 256])


class TestRegionTiling(unittest.TestCase):
    def test_red_tile_at_256(self):
        tiles = cli.tiles_for_region(1305, 2175, 512, 512, size=256)
        self.assertEqual(len(tiles), 9)  # 3x3 with overlap
        for x, y, w, h in tiles:
            self.assertGreaterEqual(x, 1305)
            self.assertGreaterEqual(y, 2175)
            self.assertLessEqual(x + w, 1305 + 512)
            self.assertLessEqual(y + h, 2175 + 512)
        self.assertEqual(max(x + w for x, _y, w, _h in tiles), 1305 + 512)
        self.assertEqual(max(y + h for _x, y, _w, h in tiles), 2175 + 512)


class TestProjection(unittest.TestCase):
    def test_region_projection(self):
        self.assertEqual(cli.project_calls(512, 512, [256]), 9)

    def test_multiscale_projection(self):
        self.assertEqual(cli.project_calls(4000, 3000, [512, 256]), 70 + 266)
        self.assertLessEqual(
            cli.project_calls(4000, 3000, [512, 256]), cli.MAX_SAM_CALLS)


class TestDrySegments(unittest.TestCase):
    def test_tile_size_offset_scale(self):
        img = Image.new("RGB", (600, 600), (128, 128, 128))
        tiles = cli.plan_scale_tiles(600, 600, 256, 1)
        segs = cli.dry_run_segments(img, tiles, offset=(100, 200))
        self.assertEqual(len(segs), 9 * 16)
        self.assertTrue(all(s.scale == "256px" for s in segs))
        for s in segs:
            x, y, w, h = s.box
            self.assertGreaterEqual(x, 100)
            self.assertGreaterEqual(y, 200)
            self.assertLessEqual(x + w, 700)
            self.assertLessEqual(y + h, 800)

    def test_defaults_unchanged(self):
        img = Image.new("RGB", (600, 600), (128, 128, 128))
        tiles = cli.plan_scale_tiles(600, 600, 512, 1)
        segs = cli.dry_run_segments(img, tiles)
        self.assertEqual(len(segs), 4 * 16)
        self.assertTrue(all(s.scale == "512px" for s in segs))


class TestBudgetGate(unittest.TestCase):
    def test_over_budget_makes_zero_calls(self):
        stub = mock.AsyncMock()
        with mock.patch.object(cli, "sam_segment_patch", new=stub):
            with self.assertRaises(RuntimeError):
                asyncio.run(cli.run_photo(
                    mock.sentinel.client,
                    cli.Path("assets/testbed/dry.jpg"),
                    dry_run=False, stamp="test", top_n=300,
                    scales=[64], region=None, phases=1))
        stub.assert_not_called()


class TestPhases(unittest.TestCase):
    def test_two_phase_counts(self):
        self.assertEqual(len(cli.plan_scale_tiles(4000, 3000, 512, 2)), 146)
        self.assertEqual(len(cli.plan_scale_tiles(4000, 3000, 256, 2)), 547)

    def test_no_duplicate_tiles(self):
        for size in (512, 256):
            tiles = cli.plan_scale_tiles(4000, 3000, size, 2)
            boxes = [t for t, _label in tiles]
            self.assertEqual(len(boxes), len(set(boxes)))

    def test_phase_labels(self):
        one = cli.plan_scale_tiles(4000, 3000, 256, 1)
        self.assertEqual({label for _, label in one}, {"256px"})
        two = cli.plan_scale_tiles(4000, 3000, 256, 2)
        self.assertEqual({label for _, label in two},
                         {"256px-p0", "256px-p1"})

    def test_full_run_projection_within_budget(self):
        n = cli.project_calls(4000, 3000, [512, 256], 2)
        self.assertEqual(n, 146 + 547)
        self.assertLessEqual(n, cli.MAX_SAM_CALLS)

    def test_combined_phase_step(self):
        # 2-phase 256 grids interleave starts every ~108px per axis, so a
        # stone split by one grid's seam lands well inside the other's.
        tiles = [t for t, _ in cli.plan_scale_tiles(4000, 3000, 256, 2)]
        for axis in (0, 1):
            starts = sorted({t[axis] for t in tiles})
            step = max(b - a for a, b in zip(starts, starts[1:]))
            self.assertLessEqual(step, 109)

    def test_phase_grids_differ(self):
        # The point of phases: phase-1 starts are offset from phase-0, so
        # stones on phase-0 seams get fresh framings (no universal no-split
        # guarantee exists for diagonal 2-phase grids -- verified 2026-10-29
        # against the run-1 red footprint, whose best 256 tile clips 3px).
        p0 = cli.tiles_for_region(0, 0, 4000, 3000, size=256,
                                  phase_offset=0)
        p1 = cli.tiles_for_region(0, 0, 4000, 3000, size=256,
                                  phase_offset=108)
        self.assertNotEqual(p0, p1)
        self.assertTrue(any(t not in p0 for t in p1))


class TestSplitTrigger(unittest.TestCase):
    """Split behavior with a stubbed SAM call (no network)."""

    def _boxes(self, n):
        return [(5 + i % 200, 5 + (i * 7) % 200, 8, 8) for i in range(n)]

    def _run_photo(self, n_objects):
        img = Image.new("RGB", (600, 600), (128, 128, 128))
        counter, splits = [0], []
        stub = mock.AsyncMock(return_value=self._boxes(n_objects))
        tiles = cli.plan_scale_tiles(600, 600, 512, 1)
        with mock.patch.object(cli, "sam_segment_patch", new=stub):
            segments = asyncio.run(
                cli.sam_segment_photo(None, img, counter, splits, tiles))
        return counter[0], splits, segments

    def test_48_objects_no_split(self):
        # Observed real max; must not trigger (one call per tile).
        calls, splits, segments = self._run_photo(48)
        self.assertEqual(calls, 4)
        self.assertEqual(splits, [])
        self.assertEqual(len(segments), 4 * 48)

    def test_over_trigger_splits_once_and_truncates(self):
        calls, splits, segments = self._run_photo(101)
        actions = [s["action"] for s in splits]
        self.assertEqual(calls, 4 + 4 * 9)  # initial + one level, no deeper
        self.assertEqual(actions.count("split"), 4)
        self.assertEqual(actions.count("truncated"), 4 * 9)
        self.assertEqual(len(segments), 4 * 9 * 101)

    def test_budget_truncates_with_reporting(self):
        img = Image.new("RGB", (600, 600), (128, 128, 128))
        counter, splits = [0], []
        stub = mock.AsyncMock(return_value=self._boxes(101))
        tiles = cli.plan_scale_tiles(600, 600, 512, 1)
        with mock.patch.object(cli, "sam_segment_patch", new=stub), \
                mock.patch.object(cli, "MAX_SAM_CALLS", 10):
            segments = asyncio.run(
                cli.sam_segment_photo(None, img, counter, splits, tiles))
        actions = [s["action"] for s in splits]
        self.assertEqual(counter[0], 10)  # hard bound holds exactly
        self.assertEqual(actions.count("budget_exceeded"), 4)
        # Dropped refinements keep their parent objects: nothing vanishes.
        self.assertEqual(len(segments), 4 * 101 + 6 * 101)


class TestWriteSegments(unittest.TestCase):
    def test_roundtrip_flag_outcomes(self):
        import json
        import tempfile
        from pathlib import Path as P
        segs = [
            cli.Segment((0, 0, 10, 10), (200.0, 50.0, 50.0), 90.0, 3.0,
                        patch=0, source="sam", scale="512px"),
            cli.Segment((20, 20, 10, 10), (150.0, 150.0, 150.0), 150.0, 9.0,
                        patch=0, source="sam", scale="512px"),
        ]
        flagged = [(segs[0], 4.25, ["color"])]
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(cli, "REPORTS", P(tmp) / "runs"):
                path = cli.write_segments("dry.jpg", segs, flagged, "T")
                payload = json.loads(P(path).read_text())
        self.assertEqual(payload["n_segments"], 2)
        first, second = payload["segments"]
        self.assertTrue(first["flagged"])
        self.assertEqual(first["z"], 4.25)
        self.assertEqual(first["triggers"], ["color"])
        self.assertEqual(first["scale"], "512px")
        self.assertFalse(second["flagged"])
        self.assertIsNone(second["z"])
        self.assertEqual(second["triggers"], [])


class TestFlagColor(unittest.TestCase):
    def _bed(self, red=True):
        segs = [cli.Segment((i, 0, 10, 10), (150.0, 140.0, 130.0),
                            140.0, 12.0)
                for i in range(20)]
        if red:
            segs.append(cli.Segment((99, 0, 10, 10), (185.0, 141.0, 129.0),
                                    152.0, 12.0))
        return segs

    def test_red_flags_on_color(self):
        flagged = cli.flag_segments(self._bed(red=True))
        hit = [(s, z, t) for s, z, t in flagged if s.box[0] == 99]
        self.assertEqual(len(hit), 1)
        self.assertIn("color", hit[0][2])
        self.assertGreater(hit[0][1], 2.0)

    def test_uniform_bed_stays_quiet(self):
        flagged = cli.flag_segments(self._bed(red=False))
        self.assertEqual(flagged, [])


class TestProjection(unittest.TestCase):
    PHOTO = Path("assets/testbed/dry.jpg")

    def test_shape_keys(self):
        proj = cli.plan_projection(self.PHOTO, [512], None, 1, 300)
        self.assertEqual(sorted(proj.keys()), [
            "height", "kind", "max_sam_calls", "mode", "phases", "photo",
            "projected_images_sent", "projected_sam_calls",
            "projected_spark_crops", "region", "sam_cap_hit", "scales",
            "top_n", "top_n_cap_hit", "width",
        ])
        self.assertEqual(proj["mode"], "projection")

    def test_dry_defaults_match_tile_plan(self):
        proj = cli.plan_projection(self.PHOTO, [512], None, 1, 300)
        sam = cli.project_calls(4000, 3000, [512], 1)
        self.assertEqual(proj["projected_sam_calls"], sam)
        self.assertEqual(proj["projected_spark_crops"], 300)
        self.assertEqual(proj["projected_images_sent"], sam + 300)
        self.assertEqual((proj["width"], proj["height"]), (4000, 3000))
        self.assertIsNone(proj["region"])
        self.assertFalse(proj["sam_cap_hit"])
        self.assertTrue(proj["top_n_cap_hit"])

    def test_region_restricts_plan(self):
        proj = cli.plan_projection(self.PHOTO, [512], (0, 0, 512, 512), 1, 300)
        sam = cli.project_calls(512, 512, [512], 1)
        self.assertEqual((proj["width"], proj["height"]), (512, 512))
        self.assertEqual(proj["projected_sam_calls"], sam)
        self.assertLess(sam, cli.project_calls(4000, 3000, [512], 1))
        with self.assertRaises(ValueError):
            cli.plan_projection(self.PHOTO, [512], (3900, 0, 512, 512), 1, 300)

    def test_closeup_kind_assesses_one_crop(self):
        proj = cli.plan_projection(self.PHOTO, [512], None, 1, 300, "closeup")
        self.assertEqual(proj["kind"], "closeup")
        self.assertEqual(proj["projected_spark_crops"], 1)
        self.assertFalse(proj["top_n_cap_hit"])
        self.assertEqual(proj["projected_images_sent"],
                         proj["projected_sam_calls"] + 1)

    def test_top_n_sets_spark_figure(self):
        proj = cli.plan_projection(self.PHOTO, [512], None, 1, 50)
        self.assertEqual(proj["projected_spark_crops"], 50)
        self.assertEqual(proj["projected_images_sent"],
                         proj["projected_sam_calls"] + 50)
        proj = cli.plan_projection(self.PHOTO, [512], None, 1, 0)
        self.assertEqual(proj["projected_spark_crops"], 1)

    def test_sam_cap_flags_over_budget(self):
        with mock.patch.object(cli, "MAX_SAM_CALLS", 1):
            proj = cli.plan_projection(self.PHOTO, [512], None, 1, 300)
        self.assertTrue(proj["sam_cap_hit"])
        self.assertEqual(proj["max_sam_calls"], 1)

    def test_scales_expand_plan(self):
        one = cli.plan_projection(self.PHOTO, [512], None, 1, 300)
        two = cli.plan_projection(self.PHOTO, [512, 256], None, 1, 300)
        self.assertEqual(two["projected_sam_calls"],
                         cli.project_calls(4000, 3000, [512, 256], 1))
        self.assertGreater(two["projected_sam_calls"],
                           one["projected_sam_calls"])


class TestCloseup(unittest.TestCase):
    PHOTO = Path("assets/testbed/dry.jpg")
    HARD = {"cleaned": True,
            "tests": [{"tool": "nail", "outcome": "stone_scratches_tool"},
                      {"tool": "glass", "outcome": "tool_scratches_stone"}],
            "range": {"lo": 2.5, "hi": 5.5, "approx": None, "label": "2.5–5.5"}}

    def test_describe_buckets(self):
        d = cli.describe_stats
        self.assertEqual(d((64.0, 224.0, 208.0), 165.0, 3.0),
                         "bright greenish blue, smooth")
        self.assertEqual(d((200.0, 50.0, 50.0), 100.0, 9.0),
                         "mid-tone reddish brown, slightly textured")
        self.assertEqual(d((150.0, 148.0, 152.0), 150.0, 2.0),
                         "pale gray, smooth")
        self.assertEqual(d((210.0, 180.0, 140.0), 175.0, 4.0),
                         "bright tan, smooth")
        self.assertEqual(d((30.0, 28.0, 25.0), 30.0, 15.0),
                         "dark gray, rough")

    def test_describe_never_names_species(self):
        for r in (20.0, 120.0, 220.0):
            for g in (20.0, 120.0, 220.0):
                for b in (20.0, 120.0, 220.0):
                    for bright, tex in ((40.0, 2.0), (150.0, 8.0),
                                        (200.0, 20.0)):
                        desc = cli.describe_stats((r, g, b), bright, tex)
                        self.assertFalse(cli._has_species_word(desc), desc)

    def test_select_nearest_containing(self):
        whole = (0, 0, 100, 100)
        part = (40, 40, 30, 30)
        far = (500, 500, 20, 20)
        self.assertEqual(
            cli.select_focus_box([whole, part, far], [], (55, 55), False),
            part)
        self.assertEqual(
            cli.select_focus_box([whole, part, far], [], (900, 900), False),
            far)

    def test_select_default_prefers_flagged_center(self):
        bg = (0, 0, 1000, 1000)
        stone = (450, 450, 100, 100)
        self.assertEqual(
            cli.select_focus_box([bg, stone], [stone], (500, 500), True),
            stone)
        self.assertEqual(
            cli.select_focus_box([bg, stone], [], (500, 500), True),
            stone)
        with self.assertRaises(RuntimeError):
            cli.select_focus_box([], [], (5, 5), True)

    def test_parse_hardness(self):
        import json
        self.assertEqual(cli.parse_hardness(json.dumps(self.HARD)), self.HARD)
        for bad in ("nope", "[]", "{}",
                    '{"cleaned": "yes", "tests": [], "range": null}',
                    '{"cleaned": true, "tests": [{"tool": "x"}], "range": null}',
                    '{"cleaned": true, "tests": [], "range": {"label": 5}}'):
            with self.assertRaises(ValueError, msg=bad):
                cli.parse_hardness(bad)

    def test_parse_focus(self):
        self.assertEqual(cli.parse_focus("10,20"), (10, 20))
        for bad in ("x", "1,2,3", "-1,5", "1.5,2", ""):
            with self.assertRaises(ValueError, msg=bad):
                cli.parse_focus(bad)

    def test_assess_prompt_carries_evidence_and_bans(self):
        prompt = cli.render_assess_prompt(self.HARD)
        for bit in ("2.5–5.5", "cleaned: yes", "nail: stone_scratches_tool",
                    "contradicting", "This is X", "never a single definitive"):
            self.assertIn(bit, prompt)
        self.assertIn("no hardness data recorded",
                      cli.render_assess_prompt(None))

    def test_parse_assessment_valid(self):
        import json
        reply = json.dumps({
            "description": "bright blue-green oval, smooth",
            "suggestions": [
                {"name": "turquoise",
                 "supporting": ["blue-green color", "hardness fits 5-6"],
                 "contradicting": ["could be dyed howlite"],
                 "next_check": "streak test"},
                {"name": "chrysocolla",
                 "supporting": ["color match"],
                 "contradicting": ["usually softer"],
                 "next_check": "UV check"},
            ],
        })
        desc, sug = cli.parse_assessment(reply, "local words")
        self.assertEqual(desc, "bright blue-green oval, smooth")
        self.assertEqual([s["name"] for s in sug],
                         ["turquoise", "chrysocolla"])

    def test_parse_assessment_degrades_honestly(self):
        desc, sug = cli.parse_assessment("not json{{{", "local words")
        self.assertEqual((desc, sug), ("local words", []))
        desc, _ = cli.parse_assessment(
            '{"description": "looks like quartz", "suggestions": []}',
            "local words")
        self.assertEqual(desc, "local words")
        import json
        reply = json.dumps({
            "description": "gray rock",
            "suggestions": [
                {"name": "This is quartz",
                 "supporting": ["hard"], "contradicting": ["none"],
                 "next_check": "streak"},
                {"name": "feldspar",
                 "supporting": ["color"], "contradicting": [],
                 "next_check": "streak"},
                {"name": "calcite",
                 "supporting": ["soft"], "contradicting": ["still not confirmed"],
                 "next_check": "acid"},
            ],
        })
        _, sug = cli.parse_assessment(reply, "local words")
        self.assertEqual([s["name"] for s in sug], ["calcite"])

    def test_parse_assessment_truncates_to_three(self):
        import json
        item = {"name": "x", "supporting": ["s"], "contradicting": ["c"],
                "next_check": "n"}
        reply = json.dumps({"description": "d",
                            "suggestions": [dict(item) for _ in range(5)]})
        _, sug = cli.parse_assessment(reply, "local words")
        self.assertEqual(len(sug), 3)

    def test_dry_closeup_returns_single_assessment(self):
        before = set(Path("runs/reports").glob("*")) \
            if Path("runs/reports").exists() else set()
        out = asyncio.run(cli.run_closeup(
            None, self.PHOTO, True, (2737, 1755), self.HARD, [512], None, 1))
        self.assertEqual(out["mode"], "closeup_assessment")
        self.assertEqual(out["focus"]["source"], "tap")
        self.assertEqual(out["focus"]["point"], [2737, 1755])
        x, y, w, h = out["stone"]["box"]
        self.assertTrue(x <= 2737 < x + w and y <= 1755 < y + h)
        self.assertEqual(out["suggestions"], [])
        self.assertEqual(out["images_sent"], 0)
        self.assertEqual(out["models"], [])
        self.assertTrue(out["dry_run"])
        self.assertEqual(out["hardness"], self.HARD)
        self.assertFalse(cli._has_species_word(out["stone"]["description"]))
        after = set(Path("runs/reports").glob("*")) \
            if Path("runs/reports").exists() else set()
        self.assertEqual(before, after)

    def test_dry_closeup_default_focus(self):
        out = asyncio.run(cli.run_closeup(
            None, self.PHOTO, True, None, None, [512], None, 1))
        self.assertEqual(out["focus"]["source"], "default")
        self.assertIsNone(out["focus"]["point"])
        self.assertEqual(out["hardness"]["range"], None)

    UNKNOWN = {"cleaned": True,
               "tests": [{"tool": t, "outcome": "no_scratch"}
                         for t in ("nail", "copper", "glass", "steel")],
               "range": None,
               "status": "inconclusive"}

    def test_parse_hardness_inconclusive(self):
        import json
        self.assertEqual(cli.parse_hardness(json.dumps(self.UNKNOWN)),
                         self.UNKNOWN)
        for bad in ('{"cleaned": true, "tests": [], "range": null,'
                    ' "status": "maybe"}',
                    '{"cleaned": true, "tests": [], '
                    '"range": {"label": "2.5–3"}, "status": "inconclusive"}'):
            with self.assertRaises(ValueError, msg=bad):
                cli.parse_hardness(bad)

    def test_assess_prompt_unknown_is_visual_only(self):
        prompt = cli.render_assess_prompt(self.UNKNOWN)
        for bit in ("inconclusive", "visual", "only",
                    "never a single definitive", "This is X"):
            self.assertIn(bit, prompt)
        self.assertNotIn("hardness fit", prompt)

    def test_parse_assessment_visual_only_drops_hardness_cites(self):
        import json
        reply = json.dumps({
            "description": "gray rock",
            "suggestions": [
                {"name": "quartz",
                 "supporting": ["glassy luster", "hardness fits 5-6"],
                 "contradicting": ["could be glass"],
                 "next_check": "streak"},
                {"name": "calcite",
                 "supporting": ["pale color"], "contradicting": ["soft look"],
                 "next_check": "a further scratch test on a fresh spot"},
            ],
        })
        _, sug = cli.parse_assessment(reply, "local words", visual_only=True)
        self.assertEqual([s["name"] for s in sug], ["calcite"])
        _, sug = cli.parse_assessment(reply, "local words")
        self.assertEqual([s["name"] for s in sug], ["quartz", "calcite"])

    def test_dry_closeup_unknown_hardness(self):
        out = asyncio.run(cli.run_closeup(
            None, self.PHOTO, True, None, self.UNKNOWN, [512], None, 1))
        self.assertEqual(out["hardness"]["status"], "inconclusive")
        self.assertIsNone(out["hardness"]["range"])
        self.assertEqual(out["suggestions"], [])
        self.assertIn("Live scan needed", out["note"])
        self.assertEqual(out["images_sent"], 0)

    def test_extract_json_object(self):
        import json
        clean = '{"description": "d", "suggestions": []}'
        self.assertEqual(cli._extract_json_object(clean), json.loads(clean))
        fenced = '```json\n{"description": "d", "suggestions": []}\n```'
        self.assertEqual(cli._extract_json_object(fenced)["description"], "d")
        bare = '```\n{"description": "d", "suggestions": []}\n```'
        self.assertEqual(cli._extract_json_object(bare)["description"], "d")
        wrapped = ('Here is the stone: {"description": "d", '
                   '"suggestions": []} hope this helps.')
        self.assertEqual(cli._extract_json_object(wrapped)["description"], "d")
        two = '{"description": "first", "suggestions": []} trailing ' \
              '{"description": "second", "suggestions": []}'
        self.assertEqual(cli._extract_json_object(two)["description"], "first")
        for bad in ('{"description": "cut off', 'no braces at all', '',
                    '[1, 2]', None, '{"a": }'):
            self.assertIsNone(cli._extract_json_object(bad), msg=repr(bad))

    def test_parse_assessment_fenced_and_prose(self):
        import json
        body = json.dumps({
            "description": "bright blue-green oval, smooth",
            "suggestions": [
                {"name": "turquoise", "supporting": ["blue-green color"],
                 "contradicting": ["could be dyed howlite"],
                 "next_check": "streak test"},
            ],
        })
        for raw in (f'```json\n{body}\n```',
                    f'Sure! Here it is:\n{body}\nLet me know.'):
            desc, sug = cli.parse_assessment(raw, "local words")
            self.assertEqual(desc, "bright blue-green oval, smooth")
            self.assertEqual([s["name"] for s in sug], ["turquoise"])

    def test_parse_assessment_truncated_falls_back(self):
        desc, sug = cli.parse_assessment('{"description": "cut off',
                                         "local words")
        self.assertEqual((desc, sug), ("local words", []))

    def _stub_client(self, content):
        import types

        async def create(**kw):
            return types.SimpleNamespace(
                choices=[types.SimpleNamespace(
                    message=types.SimpleNamespace(content=content))],
                usage=None)

        return types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create)))

    def test_spark_assess_malformed_marks_unreadable(self):
        import json
        from PIL import Image
        img = Image.new("RGB", (64, 64), (120, 120, 120))
        counters = ([0], [0, 0])
        desc, sug, unreadable = asyncio.run(cli.spark_assess(
            self._stub_client("Here is {\"description\": \"cut"),
            img, (0, 0, 64, 64), "local words", self.HARD, *counters))
        self.assertEqual((desc, sug, unreadable), ("local words", [], True))
        self.assertEqual(counters[0], [1])
        body = json.dumps({"description": "gray rock", "suggestions": []})
        desc, sug, unreadable = asyncio.run(cli.spark_assess(
            self._stub_client(f"```json\n{body}\n```"),
            img, (0, 0, 64, 64), "local words", self.HARD, [0], [0, 0]))
        self.assertEqual((desc, sug, unreadable), ("gray rock", [], False))

    def _live_closeup(self, content):
        async def fake_sam(*a, **k):
            return [cli.Segment((x * 700, 1500, 300, 300),
                                (120.0, 120.0, 120.0), 120.0, 2.0)
                    for x in range(6)]

        with mock.patch.object(cli, "sam_segment_photo", new=fake_sam):
            return asyncio.run(cli.run_closeup(
                self._stub_client(content), self.PHOTO, False, (750, 1650),
                self.HARD, [512], None, 1))

    def test_run_closeup_live_unreadable_note(self):
        out = self._live_closeup("absolutely not json")
        self.assertEqual(out["suggestions"], [])
        self.assertEqual(
            out["note"],
            "Live assessment could not be read — "
            "showing local description only.")
        self.assertEqual(out["hardness"], self.HARD)
        self.assertEqual(out["spark_images"], 1)
        self.assertFalse(cli._has_species_word(out["stone"]["description"]))

    def test_run_closeup_live_stage_error(self):
        async def boom(*a, **k):
            raise RuntimeError("socket closed")

        with mock.patch.object(cli, "sam_segment_photo", new=boom):
            with self.assertRaises(RuntimeError) as ctx:
                asyncio.run(cli.run_closeup(
                    self._stub_client("{}"), self.PHOTO, False, (750, 1650),
                    self.HARD, [512], None, 1))
        msg = str(ctx.exception)
        self.assertIn("SAM segmentation", msg)
        self.assertIn("no images sent", msg)

    def test_sam_progress_goes_to_stderr(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from unittest import mock

        async def fake_patch(client, img):
            return [(10, 10, 100, 100)]

        with Image.open(self.PHOTO) as im:
            img = im.copy()
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cli, "sam_segment_patch", new=fake_patch):
            with redirect_stdout(out), redirect_stderr(err):
                segs = asyncio.run(cli.sam_segment_photo(
                    None, img, [0], [],
                    [((0, 0, 512, 512), "512px"),
                     ((512, 0, 512, 512), "512px")]))
        self.assertEqual(len(segs), 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("sam: 2 patches", err.getvalue())
        self.assertIn("sam: done", err.getvalue())


if __name__ == "__main__":
    unittest.main()
