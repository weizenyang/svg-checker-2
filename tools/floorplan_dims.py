#!/usr/bin/env python3
"""
floorplan_dims.py — DXF/DWG → dimensioned SVG floorplans.

Usage:
    floorplan_dims.py <input.dxf|input.dwg> [-o OUT_DIR] [--min-labels N]

What it does:
  1. Accepts a DXF or DWG (converts DWG via ODA File Converter if needed).
  2. Finds every floorplan in the file by clustering room-description text labels.
  3. Skips clusters with fewer than --min-labels (default 5) labels — these are
     dimension-only artboards, title blocks, or legends, not real floorplans.
  4. For each surviving floorplan it runs the reconstruction pipeline:
       walls  →  seed from label clusters  →  compact watershed  →
       fragment absorb  →  per-room morphological de-leak  →
       line-of-sight merge of open-plan rooms  →  outlier filter  →
       gap-based edge-tier dimension selection
  5. Writes one SVG per floorplan to OUT_DIR plus an index.json summary.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

# Optional pretty output. Falls back to plain prints if rich is unavailable.
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import (
        BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn, TimeElapsedColumn,
    )
    from rich.table import Table
    _HAS_RICH = True
    _console = Console()
except Exception:  # pragma: no cover
    _HAS_RICH = False
    _console = None

import colorsys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage import measure, segmentation
from skimage.draw import line as _sk_line
from skimage.morphology import disk, binary_erosion, binary_dilation

import ezdxf


# ------------------------------ UI helpers ------------------------------

def _print(msg: str = "", style: str | None = None) -> None:
    if _HAS_RICH:
        _console.print(msg, style=style)
    else:
        print(msg)


def _header(title: str) -> None:
    if _HAS_RICH:
        _console.print(Panel(title, style="bold cyan", expand=False))
    else:
        print("\n" + "=" * len(title))
        print(title)
        print("=" * len(title))


# ------------------------------ Layer sets ------------------------------

# ---------------------------------------------------------------------------
# Layer auto-detection.
#
# Instead of hardcoding every layer name from every CAD standard (AIA, BS1192,
# Uniclass, Revit, ArchiCAD, bespoke French/Italian/etc.), we match layer
# names against keyword patterns. A layer whose name contains "WALL" is a
# wall regardless of whether the full name is "A-WALL", "A-200-M_WALL_INT",
# "A-G25-M_Wall", or "$0$$0$GB_040_CLOISON-COUPE".
# ---------------------------------------------------------------------------

import re as _re

# Keywords that indicate a layer carries geometry useful for bounding rooms.
# Each pattern is tested case-insensitively against the full layer name.
_WALL_KEYWORDS = _re.compile(
    r"(?i)"
    r"(?:WALL|CLOISON|MUR)"            # walls (EN, FR)
    r"|(?:DOOR|PORTE)"                  # doors
    r"|(?:WINDOW|FENETRE|GLAZ|VERRE|VITR|MENUISERIES)"  # windows / glazing
    r"|(?:CLAD)"                        # cladding
    r"|(?:COLUMN|COL(?:S|_))"           # columns
    r"|(?:FLOOR|FLOR|PLANCHER)"         # floor slab edges
    r"|(?:BALUSTRADE|HRAL)"             # balustrades / handrails
    r"|(?:STAIR|STRS)"                  # stairs
    r"|(?:DETL.(?:GENF|MEDM|HDLN|THIN))"  # AIA detail weight layers
    r"|(?:COUPE)"                       # French "section cut" layers
    r"|(?:BuildingReflected)"           # Revit reflected ceiling
)

# Keywords that indicate an INSERT block's contents should be expanded and
# treated as wall geometry (doors, windows, columns live inside blocks in
# most Revit / ArchiCAD exports).
_INSERT_WALL_KEYWORDS = _re.compile(
    r"(?i)"
    r"(?:DOOR|PORTE)"
    r"|(?:WINDOW|FENETRE|GLAZ|VERRE|VITR|MENUISERIES)"
    r"|(?:CLAD)"
    r"|(?:COLUMN|COL(?:S|_))"
    r"|(?:WALL|CLOISON|MUR)"
    r"|(?:FRAME|FRM|LEAF|PANEL)"
)

# Keywords that indicate a TEXT/MTEXT layer carries room names / descriptions.
_ROOM_LABEL_KEYWORDS = _re.compile(
    r"(?i)"
    r"(?:ROOM)"                         # most common
    r"|(?:AREA.?IDEN)"                  # AIA "Area Identification"
    r"|(?:RoomDescription)"             # Revit/Uniclass
    r"|(?:ANNO.?ROOM)"
    r"|(?:SPACE)"
)

# Layers we explicitly SKIP even if they match a keyword — annotation layers,
# dimension layers, hatch layers, label layers that don't carry room names.
_SKIP_LAYER_KEYWORDS = _re.compile(
    r"(?i)"
    r"(?:DIMS?(?:$|_|-|\s))"           # dimension layers
    r"|(?:ANNO.?(?:DIM|NOTE|SYMB|TTLB|TEXT|REFR|NPLT))"
    r"|(?:TITLE)"
    r"|(?:DEFPOINT)"
    r"|(?:HATCH|PATT)"                 # hatch / pattern fills
    r"|(?:FUR(?:N|NITURE)?(?:$|_))"    # furniture
    r"|(?:LABEL.?(?:DOOR|WALL))"       # label layers
    r"|(?:PLOT.?LIMIT)"
    r"|(?:SET.?BACK)"
)


def _classify_layers(doc) -> tuple[set, set, set]:
    """Scan the DXF's layer table and return three sets:
        (wall_layers, insert_wall_layers, room_label_layers)
    determined by keyword matching on each layer name.

    This replaces the old hardcoded WALL_LAYERS / INSERT_WALL_LAYERS /
    ROOM_LABEL_LAYERS sets and supports any CAD standard without
    manual additions."""
    wall = set()
    insert_wall = set()
    room_label = set()

    for layer in doc.layers:
        name = layer.dxf.name
        if _SKIP_LAYER_KEYWORDS.search(name):
            continue
        if _ROOM_LABEL_KEYWORDS.search(name):
            room_label.add(name)
        if _WALL_KEYWORDS.search(name):
            wall.add(name)
        if _INSERT_WALL_KEYWORDS.search(name):
            insert_wall.add(name)

    return wall, insert_wall, room_label


# Keep the old constants as fallbacks / for the CLI that doesn't call
# _classify_layers. The GUI and CLI both call _classify_layers now though.
WALL_LAYERS: set = set()
INSERT_WALL_LAYERS: set = set()
ROOM_LABEL_LAYERS: set = set()


# ------------------------------ DWG conversion ------------------------------

def convert_dwg_to_dxf(dwg_path: Path) -> Path:
    """Convert a DWG file to DXF via ODA File Converter and return the DXF path."""
    oda = Path("/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter")
    if not oda.exists():
        raise RuntimeError(
            "ODA File Converter not found. DWG input requires ODA File Converter "
            "to be installed at /Applications/ODAFileConverter.app."
        )
    tmp_in = Path(tempfile.mkdtemp(prefix="fpd_in_"))
    tmp_out = Path(tempfile.mkdtemp(prefix="fpd_out_"))
    staged = tmp_in / dwg_path.name
    shutil.copy(dwg_path, staged)
    _print(f"[dim]Converting DWG → DXF ({dwg_path.stat().st_size/1e6:.0f} MB)…[/dim]")
    subprocess.run(
        [str(oda), str(tmp_in), str(tmp_out), "ACAD2018", "DXF", "0", "1", dwg_path.name],
        check=True, capture_output=True,
    )
    dxf_out = tmp_out / (dwg_path.stem + ".dxf")
    if not dxf_out.exists():
        raise RuntimeError(f"ODA conversion failed: {dxf_out} not produced")
    return dxf_out


# ------------------------------ Text extraction ------------------------------

# Map $INSUNITS → mm scale factor. The pipeline assumes mm everywhere, so we
# multiply all coordinates by this factor at load time. Keeps thresholds
# (GAP_MIN, TICK, DIM_OFFSET, LINK_DIST, raster_mm…) meaningful regardless of
# the source file's native units.
INSUNITS_TO_MM = {
    0: 1.0,       # unitless — assume already in mm
    1: 25.4,      # inches
    2: 304.8,     # feet
    4: 1.0,       # millimeters
    5: 10.0,      # centimeters
    6: 1000.0,    # meters
    8: 0.0000254, # microinches
    9: 0.0254,    # mils
}


def get_unit_scale(doc, msp=None) -> float:
    """Determine a world-coordinates → mm scale factor.

    The $INSUNITS header is unreliable in practice (many files have it stale
    or wrong), so we combine it with a data-driven sanity check:

      1. Look at the extents of wall lines / room labels.
      2. If they span less than a few hundred units, the file is almost
         certainly in metres (or similar large unit); assume ×1000.
      3. Otherwise assume it's already in millimetres (×1) unless the header
         clearly says inches (×25.4) or feet (×304.8).
    """
    # Data-driven: measure label/wall span
    try:
        extmin = doc.header.get("$EXTMIN", None)
        extmax = doc.header.get("$EXTMAX", None)
        if extmin and extmax:
            span = max(abs(extmax[0] - extmin[0]), abs(extmax[1] - extmin[1]))
        else:
            span = 0
    except Exception:
        span = 0

    try:
        ins = int(doc.header.get("$INSUNITS", 4))
    except Exception:
        ins = 4

    # Tiny span → file is in metres
    if 0 < span < 500:
        return 1000.0
    # Header explicitly says imperial
    if ins == 1:
        # Only trust 'inches' if the span isn't already huge (huge = probably mm mislabelled)
        if span and span > 20000:
            return 1.0
        return 25.4
    if ins == 2:
        return 304.8
    if ins == 5:
        return 10.0
    if ins == 6:
        return 1000.0
    # Default: assume mm
    return 1.0


def extract_room_labels(msp, unit_scale: float = 1.0,
                        room_label_layers: set | None = None) -> List[Tuple[str, float, float]]:
    _layers = room_label_layers or ROOM_LABEL_LAYERS
    labels = []
    for t in msp.query("TEXT MTEXT"):
        if getattr(t.dxf, "layer", None) not in _layers:
            continue
        try:
            txt = t.plain_text() if hasattr(t, "plain_text") else t.dxf.text
        except Exception:
            txt = str(getattr(t.dxf, "text", ""))
        try:
            x = t.dxf.insert.x
            y = t.dxf.insert.y
        except Exception:
            try:
                x = t.dxf.location.x
                y = t.dxf.location.y
            except Exception:
                continue
        labels.append((str(txt).strip(), float(x) * unit_scale, float(y) * unit_scale))
    return labels


# ------------------------------ Floorplan detection ------------------------------

def detect_floorplans(labels: List[Tuple[str, float, float]], min_labels: int) -> List[dict]:
    """Group room labels into floorplan clusters using a simple link-distance
    flood fill: two labels are in the same floorplan if they're within LINK_DIST
    mm of each other. Floorplans with fewer than min_labels labels are dropped
    (they're probably dim-only artboards or legends)."""
    if not labels:
        return []
    LINK_DIST = 10000.0  # mm — typical floorplan spacing between artboards
    n = len(labels)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # Chain: two labels link if close enough. Quadratic but fine for thousands.
    for i in range(n):
        xi, yi = labels[i][1], labels[i][2]
        for j in range(i + 1, n):
            xj, yj = labels[j][1], labels[j][2]
            if abs(xi - xj) <= LINK_DIST and abs(yi - yj) <= LINK_DIST:
                if (xi - xj) ** 2 + (yi - yj) ** 2 <= LINK_DIST ** 2:
                    union(i, j)

    groups: Dict[int, List[int]] = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)

    floorplans = []
    for _, idxs in groups.items():
        if len(idxs) < min_labels:
            continue
        xs = [labels[i][1] for i in idxs]
        ys = [labels[i][2] for i in idxs]
        pad = 6000.0
        fp = {
            "labels": [labels[i] for i in idxs],
            "minx": min(xs) - pad,
            "maxx": max(xs) + pad,
            "miny": min(ys) - pad,
            "maxy": max(ys) + pad,
            "cx": (min(xs) + max(xs)) / 2,
            "cy": (min(ys) + max(ys)) / 2,
        }
        floorplans.append(fp)

    # Sort left→right, top→bottom for stable naming
    floorplans.sort(key=lambda f: (-f["cy"], f["cx"]))
    for i, fp in enumerate(floorplans, start=1):
        fp["idx"] = i
    return floorplans


# ------------------------------ Geometry collection ------------------------------

def collect_all_walls(msp, unit_scale: float = 1.0,
                      wall_layers: set | None = None,
                      insert_wall_layers: set | None = None) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Walk the DXF once and extract EVERY wall-ish line segment in world
    coordinates (already multiplied by unit_scale, so the caller sees mm).
    Returns two arrays:
        segs_xy    — shape (N, 4) float32 of (x1, y1, x2, y2) for all walls
        seal_mask  — shape (N,) bool, True for door-seal segments
        seg_mid    — shape (N, 2) float32 midpoints, used to filter per floorplan
    Each floorplan then just masks this array by its bbox — no per-floorplan
    msp iteration, no re-expanding INSERT blocks."""
    _wall_layers = wall_layers or WALL_LAYERS
    _insert_wall_layers = insert_wall_layers or INSERT_WALL_LAYERS
    segs: list = []
    is_seal: list = []
    us = unit_scale

    def add_line(ax, ay, bx, by, seal=False):
        segs.append((ax * us, ay * us, bx * us, by * us))
        is_seal.append(seal)

    def process_outline(e):
        try:
            t = e.dxftype()
            if t == "LINE":
                add_line(e.dxf.start.x, e.dxf.start.y, e.dxf.end.x, e.dxf.end.y)
            elif t == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points("xy")]
                for i in range(len(pts) - 1):
                    a, b = pts[i], pts[i + 1]
                    add_line(a[0], a[1], b[0], b[1])
                if getattr(e, "closed", False) and len(pts) >= 3:
                    add_line(pts[-1][0], pts[-1][1], pts[0][0], pts[0][1])
            elif t == "POLYLINE":
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                for i in range(len(pts) - 1):
                    a, b = pts[i], pts[i + 1]
                    add_line(a[0], a[1], b[0], b[1])
        except Exception:
            pass

    # Pass 1: non-INSERT entities on wall layers
    for e in msp:
        if e.dxftype() == "INSERT":
            continue
        if getattr(e.dxf, "layer", None) in _wall_layers:
            process_outline(e)

    # Pass 2: INSERTs on door / column / cladding layers — expand blocks once
    for ins in msp.query("INSERT"):
        if getattr(ins.dxf, "layer", None) not in _insert_wall_layers:
            continue
        try:
            for ve in ins.virtual_entities():
                if ve.dxftype() == "ARC":
                    try:
                        cx, cy = ve.dxf.center.x, ve.dxf.center.y
                        r = ve.dxf.radius
                        r_mm = r * us
                        if 400 <= r_mm <= 2200:  # typical door swing radius 0.4-2.2 m
                            a0 = math.radians(ve.dxf.start_angle)
                            a1 = math.radians(ve.dxf.end_angle)
                            if a1 < a0:
                                a1 += 2 * math.pi
                            sw = a1 - a0
                            if 1.0 < sw < 2.2:
                                for ang in (a0, a1):
                                    px = cx + r * math.cos(ang)
                                    py = cy + r * math.sin(ang)
                                    add_line(cx, cy, px, py, seal=True)
                    except Exception:
                        pass
                else:
                    process_outline(ve)
        except Exception:
            pass

    if not segs:
        empty_f = np.zeros((0, 4), dtype=np.float32)
        empty_m = np.zeros((0, 2), dtype=np.float32)
        return empty_f, np.zeros((0,), dtype=bool), empty_m

    arr = np.asarray(segs, dtype=np.float32)
    seal = np.asarray(is_seal, dtype=bool)
    mid = np.column_stack(((arr[:, 0] + arr[:, 2]) * 0.5, (arr[:, 1] + arr[:, 3]) * 0.5))
    return arr, seal, mid


def crop_walls(all_segs: np.ndarray, all_seal: np.ndarray, all_mid: np.ndarray,
               minX: float, maxX: float, minY: float, maxY: float) -> Tuple[list, list]:
    """Fast per-floorplan filter: pick segments whose midpoint OR either endpoint
    lies inside the crop box. Uses vectorized numpy — O(N) per floorplan but N is
    the total wall count, with tight constant factors."""
    if all_segs.shape[0] == 0:
        return [], []
    x1, y1, x2, y2 = all_segs[:, 0], all_segs[:, 1], all_segs[:, 2], all_segs[:, 3]
    mx, my = all_mid[:, 0], all_mid[:, 1]

    def in_box(x, y):
        return (x >= minX) & (x <= maxX) & (y >= minY) & (y <= maxY)

    mask = in_box(x1, y1) | in_box(x2, y2) | in_box(mx, my)
    picked = all_segs[mask]
    picked_seal = all_seal[mask]
    segs = [((float(s[0]), float(s[1])), (float(s[2]), float(s[3]))) for s in picked]
    door_seals = [segs[i] for i, is_s in enumerate(picked_seal) if is_s]
    return segs, door_seals


# ------------------------------ Label clustering ------------------------------

def cluster_labels(labels: List[Tuple[str, float, float]]) -> List[List[Tuple[str, float, float]]]:
    used = [False] * len(labels)
    clusters: List[List[Tuple[str, float, float]]] = []
    for i in range(len(labels)):
        if used[i]:
            continue
        used[i] = True
        cl = [labels[i]]
        changed = True
        while changed:
            changed = False
            for j in range(len(labels)):
                if used[j]:
                    continue
                n2, x2, y2 = labels[j]
                for _, x, y in cl:
                    if abs(x - x2) < 300 and abs(y - y2) < 420:
                        cl.append(labels[j])
                        used[j] = True
                        changed = True
                        break
        clusters.append(cl)
    return clusters


# ------------------------------ Pipeline per floorplan ------------------------------

def reconstruct_rooms(wall_data, fp: dict, raster_mm: float = 20.0,
                      on_progress=None) -> dict | None:
    """Run the RECONSTRUCTION half of the pipeline (walls → watershed → de-leak
    → LOS merge → outlier drop). Returns a dict the caller can render to SVG
    or hand to a GUI:

        {
          'fp':         the floorplan dict (bbox, labels, idx, …),
          'segs':       list of (p1, p2) wall segments in world mm,
          'door_seals': list of seal segments,
          'rooms':      list of room dicts, each with:
                          name, cx, cy, idx, area_mm2,
                          poly_xy  — list of (x, y) contour points in world mm,
                          bbox_xy  — (minx, miny, maxx, maxy),
                          w, h
        }

    Returns None if nothing usable could be reconstructed."""
    minX, maxX = fp["minx"], fp["maxx"]
    minY, maxY = fp["miny"], fp["maxy"]

    def step(msg):
        if on_progress:
            on_progress(msg)

    step("cropping walls…")
    all_segs, all_seal, all_mid = wall_data
    segs, door_seals = crop_walls(all_segs, all_seal, all_mid, minX, maxX, minY, maxY)
    if not segs:
        return None

    step("rasterizing…")
    PX = 1.0 / raster_mm
    W = int((maxX - minX) * PX) + 1
    H = int((maxY - minY) * PX) + 1
    if W < 100 or H < 100 or W > 8000 or H > 8000:
        return None
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)

    def tx(p):
        return ((p[0] - minX) * PX, (maxY - p[1]) * PX)

    for a, b in segs:
        d.line([tx(a), tx(b)], fill=255, width=2)
    walls_raw = np.array(img) > 0
    walls = ndimage.binary_dilation(walls_raw, iterations=3)
    walls[0, :] = walls[-1, :] = True
    walls[:, 0] = walls[:, -1] = True
    free = ~walls

    step("seeding rooms…")
    clusters = cluster_labels(fp["labels"])
    seeds = np.zeros_like(walls, dtype=np.int32)
    info = []
    for idx, cl in enumerate(clusters, start=1):
        cx = sum(x for _, x, _ in cl) / len(cl)
        cy = sum(y for _, _, y in cl) / len(cl)
        px = int((cx - minX) * PX)
        py = int((maxY - cy) * PX)
        if not (0 <= px < W and 0 <= py < H):
            continue
        if not free[py, px]:
            found = False
            for dr in range(1, 60):
                for dy in range(-dr, dr + 1):
                    for dx in range(-dr, dr + 1):
                        ny, nx = py + dy, px + dx
                        if 0 <= ny < H and 0 <= nx < W and free[ny, nx]:
                            px, py = nx, ny
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
            if not found:
                continue
        seeds[py, px] = idx
        info.append({"name": " ".join(n for n, _, _ in cl), "cx": cx, "cy": cy,
                     "idx": idx, "spx": px, "spy": py})

    if not info:
        return None

    step("watershed…")
    dist = ndimage.distance_transform_edt(free)
    ws = segmentation.watershed(-dist, markers=seeds, mask=free, compactness=0.003)

    step("absorbing fragments…")
    cc_labels, _ = ndimage.label(free)
    seed_cc = {ci["idx"]: int(cc_labels[ci["spy"], ci["spx"]]) for ci in info}
    cc_seeds = defaultdict(list)
    for idx, cc in seed_cc.items():
        if cc > 0:
            cc_seeds[cc].append(idx)
    AREA_MM2_PER_PX = 1 / (PX ** 2)
    remap = {}
    for cc, sl in cc_seeds.items():
        if len(sl) < 2:
            continue
        sa = {s: int(((ws == s) & (cc_labels == cc)).sum()) for s in sl}
        ranked = sorted(sl, key=lambda s: -sa[s])
        big = ranked[0]
        bigA = sa[big]
        for s in ranked[1:]:
            am2 = sa[s] * AREA_MM2_PER_PX / 1e6
            if am2 < 2.0 and sa[s] < bigA * 0.10:
                remap[s] = big
    for o, nn in remap.items():
        ws[ws == o] = nn

    step("de-leaking…")
    def deleak(mask, sxy, rpx):
        if mask.sum() == 0:
            return mask
        sel = disk(rpx)
        er = binary_erosion(mask, sel)
        if not er[sxy[1], sxy[0]]:
            return mask
        lbl, _ = ndimage.label(er)
        cid = lbl[sxy[1], sxy[0]]
        if cid == 0:
            return mask
        kept = lbl == cid
        return binary_dilation(kept, sel) & mask

    for ci in info:
        if ci["idx"] in remap:
            continue
        mask = ws == ci["idx"]
        if int(mask.sum()) < 200:
            continue
        a = int(mask.sum()) * AREA_MM2_PER_PX / 1e6
        r = 27 if a >= 8 else (17 if a >= 3 else 10)
        cleaned = deleak(mask, (ci["spx"], ci["spy"]), r)
        removed = mask & ~cleaned
        ws[removed] = 0

    step("line-of-sight merge…")
    alive = [ci for ci in info if ci["idx"] not in remap]
    seed_cc_after = {ci["idx"]: int(cc_labels[ci["spy"], ci["spx"]]) for ci in alive}
    area_of = {ci["idx"]: int((ws == ci["idx"]).sum()) for ci in alive}

    parent = {ci["idx"]: ci["idx"] for ci in alive}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if area_of[ra] < area_of[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        area_of[ra] += area_of[rb]

    def line_hits_walls(mask, p0, p1) -> bool:
        """True if the straight line between p0 and p1 (integer pixel coords,
        (x, y)) passes through any non-zero pixel in `mask`.
        Uses skimage.draw.line which is a C implementation that releases the
        GIL — critical for keeping the Tk main loop responsive while the
        reconstruction runs on a worker thread."""
        rr, cc = _sk_line(p0[1], p0[0], p1[1], p1[0])
        H, W = mask.shape
        in_bounds = (rr >= 0) & (rr < H) & (cc >= 0) & (cc < W)
        if not in_bounds.all():
            rr = rr[in_bounds]
            cc = cc[in_bounds]
        if rr.size == 0:
            return False
        return bool(mask[rr, cc].any())

    for i in range(len(alive)):
        ai = alive[i]
        ai_pt = (ai["spx"], ai["spy"])
        ai_cc = seed_cc_after[ai["idx"]]
        for j in range(i + 1, len(alive)):
            bj = alive[j]
            if seed_cc_after[bj["idx"]] != ai_cc:
                continue
            if not line_hits_walls(walls_raw, ai_pt, (bj["spx"], bj["spy"])):
                union(ai["idx"], bj["idx"])

    idx_to_root = {ci["idx"]: find(ci["idx"]) for ci in alive}
    for old, root in idx_to_root.items():
        if old != root:
            ws[ws == old] = root

    merged_names = defaultdict(list)
    for ci in info:
        if ci["idx"] in remap:
            merged_names[remap[ci["idx"]]].append(ci["name"])
        else:
            root = idx_to_root.get(ci["idx"], ci["idx"])
            merged_names[root].append(ci["name"])

    def combine_names(ns):
        seen = []
        for n in ns:
            if n not in seen:
                seen.append(n)
        prio = [n for n in seen if any(k in n.upper() for k in ("LIVING", "DINING", "KITCHEN"))]
        other = [n for n in seen if n not in prio]
        return " / ".join(prio + other)

    rooms = []
    seen_roots = set()
    for ci in info:
        if ci["idx"] in remap:
            continue
        root = idx_to_root.get(ci["idx"], ci["idx"])
        if root in seen_roots:
            continue
        seen_roots.add(root)
        mask = ws == root
        if int(mask.sum()) < 100:
            continue
        ys, xs = np.where(mask)
        cx_w = minX + float(xs.mean()) / PX
        cy_w = maxY - float(ys.mean()) / PX
        rooms.append({
            "name": combine_names(merged_names[root]),
            "cx": cx_w, "cy": cy_w, "idx": root, "mask": mask,
            "area_mm2": int(mask.sum()) / (PX ** 2),
        })

    if not rooms:
        return None

    step("outlier filter…")
    areas = sorted([r["area_mm2"] for r in rooms])
    if len(areas) >= 10:
        p90 = areas[int(len(areas) * 0.9)]
        cap = max(p90 * 3, 100e6)
        rooms = [r for r in rooms if r["area_mm2"] <= cap]

    if not rooms:
        return None

    step("extracting contours…")

    def _open_components(mask: np.ndarray, area_mm2: float):
        """Erode `mask`, then return a list of its connected components'
        re-dilated regions (each clipped back to the original mask) sorted
        by descending area. This handles L / T / U-shaped rooms: each arm
        of the room shows up as its own component once the thin junctions
        are eroded away. Returns [] if the opening erases the whole room.
        """
        if area_mm2 >= 30e6:
            open_mm = 1000.0
        elif area_mm2 >= 10e6:
            open_mm = 600.0
        elif area_mm2 >= 3e6:
            open_mm = 300.0
        else:
            return []  # too small to safely split
        open_px = max(1, int(round(open_mm * PX)))
        sel = disk(open_px)
        eroded = binary_erosion(mask, sel)
        if not eroded.any():
            return []
        lbl, n = ndimage.label(eroded)
        if n == 0:
            return []
        # Dilate each component back to its full extent, clipped to the
        # original mask so it can't bleed past the real walls.
        components = []
        for i in range(1, n + 1):
            comp = (lbl == i)
            dilated = binary_dilation(comp, sel) & mask
            if not dilated.any():
                continue
            area_px = int(dilated.sum())
            if area_px / (PX ** 2) < 2.0e6:  # skip parts smaller than 2 m²
                continue
            ys_c, xs_c = np.where(dilated)
            minx_w = minX + float(xs_c.min()) / PX
            maxx_w = minX + float(xs_c.max()) / PX
            miny_w = maxY - float(ys_c.max()) / PX
            maxy_w = maxY - float(ys_c.min()) / PX
            components.append({
                "bbox_xy": (minx_w, miny_w, maxx_w, maxy_w),
                "w": maxx_w - minx_w,
                "h": maxy_w - miny_w,
                "area_mm2": area_px / (PX ** 2),
            })
        components.sort(key=lambda c: -c["area_mm2"])
        return components

    # Convert each mask to a world-space polygon and compute its bbox(es).
    cooked_rooms = []
    for r in rooms:
        contours = measure.find_contours(r["mask"].astype(float), 0.5)
        if not contours:
            continue
        contour = max(contours, key=len)
        poly = [(minX + cx / PX, maxY - ry / PX) for ry, cx in contour]
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        bbox_full = (min(xs), min(ys), max(xs), max(ys))
        w_full = bbox_full[2] - bbox_full[0]
        h_full = bbox_full[3] - bbox_full[1]
        full_part = {
            "bbox_xy": bbox_full, "w": w_full, "h": h_full,
            "area_mm2": r["area_mm2"],
        }

        # Decompose the room into rectangular "parts" by morphological
        # opening + connected components. For simple (convex-ish) rooms
        # there's just one part matching the trimmed bbox. For L / T / U
        # shapes we get one part per arm, which the GUI can dimension
        # independently.
        parts_trim = _open_components(r["mask"], r["area_mm2"])
        if not parts_trim:
            parts_trim = [full_part]

        # Primary bbox (used by pick_dims + left-click + auto-select) is the
        # biggest part. The full-bbox fallback is used when tail-trim is off.
        primary = parts_trim[0]

        cooked_rooms.append({
            "name": r["name"],
            "cx": r["cx"], "cy": r["cy"],
            "idx": r["idx"],
            "area_mm2": r["area_mm2"],
            "poly_xy": poly,
            # Active bbox (defaults to trimmed — tail-ignoring mode).
            # The GUI swaps bbox_xy / w / h / parts between the *_trim and
            # *_full variants when the "Ignore trailing tails" toggle flips.
            "bbox_xy": primary["bbox_xy"],
            "w": primary["w"],
            "h": primary["h"],
            "bbox_full": bbox_full,
            "w_full": w_full,
            "h_full": h_full,
            "bbox_trim": primary["bbox_xy"],
            "w_trim": primary["w"],
            "h_trim": primary["h"],
            # Full set of parts. In trim mode this is the opened components;
            # in non-trim mode the GUI substitutes [full_part].
            "parts": parts_trim,
            "parts_trim": parts_trim,
            "parts_full": [full_part],
        })
    if not cooked_rooms:
        return None

    return {
        "fp": fp,
        "segs": segs,
        "door_seals": door_seals,
        "rooms": cooked_rooms,
    }


# Wraps reconstruct_rooms + emit_svg_from_recon. Kept for the CLI which just
# wants a one-shot "read this, write that" API.
def process_floorplan(wall_data, fp: dict, out_dir: Path, raster_mm: float = 20.0,
                      on_progress=None) -> dict | None:
    recon = reconstruct_rooms(wall_data, fp, raster_mm=raster_mm, on_progress=on_progress)
    if recon is None:
        return None
    if on_progress:
        on_progress("rendering dims…")
    return emit_svg(recon, out_dir)


# ------------------------------ Dim selection + rendering ------------------------------

def pick_dims(rooms: List[dict]) -> dict:
    """Given rooms (each with `parts`, a list of sub-rectangles), auto-pick
    which (room, part) pairs get dim lines on each of the 4 sides of the
    floorplate. Every part of every room is a candidate — L-shaped rooms
    with multiple parts can contribute more than one dim per axis.

    Selection algorithm (per side):
      1. gap-based tier detection — only candidates whose edge-distance from
         the side forms a tight cluster with no large gap are eligible,
      2. widest-first non-overlapping greedy — within each tier, take the
         longest dim that doesn't overlap an already-picked dim, repeat.

    Returns {'h_top': [(room_idx, part_idx), ...], 'h_bot': [...],
             'v_left': [...], 'v_right': [...]}"""
    if not rooms:
        return {"h_top": [], "h_bot": [], "v_left": [], "v_right": []}

    # Flatten rooms → list of candidates, one per (room, part).
    candidates = []
    for r in rooms:
        parts = r.get("parts") or [{
            "bbox_xy": r["bbox_xy"], "w": r["w"], "h": r["h"],
            "area_mm2": r.get("area_mm2", 0),
        }]
        for pi, p in enumerate(parts):
            candidates.append({
                "rid": r["idx"],
                "pid": pi,
                "bbox": p["bbox_xy"],
                "w": p["w"],
                "h": p["h"],
            })

    if not candidates:
        return {"h_top": [], "h_bot": [], "v_left": [], "v_right": []}

    all_minx = min(c["bbox"][0] for c in candidates)
    all_maxx = max(c["bbox"][2] for c in candidates)
    all_miny = min(c["bbox"][1] for c in candidates)
    all_maxy = max(c["bbox"][3] for c in candidates)

    MIN_COUNT = 3
    BUFFER_MM = 400
    HARD_CAP = 4500

    def tier_cut(items):
        if not items:
            return []
        s = sorted(items, key=lambda x: x[0])
        if len(s) <= MIN_COUNT:
            return s[:]
        kept = list(s[:MIN_COUNT])
        max_gap = 0
        for i in range(1, MIN_COUNT):
            max_gap = max(max_gap, s[i][0] - s[i - 1][0])
        for i in range(MIN_COUNT, len(s)):
            gap = s[i][0] - s[i - 1][0]
            if s[i][0] > HARD_CAP:
                break
            if gap > max_gap + BUFFER_MM:
                break
            kept.append(s[i])
            max_gap = max(max_gap, gap)
        return kept

    top_tier   = tier_cut([((all_maxy - c["bbox"][3]), c) for c in candidates if c["w"] >= 500])
    bot_tier   = tier_cut([((c["bbox"][1] - all_miny), c) for c in candidates if c["w"] >= 500])
    left_tier  = tier_cut([((c["bbox"][0] - all_minx), c) for c in candidates if c["h"] >= 500])
    right_tier = tier_cut([((all_maxx - c["bbox"][2]), c) for c in candidates if c["h"] >= 500])

    TOL = 50

    def non_overlapping(intervals):
        s = sorted(intervals, key=lambda x: -(x[1] - x[0]))
        kept = []
        for start, end, cand in s:
            if not any(not (end + TOL <= s2 or start >= e2 + TOL) for s2, e2, _ in kept):
                kept.append((start, end, cand))
        return kept

    def key(cand):
        return (cand["rid"], cand["pid"])

    return {
        "h_top":  [key(c) for _, _, c in non_overlapping(
                   [(c["bbox"][0], c["bbox"][2], c) for _, c in top_tier])],
        "h_bot":  [key(c) for _, _, c in non_overlapping(
                   [(c["bbox"][0], c["bbox"][2], c) for _, c in bot_tier])],
        "v_left": [key(c) for _, _, c in non_overlapping(
                   [(c["bbox"][1], c["bbox"][3], c) for _, c in left_tier])],
        "v_right":[key(c) for _, _, c in non_overlapping(
                   [(c["bbox"][1], c["bbox"][3], c) for _, c in right_tier])],
    }


def _resolve_pick(rooms_by_idx: dict, pick) -> tuple | None:
    """Translate a pick entry — either a bare room_idx (legacy) or a
    (room_idx, part_idx) tuple — into (bbox, w, h). Returns None if the
    pick doesn't resolve to a known room / part."""
    if isinstance(pick, tuple):
        rid, pid = pick
    else:
        rid, pid = pick, 0
    r = rooms_by_idx.get(rid)
    if r is None:
        return None
    parts = r.get("parts") or [{"bbox_xy": r["bbox_xy"], "w": r["w"], "h": r["h"]}]
    if pid >= len(parts):
        return None
    p = parts[pid]
    return p["bbox_xy"], p["w"], p["h"]


def _apply_override(auto_start, auto_end, auto_offset, override):
    """Merge a per-dim override dict onto the auto-computed values. Each
    override field is optional — None or missing means 'use the auto value'."""
    if not override:
        return auto_start, auto_end, auto_offset
    start = override.get("start")
    if start is None:
        start = auto_start
    end = override.get("end")
    if end is None:
        end = auto_end
    offset = override.get("offset")
    if offset is None:
        offset = auto_offset
    return start, end, offset


def build_dim_svg_lines(rooms: List[dict], picks: dict,
                        overrides: dict | None = None) -> Tuple[List[str], Tuple[float, float, float, float]]:
    """Given rooms and a pick dict from pick_dims (or a user override),
    return (svg_line_strings, outer_bbox). Each pick is a (room_idx, part_idx)
    tuple pointing at a specific sub-rectangle of an L-shaped room; simple
    rooms have a single part so (rid, 0) is the norm.

    Optional `overrides` is a dict keyed by (rid, pid, side) → {start, end,
    offset}, used to honour user edits from the Studio app. Any override
    field left as None falls back to the auto-computed value."""
    if not rooms:
        return [], (0, 0, 0, 0)

    all_minx = min(r["bbox_xy"][0] for r in rooms)
    all_maxx = max(r["bbox_xy"][2] for r in rooms)
    all_miny = min(r["bbox_xy"][1] for r in rooms)
    all_maxy = max(r["bbox_xy"][3] for r in rooms)

    DIM_OFFSET = 2500
    TICK = 300
    TEXT_OFF = 350

    by_idx = {r["idx"]: r for r in rooms}
    overrides = overrides or {}

    def fmt(mm):
        return f"{mm/1000:.2f} m" if mm >= 1000 else f"{mm:.0f} mm"

    lines: List[str] = []
    top_y = all_maxy + DIM_OFFSET
    bot_y = all_miny - DIM_OFFSET
    left_x = all_minx - DIM_OFFSET
    right_x = all_maxx + DIM_OFFSET

    def h_dim(start, end, y, label, flip_label_above: bool):
        """Emit a horizontal dim line centred at y, with ticks at each end.
        flip_label_above=True places the label above the line (top-side dim),
        False places it below (bottom-side dim)."""
        lines.append(f'<line class="dim-ext" x1="{start:.0f}" y1="{y-TICK:.0f}" x2="{start:.0f}" y2="{y+TICK:.0f}"/>')
        lines.append(f'<line class="dim-ext" x1="{end:.0f}" y1="{y-TICK:.0f}" x2="{end:.0f}" y2="{y+TICK:.0f}"/>')
        lines.append(f'<line class="dim-line" x1="{start:.0f}" y1="{y:.0f}" x2="{end:.0f}" y2="{y:.0f}"/>')
        cx = (start + end) / 2
        ty = y + (TEXT_OFF if flip_label_above else -TEXT_OFF)
        lines.append(f'<text class="dim-text" x="{cx:.0f}" y="{ty:.0f}" transform="scale(1,-1) translate(0,{-2*ty:.0f})">{label}</text>')

    def v_dim(start, end, x, label, label_on_left: bool):
        lines.append(f'<line class="dim-ext" x1="{x-TICK:.0f}" y1="{start:.0f}" x2="{x+TICK:.0f}" y2="{start:.0f}"/>')
        lines.append(f'<line class="dim-ext" x1="{x-TICK:.0f}" y1="{end:.0f}" x2="{x+TICK:.0f}" y2="{end:.0f}"/>')
        lines.append(f'<line class="dim-line" x1="{x:.0f}" y1="{start:.0f}" x2="{x:.0f}" y2="{end:.0f}"/>')
        cy = (start + end) / 2
        tx = x - TEXT_OFF if label_on_left else x + TEXT_OFF
        rot = -90 if label_on_left else 90
        lines.append(f'<text class="dim-text" x="0" y="0" transform="translate({tx:.0f},{cy:.0f}) scale(1,-1) rotate({rot})" text-anchor="middle">{label}</text>')

    def side_auto_values(bbox, side):
        """Return (auto_start, auto_end, auto_offset) for a given side."""
        if side == "h_top":
            return bbox[0], bbox[2], top_y
        if side == "h_bot":
            return bbox[0], bbox[2], bot_y
        if side == "v_left":
            return bbox[1], bbox[3], left_x
        if side == "v_right":
            return bbox[1], bbox[3], right_x
        return bbox[0], bbox[2], top_y

    def draw_dim_side(side: str):
        for pick in picks.get(side, []):
            resolved = _resolve_pick(by_idx, pick)
            if not resolved:
                continue
            bbox, _w, _h = resolved
            rid = pick[0] if isinstance(pick, tuple) else pick
            pid = pick[1] if isinstance(pick, tuple) else 0
            auto_s, auto_e, auto_o = side_auto_values(bbox, side)
            start, end, off = _apply_override(
                auto_s, auto_e, auto_o, overrides.get((rid, pid, side)))
            length = abs(end - start)
            label = fmt(length)
            if side == "h_top":
                h_dim(start, end, off, label, flip_label_above=True)
            elif side == "h_bot":
                h_dim(start, end, off, label, flip_label_above=False)
            elif side == "v_left":
                v_dim(start, end, off, label, label_on_left=True)
            elif side == "v_right":
                v_dim(start, end, off, label, label_on_left=False)

    for side in ("h_top", "h_bot", "v_left", "v_right"):
        draw_dim_side(side)

    return lines, (all_minx, all_miny, all_maxx, all_maxy)


# ------------------------------ SVG emission ------------------------------

def emit_svg(recon: dict, out_dir: Path, picks: dict | None = None,
             overrides: dict | None = None) -> dict:
    """Write a dimensioned SVG for a reconstruction bundle.

    - `picks=None`    → auto-pick via pick_dims()
    - `overrides=None`→ no per-dim edits; auto bboxes used as-is
    """
    rooms = recon["rooms"]
    segs = recon["segs"]
    fp = recon["fp"]

    if not rooms:
        return None
    if picks is None:
        picks = pick_dims(rooms)

    all_minx = min(r["bbox_xy"][0] for r in rooms)
    all_maxx = max(r["bbox_xy"][2] for r in rooms)
    all_miny = min(r["bbox_xy"][1] for r in rooms)
    all_maxy = max(r["bbox_xy"][3] for r in rooms)

    dim_lines, _ = build_dim_svg_lines(rooms, picks, overrides=overrides)

    margin = 4500
    vbX = all_minx - margin
    vbY = -(all_maxy + margin)
    vbW = (all_maxx - all_minx) + margin * 2
    vbH = (all_maxy - all_miny) + margin * 2

    svg_parts = []
    svg_parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vbX:.0f} {vbY:.0f} {vbW:.0f} {vbH:.0f}" preserveAspectRatio="xMidYMid meet">'
    )
    svg_parts.append(
        "<style>"
        ".room{stroke:#0f172a;stroke-width:18;stroke-linejoin:round;fill-opacity:.6}"
        ".rname{font:bold 240px sans-serif;fill:#0f172a;text-anchor:middle}"
        ".rarea{font:180px sans-serif;fill:#334155;text-anchor:middle}"
        ".wall{stroke:#000;stroke-width:28;fill:none;stroke-linecap:square}"
        ".dim-line{stroke:#dc2626;stroke-width:15;fill:none;stroke-linecap:round}"
        ".dim-ext{stroke:#dc2626;stroke-width:15;fill:none;stroke-linecap:round}"
        ".dim-text{font:bold 260px sans-serif;fill:#dc2626;text-anchor:middle}"
        "</style>"
    )
    svg_parts.append(
        f'<rect x="{vbX:.0f}" y="{vbY:.0f}" width="{vbW:.0f}" height="{vbH:.0f}" fill="#f8fafc"/>'
    )
    svg_parts.append('<g transform="scale(1,-1)">')
    for i, r in enumerate(rooms):
        step = max(1, len(r["poly_xy"]) // 300)
        pts_txt = " ".join(f"{p[0]:.0f},{p[1]:.0f}" for p in r["poly_xy"][::step])
        hue = (i * 0.137) % 1
        R, G, B = colorsys.hsv_to_rgb(hue, 0.5, 0.96)
        col = f"#{int(R*255):02x}{int(G*255):02x}{int(B*255):02x}"
        svg_parts.append(f'<polygon class="room" points="{pts_txt}" fill="{col}"/>')

    wall_path = " ".join(f"M{a[0]:.0f} {a[1]:.0f} L{b[0]:.0f} {b[1]:.0f}" for a, b in segs)
    svg_parts.append(f'<path class="wall" d="{wall_path}"/>')

    for r in rooms:
        svg_parts.append(
            f'<text class="rname" x="{r["cx"]:.0f}" y="{r["cy"]:.0f}" transform="scale(1,-1) translate(0,{-2*r["cy"]:.0f})">{r["name"][:24]}</text>'
        )
        svg_parts.append(
            f'<text class="rarea" x="{r["cx"]:.0f}" y="{r["cy"]-240:.0f}" transform="scale(1,-1) translate(0,{-2*(r["cy"]-240):.0f})">{r["area_mm2"]/1e6:.1f} m²</text>'
        )

    svg_parts.append('<g class="dims">')
    svg_parts.extend(dim_lines)
    svg_parts.append("</g>")
    svg_parts.append("</g></svg>")
    svg = "\n".join(svg_parts)

    out_name = f"floorplan_{fp['idx']:02d}.svg"
    out_path = out_dir / out_name
    out_path.write_text(svg)

    return {
        "idx": fp["idx"],
        "file": out_name,
        "rooms": len(rooms),
        "bbox": (all_minx, all_miny, all_maxx, all_maxy),
        "area_m2": (all_maxx - all_minx) * (all_maxy - all_miny) / 1e6,
    }


# ------------------------------ Programmatic API ------------------------------

def process_input_file(
    input_path: Path,
    out_dir: Path,
    *,
    min_labels: int = 5,
    raster_mm: float = 20.0,
    log: Optional[Callable[[str], None]] = None,
    on_floorplan_progress: Optional[Callable[[str], None]] = None,
) -> dict:
    """Run the full DXF/DWG → SVG pipeline for one file.

    Each job should use its own ``out_dir`` (e.g. a subfolder per input when batching).

    Returns a dict with keys:
      ok, error (optional), input, out_dir, labels_found, floorplans_detected,
      saved, results (list of per-floorplan summaries), index_path (optional).
    """
    def L(msg: str) -> None:
        if log:
            log(msg)

    result: dict = {
        "ok": False,
        "error": None,
        "warning": None,
        "input": str(input_path.resolve()),
        "out_dir": str(out_dir.resolve()),
        "labels_found": 0,
        "floorplans_detected": 0,
        "saved": 0,
        "results": [],
        "index_path": None,
    }

    if not input_path.exists():
        result["error"] = f"file not found: {input_path}"
        return result

    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        dxf_path = input_path
        if input_path.suffix.lower() == ".dwg":
            L(f"Converting DWG → DXF ({input_path.stat().st_size / 1e6:.1f} MB)…")
            dxf_path = convert_dwg_to_dxf(input_path)

        L(f"Loading DXF ({dxf_path.stat().st_size / 1e6:.1f} MB)…")
        doc = ezdxf.readfile(str(dxf_path))
        msp = doc.modelspace()

        unit_scale = get_unit_scale(doc)
        if unit_scale != 1.0:
            L(f"Source unit scale → mm: ×{unit_scale:g}")

        # Auto-detect layer roles from the DXF's layer table. This replaces
        # hardcoded layer sets and supports any CAD standard without manual
        # additions (AIA, BS1192, Uniclass, Revit, ArchiCAD, bespoke…).
        wall_layers, insert_wall_layers, room_label_layers = _classify_layers(doc)
        L(f"Auto-detected layers: {len(wall_layers)} wall, "
          f"{len(insert_wall_layers)} insert-wall, {len(room_label_layers)} room-label")

        labels = extract_room_labels(msp, unit_scale=unit_scale,
                                     room_label_layers=room_label_layers)
        result["labels_found"] = len(labels)
        L(f"Found {len(labels)} room labels")

        floorplans = detect_floorplans(labels, min_labels)
        result["floorplans_detected"] = len(floorplans)
        if not floorplans:
            result["ok"] = True
            result["warning"] = "no floorplans with enough labels"
            L(result["warning"])
            idx_path = out_dir / "index.json"
            idx_path.write_text(json.dumps({
                "source": str(input_path.resolve()),
                "floorplans": [],
            }, indent=2))
            result["index_path"] = str(idx_path)
            return result

        L("Pre-collecting wall geometry…")
        wall_data = collect_all_walls(msp, unit_scale=unit_scale,
                                      wall_layers=wall_layers,
                                      insert_wall_layers=insert_wall_layers)
        n_segs = wall_data[0].shape[0]
        L(f"Collected {n_segs} wall segments globally")

        for fp in floorplans:
            w = (fp["maxx"] - fp["minx"]) / 1000
            h = (fp["maxy"] - fp["miny"]) / 1000
            L(
                f"  Floorplan #{fp['idx']}: {len(fp['labels'])} labels, "
                f"bbox {w:.1f}×{h:.1f} m, centre ({fp['cx']/1000:.0f}, {fp['cy']/1000:.0f})"
            )

        results: List[dict] = []
        for fp in floorplans:
            desc = f"#{fp['idx']} ({len(fp['labels'])} labels)"

            def _make_prog(d: str):
                def _prog(m: str) -> None:
                    if on_floorplan_progress:
                        on_floorplan_progress(f"{d} — {m}")
                return _prog

            try:
                res = process_floorplan(
                    wall_data, fp, out_dir, raster_mm=raster_mm,
                    on_progress=_make_prog(desc) if on_floorplan_progress else None,
                )
            except Exception as e:
                L(f"  #{fp['idx']} failed: {e}")
                res = None
            if res:
                results.append(res)
                L(f"  ✓ #{fp['idx']}: {res['rooms']} rooms → {res['file']}")
            else:
                L(f"  ⊘ #{fp['idx']}: skipped (no rooms reconstructable)")

        idx_path = out_dir / "index.json"
        idx_path.write_text(json.dumps({
            "source": str(input_path.resolve()),
            "floorplans": results,
        }, indent=2))
        result["index_path"] = str(idx_path)
        result["results"] = results
        result["saved"] = len(results)
        result["ok"] = True
        L(f"Done — {len(results)}/{len(floorplans)} floorplans saved to {out_dir}")
        return result

    except Exception as e:
        result["error"] = str(e)
        L(f"error: {e}")
        return result


# ------------------------------ CLI ------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Extract floorplans with auto dimensions from DXF/DWG.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    ap.add_argument("input", type=Path, help="Input DXF or DWG file")
    ap.add_argument("-o", "--out", type=Path, default=Path("./floorplans_out"),
                    help="Output directory (default: ./floorplans_out)")
    ap.add_argument("--min-labels", type=int, default=5,
                    help="Minimum room labels per floorplan to process (default: 5)")
    ap.add_argument("--raster-mm", type=float, default=20.0,
                    help="Raster resolution in mm/pixel. Lower = finer + slower. "
                         "Default 20 mm (15 = higher fidelity, 30 = faster)")
    args = ap.parse_args()

    if not args.input.exists():
        _print(f"[red]error:[/red] input file not found: {args.input}")
        sys.exit(1)

    _header(f"floorplan_dims → {args.input.name}")

    def plain_log(msg: str) -> None:
        if _HAS_RICH:
            _console.print(msg)
        else:
            print(msg)

    r = process_input_file(
        args.input,
        args.out,
        min_labels=args.min_labels,
        raster_mm=args.raster_mm,
        log=plain_log,
        on_floorplan_progress=None,
    )

    if r.get("warning"):
        _print(f"[yellow]{r['warning']}[/yellow]")
        sys.exit(0)

    if not r["ok"]:
        _print(f"[red]error:[/red] {r.get('error', 'unknown')}")
        sys.exit(1)

    _header(f"Done — {r['saved']}/{r['floorplans_detected']} floorplans saved to {args.out}")


if __name__ == "__main__":
    main()
