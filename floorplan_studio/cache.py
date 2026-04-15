"""On-disk cache for intermediate floorplan_studio pipeline results.

Every heavy pipeline step — DWG→DXF conversion, DXF read, wall collection,
per-floorplan reconstruction — can take minutes on a large file. Reopening
the same file later should be instant, so we pickle each step's output into
a cache directory keyed by a cheap hash of the source file.

Cache layout
------------
    ~/.cache/floorplan_studio/
        <src_hash>/
            meta.json              source path + size + mtime + cache version
            walls.pkl              wall_data tuple from collect_all_walls()
            floorplans.pkl         list[fp_dict] from detect_floorplans()
            recon_<idx>_<raster>.pkl    one per (floorplan idx, raster_mm)

`<src_hash>` is derived from the absolute path, file size and mtime — so
editing the source file produces a new hash and invalidates the old cache
automatically.
"""
from __future__ import annotations

import hashlib
import json
import pickle
import sys
from pathlib import Path

# Bump when the pickled schema changes in an incompatible way so old caches
# are rejected instead of blowing up on load.
CACHE_VERSION = 2

_CACHE_ROOT = Path.home() / ".cache" / "floorplan_studio"


def source_hash(path: Path) -> str:
    """Return a short content-identifying hash for a source file.

    Uses (absolute path, size, mtime) rather than hashing the file body so
    lookups stay O(1) even for multi-hundred-MB DWGs.
    """
    try:
        st = path.stat()
        key = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    except FileNotFoundError:
        key = str(path.resolve())
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def cache_dir_for(path: Path) -> Path:
    """Return (and create) the cache directory for the given source file."""
    d = _CACHE_ROOT / source_hash(path)
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_pickle(path: Path, obj) -> bool:
    """Pickle `obj` to `path` atomically. Returns True on success."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp.open("wb") as f:
            pickle.dump(obj, f, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(path)
        return True
    except Exception as e:
        print(f"[cache] save failed for {path}: {e}", file=sys.stderr)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        return False


def load_pickle(path: Path):
    """Load a previously-saved pickle or return None if missing/corrupt."""
    if not path.exists():
        return None
    try:
        with path.open("rb") as f:
            return pickle.load(f)
    except Exception as e:
        print(f"[cache] load failed for {path}: {e}", file=sys.stderr)
        return None


def save_meta(cache_dir: Path, meta: dict) -> bool:
    meta = {**meta, "version": CACHE_VERSION}
    try:
        (cache_dir / "meta.json").write_text(json.dumps(meta, indent=2, default=str))
        return True
    except Exception as e:
        print(f"[cache] save meta failed: {e}", file=sys.stderr)
        return False


def load_meta(cache_dir: Path) -> dict | None:
    p = cache_dir / "meta.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except Exception:
        return None
    if data.get("version") != CACHE_VERSION:
        return None  # schema mismatch → ignore old cache
    return data


def recon_path(cache_dir: Path, fp_idx: int, raster_mm: float) -> Path:
    """Pickle path for a single reconstruction bundle. Raster is encoded so
    switching between 15/20/30 mm/px gives each its own cache entry."""
    return cache_dir / f"recon_{fp_idx:03d}_{int(round(raster_mm))}.pkl"


def names_path(cache_dir: Path) -> Path:
    """Single JSON file storing user-chosen display names for every
    floorplan in this source file. Keyed by string fp idx since JSON
    object keys must be strings."""
    return cache_dir / "floorplan_names.json"


def save_floorplan_names(cache_dir: Path, names: dict) -> bool:
    """Persist a {fp_idx: display_name} mapping. Empty/None values are
    dropped so the file stays clean."""
    try:
        clean = {str(k): v for k, v in names.items() if v}
        path = names_path(cache_dir)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(clean, indent=2))
        tmp.replace(path)
        return True
    except Exception as e:
        print(f"[cache] save floorplan names failed: {e}", file=sys.stderr)
        return False


def load_floorplan_names(cache_dir: Path) -> dict[int, str] | None:
    """Return {fp_idx: display_name} from disk, or None if missing."""
    path = names_path(cache_dir)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text())
    except Exception as e:
        print(f"[cache] load floorplan names failed: {e}", file=sys.stderr)
        return None
    out: dict[int, str] = {}
    for k, v in raw.items():
        try:
            out[int(k)] = str(v)
        except Exception:
            continue
    return out


def picks_path(cache_dir: Path, fp_idx: int, raster_mm: float) -> Path:
    """JSON path for a floorplan's persisted dim selections. Tied to the
    same (fp_idx, raster) key as the recon bundle because pick identifiers
    reference (room_idx, part_idx) tuples whose meaning only makes sense
    against a specific reconstruction."""
    return cache_dir / f"picks_{fp_idx:03d}_{int(round(raster_mm))}.json"


def save_picks(path: Path, picks: dict, overrides: dict | None = None) -> bool:
    """Persist a pick set + per-dim overrides.

    JSON shape::

        {
            "version": 2,
            "picks": {"h_top": [[rid, pid], ...], ...},
            "overrides": [
                {"rid": int, "pid": int, "side": str,
                 "start": float|null, "end": float|null, "offset": float|null},
                ...
            ]
        }

    Picks are tuples → 2-element lists because JSON has no tuple.
    Overrides are stored as a flat list of dicts keyed by (rid, pid, side)
    so they survive the round trip cleanly.
    """
    try:
        picks_serial = {
            side: [
                list(p) if isinstance(p, (list, tuple)) else [p, 0]
                for p in picks_list
            ]
            for side, picks_list in picks.items()
        }
        overrides_serial = []
        for (rid, pid, side), ov in (overrides or {}).items():
            overrides_serial.append({
                "rid": rid, "pid": pid, "side": side,
                "start": ov.get("start"),
                "end": ov.get("end"),
                "offset": ov.get("offset"),
            })
        payload = {
            "version": 2,
            "picks": picks_serial,
            "overrides": overrides_serial,
        }
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(path)
        return True
    except Exception as e:
        print(f"[cache] save picks failed for {path}: {e}", file=sys.stderr)
        return False


def load_picks(path: Path):
    """Return `(picks, overrides)` from a persisted picks file, or
    `(None, None)` if the file doesn't exist or can't be read.

    Accepts both the v2 format (with overrides) and the legacy v1 format
    (flat pick lists only) — legacy files load with an empty overrides dict.
    """
    if not path.exists():
        return None, None
    try:
        raw = json.loads(path.read_text())
    except Exception as e:
        print(f"[cache] load picks failed for {path}: {e}", file=sys.stderr)
        return None, None

    picks_src = raw.get("picks", raw)   # v1 had picks at the top level
    picks: dict = {}
    for side in ("h_top", "h_bot", "v_left", "v_right"):
        lst = picks_src.get(side, []) if isinstance(picks_src, dict) else []
        picks[side] = [
            tuple(p) for p in lst
            if isinstance(p, (list, tuple)) and len(p) == 2
        ]

    overrides: dict = {}
    for ov in raw.get("overrides", []) if isinstance(raw, dict) else []:
        try:
            key = (int(ov["rid"]), int(ov["pid"]), str(ov["side"]))
        except Exception:
            continue
        overrides[key] = {
            "start":  ov.get("start"),
            "end":    ov.get("end"),
            "offset": ov.get("offset"),
        }
    return picks, overrides


def clear_cache_for(path: Path) -> int:
    """Delete every cached file for a given source. Returns the number of
    files removed (mostly for the status bar)."""
    d = _CACHE_ROOT / source_hash(path)
    if not d.exists():
        return 0
    n = 0
    for f in d.iterdir():
        try:
            f.unlink()
            n += 1
        except Exception:
            pass
    try:
        d.rmdir()
    except Exception:
        pass
    return n
