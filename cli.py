#!/usr/bin/env python3
"""Gem Finder — Day 1 batch CLI.

Single-frame inference over static gravel photos: tile, segment, flag
bed-deviants, rank candidates, write an annotated overlay + JSON report.

Live model paths (SAM 3.1 segmentation, Muse Spark ranking) follow the
official Meta Model API cookbook shapes exactly; --dry-run exercises
tiling + local stats + outputs with zero API calls.

Usage:
    python cli.py <photo> [--pair dry.jpg splash.jpg] [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# ---------------------------------------------------------------- config

PATCH_SIZE = 512          # approved starting value (spec section 7)
OVERLAP_FRAC = 0.15       # approved starting value (spec section 7)
SAM_MODEL = "sam-3.1"
SPARK_MODEL = "muse-spark-1.3"   # approved
META_BASE_URL = "https://api.meta.ai/v1"
API_KEY_ENV = "MODEL_API_KEY"    # environment only; never hardcoded/printed
SAM_CONCEPT = "stone"            # approved noun prompt; logged as sam_prompt
MIN_SPLIT_SIZE = 128      # never split patches at or below this (px)
MAX_SPLIT_DEPTH = 1       # single split level; depth-2 recursion exploded
                          # 70 patches into 3,913 calls on dense gravel
SPLIT_TRIGGER = 100       # split a patch only past this many objects. SAM's
                          # image path returns complete sets (observed max 48),
                          # so the 16-object multiplex figure must not trigger.
MAX_SAM_CALLS = 700       # hard per-photo SAM budget; refinement past it keeps
                          # parent objects and reports budget_exceeded
SAM_CONCURRENCY = 8       # parallel SAM patch requests
SPARK_CONCURRENCY = 4     # parallel Spark ranking requests
REQUEST_TIMEOUT = 600.0   # seconds per API request
RANK_TOP_N = 300          # default cap on ranked candidates (--top-n)
CROP_MARGIN_FRAC = 0.25   # context margin around a candidate box for Spark
SPARK_BATCH = 16          # max crops per ranking request
MATCH_RADIUS_FRAC = 0.05  # dry<->wet match radius, fraction of photo width
WET_BOOST = 0.1           # score bump when wet_score > dry_score
SUPPRESS_COVER_NUM = 9    # drop a candidate this covered by kept ...
SUPPRESS_COVER_DEN = 10   # ... higher-ranked boxes (9/10 = 90%)

# Recall-leaning flagging: flag when any stat's robust z exceeds Z. A false
# positive costs picking up a boring rock; a false negative costs walking
# past the good one. Tightened 1.5 -> 2.0 after the first live run flagged
# 28% of segments; the top-N rank cap (not this threshold) is the spend control.
# Color is scored in chromaticity (hue separated from brightness): euclidean
# RGB distance can't see a red stone in a bed whose own span is wider than
# the stone's deviation (verified on probe data 2026-10-29).
FLAG_THRESHOLDS = {
    "z": 2.0,
    "brightness_floor": 8.0,
    "texture_floor": 1.0,
    "color_floor": 0.02,
    "color_metric": "chromaticity",
}

RUNS = Path("runs")
ANNOTATED = RUNS / "annotated"
REPORTS = RUNS / "reports"
DAY1_LOG = RUNS / "day1-log.md"
TESTBED = Path("assets/testbed")

WORTH_IT = "candidate \u2014 worth picking up"  # only allowed verdict wording


@dataclass
class Segment:
    box: tuple[int, int, int, int]  # x, y, w, h in full-photo pixels
    color: tuple[float, float, float]
    brightness: float
    texture: float
    patch: int = 0
    source: str = "sam"  # "sam" or "cell" (dry-run grid cell)
    scale: str = "512px"  # tile size of the scale pass that produced it


@dataclass
class Candidate:
    id: int
    box: tuple[int, int, int, int]
    score: float
    reason: str
    dry_score: float | None = None
    wet_score: float | None = None
    scale: str = "512px"


# ---------------------------------------------------------------- tiling

def _axis_starts(dim: int, size: int, stride: int,
                 offset: int = 0) -> list[int]:
    if dim <= size:
        return [0]
    starts = {0}
    s = offset
    while s <= dim - size:
        starts.add(s)
        s += stride
    starts.add(dim - size)
    return sorted(starts)


def tiles_for_region(x0: int, y0: int, w: int, h: int,
                     size: int = PATCH_SIZE,
                     overlap: float = OVERLAP_FRAC,
                     phase_offset: int = 0,
                     ) -> list[tuple[int, int, int, int]]:
    """Tiles covering a region; edge tiles shift back so nothing is clipped."""
    stride = max(1, int(size * (1 - overlap)))
    out = []
    for y in _axis_starts(h, min(size, h), stride, phase_offset):
        for x in _axis_starts(w, min(size, w), stride, phase_offset):
            pw, ph = min(size, w - x), min(size, h - y)
            out.append((x0 + x, y0 + y, pw, ph))
    return out


def plan_scale_tiles(w: int, h: int, tile_size: int,
                     phases: int) -> list[tuple[tuple[int, int, int, int], str]]:
    """Ordered unique (tile, scale label) list across phase-shifted grids.

    Phase grids share edges, so exact-duplicate tiles are dropped: every
    planned tile is one SAM call, no pixels paid for twice. Single source
    of truth for project_calls() and the live loop, so the projection
    always equals actual spend (absent splits).
    """
    stride = max(1, int(tile_size * (1 - OVERLAP_FRAC)))
    seen: set[tuple[int, int, int, int]] = set()
    out: list[tuple[tuple[int, int, int, int], str]] = []
    for p in range(phases):
        label = f"{tile_size}px" if phases == 1 else f"{tile_size}px-p{p}"
        for tile in tiles_for_region(0, 0, w, h, size=tile_size,
                                     phase_offset=p * stride // phases):
            if tile not in seen:
                seen.add(tile)
                out.append((tile, label))
    return out


def tiles_for(w: int, h: int) -> list[tuple[int, int, int, int]]:
    return tiles_for_region(0, 0, w, h)


def max_sam_calls(w: int, h: int) -> int:
    """Upper bound on SAM calls for a photo if every patch saturates.

    Drives the cost guard in tests: dense gravel saturates nearly every
    patch, so this bound (not the patch count) predicts the SAM bill.
    """
    total = [0]

    def count(pw: int, ph: int, depth: int) -> None:
        total[0] += 1
        if depth < MAX_SPLIT_DEPTH and min(pw, ph) > MIN_SPLIT_SIZE:
            sub = max(MIN_SPLIT_SIZE, min(pw, ph) // 2)
            n = len(tiles_for_region(0, 0, pw, ph, size=sub))
            for _ in range(n):
                count(sub, sub, depth + 1)

    for (_px, _py, pw, ph) in tiles_for(w, h):
        count(pw, ph, 0)
    return total[0]


def project_calls(w: int, h: int, scales: list[int],
                  phases: int = 1) -> int:
    """Projected SAM calls for a photo/region with no splits firing.

    Printed before any spend; live runs refuse to start past MAX_SAM_CALLS.
    """
    return sum(len(plan_scale_tiles(w, h, s, phases)) for s in scales)


def plan_projection(photo: Path, scales: list[int],
                    region: tuple[int, int, int, int] | None,
                    phases: int, top_n: int, kind: str = "bed") -> dict:
    """$0 spend projection for one photo. Reads dimensions only; no API calls,
    no ranking, no writes. Bed Spark figure is the top-N cap: every observed
    pool overflows it (440-835 stitched vs 300), so the cap binds every live
    run. Close-up assesses one stone: exactly 1 Spark crop, never capped."""
    with Image.open(photo) as im:
        w, h = im.width, im.height
    if region is not None:
        rx, ry, rw, rh = region
        if rx < 0 or ry < 0 or rw < 1 or rh < 1 \
                or rx + rw > w or ry + rh > h:
            raise ValueError(
                f"region {list(region)} outside {photo.name} ({w}x{h})")
        w, h = rw, rh
    sam = project_calls(w, h, scales, phases)
    spark = 1 if kind == "closeup" else max(1, top_n)
    return {
        "mode": "projection",
        "kind": kind,
        "photo": photo.name,
        "width": w,
        "height": h,
        "scales": [f"{s}px" for s in scales],
        "phases": phases,
        "region": list(region) if region else None,
        "top_n": top_n,
        "projected_sam_calls": sam,
        "max_sam_calls": MAX_SAM_CALLS,
        "sam_cap_hit": sam > MAX_SAM_CALLS,
        "projected_spark_crops": spark,
        "top_n_cap_hit": kind == "bed",
        "projected_images_sent": sam + spark,
    }


# ---------------------------------------------------------------- stats

def crop_stats(arr: np.ndarray, gray: np.ndarray,
               box: tuple[int, int, int, int]) -> tuple[tuple[float, float, float], float, float]:
    x, y, w, h = box
    crop = arr[y:y + h, x:x + w]
    g = gray[y:y + h, x:x + w].astype(np.float32)
    gy, gx = np.gradient(g)
    texture = float(np.mean(np.hypot(gx, gy)))
    mean = crop.reshape(-1, 3).mean(axis=0)
    return (float(mean[0]), float(mean[1]), float(mean[2])), float(g.mean()), texture


def bed_median(segments: list[Segment]) -> dict[str, np.ndarray | float]:
    colors = np.array([s.color for s in segments], dtype=np.float64)
    brights = np.array([s.brightness for s in segments])
    textures = np.array([s.texture for s in segments])
    totals = colors.sum(axis=1, keepdims=True)
    totals[totals == 0] = 1.0  # pure black -> uniform chromaticity
    chroma = colors / totals
    med_chroma = np.median(chroma, axis=0)
    return {
        "color": np.median(colors, axis=0),
        "brightness": float(np.median(brights)),
        "texture": float(np.median(textures)),
        "chroma_dists": np.linalg.norm(chroma - med_chroma, axis=1),
        "brights": brights,
        "textures": textures,
    }


def _mad(values: np.ndarray, med: float) -> float:
    return float(np.median(np.abs(values - med)))


def flag_segments(segments: list[Segment]) -> list[tuple[Segment, float, list[str]]]:
    """Flag segments deviating from the bed median. Returns (segment, max z, triggers)."""
    if not segments:
        return []
    bed = bed_median(segments)
    z_cut = FLAG_THRESHOLDS["z"]
    b_scale = max(_mad(bed["brights"], bed["brightness"]) * 1.4826,
                  FLAG_THRESHOLDS["brightness_floor"])
    t_scale = max(_mad(bed["textures"], bed["texture"]) * 1.4826,
                  FLAG_THRESHOLDS["texture_floor"])
    c_dists = bed["chroma_dists"]
    c_scale = max(_mad(c_dists, float(np.median(c_dists))) * 1.4826,
                  FLAG_THRESHOLDS["color_floor"])
    flagged = []
    for k, seg in enumerate(segments):
        zb = abs(seg.brightness - bed["brightness"]) / b_scale
        zt = abs(seg.texture - bed["texture"]) / t_scale
        zc = float(c_dists[k]) / c_scale  # direct: hue deviation itself
        triggers = [name for name, z in
                    (("brightness", zb), ("texture", zt), ("color", zc)) if z > z_cut]
        if triggers:
            flagged.append((seg, max(zb, zt, zc), triggers))
    return flagged


# ---------------------------------------------------------------- stitch

def iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    if ix == 0 or iy == 0:
        return 0.0
    inter = ix * iy
    return inter / (aw * ah + bw * bh - inter)


def dedupe_boxes(items: list[tuple[tuple[int, int, int, int], float]],
                 thresh: float = 0.5,
                 ) -> list[tuple[tuple[int, int, int, int], float,
                                 list[tuple[int, int, int, int]]]]:
    """Merge same-object boxes duplicated by tile overlap (greedy union).

    Returns (merged box, max score, member boxes) per group."""
    remaining = sorted(items, key=lambda it: it[0][2] * it[0][3], reverse=True)
    merged = []
    while remaining:
        box, score = remaining.pop(0)
        x, y, w, h = box
        members = [box]
        keep = []
        for obox, oscore in remaining:
            if iou((x, y, w, h), obox) > thresh:
                ox, oy, ow, oh = obox
                x, y = min(x, ox), min(y, oy)
                w, h = max(x + w, ox + ow) - x, max(y + h, oy + oh) - y
                score = max(score, oscore)
                members.append(obox)
            else:
                keep.append((obox, oscore))
        remaining = keep
        merged.append(((x, y, w, h), score, members))
    return merged


def _union_cover(box: tuple[int, int, int, int],
                 keepers: list[tuple[int, int, int, int]]) -> int:
    """Area of box covered by the union of keeper boxes (exact x-slab sweep)."""
    slabs: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for k in keepers:
        x0 = max(box[0], k[0])
        x1 = min(box[0] + box[2], k[0] + k[2])
        if x1 > x0:
            slabs.setdefault((x0, x1), []).append(
                (max(box[1], k[1]), min(box[1] + box[3], k[1] + k[3])))
    xs = sorted({e for x0, x1 in slabs for e in (x0, x1)})
    cover = 0
    for i in range(len(xs) - 1):
        lo, hi = xs[i], xs[i + 1]
        if hi <= lo:
            continue
        segs = sorted(s for (x0, x1), ss in slabs.items()
                      if x0 <= lo and hi <= x1 for s in ss)
        cur0 = cur1 = None
        tot = 0
        for a0, a1 in segs:
            if a1 <= a0:
                continue
            if cur0 is None:
                cur0, cur1 = a0, a1
            elif a0 <= cur1:
                cur1 = max(cur1, a1)
            else:
                tot += cur1 - cur0
                cur0, cur1 = a0, a1
        if cur0 is not None:
            tot += cur1 - cur0
        cover += tot * (hi - lo)
    return cover


def suppress_covered(boxes: list[tuple[int, int, int, int]]) -> list[int]:
    """Top-down overlap suppression. Walk boxes in rank order and keep a box
    unless >=90% of its area falls inside the union of kept higher-ranked
    boxes. Returns kept indices in rank order; comparison is exact integer
    math, so the 90% boundary is deterministic."""
    kept: list[int] = []
    for i, box in enumerate(boxes):
        w, h = box[2], box[3]
        if w < 1 or h < 1:
            kept.append(i)  # degenerate box: keep what we cannot measure
            continue
        cover = _union_cover(box, [boxes[k] for k in kept])
        if cover * SUPPRESS_COVER_DEN >= w * h * SUPPRESS_COVER_NUM:
            continue
        kept.append(i)
    return kept


def suppress_pool(stitched: list[tuple[Segment, float, list[str]]]
                  ) -> list[tuple[Segment, float, list[str]]]:
    """Rank the stitched pool by z and suppress covered duplicates top-down.
    Runs before the top-N cap so freed slots refill from the next candidates."""
    ranked = sorted(stitched, key=lambda item: item[1], reverse=True)
    return [ranked[i]
            for i in suppress_covered([seg.box for seg, _, _ in ranked])]


# Species names may appear ONLY in the close-up suggestions panel, never in
# bed reasons, descriptions, or list labels. The scrubber enforces this on
# every free-text field the close-up path emits outside that panel.
SPECIES_WORDS = frozenset({
    "quartz", "agate", "jasper", "amethyst", "opal", "onyx", "granite",
    "marble", "basalt", "obsidian", "feldspar", "mica", "calcite",
    "turquoise", "sapphire", "ruby", "emerald", "diamond", "crystal",
    "mineral", "species", "peridot", "garnet",
})

DEFINITIVE_CLAIM = re.compile(
    r"\bthis is\b|\bit is\b|\bdefinitely\b|\bcertain(?:ly|ty)?\b", re.IGNORECASE)

# Explicit hardness citations in a suggestion's claimed fit (name +
# supporting). Backstop for visual-only assessments; the prompt carries the
# subtler cases (scratch verbs, softer/harder comparisons).
HARDNESS_CITE = re.compile(
    r"hardness|\bmohs?\b|\bfits?\b.{0,12}\d|\d+(?:\.\d+)?\s*[-\u2013]\s*\d+",
    re.IGNORECASE)


def _has_confirmed(text: str) -> bool:
    scrubbed = re.sub(r"not confirmed", "", text, flags=re.IGNORECASE)
    return re.search(r"\bconfirmed\b", scrubbed, re.IGNORECASE) is not None


def _has_species_word(text: str) -> bool:
    words = re.findall(r"[a-z]+", text.lower())
    return any(w in SPECIES_WORDS for w in words)


def describe_stats(color: tuple[float, float, float],
                   brightness: float, texture: float) -> str:
    """Local color/texture/brightness wording. Species-free by construction."""
    r, g, b = color
    gray = max(color) - min(color) < 12
    if gray:
        hue = "pale gray" if brightness >= 150 else \
            "dark gray" if brightness < 60 else "gray"
    elif r >= g and r >= b:
        if r - b > 60 and brightness >= 140:
            hue = "tan"
        elif r - g > 25:
            hue = "reddish brown"
        else:
            hue = "brown"
    elif g >= r and g >= b:
        hue = "greenish blue" if b > r + 20 else "greenish"
    else:
        hue = "bluish green" if g > r + 20 else "bluish"
    if brightness < 60:
        tone = "dark"
    elif brightness < 120:
        tone = "mid-tone"
    elif brightness < 180:
        tone = "bright"
    else:
        tone = "very bright"
    if texture < 5:
        feel = "smooth"
    elif texture < 12:
        feel = "slightly textured"
    else:
        feel = "rough"
    if gray:
        return f"{hue}, {feel}"
    return f"{tone} {hue}, {feel}"


def select_focus_box(all_boxes: list[tuple[int, int, int, int]],
                     flagged_boxes: list[tuple[int, int, int, int]],
                     point: tuple[int, int],
                     prefer_flagged: bool) -> tuple[int, int, int, int]:
    """The single close-up box: the containing box whose center is nearest
    the point (flagged first when preferred, smaller breaks ties), else the
    nearest centroid overall."""
    if not all_boxes:
        raise RuntimeError("close-up found no segments; retake closer")
    flagged = set(flagged_boxes)
    px, py = point

    def inside(b):
        x, y, w, h = b
        return x <= px < x + w and y <= py < y + h

    def key(b):
        cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        return (cx - px) ** 2 + (cy - py) ** 2, b[2] * b[3]

    containing = [b for b in all_boxes if inside(b)]
    pool = containing or all_boxes
    if prefer_flagged:
        pool = sorted(pool, key=lambda b: (b not in flagged, *key(b)))
    else:
        pool = sorted(pool, key=key)
    return pool[0]


SCRATCH_OUTCOMES = frozenset({
    "stone_scratches_tool", "tool_scratches_stone", "no_scratch",
})


def parse_hardness(text: str) -> dict:
    """Validate the guided-hardness payload (PWA sends it with the scan)."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        raise ValueError("hardness must be a JSON object")
    if not isinstance(data, dict):
        raise ValueError("hardness must be a JSON object")
    cleaned = data.get("cleaned")
    if cleaned is not None and not isinstance(cleaned, bool):
        raise ValueError("hardness.cleaned must be true/false/null")
    tests = data.get("tests")
    if not isinstance(tests, list):
        raise ValueError("hardness.tests must be a list")
    for t in tests:
        if not isinstance(t, dict) or not isinstance(t.get("tool"), str) \
                or t.get("outcome") not in SCRATCH_OUTCOMES:
            raise ValueError("hardness.tests entries need {tool, outcome}")
    rng = data.get("range")
    if rng is not None:
        if not isinstance(rng, dict) or not isinstance(rng.get("label"), str):
            raise ValueError("hardness.range needs {label, ...}")
        for k in ("lo", "hi", "approx"):
            v = rng.get(k)
            if v is not None and not isinstance(v, (int, float)):
                raise ValueError(f"hardness.range.{k} must be numeric/null")
    status = data.get("status")
    if status is not None and status != "inconclusive":
        raise ValueError("hardness.status must be 'inconclusive' or absent")
    if status == "inconclusive" and rng is not None:
        raise ValueError("inconclusive hardness carries no range")
    parsed = {"cleaned": cleaned, "tests": tests, "range": rng}
    if status is not None:
        parsed["status"] = status
    return parsed


def parse_focus(text: str) -> tuple[int, int]:
    """Raw full-photo pixel coords of the user tap, as 'X,Y'."""
    try:
        x, y = (int(v) for v in text.split(","))
    except (ValueError, AttributeError):
        raise ValueError("focus must be raw pixel coords as 'X,Y'")
    if x < 0 or y < 0:
        raise ValueError("focus must be raw pixel coords as 'X,Y'")
    return x, y


# ---------------------------------------------------------------- dry-run

def dry_run_segments(img: Image.Image,
                     tiles: list[tuple[tuple[int, int, int, int], str]],
                     offset: tuple[int, int] = (0, 0)) -> list[Segment]:
    """Exhaustive 4x4 grid cells per patch with local stats. Zero API calls."""
    arr = np.asarray(img.convert("RGB")).astype(np.float32)
    gray = np.asarray(img.convert("L"))
    ox, oy = offset
    segments = []
    for i, ((px, py, pw, ph), scale) in enumerate(tiles):
        cw, ch = max(1, pw // 4), max(1, ph // 4)
        for gy in range(4):
            for gx in range(4):
                x, y = px + gx * cw, py + gy * ch
                w = (px + pw - x) if gx == 3 else cw
                h = (py + ph - y) if gy == 3 else ch
                if w <= 0 or h <= 0:
                    continue
                color, bright, tex = crop_stats(arr, gray, (x, y, w, h))
                segments.append(Segment((x + ox, y + oy, w, h), color, bright,
                                        tex, patch=i, source="cell",
                                        scale=scale))
    return segments


# ---------------------------------------------------------------- live: SAM

async def _stream_events(stream):
    """Cookbook lane shim: the API streams response.content_part.done but not
    response.output_text.done, which the parser uses to close a lane."""
    completed = set()
    async for event in stream:
        data = event.model_dump() if hasattr(event, "model_dump") else dict(event)
        lane = (data.get("item_id"), data.get("output_index"),
                data.get("content_index"))
        if data.get("type") == "response.output_text.done":
            if lane not in completed:
                completed.add(lane)
                yield data
            continue
        yield data
        part = data.get("part")
        if (data.get("type") == "response.content_part.done"
                and lane not in completed
                and isinstance(part, dict)
                and part.get("type") == "output_text"
                and isinstance(part.get("text"), str)):
            completed.add(lane)
            yield {"type": "response.output_text.done",
                   "item_id": data.get("item_id"),
                   "output_index": data.get("output_index"),
                   "content_index": data.get("content_index"),
                   "text": part["text"]}


def _pil_to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


async def sam_segment_patch(client, patch: Image.Image) -> list[tuple[int, int, int, int]]:
    """One SAM pass over a patch. Returns boxes in patch-pixel coordinates.

    Box coordinate space verified 2026-10-28: overlay boxes land exactly
    on their stones, so cookbook record values are patch pixels as assumed.
    """
    from contextlib import aclosing

    from meta_sam_parser import image_segmentation_format, parse_responses_stream

    stream = await client.responses.create(
        model=SAM_MODEL,
        stream=True,
        input=[{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": SAM_CONCEPT},
            {"type": "input_image", "image_url": _pil_to_data_url(patch)},
        ]}],
    )
    async with stream, aclosing(_stream_events(stream)) as events:
        parsed = parse_responses_stream(events, image_segmentation_format())
        async with parsed:
            result = await parsed.final_result()
    if result.outcome.status != "completed":
        raise RuntimeError(f"SAM segmentation incomplete: {result.outcome.status} "
                           f"({getattr(result.outcome, 'reason', 'unknown')})")
    errors = [d for d in result.diagnostics if d.severity == "error"]
    if errors:
        msgs = "; ".join(f"line {d.line}: {d.message}" for d in errors)
        raise RuntimeError(f"SAM parser rejected records: {msgs}")
    boxes = []
    for record in result.records:
        if record.kind != "box":
            continue
        left, top = int(record.left), int(record.top)
        w, h = int(record.right - record.left), int(record.bottom - record.top)
        if w > 0 and h > 0:
            boxes.append((left, top, w, h))
    return boxes


async def sam_segment_photo(client, img: Image.Image, sam_counter: list[int],
                            splits: list[dict],
                            tiles: list[tuple[tuple[int, int, int, int], str]],
                            offset: tuple[int, int] = (0, 0)) -> list[Segment]:
    """Segment every planned patch concurrently; split saturated patches ONCE,
    then accept-and-report truncation. Dense gravel saturates even small
    patches, so unbounded recursion explodes call volume instead of
    resolving it."""
    arr = np.asarray(img.convert("RGB")).astype(np.float32)
    gray = np.asarray(img.convert("L"))
    ox, oy = offset
    patches = [t for t, _label in tiles]
    labels = [label for _t, label in tiles]
    sem = asyncio.Semaphore(SAM_CONCURRENCY)

    def full_box(bx: int, by: int, bw: int, bh: int) -> list[int]:
        return [bx + ox, by + oy, bw, bh]

    def to_segments(px: int, py: int,
                    boxes: list[tuple[int, int, int, int]],
                    patch_id: int, label: str) -> list[Segment]:
        segs = []
        for (lx, ly, lw, lh) in boxes:
            x, y = px + lx, py + ly
            w = min(lw, img.width - x)
            h = min(lh, img.height - y)
            if w <= 0 or h <= 0:
                continue
            color, bright, tex = crop_stats(arr, gray, (x, y, w, h))
            segs.append(Segment((x + ox, y + oy, w, h), color, bright, tex,
                                patch=patch_id, source="sam", scale=label))
        return segs

    async def fetch(tile: tuple[int, int, int, int]):
        px, py, pw, ph = tile
        async with sem:
            sam_counter[0] += 1
            n = sam_counter[0]
            boxes = await sam_segment_patch(
                client, img.crop((px, py, px + pw, py + ph)))
        if n % 50 == 0:
            print(f"  sam: {n} calls, {len(splits)} splits",
                  flush=True, file=sys.stderr)
        return boxes

    print(f"  sam: {len(patches)} patches ({img.width}x{img.height})",
          flush=True, file=sys.stderr)
    phase1 = await asyncio.gather(*(fetch(t) for t in patches))
    results: list[list[Segment]] = []
    children: list[tuple[int, tuple[int, int, int, int], str]] = []
    parents: dict[int, tuple[tuple[int, int, int, int],
                             list[tuple[int, int, int, int]]]] = {}
    for i, ((px, py, pw, ph), boxes, label) in enumerate(
            zip(patches, phase1, labels)):
        if len(boxes) > SPLIT_TRIGGER and min(pw, ph) > MIN_SPLIT_SIZE:
            splits.append({"patch": i, "objects": len(boxes),
                           "box": full_box(px, py, pw, ph), "action": "split",
                           "scale": label})
            parents[i] = ((px, py, pw, ph), boxes)
            sub_size = max(MIN_SPLIT_SIZE, min(pw, ph) // 2)
            for sub in tiles_for_region(px, py, pw, ph, size=sub_size):
                children.append((i, sub, label))
            results.append([])
        else:
            if len(boxes) > SPLIT_TRIGGER:
                splits.append({"patch": i, "objects": len(boxes),
                               "box": full_box(px, py, pw, ph),
                               "action": "truncated", "scale": label,
                               "note": "past trigger below split size; kept all "
                                       "returned objects"})
            results.append(to_segments(px, py, boxes, i, label))
    if children:
        allowed = MAX_SAM_CALLS - sam_counter[0]
        if allowed < len(children):
            kept = children[:max(0, allowed)]
            dropped = sorted({i for i, _, _ in children[max(0, allowed):]})
            for i in dropped:
                (px, py, pw, ph), boxes = parents[i]
                splits.append({"patch": i, "objects": len(boxes),
                               "box": full_box(px, py, pw, ph),
                               "action": "budget_exceeded",
                               "scale": labels[i],
                               "note": f"refinement skipped past {MAX_SAM_CALLS} "
                                       "SAM-call budget; kept parent objects"})
                results[i].extend(to_segments(px, py, boxes, i, labels[i]))
            children = kept
        n_split = sum(1 for s in splits if s["action"] == "split")
        print(f"  sam: {len(children)} sub-patches from {n_split} splits",
              flush=True, file=sys.stderr)
        child_boxes = await asyncio.gather(*(fetch(t) for _, t, _ in children))
        for (i, (px, py, pw, ph), label), boxes in zip(children, child_boxes):
            if len(boxes) > SPLIT_TRIGGER:
                splits.append({"patch": i, "objects": len(boxes),
                               "box": full_box(px, py, pw, ph),
                               "action": "truncated", "scale": label,
                               "note": "past trigger at single-split floor; kept "
                                       "all returned objects"})
            results[i].extend(to_segments(px, py, boxes, i, label))
    splits.sort(key=lambda s: (s["patch"], s["action"], str(s["box"])))
    total = sum(len(r) for r in results)
    print(f"  sam: done, {sam_counter[0]} calls, {total} segments, "
          f"{len(splits)} split events", flush=True, file=sys.stderr)
    return [s for r in results for s in r]


# ---------------------------------------------------------------- live: Spark

SPARK_INSTRUCTIONS = (
    "These crops are rock candidates from a gravel bed photo; each crop shows "
    "one candidate plus its surrounding bed. Score how strongly each candidate "
    "stands out from the surrounding bed (color, texture, brightness, shape): "
    "0.0 = looks like ordinary bed gravel, 1.0 = unmistakably different. "
    "Give one short reason per candidate: why this one stands out. "
    f"End every reason with the exact words '{WORTH_IT}'. "
    "Never name a mineral, species, or gemstone variety: visual difference only."
)

SPARK_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "score": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["id", "score", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["candidates"],
    "additionalProperties": False,
}


def candidate_crop(img: Image.Image,
                   box: tuple[int, int, int, int]) -> Image.Image:
    """Candidate box plus a context margin of surrounding bed."""
    x, y, w, h = box
    mx, my = int(w * CROP_MARGIN_FRAC), int(h * CROP_MARGIN_FRAC)
    return img.crop((max(0, x - mx), max(0, y - my),
                     min(img.width, x + w + mx), min(img.height, y + h + my)))


async def spark_rank(client, img: Image.Image,
                     flagged: list[tuple[Segment, float, list[str]]],
                     spark_counter: list[int],
                     token_counter: list[int]) -> list[Candidate]:
    """Rank flagged segments from per-candidate crops. Structured JSON out."""
    if not flagged:
        return []
    sem = asyncio.Semaphore(SPARK_CONCURRENCY)
    ids = list(range(len(flagged)))
    crops = [candidate_crop(img, seg.box) for seg, _, _ in flagged]
    batches = [(ids[i:i + SPARK_BATCH], crops[i:i + SPARK_BATCH])
               for i in range(0, len(crops), SPARK_BATCH)]

    async def rank_batch(bi: int, batch):
        b_ids, b_crops = batch
        content: list[dict] = [{"type": "text", "text": SPARK_INSTRUCTIONS}]
        for cid, crop in zip(b_ids, b_crops):
            spark_counter[0] += 1
            content.append({"type": "text", "text": f"candidate {cid}:"})
            content.append({"type": "image_url",
                            "image_url": {"url": _pil_to_data_url(crop)}})
        async with sem:
            resp = await client.chat.completions.create(
                model=SPARK_MODEL,
                messages=[{"role": "user", "content": content}],
                response_format={"type": "json_schema",
                                 "json_schema": {"name": "rank",
                                                 "schema": SPARK_SCHEMA}},
            )
        usage = getattr(resp, "usage", None)
        if usage is not None:
            token_counter[0] += int(getattr(usage, "prompt_tokens", 0) or 0)
            token_counter[1] += int(getattr(usage, "completion_tokens", 0) or 0)
        print(f"  spark: batch {bi + 1}/{len(batches)}", flush=True)
        payload = json.loads(resp.choices[0].message.content or "{}")
        out: dict[int, tuple[float, str]] = {}
        for item in payload.get("candidates", []):
            try:
                out[int(item["id"])] = (
                    max(0.0, min(1.0, float(item["score"]))),
                    str(item["reason"]))
            except (KeyError, TypeError, ValueError):
                continue
        return out

    ranked: dict[int, tuple[float, str]] = {}
    for part in await asyncio.gather(
            *(rank_batch(bi, b) for bi, b in enumerate(batches))):
        ranked.update(part)
    out = []
    for cid, (seg, zmax, triggers) in enumerate(flagged):
        if cid in ranked:
            score, reason = ranked[cid]
        else:  # never silently drop: keep the local flag, report the gap
            score = min(0.99, zmax / 5)
            reason = (f"Spark returned no score; local flag ({', '.join(triggers)}) "
                      f"\u2014 {WORTH_IT}")
        out.append(Candidate(cid, seg.box, round(score, 3), reason))
    return out


def live_client():
    from openai import AsyncOpenAI

    key = os.environ.get(API_KEY_ENV)
    if not key:
        raise RuntimeError(
            f"Live mode needs {API_KEY_ENV} in the environment "
            f"(--dry-run needs no key).")
    return AsyncOpenAI(base_url=META_BASE_URL, api_key=key,
                         timeout=REQUEST_TIMEOUT)


# ---------------------------------------------------------------- close-up

SPARK_ASSESS_TEMPLATE = (
    "You are shown one stone plus context. First describe ONLY what you see: "
    "color, texture, brightness words. Never name a mineral, species, or "
    "gemstone variety in the description. "
    "Then suggest up to 3 possible identities, best fit first, using the look "
    "and this hardness evidence: {hardness}. "
    "Each suggestion needs supporting features (visual + hardness fit), at "
    "least one contradicting or uncertain feature, and one next check "
    "(streak, UV, or a further scratch test). "
    "Possible identities only, never a single definitive claim: never write "
    "'This is X', 'definitely', 'confirmed', or 'certain'. "
    "If unsure, return zero suggestions."
)

SPARK_ASSESS_UNKNOWN_TEMPLATE = (
    "You are shown one stone plus context. First describe ONLY what you see: "
    "color, texture, brightness words. Never name a mineral, species, or "
    "gemstone variety in the description. "
    "Then suggest up to 3 possible identities, best fit first, from visual "
    "features only. Hardness context: {hardness}. "
    "Each suggestion needs supporting visual features only (never a hardness "
    "feature, never a hardness range), at least one contradicting or "
    "uncertain feature, and one next check (a careful retest on a fresh "
    "spot, streak, or UV). "
    "Possible identities only, never a single definitive claim: never write "
    "'This is X', 'definitely', 'confirmed', or 'certain'. "
    "Uncertainty is high without hardness: if unsure, return zero suggestions."
)

ASSESS_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "suggestions": {
            "type": "array",
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "supporting": {"type": "array", "items": {"type": "string"}},
                    "contradicting": {"type": "array", "items": {"type": "string"}},
                    "next_check": {"type": "string"},
                },
                "required": ["name", "supporting", "contradicting", "next_check"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["description", "suggestions"],
    "additionalProperties": False,
}


def render_hardness_summary(hardness: dict | None) -> str:
    """One-line hardness evidence for the assessment prompt."""
    if not hardness:
        return "no hardness data recorded"
    cleaned = hardness.get("cleaned")
    cleaned_bit = (
        f"cleaned: {'yes' if cleaned else 'no' if cleaned is False else 'unknown'}")
    tests = hardness.get("tests", [])
    if hardness.get("status") == "inconclusive":
        bits = ["hardness inconclusive: the scratch test gave no usable result",
                cleaned_bit]
        bits.extend(f"{t['tool']}: {t['outcome']}" for t in tests)
        return "; ".join(bits)
    if not hardness.get("range"):
        return "no hardness data recorded"
    rng = hardness["range"]
    bits = [f"hardness {rng['label']}", cleaned_bit]
    bits.extend(f"{t['tool']}: {t['outcome']}" for t in tests)
    return "; ".join(bits)


def render_assess_prompt(hardness: dict | None) -> str:
    if hardness and hardness.get("status") == "inconclusive":
        return SPARK_ASSESS_UNKNOWN_TEMPLATE.format(
            hardness=render_hardness_summary(hardness))
    return SPARK_ASSESS_TEMPLATE.format(
        hardness=render_hardness_summary(hardness))


def _definitive(text: str) -> bool:
    return DEFINITIVE_CLAIM.search(text) is not None or _has_confirmed(text)


UNREADABLE_NOTE = ("Live assessment could not be read — "
                   "showing local description only.")

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def _balanced_spans(text: str) -> list[str]:
    """Brace-balanced {...} spans in order. String-aware, so braces inside
    quoted description text do not end the span early."""
    spans = []
    n = len(text)
    i = 0
    while i < n:
        if text[i] != "{":
            i += 1
            continue
        depth, instr, esc, j = 0, False, False, i
        while j < n:
            ch = text[j]
            if instr:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    instr = False
            elif ch == '"':
                instr = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    spans.append(text[i:j + 1])
                    break
            j += 1
        i += 1
    return spans


def _extract_json_object(text: str | None) -> dict | None:
    """First valid JSON object: raw body, fenced block, or prose-wrapped."""
    if not isinstance(text, str):
        return None
    cands = [text]
    cands.extend(m.group(1) for m in _FENCE.finditer(text))
    cands.extend(_balanced_spans(text))
    for cand in cands:
        try:
            obj = json.loads(cand.strip())
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


def parse_assessment(text: str, local_desc: str,
                     visual_only: bool = False) -> tuple[str, list[dict]]:
    """Parse one assessment reply. Anything off-format degrades honestly:
    description falls back to local stats, bad suggestions are dropped.
    Visual-only (unknown hardness) also drops any suggestion whose claimed
    fit cites hardness."""
    payload = _extract_json_object(text)
    if payload is None:
        return local_desc, []
    desc = payload.get("description")
    if not isinstance(desc, str) or not desc.strip() \
            or _has_species_word(desc) or _definitive(desc):
        desc = local_desc
    else:
        desc = desc.strip()
    suggestions = []
    items = payload.get("suggestions")
    if not isinstance(items, list):
        return desc, []
    for item in items[:3]:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        supporting = item.get("supporting")
        contradicting = item.get("contradicting")
        nxt = item.get("next_check")
        if not isinstance(name, str) or not 0 < len(name.split()) <= 6:
            continue
        if not isinstance(supporting, list) or not supporting \
                or not all(isinstance(s, str) and s.strip() for s in supporting):
            continue
        if not isinstance(contradicting, list) or not contradicting \
                or not all(isinstance(s, str) and s.strip() for s in contradicting):
            continue
        if not isinstance(nxt, str) or not nxt.strip():
            continue
        joined = " ".join([name, *supporting, *contradicting, nxt])
        if _definitive(joined):
            continue
        if visual_only and HARDNESS_CITE.search(" ".join([name, *supporting])):
            continue
        suggestions.append({
            "name": " ".join(name.split()),
            "supporting": [" ".join(s.split()) for s in supporting],
            "contradicting": [" ".join(s.split()) for s in contradicting],
            "next_check": " ".join(nxt.split()),
        })
    return desc, suggestions


async def spark_assess(client, img: Image.Image,
                       box: tuple[int, int, int, int],
                       local_desc: str, hardness: dict | None,
                       spark_counter: list[int],
                       token_counter: list[int]
                       ) -> tuple[str, list[dict], bool]:
    """One focused stone, one assessment call. Structured JSON out.

    Returns (description, suggestions, unreadable): unreadable is True only
    when the reply held no valid JSON object at all, so the caller can say
    so honestly instead of silently showing local stats."""
    content: list[dict] = [
        {"type": "text", "text": render_assess_prompt(hardness)},
        {"type": "image_url",
         "image_url": {"url": _pil_to_data_url(candidate_crop(img, box))}},
    ]
    spark_counter[0] += 1
    resp = await client.chat.completions.create(
        model=SPARK_MODEL,
        messages=[{"role": "user", "content": content}],
        response_format={"type": "json_schema",
                         "json_schema": {"name": "assess",
                                         "schema": ASSESS_SCHEMA}},
    )
    usage = getattr(resp, "usage", None)
    if usage is not None:
        token_counter[0] += int(getattr(usage, "prompt_tokens", 0) or 0)
        token_counter[1] += int(getattr(usage, "completion_tokens", 0) or 0)
    print("  spark: close-up assessment", flush=True, file=sys.stderr)
    raw = resp.choices[0].message.content
    if _extract_json_object(raw) is None:
        print(f"  close-up: assessment unreadable "
              f"({len(raw or '')} chars); raw reply follows",
              flush=True, file=sys.stderr)
        print(raw, flush=True, file=sys.stderr)
        return local_desc, [], True
    visual_only = bool(hardness and hardness.get("status") == "inconclusive")
    desc, suggestions = parse_assessment(raw, local_desc,
                                         visual_only=visual_only)
    return desc, suggestions, False


def _live_err(stage: str, sam_counter: list[int],
              spark_counter: list[int], cause: Exception) -> RuntimeError:
    """Stage-specific close-up failure with honest images-sent accounting."""
    sent = sam_counter[0] + spark_counter[0]
    sent_bit = f"{sent} images sent" if sent else "no images sent"
    return RuntimeError(f"close-up failed during {stage} ({sent_bit}): {cause}")


async def run_closeup(client, photo: Path, dry_run: bool,
                      focus: tuple[int, int] | None,
                      hardness: dict | None,
                      scales: list[int],
                      region: tuple[int, int, int, int] | None,
                      phases: int) -> dict:
    """Single-stone close-up assessment. Segments the photo, focuses ONE stone
    (user tap, else a deviant center segment), and assesses only it. Fileless:
    the assessment dict is the whole output; nothing is written."""
    img = Image.open(photo)
    if region is not None:
        rx, ry, rw, rh = region
        if rx < 0 or ry < 0 or rw < 1 or rh < 1 \
                or rx + rw > img.width or ry + rh > img.height:
            raise ValueError(
                f"region {list(region)} outside {photo.name} "
                f"({img.width}x{img.height})")
        work = img.crop((rx, ry, rx + rw, ry + rh))
        offset = (rx, ry)
    else:
        work = img
        offset = (0, 0)
    if focus is not None and not (
            0 <= focus[0] < img.width and 0 <= focus[1] < img.height):
        raise ValueError(f"focus {list(focus)} outside {photo.name} "
                         f"({img.width}x{img.height})")
    if focus is not None and region is not None and not (
            rx <= focus[0] < rx + rw and ry <= focus[1] < ry + rh):
        raise ValueError(f"focus {list(focus)} outside region {list(region)}")
    sam_counter = [0]
    spark_counter = [0]
    spark_tokens = [0, 0]
    splits: list[dict] = []
    projection = project_calls(work.width, work.height, scales, phases)
    print(f"  projected SAM calls: {projection} (budget {MAX_SAM_CALLS})",
          flush=True, file=sys.stderr)
    if not dry_run and projection > MAX_SAM_CALLS:
        raise RuntimeError(
            f"projected {projection} SAM calls exceed the {MAX_SAM_CALLS} "
            "per-photo budget; stopping before spending")
    segments: list[Segment] = []
    plans = [(ts, plan_scale_tiles(work.width, work.height, ts, phases))
             for ts in scales]
    if dry_run:
        for _ts, tiles in plans:
            segments.extend(dry_run_segments(work, tiles, offset=offset))
    else:
        assert client is not None
        try:
            for ts, tiles in plans:
                print(f"  scale {ts}px: {len(tiles)} patches", flush=True,
                      file=sys.stderr)
                segments.extend(await sam_segment_photo(
                    client, work, sam_counter, splits, tiles, offset=offset))
        except Exception as e:
            raise _live_err("SAM segmentation", sam_counter,
                            spark_counter, e) from e
        if not segments:
            sent = sam_counter[0] + spark_counter[0]
            raise RuntimeError(
                f"close-up found no segments after SAM ({sent} images "
                f"sent); retake closer")
    flagged = flag_segments(segments)
    all_boxes = [s.box for s in segments]
    flagged_boxes = [s.box for s, _, _ in flagged]
    cx, cy = offset[0] + work.width // 2, offset[1] + work.height // 2
    if focus is not None:
        box = select_focus_box(all_boxes, flagged_boxes, focus, False)
        source = "tap"
    else:
        box = select_focus_box(all_boxes, flagged_boxes, (cx, cy), True)
        source = "default"
    arr = np.asarray(img.convert("RGB")).astype(np.float32)
    gray = np.asarray(img.convert("L"))
    color, bright, tex = crop_stats(arr, gray, box)
    local_desc = describe_stats(color, bright, tex)
    hard = hardness or {"cleaned": None, "tests": [], "range": None}
    if dry_run:
        desc, suggestions = local_desc, []
        note = "Live scan needed for possible identities."
    else:
        assert client is not None
        try:
            desc, suggestions, unreadable = await spark_assess(
                client, img, box, local_desc, hard, spark_counter,
                spark_tokens)
        except Exception as e:
            raise _live_err("Spark assessment", sam_counter,
                            spark_counter, e) from e
        note = UNREADABLE_NOTE if unreadable else ""
    sent = sam_counter[0] + spark_counter[0]
    print(f"{photo.name}: close-up {box} source={source}, "
          f"{sent} images sent "
          f"(sam {sam_counter[0]} + spark {spark_counter[0]})",
          file=sys.stderr)
    return {
        "mode": "closeup_assessment",
        "photo": photo.name,
        "width": img.width,
        "height": img.height,
        "focus": {"point": list(focus) if focus else None, "source": source},
        "stone": {
            "box": list(box),
            "description": desc,
            "stats": {"color": [round(v, 1) for v in color],
                      "brightness": round(bright, 1),
                      "texture": round(tex, 2)},
        },
        "hardness": hard,
        "suggestions": [{"rank": i + 1, **s} for i, s in enumerate(suggestions)],
        "note": note,
        "dry_run": dry_run,
        "images_sent": sent,
        "sam_images": sam_counter[0],
        "spark_images": spark_counter[0],
        "spark_tokens": {"input": spark_tokens[0], "output": spark_tokens[1]},
        "models": [SAM_MODEL, SPARK_MODEL] if sent else [],
        "splits": splits,
    }


# ---------------------------------------------------------------- pair

def _center(box: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, w, h = box
    return x + w / 2, y + h / 2


def match_pairs(dry: list[Candidate], wet: list[Candidate],
                width: int) -> list[tuple[Candidate | None, Candidate | None]]:
    """Greedy nearest-center matching (fixed-spot shooting keeps frames close)."""
    radius = width * MATCH_RADIUS_FRAC
    unmatched = list(wet)
    pairs: list[tuple[Candidate | None, Candidate | None]] = []
    for d in dry:
        dx, dy = _center(d.box)
        best, best_dist = None, radius
        for w in unmatched:
            wx, wy = _center(w.box)
            dist = ((dx - wx) ** 2 + (dy - wy) ** 2) ** 0.5
            if dist < best_dist:
                best, best_dist = w, dist
        if best is not None:
            unmatched.remove(best)
        pairs.append((d, best))
    for w in unmatched:
        pairs.append((None, w))
    return pairs


def apply_pair_scores(pairs: list[tuple[Candidate | None, Candidate | None]],
                      dry: list[Candidate], wet: list[Candidate]) -> None:
    """Fill dry_score/wet_score on both sides; boost wet risers in place."""
    for d, w in pairs:
        if d is not None and w is not None:
            d.dry_score, d.wet_score = d.score, w.score
            w.dry_score, w.wet_score = d.score, w.score
            if w.score > d.score:  # splash boost for risers
                w.score = round(min(1.0, w.score + WET_BOOST), 3)
        elif d is not None:
            d.dry_score, d.wet_score = d.score, None
        elif w is not None:
            w.dry_score, w.wet_score = None, w.score


# ---------------------------------------------------------------- outputs

def annotate(img: Image.Image, candidates: list[Candidate], out: Path) -> None:
    marked = img.convert("RGB").copy()
    draw = ImageDraw.Draw(marked)
    for cand in candidates:
        x, y, w, h = cand.box
        draw.rectangle([x, y, x + w, y + h], outline="red", width=3)
        label = str(cand.id)
        tx, ty = x + 4, max(0, y - 16)
        draw.rectangle([tx - 2, ty, tx + 12, ty + 15], fill="red")
        draw.text((tx, ty), label, fill="white")
    out.parent.mkdir(parents=True, exist_ok=True)
    marked.save(out, "JPEG", quality=92)


def write_pool(photo_name: str, segments: list[Segment],
               stitched: list[tuple[Segment, float, list[str]]],
               ranked_boxes: set[tuple[int, int, int, int]],
               dry_run: bool, top_n: int, stamp: str, tag: str = "") -> Path:
    """Persist the pre-top-N stitched pool so a dropped stone traces to
    segmentation vs flagging vs top-N cut without another paid run."""
    local = {c.box: (c.score, c.reason)
             for c in local_rank(stitched, dry_run)}
    bed = bed_median(segments) if segments else None
    payload = {
        "photo": photo_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "bed": None if bed is None else {
            "color": [float(v) for v in bed["color"]],
            "brightness": float(bed["brightness"]),
            "texture": float(bed["texture"])},
        "flag_thresholds": FLAG_THRESHOLDS,
        "pool_size": len(stitched),
        "rank_top_n": top_n,
        "pool": [{
            "box": list(seg.box),
            "z": round(z, 3),
            "triggers": triggers,
            "scale": seg.scale,
            "local_score": local[seg.box][0],
            "local_reason": local[seg.box][1],
            "stats": {
                "color": [round(v, 1) for v in seg.color],
                "brightness": round(seg.brightness, 1),
                "texture": round(seg.texture, 2)},
            "ranked": seg.box in ranked_boxes,
        } for seg, z, triggers in stitched],
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"{Path(photo_name).stem}{tag}.{stamp}.pool.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def write_segments(photo_name: str, segments: list[Segment],
                   flagged: list[tuple[Segment, float, list[str]]],
                   stamp: str, tag: str = "") -> Path:
    """Persist every pre-flag segment with its flag outcome, so a miss
    traces to segmentation (no segment) vs flagging (z below cut)."""
    flag_by_box = {seg.box: (z, triggers) for seg, z, triggers in flagged}
    payload = {
        "photo": photo_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "n_segments": len(segments),
        "segments": [{
            "box": list(s.box),
            "stats": {
                "color": [round(v, 1) for v in s.color],
                "brightness": round(s.brightness, 1),
                "texture": round(s.texture, 2)},
            "patch": s.patch,
            "source": s.source,
            "scale": s.scale,
            "flagged": s.box in flag_by_box,
            "z": (round(flag_by_box[s.box][0], 3)
                  if s.box in flag_by_box else None),
            "triggers": (flag_by_box[s.box][1]
                         if s.box in flag_by_box else []),
        } for s in segments],
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"{Path(photo_name).stem}{tag}.{stamp}.segments.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def write_report(photo_name: str, latency_ms: int, candidates: list[Candidate],
                 sam_images: int, spark_images: int, spark_tokens: tuple[int, int],
                 flagged_count: int, rank_top_n: int, pool_file: str,
                 scales: list[int], region: list[int] | None, phases: int,
                 segments_file: str,
                 splits: list[dict], stamp: str, tag: str = "") -> Path:
    report = {
        "photo": photo_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "latency_ms": latency_ms,
        "patch_size": f"{scales[0]}px",
        "scales": [f"{s}px" for s in scales],
        "region": region,
        "phases": phases,
        "overlap": f"{OVERLAP_FRAC:.0%}",
        "flag_thresholds": FLAG_THRESHOLDS,
        "sam_prompt": SAM_CONCEPT,
        "candidates": [
            {"id": c.id, "box": list(c.box), "score": c.score,
             "reason": c.reason, "dry_score": c.dry_score,
             "wet_score": c.wet_score, "scale": c.scale}
            for c in candidates
        ],
        "models": [SAM_MODEL, SPARK_MODEL] if sam_images + spark_images else [],
        "images_sent": sam_images + spark_images,
        "sam_images": sam_images,
        "spark_images": spark_images,
        "spark_tokens": {"input": spark_tokens[0], "output": spark_tokens[1]},
        "flagged_count": flagged_count,
        "rank_top_n": rank_top_n,
        "split_trigger": SPLIT_TRIGGER,
        "pool_file": pool_file,
        "segments_file": segments_file,
        "splits": splits,
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"{Path(photo_name).stem}{tag}.{stamp}.json"
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return path


def append_log(photo_name: str, latency_ms: int, report: Path) -> None:
    RUNS.mkdir(parents=True, exist_ok=True)
    if not DAY1_LOG.exists():
        DAY1_LOG.write_text(
            "| timestamp | photo | latency_ms | recall | false_positives | report |\n"
            "| --- | --- | --- | --- | --- | --- |\n", encoding="utf-8")
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with DAY1_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"| {stamp} | {photo_name} | {latency_ms} | TBD "
                 f"| TBD | {report.name} |\n")


# ---------------------------------------------------------------- run

def cap_pool(pool: list[tuple[Segment, float, list[str]]],
             top_n: int) -> list[tuple[Segment, float, list[str]]]:
    """Keep the top_n flagged segments by deviation z.

    Spend control: ranking costs per candidate, flagging is free local
    compute, so the cap binds here rather than at the flag threshold.
    """
    return sorted(pool, key=lambda item: item[1], reverse=True)[:max(1, top_n)]


def local_rank(flagged: list[tuple[Segment, float, list[str]]],
               dry_run: bool) -> list[Candidate]:
    out = []
    for cid, (seg, zmax, triggers) in enumerate(flagged):
        score = round(min(0.99, zmax / 5), 3)
        tag = "dry-run: " if dry_run else ""
        reason = (f"{tag}{', '.join(triggers)} deviate from bed median "
                  f"\u2014 {WORTH_IT}"
                  + (" (local stats only, no model call)" if dry_run else ""))
        out.append(Candidate(cid, seg.box, score, reason, scale=seg.scale))
    return out


async def run_photo(client, photo: Path, dry_run: bool,
                    stamp: str, top_n: int,
                    scales: list[int], region: tuple[int, int, int, int] | None,
                    phases: int,
                    ) -> tuple[list[Candidate], Path, Path, int, int]:
    started = time.monotonic()
    img = Image.open(photo)
    if region is not None:
        rx, ry, rw, rh = region
        if rx < 0 or ry < 0 or rw < 1 or rh < 1 \
                or rx + rw > img.width or ry + rh > img.height:
            raise RuntimeError(
                f"region {list(region)} outside {photo.name} "
                f"({img.width}x{img.height})")
        work = img.crop((rx, ry, rx + rw, ry + rh))
        offset = (rx, ry)
    else:
        work = img
        offset = (0, 0)
    sam_counter = [0]
    spark_counter = [0]
    spark_tokens = [0, 0]  # prompt, completion
    splits: list[dict] = []
    projection = project_calls(work.width, work.height, scales, phases)
    print(f"  projected SAM calls: {projection} (budget {MAX_SAM_CALLS})",
          flush=True)
    if not dry_run and projection > MAX_SAM_CALLS:
        raise RuntimeError(
            f"projected {projection} SAM calls exceed the {MAX_SAM_CALLS} "
            "per-photo budget; stopping before spending")
    segments: list[Segment] = []
    plans = [(ts, plan_scale_tiles(work.width, work.height, ts, phases))
             for ts in scales]
    if dry_run:
        for _ts, tiles in plans:
            segments.extend(dry_run_segments(work, tiles, offset=offset))
    else:
        assert client is not None
        for ts, tiles in plans:
            print(f"  scale {ts}px: {len(tiles)} patches", flush=True)
            segments.extend(await sam_segment_photo(
                client, work, sam_counter, splits, tiles, offset=offset))
    flagged = flag_segments(segments)
    # Stitch: merge duplicates from tile overlap before ranking.
    by_box = {seg.box: (seg, z, t) for seg, z, t in flagged}
    stitched: list[tuple[Segment, float, list[str]]] = []
    for box, z, members in dedupe_boxes([(seg.box, z) for seg, z, _ in flagged]):
        triggers = sorted({t for m in members for t in by_box[m][2]})
        if len(members) == 1:
            seg = by_box[members[0]][0]
        else:  # union of duplicates: recompute stats over the union
            arr = np.asarray(img.convert("RGB")).astype(np.float32)
            gray = np.asarray(img.convert("L"))
            color, bright, tex = crop_stats(arr, gray, box)
            member_scales = sorted({by_box[m][0].scale for m in members})
            seg = Segment(box, color, bright, tex,
                          source=segments[0].source if segments else "cell",
                          scale="+".join(member_scales))
        stitched.append((seg, z, triggers))
    suppressed = suppress_pool(stitched)
    pool = cap_pool(suppressed, top_n)
    print(f"  flagged {len(flagged)} -> stitched {len(stitched)} "
          f"-> kept {len(suppressed)} -> ranking top {len(pool)}", flush=True)
    if dry_run:
        candidates = local_rank(pool, dry_run=True)
    else:
        assert client is not None
        candidates = await spark_rank(client, img, pool, spark_counter,
                                      spark_tokens)
        for c, (seg, _, _) in zip(candidates, pool):
            c.box = seg.box
            c.scale = seg.scale
    # Re-number by descending score for a ranked overlay.
    candidates.sort(key=lambda c: c.score, reverse=True)
    for i, c in enumerate(candidates):
        c.id = i
    latency_ms = int((time.monotonic() - started) * 1000)
    tag = (f".region-{rx}-{ry}-{rw}-{rh}" if region is not None else "")
    annotated = ANNOTATED / f"{photo.stem}{tag}.annotated.jpg"
    annotate(img, candidates, annotated)
    pool_path = write_pool(photo.name, segments, stitched,
                           {seg.box for seg, _, _ in pool},
                           dry_run, top_n, stamp, tag)
    segments_path = write_segments(photo.name, segments, flagged, stamp, tag)
    report = write_report(photo.name, latency_ms, candidates,
                          sam_counter[0], spark_counter[0],
                          (spark_tokens[0], spark_tokens[1]),
                          len(stitched), top_n, pool_path.name,
                          scales, list(region) if region else None, phases,
                          segments_path.name, splits, stamp, tag)
    log_name = photo.name if region is None else \
        f"{photo.name} region={rx},{ry},{rw},{rh}"
    append_log(log_name, latency_ms, report)
    sent = sam_counter[0] + spark_counter[0]
    where = f"region {list(region)} " if region is not None else ""
    print(f"{photo.name}: {where}{len(segments)} segments, "
          f"{len(flagged)} flagged, {len(candidates)} candidates, "
          f"{sent} images sent "
          f"(sam {sam_counter[0]} + spark {spark_counter[0]})")
    if spark_counter[0]:
        print(f"  spark tokens: {spark_tokens[0]} in / {spark_tokens[1]} out")
    print(f"  annotated: {annotated}")
    print(f"  report:    {report}")
    print(f"  pool:      {pool_path}")
    print(f"  segments:  {segments_path}")
    if splits:
        print(f"  splits:    {len(splits)} patch split events (see report)")
    return candidates, annotated, report, latency_ms, sent


def resolve_photo(name: str) -> Path:
    direct = Path(name)
    if direct.is_file():
        return direct
    bed = TESTBED / name
    if bed.is_file():
        return bed
    raise FileNotFoundError(f"No such photo: {name} (also tried {bed})")


async def amain(args: argparse.Namespace) -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if args.closeup:
        client = None if args.dry_run else live_client()
        try:
            assessment = await run_closeup(
                client, resolve_photo(args.photo), args.dry_run, args.focus,
                args.hardness, args.scales, args.region, args.phases)
        except Exception as e:
            msg = str(e)
            if not msg.startswith("close-up"):
                msg = f"close-up failed: {msg}"
            print(msg, file=sys.stderr)
            return 1
        finally:
            if client is not None:
                await client.close()
        print(json.dumps(assessment, indent=2))
        return 0
    if args.pair:
        dry_path = resolve_photo(args.pair[0])
        wet_path = resolve_photo(args.pair[1])
        client = None if args.dry_run else live_client()
        try:
            dry_cands, _, dry_report, _, _ = await run_photo(
                client, dry_path, args.dry_run, stamp, args.top_n,
                args.scales, args.region, args.phases)
            wet_cands, _, wet_report, _, _ = await run_photo(
                client, wet_path, args.dry_run, stamp, args.top_n,
                args.scales, args.region, args.phases)
        finally:
            if client is not None:
                await client.close()
        with Image.open(dry_path) as im:
            width = im.width
        pairs = match_pairs(dry_cands, wet_cands, width)
        apply_pair_scores(pairs, dry_cands, wet_cands)
        # Re-write both reports with the side-by-side scores.
        for cands, report in ((dry_cands, dry_report), (wet_cands, wet_report)):
            payload = json.loads(report.read_text(encoding="utf-8"))
            by_id = {c.id: c for c in cands}
            for item in payload["candidates"]:
                c = by_id[item["id"]]
                item.update(score=c.score, dry_score=c.dry_score,
                            wet_score=c.wet_score)
            report.write_text(json.dumps(payload, indent=2) + "\n",
                              encoding="utf-8")
        matched = sum(1 for d, w in pairs if d and w)
        risen = sum(1 for w in wet_cands
                    if w.dry_score is not None and w.wet_score is not None
                    and w.wet_score > w.dry_score)
        print(f"pair: {len(dry_cands)} dry / {len(wet_cands)} wet candidates, "
              f"{matched} matched, {risen} rose on wet read (boosted +{WET_BOOST})")
        print("Score recall + false positives against the answer key, then "
              f"fill them in {DAY1_LOG}")
        return 0
    if not args.photo:
        print("error: need <photo> or --pair", file=sys.stderr)
        return 2
    photo = resolve_photo(args.photo)
    client = None if args.dry_run else live_client()
    try:
        await run_photo(client, photo, args.dry_run, stamp, args.top_n,
                         args.scales, args.region, args.phases)
    finally:
        if client is not None:
            await client.close()
    print("Score recall + false positives against the answer key, then "
          f"fill them in {DAY1_LOG}")
    return 0


def parse_region(text: str) -> tuple[int, int, int, int]:
    try:
        x, y, w, h = (int(v) for v in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"--region expects X,Y,W,H, got {text!r}")
    if w < 1 or h < 1:
        raise argparse.ArgumentTypeError("--region needs W,H >= 1")
    return x, y, w, h


def parse_scales(text: str) -> list[int]:
    try:
        scales = [int(v) for v in text.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"--scales expects comma sizes, got {text!r}")
    if not scales or any(s < 64 for s in scales):
        raise argparse.ArgumentTypeError("--scales needs sizes >= 64")
    return list(dict.fromkeys(scales))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Gem Finder Day 1: rank rock candidates in a gravel photo.")
    parser.add_argument("photo", nargs="?",
                        help="static gravel photo (also searched in assets/testbed/)")
    parser.add_argument("--pair", nargs=2, metavar=("DRY", "WET"),
                        help="dry + wet shots of the same patch")
    parser.add_argument("--dry-run", action="store_true",
                        help="tiling + local stats only, zero API calls")
    parser.add_argument("--project", action="store_true",
                        help="print a $0 spend projection and exit before "
                             "any API call")
    parser.add_argument("--kind", choices=["bed", "closeup"], default="bed",
                        help="projection kind: a bed scan ranks top-N crops, "
                             "a close-up assesses one stone (default bed)")
    parser.add_argument("--closeup", action="store_true",
                        help="single-stone close-up assessment instead of a "
                             "bed scan")
    parser.add_argument("--focus", type=parse_focus, default=None,
                        metavar="X,Y",
                        help="raw full-photo pixel coords of the user tap")
    parser.add_argument("--hardness", type=parse_hardness, default=None,
                        metavar="JSON",
                        help="guided-hardness payload "
                             "{cleaned, tests, range}")
    parser.add_argument("--top-n", type=int, default=RANK_TOP_N,
                        help=f"rank at most N flagged candidates by deviation "
                             f"(default {RANK_TOP_N})")
    parser.add_argument("--region", type=parse_region, default=None,
                        metavar="X,Y,W,H",
                        help="restrict processing to a full-photo region box")
    parser.add_argument("--scales", type=parse_scales, default=[PATCH_SIZE],
                        metavar="SIZES",
                        help="comma tile sizes, e.g. 512 or 512,256 "
                             f"(default {PATCH_SIZE})")
    parser.add_argument("--phases", type=int, default=1,
                        help="phase-shifted grids per scale; extra phases "
                             "catch stones split by another grid's seams "
                             "(default 1)")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.top_n < 1:
        parser.error("--top-n must be >= 1")
    if args.phases < 1:
        parser.error("--phases must be >= 1")
    if args.project and args.pair:
        parser.error("--project takes one photo, not --pair")
    if args.project and not args.photo:
        parser.error("--project needs a photo")
    if args.project and args.closeup:
        parser.error("--project and --closeup are exclusive")
    if args.kind != "bed" and not args.project:
        parser.error("--kind only applies to --project")
    if args.closeup and not args.photo:
        parser.error("--closeup needs a photo")
    if args.closeup and args.pair:
        parser.error("--closeup takes one photo, not --pair")
    try:
        if args.project:
            proj = plan_projection(resolve_photo(args.photo), args.scales,
                                   args.region, args.phases, args.top_n,
                                   args.kind)
            print(json.dumps(proj, indent=2))
            return 0
        return asyncio.run(amain(args))
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
