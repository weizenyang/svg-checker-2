"""Floorplan Studio — Tkinter desktop GUI.

Open a DXF or DWG, see every detected floorplan as a clickable canvas,
toggle dimensions on/off per room, export each floorplan as SVG.
"""
from __future__ import annotations

import colorsys
import csv
import shutil
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

# Import the shared pipeline from tools/floorplan_dims.py
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import ezdxf

from tools.floorplan_dims import (
    _classify_layers,
    collect_all_walls,
    convert_dwg_to_dxf,
    detect_floorplans,
    emit_svg,
    extract_room_labels,
    get_unit_scale,
    pick_dims,
    reconstruct_rooms,
)
from floorplan_studio import cache


# ------------------------------ Background worker ------------------------------
#
# Reconstruction runs in a worker *thread*, not a subprocess. An earlier
# version used ProcessPoolExecutor to bypass the GIL during the O(N²)
# line-of-sight merge, but on macOS every spawned Python subprocess
# registers itself as its own NSApplication and steals focus from the
# real Tk window.
#
# The LOS merge is now vectorized via skimage.draw.line (C, releases GIL)
# so threading is fast enough — the GIL only holds for short bursts and the
# Tk main loop stays responsive. As a bonus: no subprocess startup cost,
# no pickling wall_data across a pipe, and no focus thievery.


# ------------------------------ Viewport helpers ------------------------------

class Viewport:
    """Pan / zoom state: world (mm, Y-up) ↔ canvas (px, Y-down)."""
    def __init__(self):
        self.scale = 1.0        # px per mm
        self.offset_x = 0.0     # canvas px at world x=0
        self.offset_y = 0.0     # canvas px at world y=0

    def w2c(self, x, y):
        return (x * self.scale + self.offset_x,
                -y * self.scale + self.offset_y)

    def c2w(self, cx, cy):
        return ((cx - self.offset_x) / self.scale,
                -(cy - self.offset_y) / self.scale)

    def fit(self, minx, miny, maxx, maxy, canvas_w, canvas_h, padding=0.08):
        if maxx <= minx or maxy <= miny:
            return
        world_w = maxx - minx
        world_h = maxy - miny
        sx = canvas_w * (1 - padding * 2) / world_w
        sy = canvas_h * (1 - padding * 2) / world_h
        self.scale = max(min(sx, sy), 1e-6)
        cx = (minx + maxx) / 2
        cy = (miny + maxy) / 2
        self.offset_x = canvas_w / 2 - cx * self.scale
        self.offset_y = canvas_h / 2 + cy * self.scale


# ------------------------------ Main app ------------------------------

class FloorplanStudio:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Floorplan Studio")
        self.root.geometry("1500x950")

        # State
        # Each "entry" represents one detected floorplan and tracks its async
        # reconstruction progress. We don't process floorplans until the user
        # actually selects them — see _bg_reconstruct / _load_current.
        #     entry = {
        #         'fp':     floorplan dict (bbox, labels, idx, …),
        #         'status': 'pending' | 'processing' | 'ready' | 'failed',
        #         'recon':  reconstruction bundle (set when ready),
        #         'picks':  dim pick set (set when ready),
        #         'error':  error message (set when failed),
        #     }
        self.entries: list[dict] = []
        self.wall_data: tuple | None = None   # shared across floorplans
        self.current_path: Path | None = None  # currently open source file (for cache)
        self.raster_mm: float = 20.0
        self.current_entry: dict | None = None
        self.current: dict | None = None      # convenience alias: current_entry['recon']
        self.viewport = Viewport()
        self.pan_anchor = None
        self.hover_idx: int | None = None
        self._item_to_room: dict[int, int] = {}
        self._is_loading_file = False
        # Active dim-drag state. None when not dragging; otherwise:
        #   {
        #     "rid": int, "pid": int, "side": str, "component": "start"|"end"|"body",
        #     "orig_override": dict,   # the override dict before drag started
        #     "moved": bool,           # did the pointer actually move?
        #   }
        self._dim_drag: dict | None = None
        # Unified left-button press state for click-vs-drag disambiguation.
        # Set on ButtonPress-1, consumed on ButtonRelease-1.
        #   None          – idle
        #   {"kind":"pan", ...}           – panning the viewport
        #   {"kind":"room_pending", ...}  – pressed on a room, might be
        #                                   click (toggle) or drag (pan)
        self._press_state: dict | None = None
        # Tracks whether the app currently has macOS foreground focus.
        # Flipped by <Activate>/<Deactivate> on the root window. Used by
        # the focus indicator overlay so the user can see at a glance
        # that the next click will be eaten by macOS as an activation
        # click and won't reach the canvas.
        self._is_app_active: bool = True
        # Temporary Entry widget used for inline floorplan renaming.
        # Created on double-click of a listbox row, destroyed on commit
        # (Return / FocusOut) or cancel (Escape).
        self._rename_editor: tk.Entry | None = None
        self._rename_target_idx: int | None = None
        # Single-worker thread pool used for every reconstruction. Created
        # lazily on the first file load so the app starts fast. Rebuilt on
        # close or when the user opens a new file (we throw the old one away
        # so any in-flight work is abandoned).
        self._executor: ThreadPoolExecutor | None = None
        # Map entry index → Future so we can tell which floorplans are in flight.
        self._futures: dict[int, Future] = {}
        # When True (default), rooms use their tail-trimmed bbox for
        # dimensioning so narrow protrusions don't inflate dim lines.
        self.ignore_tails_var: tk.BooleanVar  # created in _build_ui

        self._build_ui()
        self._bind_events()

        # Ensure the thread pool is torn down when the window closes.
        self.root.protocol("WM_DELETE_WINDOW", self._on_quit)

        # macOS: handle files dropped onto the Dock icon or opened via
        # Finder "Open With…". This is a built-in Tk callback — no
        # external package needed. Silently ignored on non-macOS.
        try:
            self.root.createcommand(
                "::tk::mac::OpenDocument", self._on_mac_open_document)
        except Exception:
            pass

        # Auto-open a file passed on the command line, otherwise paint
        # the empty-state drop hint so the user has somewhere to drop on.
        if len(sys.argv) > 1:
            p = Path(sys.argv[1])
            if p.exists():
                self.root.after(100, lambda: self.load_file(p))
        else:
            self.root.after(50, self._redraw)

    # ---- UI construction ----

    def _build_ui(self):
        # Menu bar
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)
        filemenu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="File", menu=filemenu)
        filemenu.add_command(label="Open DXF/DWG…", command=self._cmd_open, accelerator="⌘O")
        filemenu.add_command(label="Save SVG dims only (current)…",
                             command=self._cmd_save_dims_svg_current, accelerator="⌘D")
        filemenu.add_command(label="Save SVG dims only (all)…",
                             command=self._cmd_save_dims_svg_all, accelerator="⌘⇧D")
        filemenu.add_separator()
        filemenu.add_command(label="Save SVG full (current)…", command=self._cmd_save_current, accelerator="⌘S")
        filemenu.add_command(label="Save SVG full (all)…", command=self._cmd_save_all, accelerator="⌘⇧S")
        filemenu.add_separator()
        filemenu.add_command(label="Export dimensions (current floorplan)…",
                             command=self._cmd_export_dims_current,
                             accelerator="⌘E")
        filemenu.add_command(label="Export dimensions (all floorplans)…",
                             command=self._cmd_export_dims_all,
                             accelerator="⌘⇧E")
        filemenu.add_separator()
        filemenu.add_command(label="Clear cache for this file", command=self._cmd_clear_cache)
        filemenu.add_separator()
        filemenu.add_command(label="Quit", command=self._on_quit, accelerator="⌘Q")

        # Main horizontal layout
        paned = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True)

        # Left sidebar
        sidebar = ttk.Frame(paned, width=260)
        paned.add(sidebar, weight=0)

        ttk.Label(sidebar, text="Floorplans", font=("Helvetica", 13, "bold")).pack(
            padx=12, pady=(12, 4), anchor=tk.W)

        listframe = ttk.Frame(sidebar)
        listframe.pack(fill=tk.X, padx=12)
        self.fp_list = tk.Listbox(listframe, height=12, exportselection=False,
                                   activestyle="dotbox", relief="flat", borderwidth=1,
                                   highlightthickness=1)
        self.fp_list.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        sb = ttk.Scrollbar(listframe, orient=tk.VERTICAL, command=self.fp_list.yview)
        sb.pack(side=tk.RIGHT, fill=tk.Y)
        self.fp_list.config(yscrollcommand=sb.set)
        self.fp_list.bind("<<ListboxSelect>>", self._on_fp_select)
        # Double-click an entry → rename it. Persists across reopens.
        self.fp_list.bind("<Double-Button-1>", self._on_fp_rename)

        ttk.Separator(sidebar, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=14)

        ttk.Label(sidebar, text="Dimensions", font=("Helvetica", 13, "bold")).pack(
            padx=12, pady=(0, 4), anchor=tk.W)
        ttk.Label(sidebar,
                  text="Left-click a room to toggle dims.\n"
                       "Two-finger / Ctrl+click → choose side.\n"
                       "Drag dim ticks to resize, body to move.\n"
                       "Hold ⌥ Option while dragging → no snap.\n\n"
                       "Shift+drag to pan, wheel to zoom.",
                  wraplength=230, foreground="#475569", justify=tk.LEFT).pack(padx=12, anchor=tk.W)

        btns = ttk.Frame(sidebar)
        btns.pack(fill=tk.X, padx=12, pady=10)
        ttk.Button(btns, text="Auto-pick dims", command=self._cmd_auto_pick).pack(fill=tk.X, pady=2)
        ttk.Button(btns, text="Clear all dims", command=self._cmd_clear_dims).pack(fill=tk.X, pady=2)
        ttk.Button(btns, text="Fit view", command=self._cmd_fit_view).pack(fill=tk.X, pady=2)

        # Tail-trimming toggle. ON by default — rooms with thin protrusions
        # (e.g. the LIVING/DINING ‘tail’ wrapping behind the terrace) are
        # dimensioned by their trimmed bbox, not the full shape. The drawn
        # polygon still shows the full room; only the dim ranges change.
        self.ignore_tails_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            sidebar,
            text="Ignore trailing tails for dims",
            variable=self.ignore_tails_var,
            command=self._cmd_toggle_tails,
        ).pack(padx=12, pady=(4, 8), anchor=tk.W)

        # ---- Export buttons ----
        ttk.Separator(sidebar, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=14)
        ttk.Label(sidebar, text="Export", font=("Helvetica", 13, "bold")).pack(
            padx=12, pady=(0, 6), anchor=tk.W)
        export_btns = ttk.Frame(sidebar)
        export_btns.pack(fill=tk.X, padx=12, pady=(0, 4))
        # ttk.Button(export_btns, text="Export dims (current)…",
        #            command=self._cmd_export_dims_current).pack(fill=tk.X, pady=2)
        # ttk.Button(export_btns, text="Export dims (all)…",
        #            command=self._cmd_export_dims_all).pack(fill=tk.X, pady=2)
        ttk.Button(export_btns, text="Save SVG dims only (current)…",
                   command=self._cmd_save_dims_svg_current).pack(fill=tk.X, pady=(8, 2))
        ttk.Button(export_btns, text="Save SVG dims only (all)…",
                   command=self._cmd_save_dims_svg_all).pack(fill=tk.X, pady=2)
        ttk.Button(export_btns, text="Save SVG full (current)…",
                   command=self._cmd_save_current).pack(fill=tk.X, pady=(8, 2))
        ttk.Button(export_btns, text="Save SVG full (all)…",
                   command=self._cmd_save_all).pack(fill=tk.X, pady=2)

        ttk.Separator(sidebar, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=14)

        self.info_var = tk.StringVar(value="No file loaded.")
        ttk.Label(sidebar, textvariable=self.info_var, wraplength=230,
                  foreground="#334155", justify=tk.LEFT).pack(padx=12, anchor=tk.W)

        # Main canvas with its own status bar
        right = ttk.Frame(paned)
        paned.add(right, weight=1)

        self.canvas = tk.Canvas(right, bg="#f8fafc", highlightthickness=0, cursor="arrow")
        self.canvas.pack(fill=tk.BOTH, expand=True)

        self.status = tk.StringVar(
            value="Drop a file onto the Dock icon, or click the canvas to open."
        )
        statbar = ttk.Frame(right)
        statbar.pack(fill=tk.X)
        ttk.Label(statbar, textvariable=self.status, anchor=tk.W, padding=(10, 4),
                  foreground="#64748b").pack(side=tk.LEFT, fill=tk.X, expand=True)

    def _bind_events(self):
        self.root.bind_all("<Command-o>", lambda e: self._cmd_open())
        self.root.bind_all("<Control-o>", lambda e: self._cmd_open())
        self.root.bind_all("<Command-s>", lambda e: self._cmd_save_current())
        self.root.bind_all("<Control-s>", lambda e: self._cmd_save_current())
        self.root.bind_all("<Command-Shift-s>", lambda e: self._cmd_save_all())
        self.root.bind_all("<Control-Shift-s>", lambda e: self._cmd_save_all())
        self.root.bind_all("<Command-d>", lambda e: self._cmd_save_dims_svg_current())
        self.root.bind_all("<Control-d>", lambda e: self._cmd_save_dims_svg_current())
        self.root.bind_all("<Command-Shift-d>", lambda e: self._cmd_save_dims_svg_all())
        self.root.bind_all("<Control-Shift-d>", lambda e: self._cmd_save_dims_svg_all())
        self.root.bind_all("<Command-e>", lambda e: self._cmd_export_dims_current())
        self.root.bind_all("<Control-e>", lambda e: self._cmd_export_dims_current())
        self.root.bind_all("<Command-Shift-e>", lambda e: self._cmd_export_dims_all())
        self.root.bind_all("<Control-Shift-e>", lambda e: self._cmd_export_dims_all())
        self.root.bind_all("<Command-q>", lambda e: self._on_quit())

        self.canvas.bind("<Configure>", self._on_canvas_resize)

        # macOS first-click-activation bug: when the user switches away from
        # the Studio and then back (Cmd-Tab, Dock click), the first click
        # on the canvas is swallowed by macOS to activate the window and
        # never reaches our widgets. Tk on macOS doesn't override
        # NSView's `acceptsFirstMouse:` so we cannot fix it directly —
        # instead we (a) try to recover focus aggressively on the
        # `<Activate>` event, and (b) show a clear visual indicator on
        # the canvas while the app is inactive so the user knows the next
        # click will be eaten.
        self.root.bind("<Activate>", self._on_app_activated, add="+")
        self.root.bind("<Deactivate>", self._on_app_deactivated, add="+")
        self.root.bind("<FocusIn>", self._on_root_focus_in, add="+")
        self.root.bind("<FocusOut>", self._on_root_focus_out, add="+")
        # Mouse entering the canvas should also try to grab focus, but it
        # must NOT flip the active-state flag — moving the mouse around
        # doesn't actually re-activate the app at the OS level.
        self.canvas.bind("<Enter>", self._on_canvas_enter, add="+")

        # Left-click on canvas: find a room under the cursor and toggle its dim.
        # This is done via find_overlapping (walks the z-stack) rather than
        # tag_bind on the polygon, because text labels on top of rooms would
        # otherwise swallow the click.
        # Unified left-button: press → motion → release. Disambiguates
        # click (toggle room) from drag (pan viewport) automatically.
        # Dim handle drags are handled by tag_bind in _draw_dims which
        # fires first and returns "break" to suppress these handlers.
        self.canvas.bind("<ButtonPress-1>", self._on_canvas_press)
        self.canvas.bind("<B1-Motion>", self._on_canvas_motion)
        self.canvas.bind("<ButtonRelease-1>", self._on_canvas_release)

        # Right-click / Ctrl+click / two-finger-click on a room: context menu
        # to choose which side each dim lives on (top/bottom/left/right).
        self.canvas.bind("<Button-2>", self._on_room_context_menu)
        self.canvas.bind("<Button-3>", self._on_room_context_menu)
        self.canvas.bind("<Control-Button-1>", self._on_room_context_menu)
        # Zoom with mouse wheel (macOS sends <MouseWheel>, linux sends Button-4/5)
        self.canvas.bind("<MouseWheel>", self._on_zoom)
        self.canvas.bind("<Button-4>", self._on_zoom)
        self.canvas.bind("<Button-5>", self._on_zoom)
        # Report world coords under the cursor
        self.canvas.bind("<Motion>", self._on_motion)

    # ---- Commands ----

    def _cmd_open(self):
        path = filedialog.askopenfilename(
            title="Open DXF or DWG",
            filetypes=[("CAD files", "*.dxf *.dwg"),
                       ("DXF", "*.dxf"), ("DWG", "*.dwg"),
                       ("All files", "*.*")],
        )
        if path:
            self.load_file(Path(path))

    def _cmd_save_current(self):
        if self.current is None:
            messagebox.showinfo("Nothing to save", "Open a file and select a floorplan first.")
            return
        path = filedialog.asksaveasfilename(
            title="Save floorplan as SVG",
            defaultextension=".svg",
            filetypes=[("SVG", "*.svg")],
            initialfile=f"floorplan_{self.current['fp']['idx']:02d}.svg",
        )
        if not path:
            return
        out_path = Path(path)
        picks = self.current_entry["picks"]
        overrides = self.current_entry.get("overrides") or {}
        # emit_svg writes `floorplan_NN.svg` inside out_dir by default; we want
        # an exact path instead, so we run it into a temp dir then move the file.
        import tempfile, shutil
        with tempfile.TemporaryDirectory() as td:
            res = emit_svg(self.current, Path(td), picks=picks, overrides=overrides)
            src = Path(td) / res["file"]
            shutil.copy(src, out_path)
        self.status.set(f"Saved → {out_path}")

    # ---- Dims-only SVG export ----

    def _cmd_save_dims_svg_current(self):
        """Export ONLY the dimension lines/ticks/labels as a standalone SVG.
        No rooms, no walls — just the measurements. Useful as an overlay
        that can be placed on top of another drawing."""
        if self.current_entry is None or self.current is None:
            messagebox.showinfo("Nothing to save",
                "Select a processed floorplan first.")
            return
        picks = self.current_entry.get("picks")
        if not picks or not any(picks.values()):
            messagebox.showinfo("No dimensions",
                "Add some dimensions first (click rooms).")
            return

        default_name = (
            (self.current_entry.get("display_name")
             or f"floorplan_{self.current_entry['fp']['idx']:02d}")
            .replace("/", "-").replace(" ", "_")
            + "_dims.svg"
        )
        path = filedialog.asksaveasfilename(
            title="Save dimensions SVG",
            defaultextension=".svg",
            filetypes=[("SVG", "*.svg")],
            initialfile=default_name,
        )
        if not path:
            return

        rooms = self.current["rooms"]
        overrides = self.current_entry.get("overrides") or {}

        from tools.floorplan_dims import build_dim_svg_lines
        dim_lines, (minx, miny, maxx, maxy) = build_dim_svg_lines(
            rooms, picks, overrides=overrides)

        if not dim_lines:
            messagebox.showinfo("No dimensions",
                "No dimension lines were generated.")
            return

        # Build a minimal SVG containing only the dim elements.
        # Use the same coordinate system as the full SVG (world mm,
        # Y-flipped via scale(1,-1)) so the dims overlay aligns pixel-
        # perfectly if the user layers it on top of the full export.
        margin = 4500
        vbX = minx - margin
        vbY = -(maxy + margin)
        vbW = (maxx - minx) + margin * 2
        vbH = (maxy - miny) + margin * 2

        svg_parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg"'
            f' viewBox="{vbX:.0f} {vbY:.0f} {vbW:.0f} {vbH:.0f}"'
            f' preserveAspectRatio="xMidYMid meet">',
            "<style>"
            ".dim-line{stroke:#dc2626;stroke-width:15;fill:none;stroke-linecap:round}"
            ".dim-ext{stroke:#dc2626;stroke-width:15;fill:none;stroke-linecap:round}"
            ".dim-text{font:bold 260px sans-serif;fill:#dc2626;text-anchor:middle}"
            "</style>",
            '<g transform="scale(1,-1)">',
        ]
        svg_parts.extend(dim_lines)
        svg_parts.append("</g></svg>")

        Path(path).write_text("\n".join(svg_parts))
        self.status.set(f"Saved dims SVG → {path}")

    def _cmd_save_dims_svg_all(self):
        """Export dims-only SVGs for every ready floorplan into a directory."""
        ready = [e for e in self.entries if e.get("status") == "ready"]
        if not ready:
            messagebox.showinfo("Nothing to save",
                "No floorplans are processed yet.")
            return
        out_dir = filedialog.askdirectory(title="Choose output directory for dims SVGs")
        if not out_dir:
            return
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        from tools.floorplan_dims import build_dim_svg_lines

        saved = 0
        skipped = 0
        for entry in ready:
            picks = entry.get("picks")
            if not picks or not any(picks.values()):
                skipped += 1
                continue
            rooms = entry["recon"]["rooms"]
            overrides = entry.get("overrides") or {}
            dim_lines, (minx, miny, maxx, maxy) = build_dim_svg_lines(
                rooms, picks, overrides=overrides)
            if not dim_lines:
                skipped += 1
                continue

            margin = 4500
            vbX = minx - margin
            vbY = -(maxy + margin)
            vbW = (maxx - minx) + margin * 2
            vbH = (maxy - miny) + margin * 2

            svg_parts = [
                f'<svg xmlns="http://www.w3.org/2000/svg"'
                f' viewBox="{vbX:.0f} {vbY:.0f} {vbW:.0f} {vbH:.0f}"'
                f' preserveAspectRatio="xMidYMid meet">',
                "<style>"
                ".dim-line{stroke:#dc2626;stroke-width:15;fill:none;stroke-linecap:round}"
                ".dim-ext{stroke:#dc2626;stroke-width:15;fill:none;stroke-linecap:round}"
                ".dim-text{font:bold 260px sans-serif;fill:#dc2626;text-anchor:middle}"
                "</style>",
                '<g transform="scale(1,-1)">',
            ]
            svg_parts.extend(dim_lines)
            svg_parts.append("</g></svg>")

            name = (
                (entry.get("display_name")
                 or f"floorplan_{entry['fp']['idx']:02d}")
                .replace("/", "-").replace(" ", "_")
                + "_dims.svg"
            )
            (out_dir / name).write_text("\n".join(svg_parts))
            saved += 1

        msg = f"Saved {saved} dims SVG(s) to {out_dir}"
        if skipped:
            msg += f" ({skipped} skipped — no active dims)"
        messagebox.showinfo("Done", msg)
        self.status.set(msg)

    # ---- PNG export ----

    @staticmethod
    def _svg_to_png(svg_path: Path, png_path: Path, width: int = 4096) -> bool:
        """Convert an SVG file to PNG via a fallback chain. Returns True
        on success. Tries (in order):
          1. cairosvg   (pip install cairosvg — best quality)
          2. rsvg-convert (brew install librsvg — common on macOS/Linux)
          3. qlmanage     (built into macOS — zero-install fallback)
        """
        # 1. cairosvg
        try:
            import cairosvg  # type: ignore
            cairosvg.svg2png(
                url=str(svg_path), write_to=str(png_path), output_width=width)
            return True
        except Exception:
            pass

        # 2. rsvg-convert
        try:
            subprocess.run(
                ["rsvg-convert", "-w", str(width),
                 "-o", str(png_path), str(svg_path)],
                check=True, capture_output=True,
            )
            if png_path.exists():
                return True
        except Exception:
            pass

        # 3. qlmanage (macOS Quick Look — always available on macOS)
        try:
            with tempfile.TemporaryDirectory() as td:
                subprocess.run(
                    ["qlmanage", "-t", "-s", str(width),
                     "-o", td, str(svg_path)],
                    check=True, capture_output=True,
                )
                ql_out = Path(td) / (svg_path.name + ".png")
                if ql_out.exists():
                    shutil.copy(ql_out, png_path)
                    return True
        except Exception:
            pass

        return False

    def _export_entry_as_png(self, entry: dict, out_path: Path,
                              width: int = 4096) -> bool:
        """Render one entry to PNG by emitting a temp SVG then converting.
        Returns True on success."""
        picks = entry.get("picks")
        overrides = entry.get("overrides") or {}
        with tempfile.TemporaryDirectory() as td:
            res = emit_svg(entry["recon"], Path(td),
                           picks=picks, overrides=overrides)
            if res is None:
                return False
            svg_path = Path(td) / res["file"]
            return self._svg_to_png(svg_path, out_path, width=width)

    def _cmd_save_png_current(self):
        if self.current_entry is None or self.current is None:
            messagebox.showinfo("Nothing to save",
                "Select a processed floorplan first.")
            return
        default_name = (
            (self.current_entry.get("display_name")
             or f"floorplan_{self.current_entry['fp']['idx']:02d}")
            .replace("/", "-").replace(" ", "_")
            + ".png"
        )
        path = filedialog.asksaveasfilename(
            title="Save floorplan as PNG",
            defaultextension=".png",
            filetypes=[("PNG image", "*.png")],
            initialfile=default_name,
        )
        if not path:
            return
        self.status.set("Rendering PNG…")
        self.root.update_idletasks()
        ok = self._export_entry_as_png(self.current_entry, Path(path))
        if ok:
            self.status.set(f"Saved PNG → {path}")
        else:
            messagebox.showerror(
                "PNG export failed",
                "Could not convert SVG to PNG.\n\n"
                "Install one of these for PNG support:\n"
                "  pip install cairosvg\n"
                "  brew install librsvg\n"
                "(macOS qlmanage was also tried)",
            )
            self.status.set("PNG export failed — see error dialog.")

    def _cmd_save_png_all(self):
        ready = [e for e in self.entries if e.get("status") == "ready"]
        if not ready:
            messagebox.showinfo("Nothing to save",
                "No floorplans are processed yet.")
            return
        out_dir = filedialog.askdirectory(title="Choose output directory for PNGs")
        if not out_dir:
            return
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        self.status.set("Rendering PNGs…")
        self.root.update_idletasks()
        saved = 0
        failed = 0
        for entry in ready:
            name = (
                (entry.get("display_name")
                 or f"floorplan_{entry['fp']['idx']:02d}")
                .replace("/", "-").replace(" ", "_")
                + ".png"
            )
            ok = self._export_entry_as_png(entry, out_dir / name)
            if ok:
                saved += 1
            else:
                failed += 1
        if failed and saved == 0:
            messagebox.showerror(
                "PNG export failed",
                "Could not convert any SVGs to PNG.\n\n"
                "Install one of these:\n"
                "  pip install cairosvg\n"
                "  brew install librsvg",
            )
            self.status.set("PNG export failed.")
        else:
            msg = f"Saved {saved} PNG(s) to {out_dir}"
            if failed:
                msg += f" ({failed} failed)"
            messagebox.showinfo("Done", msg)
            self.status.set(msg)

    # ---- Dim CSV export ----

    # Columns emitted by _collect_dim_rows(). Kept as a class const so the
    # "current" and "all" commands share the same header.
    _DIM_CSV_HEADER = (
        "floorplan", "room", "side", "part", "length_m",
        "start_mm", "end_mm", "offset_mm",
    )

    def _format_side(self, side: str) -> str:
        return {"h_top": "top", "h_bot": "bottom",
                "v_left": "left", "v_right": "right"}.get(side, side)

    def _collect_dim_rows(self, entry: dict) -> list[list]:
        """Return a list of CSV rows describing every active dim on the
        given entry. Uses _effective_dim (via a temporary context switch
        to this entry) so user overrides are honoured in the output."""
        if entry.get("recon") is None or entry.get("picks") is None:
            return []
        # _effective_dim reads self.current / self.current_entry, so point
        # them at this entry for the duration of the collection and
        # restore afterwards. This keeps the helper pure-read with no
        # duplicated logic.
        prev_current = self.current
        prev_entry = self.current_entry
        self.current = entry["recon"]
        self.current_entry = entry
        try:
            rooms_by_idx = {r["idx"]: r for r in entry["recon"]["rooms"]}
            fp_label = entry.get("display_name") or f"#{entry['fp']['idx']:02d}"
            rows: list[list] = []
            picks = entry["picks"]
            for side in ("h_top", "h_bot", "v_left", "v_right"):
                for pick in picks.get(side, []):
                    rid = pick[0] if isinstance(pick, tuple) else pick
                    pid = pick[1] if isinstance(pick, tuple) else 0
                    room = rooms_by_idx.get(rid)
                    if room is None:
                        continue
                    eff = self._effective_dim(rid, pid, side)
                    if eff is None:
                        continue
                    start, end, offset = eff
                    length_mm = abs(end - start)
                    rows.append([
                        fp_label,
                        room.get("name", ""),
                        self._format_side(side),
                        pid,
                        f"{length_mm / 1000:.3f}",
                        f"{start:.0f}",
                        f"{end:.0f}",
                        f"{offset:.0f}",
                    ])
            # Stable sort for a predictable output: by side then room name
            rows.sort(key=lambda r: (r[2], r[1]))
            return rows
        finally:
            self.current = prev_current
            self.current_entry = prev_entry

    def _write_csv(self, path: Path, all_rows: list[list]) -> None:
        with path.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(self._DIM_CSV_HEADER)
            for r in all_rows:
                w.writerow(r)

    def _cmd_export_dims_current(self):
        """Write a CSV of every active dim on the currently selected
        floorplan. Asks the user for a destination via Save dialog."""
        if self.current_entry is None or self.current_entry.get("picks") is None:
            messagebox.showinfo("Nothing to export",
                "Select a processed floorplan first.")
            return
        rows = self._collect_dim_rows(self.current_entry)
        if not rows:
            messagebox.showinfo("No dimensions",
                "The selected floorplan has no active dimensions to export.")
            return
        default_name = (
            (self.current_entry.get("display_name")
             or f"floorplan_{self.current_entry['fp']['idx']:02d}")
            .replace("/", "-").replace(" ", "_")
            + "_dims.csv"
        )
        path = filedialog.asksaveasfilename(
            title="Export dimensions (current floorplan)",
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile=default_name,
        )
        if not path:
            return
        self._write_csv(Path(path), rows)
        self.status.set(f"Exported {len(rows)} dim(s) → {path}")

    def _cmd_export_dims_all(self):
        """Write a single CSV with every active dim across every
        ready floorplan, with the floorplan column identifying origin."""
        ready = [e for e in self.entries if e.get("status") == "ready"]
        if not ready:
            messagebox.showinfo("Nothing to export",
                "No floorplans are processed yet.")
            return
        all_rows: list[list] = []
        for entry in ready:
            all_rows.extend(self._collect_dim_rows(entry))
        if not all_rows:
            messagebox.showinfo("No dimensions",
                "None of the floorplans have active dimensions to export.")
            return
        default_name = "all_floorplans_dims.csv"
        if self.current_path is not None:
            default_name = f"{self.current_path.stem}_dims.csv"
        path = filedialog.asksaveasfilename(
            title="Export dimensions (all floorplans)",
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile=default_name,
        )
        if not path:
            return
        self._write_csv(Path(path), all_rows)
        self.status.set(
            f"Exported {len(all_rows)} dim(s) across {len(ready)} floorplan(s) → {path}"
        )

    def _cmd_save_all(self):
        ready = [e for e in self.entries if e["status"] == "ready"]
        if not ready:
            if not self.entries:
                messagebox.showinfo("Nothing to save", "Open a file first.")
                return
            messagebox.showinfo(
                "Nothing to save",
                "No floorplans have been reconstructed yet.\n"
                "Click each floorplan in the sidebar first to process it, "
                "then try again.",
            )
            return
        out_dir = filedialog.askdirectory(title="Choose output directory")
        if not out_dir:
            return
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        saved = 0
        for entry in ready:
            res = emit_svg(
                entry["recon"],
                out_dir,
                picks=entry["picks"],
                overrides=entry.get("overrides") or {},
            )
            if res:
                saved += 1
        messagebox.showinfo("Saved", f"Wrote {saved} floorplan SVG(s) to {out_dir}")
        self.status.set(f"Saved {saved} SVG(s) to {out_dir}")

    def _cmd_auto_pick(self):
        if self.current is None or self.current_entry is None:
            return
        self.current_entry["picks"] = pick_dims(self.current["rooms"])
        self._redraw()
        self._save_entry_picks(self.current_entry)
        self.status.set("Auto-picked dimensions.")

    def _cmd_clear_cache(self):
        """Wipe every cached pickle for the currently open file. Next open
        will re-run the full pipeline from scratch. Useful when the pipeline
        code itself changed and older cached results are stale."""
        if self.current_path is None:
            messagebox.showinfo("Nothing to clear",
                "Open a file first. The cache is stored per source file.")
            return
        n = cache.clear_cache_for(self.current_path)
        if n == 0:
            self.status.set(f"No cache to clear for {self.current_path.name}")
        else:
            self.status.set(
                f"Cleared {n} cached file(s) for {self.current_path.name}. "
                "Re-open the file to reprocess from scratch."
            )

    def _cmd_toggle_tails(self):
        """Swap the active bbox on every room in every already-reconstructed
        floorplan based on the checkbox, then redraw the current view. Any
        floorplan that hasn't been processed yet will inherit the new default
        via `_apply_tail_mode` as soon as it finishes reconstructing."""
        mode_trim = bool(self.ignore_tails_var.get())
        for entry in self.entries:
            if entry.get("recon") is not None:
                self._apply_tail_mode(entry["recon"]["rooms"], trim=mode_trim)
        if self.current is not None:
            self._redraw()
        self.status.set(
            "Dim bboxes trimmed (tails ignored)." if mode_trim
            else "Dim bboxes use full room shape."
        )

    @staticmethod
    def _apply_tail_mode(rooms: list[dict], *, trim: bool) -> None:
        """Point each room's active bbox + parts at either the trimmed or
        the full variant. In full mode every room has exactly one part
        (the full bbox); in trim mode multi-part rooms expose all their
        arms so they can be dimensioned independently."""
        for r in rooms:
            if trim and "bbox_trim" in r:
                r["bbox_xy"] = r["bbox_trim"]
                r["w"] = r["w_trim"]
                r["h"] = r["h_trim"]
                if "parts_trim" in r:
                    r["parts"] = r["parts_trim"]
            elif "bbox_full" in r:
                r["bbox_xy"] = r["bbox_full"]
                r["w"] = r["w_full"]
                r["h"] = r["h_full"]
                if "parts_full" in r:
                    r["parts"] = r["parts_full"]

    def _cmd_clear_dims(self):
        if self.current is None or self.current_entry is None:
            return
        self.current_entry["picks"] = {"h_top": [], "h_bot": [], "v_left": [], "v_right": []}
        self.current_entry["overrides"] = {}
        self._draw_dims()
        self._save_entry_picks(self.current_entry)
        self.status.set("Cleared all dimensions.")

    def _cmd_fit_view(self):
        if self.current is None:
            return
        self._fit_view_to_current()
        self._redraw()

    # ---- File loading ----

    # ---- Async load / reconstruct ----

    def _post(self, fn):
        """Marshal a callable from a worker thread back to the Tk main loop."""
        try:
            self.root.after(0, fn)
        except Exception:
            pass

    # ---- Persistent pick storage ----

    def _save_entry_picks(self, entry: dict | None) -> None:
        """Persist the entry's current dim selections AND per-dim overrides
        so reopening the file restores everything verbatim."""
        if self.current_path is None or entry is None:
            return
        picks = entry.get("picks")
        if picks is None:
            return
        overrides = entry.get("overrides") or {}
        try:
            cache_dir = cache.cache_dir_for(self.current_path)
            ppath = cache.picks_path(cache_dir, entry["fp"]["idx"], self.raster_mm)
            cache.save_picks(ppath, picks, overrides)
        except Exception as e:
            print(f"[cache] picks save failed for fp {entry['fp']['idx']}: {e}")

    def _load_saved_picks(self, entry: dict):
        """Return `(picks, overrides)` restored from disk for this floorplan,
        or `(None, None)` if nothing is saved. Both payloads are validated
        against the current reconstruction: picks referencing missing rooms
        or parts are dropped; overrides attached to missing (rid, pid, side)
        triples are dropped too."""
        if self.current_path is None or entry.get("recon") is None:
            return None, None
        try:
            cache_dir = cache.cache_dir_for(self.current_path)
            ppath = cache.picks_path(cache_dir, entry["fp"]["idx"], self.raster_mm)
            picks, overrides = cache.load_picks(ppath)
        except Exception as e:
            print(f"[cache] picks load failed for fp {entry['fp']['idx']}: {e}")
            return None, None
        if picks is None:
            return None, None

        valid_keys = set()
        for r in entry["recon"]["rooms"]:
            parts = r.get("parts") or [None]
            for pi in range(len(parts)):
                valid_keys.add((r["idx"], pi))

        validated_picks = {
            side: [p for p in picks.get(side, []) if p in valid_keys]
            for side in ("h_top", "h_bot", "v_left", "v_right")
        }
        if not any(validated_picks.values()):
            return None, None

        validated_overrides = {
            (rid, pid, side): ov
            for (rid, pid, side), ov in (overrides or {}).items()
            if (rid, pid) in valid_keys and side in ("h_top", "h_bot", "v_left", "v_right")
        }
        return validated_picks, validated_overrides

    # ---- macOS "Open Document" (Dock drop / Finder "Open With") ----

    def _on_mac_open_document(self, *args):
        """Called by Tk when macOS delivers one or more files via the
        ::tk::mac::OpenDocument protocol (Dock icon drop, Finder "Open
        With…", or `open -a` from the terminal). Loads the first .dxf
        or .dwg it finds."""
        for arg in args:
            p = Path(str(arg))
            if p.suffix.lower() in (".dxf", ".dwg") and p.exists():
                self.load_file(p)
                return
        # If none matched, update the status bar
        if args:
            self.status.set(f"Not a .dxf or .dwg: {args[0]}")

    # ---- Inline floorplan rename ----

    def _on_fp_rename(self, event):
        """Double-click handler on the floorplan listbox. Overlays an Entry
        widget on top of the clicked row so the user can edit the name in
        place. Return commits, Escape cancels, losing focus commits."""
        # Cancel any rename already in progress
        if self._rename_editor is not None:
            self._cancel_rename()

        idx = self.fp_list.nearest(event.y)
        if idx < 0 or idx >= len(self.entries):
            return
        bbox = self.fp_list.bbox(idx)
        if not bbox:
            return  # row not visible
        x, y, w, h = bbox

        # Compose a parent-relative geometry — the listbox is inside a
        # Frame inside the sidebar inside the paned window, so the
        # overlay needs to be placed on the listbox's own coordinate
        # space. tk.Entry(parent=listbox) + place() works cleanly.
        entry_widget = tk.Entry(
            self.fp_list,
            borderwidth=1,
            relief="solid",
            font=("Helvetica", -15),
        )
        current = (self.entries[idx].get("display_name")
                   or f"#{self.entries[idx]['fp']['idx']:02d}")
        entry_widget.insert(0, current)
        entry_widget.select_range(0, tk.END)
        entry_widget.icursor(tk.END)
        entry_widget.place(x=x, y=y, width=max(w, 220), height=h + 2)
        entry_widget.focus_set()

        entry_widget.bind("<Return>",  lambda e: self._commit_rename())
        entry_widget.bind("<KP_Enter>",lambda e: self._commit_rename())
        entry_widget.bind("<Escape>",  lambda e: self._cancel_rename())
        entry_widget.bind("<FocusOut>",lambda e: self._commit_rename())

        self._rename_editor = entry_widget
        self._rename_target_idx = idx
        return "break"

    def _commit_rename(self):
        """Apply the text in the inline editor to the target entry,
        persist to cache, refresh the listbox row, tear down the Entry."""
        editor = self._rename_editor
        idx = self._rename_target_idx
        if editor is None or idx is None:
            self._cleanup_rename_editor()
            return
        new_name = editor.get().strip()
        self._cleanup_rename_editor()
        if not (0 <= idx < len(self.entries)):
            return
        entry = self.entries[idx]
        # Treat empty string or the default "#NN" auto label as "clear the
        # override so we fall back to the auto name in _entry_label".
        auto_label = f"#{entry['fp']['idx']:02d}"
        if not new_name or new_name == auto_label:
            entry["display_name"] = None
        else:
            entry["display_name"] = new_name
        self._update_entry_label(idx)
        # Keep the row selected so the user sees what they renamed
        self.fp_list.selection_clear(0, tk.END)
        self.fp_list.selection_set(idx)
        self._persist_display_names()

    def _cancel_rename(self):
        """Discard any in-progress inline rename."""
        self._cleanup_rename_editor()

    def _cleanup_rename_editor(self):
        if self._rename_editor is not None:
            try:
                self._rename_editor.destroy()
            except Exception:
                pass
        self._rename_editor = None
        self._rename_target_idx = None

    def _persist_display_names(self) -> None:
        """Write the current display-name map to the cache file so renames
        survive file reopens. Cheap — single small JSON file."""
        if self.current_path is None:
            return
        try:
            cache_dir = cache.cache_dir_for(self.current_path)
            names = {
                e["fp"]["idx"]: e["display_name"]
                for e in self.entries
                if e.get("display_name")
            }
            cache.save_floorplan_names(cache_dir, names)
        except Exception as e:
            print(f"[cache] save floorplan names failed: {e}")

    def _restore_focus(self):
        """Gently restore input focus to the main window. Called after macOS
        Tk widgets that tend to leave the window without focus — notably
        `tk_popup` + `grab_release` after dismissing a context menu."""
        try:
            self.root.lift()
            self.canvas.focus_set()
        except Exception:
            pass

    # ---- Dim drag interaction ----

    # Snap radius in world units (mm). Endpoint drags snap to room-edge
    # coordinates within this distance; body drags snap to existing dim
    # offsets or the default ring within this distance.
    _DIM_SNAP_MM = 400.0

    def _snap_endpoint(self, value: float, axis: str, ignore_key=None) -> float:
        """Snap an endpoint coordinate to any room-part bbox edge on the
        same axis, within _DIM_SNAP_MM. axis is 'x' or 'y'. Returns the
        snapped value (or the input value if nothing is near enough)."""
        if self.current is None:
            return value
        targets: list[float] = []
        rooms = self.current["rooms"]
        for r in rooms:
            for p in r.get("parts") or [{"bbox_xy": r["bbox_xy"]}]:
                b = p["bbox_xy"]
                if axis == "x":
                    targets.append(b[0])
                    targets.append(b[2])
                else:
                    targets.append(b[1])
                    targets.append(b[3])
        best_val = value
        best_d = self._DIM_SNAP_MM
        for t in targets:
            d = abs(t - value)
            if d < best_d:
                best_d = d
                best_val = t
        return best_val

    def _snap_offset(self, value: float, side: str, rid: int, pid: int) -> float:
        """Snap a dim-line offset to nearby targets:
          - the default dim ring (all_maxy + OFF, etc.)
          - offsets of other dims on the same side
          - the floorplate edge itself
        Returns the snapped value or the input if nothing is near enough."""
        if self.current is None or self.current_entry is None:
            return value
        all_minx, all_maxx, all_miny, all_maxy = self._floorplate_outer_bbox()
        OFF = self._DEFAULT_DIM_OFFSET

        targets: list[float] = []
        if side == "h_top":
            targets += [all_maxy + OFF, all_maxy, all_maxy + OFF * 2]
        elif side == "h_bot":
            targets += [all_miny - OFF, all_miny, all_miny - OFF * 2]
        elif side == "v_left":
            targets += [all_minx - OFF, all_minx, all_minx - OFF * 2]
        elif side == "v_right":
            targets += [all_maxx + OFF, all_maxx, all_maxx + OFF * 2]

        # Other dims on the same side → snap to their offsets so stacks align
        picks = self.current_entry.get("picks", {}) or {}
        for other in picks.get(side, []):
            o_rid = other[0] if isinstance(other, tuple) else other
            o_pid = other[1] if isinstance(other, tuple) else 0
            if o_rid == rid and o_pid == pid:
                continue
            eff = self._effective_dim(o_rid, o_pid, side)
            if eff is not None:
                targets.append(eff[2])

        best_val = value
        best_d = self._DIM_SNAP_MM
        for t in targets:
            d = abs(t - value)
            if d < best_d:
                best_d = d
                best_val = t
        return best_val

    def _on_dim_hover_enter(self, cursor: str):
        """Mouse moved over a dim hit region. Set the appropriate resize
        cursor unless a drag is already in progress (in which case the
        press handler has already chosen the right cursor)."""
        if self._dim_drag is not None:
            return
        try:
            self.canvas.config(cursor=cursor)
        except Exception:
            pass

    def _on_dim_hover_leave(self):
        """Mouse left a dim hit region. Restore the default arrow cursor —
        unless a drag is in progress (cursor is already correct)."""
        if self._dim_drag is not None:
            return
        try:
            self.canvas.config(cursor="arrow")
        except Exception:
            pass

    def _on_dim_press(self, event, side: str, rid: int, pid: int, component: str):
        """Button-1 press on a dim tick or body — begin a drag gesture.
        Returns 'break' so the click doesn't also trigger _on_canvas_click."""
        if self.current_entry is None:
            return "break"
        # Snapshot the existing override so we can restore on cancel (future).
        existing = (self.current_entry.get("overrides") or {}).get((rid, pid, side), {})
        self._dim_drag = {
            "rid": rid,
            "pid": pid,
            "side": side,
            "component": component,
            "orig_override": dict(existing),
            "moved": False,
        }
        self.canvas.config(cursor="hand2" if component == "body" else "sb_h_double_arrow"
                           if side in ("h_top", "h_bot") else "sb_v_double_arrow")
        # Make sure an override dict exists so the motion handler can mutate it.
        self._get_or_create_override(rid, pid, side)
        return "break"

    def _on_canvas_b1_motion(self, event):
        """Dispatch <B1-Motion>:
          - if a dim drag is active, update the relevant override field
          - otherwise fall through to the existing Shift+drag pan handler
            (pan is bound separately to <Shift-B1-Motion> so this never
            fires for plain B1 drags — nothing to do)

        Hold **Alt/Option** while dragging to disable snapping for fine
        granular control. Release Alt to re-enable snapping mid-drag."""
        drag = self._dim_drag
        if drag is None:
            return
        drag["moved"] = True
        wx, wy = self.viewport.c2w(event.x, event.y)
        side = drag["side"]
        rid = drag["rid"]
        pid = drag["pid"]
        component = drag["component"]
        override = self._get_or_create_override(rid, pid, side)

        # Alt/Option key (bit 4 = 0x10 on macOS Tk, bit 3 = 0x08 on some
        # builds). Check both so it works regardless of Tk version.
        alt_held = bool(event.state & 0x0018)
        snap = not alt_held

        if component in ("start", "end"):
            is_h = side in ("h_top", "h_bot")
            raw = wx if is_h else wy
            axis = "x" if is_h else "y"
            new_val = self._snap_endpoint(raw, axis=axis) if snap else raw
            override[component] = new_val
        elif component == "body":
            if side in ("h_top", "h_bot"):
                raw = wy
            else:
                raw = wx
            new_val = self._snap_offset(raw, side, rid, pid) if snap else raw
            override["offset"] = new_val

        # Live redraw so the dim follows the cursor
        self._draw_dims()

        # Dotted guide line across the full canvas at the drag coordinate.
        self.canvas.delete("drag_guide")
        if component in ("start", "end"):
            is_horizontal = side in ("h_top", "h_bot")
            cw = self.canvas.winfo_width()
            ch = self.canvas.winfo_height()
            # Guide line colour: blue when snapping, orange when free
            guide_color = "#3b82f6" if snap else "#f97316"
            if is_horizontal:
                gx, _ = self.viewport.w2c(new_val, 0)
                self.canvas.create_line(
                    gx, 0, gx, ch,
                    fill=guide_color, width=1, dash=(6, 4),
                    tags=("drag_guide",),
                )
            else:
                _, gy = self.viewport.w2c(0, new_val)
                self.canvas.create_line(
                    0, gy, cw, gy,
                    fill=guide_color, width=1, dash=(6, 4),
                    tags=("drag_guide",),
                )

    def _on_canvas_b1_release(self, event):
        """Finish a dim drag, persist, reset cursor."""
        drag = self._dim_drag
        if drag is None:
            return
        self._dim_drag = None
        self.canvas.config(cursor="arrow")
        self.canvas.delete("drag_guide")
        if drag["moved"]:
            self._save_entry_picks(self.current_entry)
            self.status.set("Dimension updated.")

    def _on_app_activated(self, _event=None):
        """Fires when the Studio regains foreground focus on macOS
        (Cmd-Tab back, Dock click, clicking the window). Aggressively
        restore focus AND clear the inactive-state visual indicator."""
        was_inactive = not self._is_app_active
        self._is_app_active = True
        try:
            # Belt and suspenders: lift, force-focus the toplevel, then
            # focus_set on the canvas so subsequent clicks land in our
            # widget tree. focus_force is normally aggressive but on
            # macOS it just normalises Tk's idea of where focus is —
            # the OS-level activation has already happened by the time
            # this fires.
            self.root.lift()
            self.root.focus_force()
            self.canvas.focus_set()
            self.root.update_idletasks()
        except Exception:
            pass
        if was_inactive:
            self._update_focus_indicator()
            self.status.set("Window active.")

    def _on_app_deactivated(self, _event=None):
        """Fires when another app comes to the foreground. Show the
        focus indicator so the user knows their next click on the
        Studio will be eaten by macOS as an activation click."""
        self._is_app_active = False
        self._update_focus_indicator()

    def _on_root_focus_in(self, event):
        """Some platforms (Linux, Windows) deliver <FocusIn> instead of
        <Activate> when the toplevel regains focus. Treat them the
        same — but only when the event is for the root, not when a
        child widget gains focus internally."""
        if event.widget is self.root:
            self._on_app_activated(event)

    def _on_root_focus_out(self, event):
        """Cross-platform companion to _on_app_deactivated. Only fires
        for the root toplevel, not for child widgets losing focus."""
        if event.widget is self.root:
            self._on_app_deactivated(event)

    def _on_canvas_enter(self, _event=None):
        """Mouse moved into the canvas. Quietly request focus on the
        canvas so the next click is delivered, but DO NOT flip the
        active-state flag — mousing around doesn't actually re-activate
        the app at the OS level on macOS."""
        try:
            self.canvas.focus_set()
        except Exception:
            pass

    # ---- Focus visual indicator ----

    def _update_focus_indicator(self):
        """Show or clear the 'app inactive' visual cue on the canvas:
          - amber 4px highlight border around the canvas
          - small amber 'click anywhere to activate' toast in the top right
        Both vanish the moment <Activate> fires (= the user has clicked
        the window and macOS has actually activated us)."""
        try:
            if self._is_app_active:
                self.canvas.config(highlightthickness=0)
                self.canvas.delete("focus_overlay")
                return
            self.canvas.config(
                highlightthickness=4,
                highlightbackground="#fbbf24",
                highlightcolor="#fbbf24",
            )
            self._draw_focus_toast()
        except Exception:
            pass

    def _draw_focus_toast(self):
        """Paint a compact amber toast in the top-right of the canvas
        when the app is inactive. Re-anchored on every redraw because
        the canvas size may change during a window resize."""
        self.canvas.delete("focus_overlay")
        w = max(self.canvas.winfo_width(), 320)
        msg = "  Window inactive — click anywhere to activate  "
        text_w = len(msg) * 7 + 24
        x_right = w - 16
        y_top = 14
        x1 = x_right - text_w
        y1 = y_top
        x2 = x_right
        y2 = y_top + 28
        self.canvas.create_rectangle(
            x1, y1, x2, y2,
            fill="#fbbf24", outline="#d97706", width=2,
            tags=("focus_overlay",),
        )
        self.canvas.create_text(
            (x1 + x2) / 2, (y1 + y2) / 2,
            text=msg.strip(),
            font=("Helvetica", -13, "bold"),
            fill="#7c2d12",
            tags=("focus_overlay",),
        )

    def _on_quit(self):
        """Shutdown the thread pool and exit cleanly."""
        try:
            if self._executor is not None:
                self._executor.shutdown(wait=False, cancel_futures=True)
                self._executor = None
        finally:
            self.root.destroy()

    def load_file(self, path: Path):
        """Kick off the load in a background thread so the UI stays responsive."""
        if self._is_loading_file:
            return
        self._is_loading_file = True
        # Cancel any in-flight reconstructions from the previous file and
        # throw away their futures — we don't want stale completions to
        # update the new sidebar.
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        self._futures.clear()
        # Reset state immediately on the UI thread
        self.entries = []
        self.wall_data = None
        self.current_path = None
        self.current_entry = None
        self.current = None
        self.fp_list.delete(0, tk.END)
        self._redraw()
        self.info_var.set("Loading…")
        self.status.set(f"Loading {path.name}…")
        self.root.update_idletasks()

        t = threading.Thread(target=self._bg_load_file, args=(path,), daemon=True)
        t.start()

    def _bg_load_file(self, path: Path):
        """Runs on a worker thread. Does DWG→DXF conversion, DXF read, label
        extraction, floorplan detection and wall pre-collection — except each
        step is backed by an on-disk cache keyed by the source file, so
        reopening an unchanged file is near-instantaneous."""
        try:
            cache_dir = cache.cache_dir_for(path)
            walls_path = cache_dir / "walls.pkl"
            fps_path = cache_dir / "floorplans.pkl"
            meta = cache.load_meta(cache_dir)

            # ---- Fast path: warm cache ----
            if meta is not None:
                wall_data = cache.load_pickle(walls_path)
                fps = cache.load_pickle(fps_path)
                if wall_data is not None and fps is not None:
                    self._post(lambda n=len(fps): self.status.set(
                        f"Loaded from cache ({n} floorplans)…"))
                    self._post(lambda: self._on_file_loaded(path, fps, wall_data))
                    return
                # Fall through to cold path if the pickles went missing.

            # ---- Cold path: parse the source file ----
            dxf_path = path
            if path.suffix.lower() == ".dwg":
                self._post(lambda: self.status.set(f"Converting {path.name} (DWG → DXF)…"))
                dxf_path = convert_dwg_to_dxf(path)

            self._post(lambda: self.status.set(f"Reading {dxf_path.name}…"))
            doc = ezdxf.readfile(str(dxf_path))
            msp = doc.modelspace()

            unit_scale = get_unit_scale(doc)

            # Auto-detect layer roles from the DXF's layer table so we
            # support any naming convention without hardcoded layer lists.
            wall_layers, insert_wall_layers, room_label_layers = _classify_layers(doc)
            self._post(lambda wl=len(wall_layers), rl=len(room_label_layers):
                       self.status.set(
                           f"Auto-detected {wl} wall layers, {rl} room-label layers…"))

            labels = extract_room_labels(msp, unit_scale=unit_scale,
                                         room_label_layers=room_label_layers)
            fps = detect_floorplans(labels, 5)
            if not fps:
                self._post(lambda: self._on_file_error(
                    f"No floorplans with ≥5 room labels detected in {path.name}.\n\n"
                    f"Room-label layers found: {room_label_layers or 'none'}\n"
                    f"Wall layers found: {len(wall_layers)}"))
                return

            self._post(lambda n=len(fps): self.status.set(
                f"Pre-collecting wall geometry ({n} floorplans detected)…"))
            wall_data = collect_all_walls(msp, unit_scale=unit_scale,
                                          wall_layers=wall_layers,
                                          insert_wall_layers=insert_wall_layers)

            # Save to cache so the next open skips all of the above.
            cache.save_pickle(walls_path, wall_data)
            cache.save_pickle(fps_path, fps)
            cache.save_meta(cache_dir, {
                "source": str(path.resolve()),
                "name": path.name,
                "size": path.stat().st_size,
                "mtime": int(path.stat().st_mtime),
                "n_floorplans": len(fps),
                "unit_scale": unit_scale,
            })

            self._post(lambda: self._on_file_loaded(path, fps, wall_data))
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._post(lambda err=f"{type(e).__name__}: {e}": self._on_file_error(err))

    def _on_file_loaded(self, path: Path, fps: list, wall_data: tuple):
        """Main thread callback once the file is read and floorplans are detected.
        Populates the sidebar with one row per floorplan and submits EVERY
        floorplan to the background subprocess pool right away. The user
        can click any entry — if it's still processing they see a placeholder
        and the moment it finishes the canvas updates automatically."""
        self.wall_data = wall_data
        self.current_path = path
        # Restore any persisted display names from a previous session
        saved_names = cache.load_floorplan_names(cache.cache_dir_for(path)) or {}
        self.entries = [{
            "fp": fp,
            "status": "pending",
            "recon": None,
            "picks": None,
            "overrides": {},   # key: (rid, pid, side) → {start, end, offset}
            "display_name": saved_names.get(fp["idx"]),  # None → use auto label
            "error": None,
        } for fp in fps]

        self.fp_list.delete(0, tk.END)
        for e in self.entries:
            self.fp_list.insert(tk.END, self._entry_label(e))

        self._is_loading_file = False

        # (Re)create the thread pool. Killing the old one cancels any
        # in-flight work from a previously loaded file.
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
        self._futures.clear()
        try:
            self._executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="floorplan-recon",
            )
        except Exception as e:
            messagebox.showerror("Worker pool failed",
                f"Could not start background worker:\n{e}")
            self._executor = None

        # Submit every floorplan for background reconstruction. The worker
        # processes them one at a time (max_workers=1) in sidebar order, but
        # the main thread is totally free while they run.
        for i, entry in enumerate(self.entries):
            self._submit_reconstruction(i)

        self.status.set(
            f"Loaded {len(self.entries)} floorplan(s) — reconstructing in background…")

        if self.entries:
            self.fp_list.selection_clear(0, tk.END)
            self.fp_list.selection_set(0)
            self.fp_list.see(0)
            self._load_current(0)

    def _submit_reconstruction(self, entry_idx: int):
        """Queue floorplan `entry_idx` for reconstruction.

        Checks the on-disk cache first — if a matching recon pickle exists
        we load it synchronously on the main thread and mark the entry
        ready without touching the worker thread. Otherwise hands the
        work to the background thread pool."""
        if not (0 <= entry_idx < len(self.entries)):
            return
        entry = self.entries[entry_idx]
        if entry["status"] in ("processing", "ready", "failed"):
            return

        # ---- Cache hit? ----
        if self.current_path is not None:
            cache_dir = cache.cache_dir_for(self.current_path)
            rpath = cache.recon_path(cache_dir, entry["fp"]["idx"], self.raster_mm)
            cached = cache.load_pickle(rpath)
            if cached is not None:
                entry["recon"] = cached
                self._apply_tail_mode(
                    cached["rooms"], trim=bool(self.ignore_tails_var.get()))
                # Restore saved picks + overrides if they exist; otherwise
                # fall back to the gap-based auto-pick with no overrides.
                saved_picks, saved_overrides = self._load_saved_picks(entry)
                if saved_picks is not None:
                    entry["picks"] = saved_picks
                    entry["overrides"] = saved_overrides or {}
                else:
                    entry["picks"] = pick_dims(cached["rooms"])
                    entry["overrides"] = {}
                entry["status"] = "ready"
                self._update_entry_label(entry_idx)
                # If this is the active entry, render immediately.
                if self.current_entry is entry:
                    self._load_current(entry_idx)
                return

        if self._executor is None:
            return
        entry["status"] = "processing"
        self._update_entry_label(entry_idx)
        try:
            future = self._executor.submit(
                reconstruct_rooms,
                self.wall_data,
                entry["fp"],
                raster_mm=self.raster_mm,
            )
        except Exception as e:
            # Pool might already be shutting down — fall back to 'failed'
            entry["status"] = "failed"
            entry["error"] = f"{type(e).__name__}: {e}"
            self._update_entry_label(entry_idx)
            return
        self._futures[entry_idx] = future
        # Completion callback runs on an executor thread; marshal back to main.
        future.add_done_callback(
            lambda f, i=entry_idx: self._post(
                lambda: self._on_future_done(i, f))
        )

    def _on_future_done(self, entry_idx: int, future: Future):
        """Runs on the Tk main thread after a subprocess reconstruction
        finishes. Unpacks the future result or error and hands it to
        the existing `_on_reconstruct_done` state machine."""
        self._futures.pop(entry_idx, None)
        try:
            recon = future.result()
            self._on_reconstruct_done(entry_idx, recon, None)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._on_reconstruct_done(entry_idx, None, f"{type(e).__name__}: {e}")

    def _on_file_error(self, msg: str):
        self._is_loading_file = False
        self.status.set("Load failed.")
        self.info_var.set("No file loaded.")
        messagebox.showerror("Load failed", msg)

    @staticmethod
    def _entry_label(entry: dict) -> str:
        fp = entry["fp"]
        status = entry["status"]
        # Prefix is the user's display name if set, otherwise the auto idx.
        name = entry.get("display_name") or f"#{fp['idx']:02d}"
        if status == "ready":
            n = len(entry["recon"]["rooms"])
            return f"{name}  ·  {n} rooms"
        if status == "processing":
            return f"{name}  ·  processing…"
        if status == "failed":
            return f"{name}  ·  failed"
        return f"{name}  ·  {len(fp['labels'])} labels (pending)"

    def _update_entry_label(self, entry_idx: int):
        if not (0 <= entry_idx < len(self.entries)):
            return
        label = self._entry_label(self.entries[entry_idx])
        # Replace the listbox entry in place, preserving selection
        was_selected = entry_idx in self.fp_list.curselection()
        self.fp_list.delete(entry_idx)
        self.fp_list.insert(entry_idx, label)
        if was_selected:
            self.fp_list.selection_set(entry_idx)

    def _on_fp_select(self, _event):
        sel = self.fp_list.curselection()
        if not sel:
            return
        self._load_current(sel[0])

    def _load_current(self, idx: int):
        """Switch the main canvas to floorplan `idx`. If its reconstruction
        isn't ready yet, kick off a worker thread and show a placeholder
        message on the canvas in the meantime."""
        if not (0 <= idx < len(self.entries)):
            return
        entry = self.entries[idx]
        self.current_entry = entry

        if entry["status"] == "ready":
            self.current = entry["recon"]
            rooms = self.current["rooms"]
            fp = self.current["fp"]
            total_area = sum(r["area_mm2"] for r in rooms) / 1e6
            self.info_var.set(
                f"Floorplan #{fp['idx']:02d}\n"
                f"Rooms: {len(rooms)}\n"
                f"Walls: {len(self.current['segs'])} segs\n"
                f"Labels: {len(fp['labels'])}\n"
                f"Total area: {total_area:.1f} m²"
            )
            self._fit_view_to_current()
            self._redraw()
            return

        # Not ready yet — the background pool is already working on it
        # (or will get to it soon). Show a placeholder and let the completion
        # callback re-trigger this method when the reconstruction finishes.
        self.current = None
        fp = entry["fp"]
        self.info_var.set(
            f"Floorplan #{fp['idx']:02d}\n"
            f"Labels: {len(fp['labels'])}\n"
            f"Status: {entry['status']}"
        )
        self._draw_placeholder(entry)

        # Safety net — if for some reason this entry never got submitted
        # (e.g. executor was rebuilt after file load), submit it now.
        if entry["status"] == "pending":
            self._submit_reconstruction(idx)

    def _on_reconstruct_done(self, entry_idx: int, recon: dict | None, error: str | None):
        if not (0 <= entry_idx < len(self.entries)):
            return
        entry = self.entries[entry_idx]
        if error or recon is None:
            entry["status"] = "failed"
            entry["error"] = error or "reconstruction returned None"
            self._update_entry_label(entry_idx)
            if self.current_entry is entry:
                self._draw_placeholder(entry)
                self.status.set(f"Floorplan #{entry['fp']['idx']:02d} failed.")
            return

        entry["recon"] = recon

        # Persist the recon bundle to the on-disk cache so the next time
        # this source file opens, we skip the subprocess call entirely.
        if self.current_path is not None:
            try:
                cache_dir = cache.cache_dir_for(self.current_path)
                rpath = cache.recon_path(cache_dir, entry["fp"]["idx"], self.raster_mm)
                cache.save_pickle(rpath, recon)
            except Exception as e:
                print(f"[cache] recon save failed for fp {entry['fp']['idx']}: {e}")

        # Honour the current "ignore trailing tails" toggle immediately so
        # the auto-picked dims use the right bboxes from the start.
        self._apply_tail_mode(recon["rooms"], trim=bool(self.ignore_tails_var.get()))
        # Restore saved picks + per-dim overrides if they exist.
        saved_picks, saved_overrides = self._load_saved_picks(entry)
        if saved_picks is not None:
            entry["picks"] = saved_picks
            entry["overrides"] = saved_overrides or {}
        else:
            entry["picks"] = pick_dims(recon["rooms"])
            entry["overrides"] = {}
        entry["status"] = "ready"
        self._update_entry_label(entry_idx)

        # If the user is still looking at this entry, render it now
        if self.current_entry is entry:
            self._load_current(entry_idx)
            self.status.set(f"Floorplan #{entry['fp']['idx']:02d} ready.")

    def _draw_placeholder(self, entry: dict):
        """Canvas placeholder while a floorplan is being reconstructed."""
        self.canvas.delete("all")
        self._item_to_room.clear()
        w = max(self.canvas.winfo_width(), 200)
        h = max(self.canvas.winfo_height(), 200)
        fp = entry["fp"]
        status = entry["status"]
        if status == "processing":
            msg = f"Reconstructing floorplan #{fp['idx']:02d} …\n\n{len(fp['labels'])} rooms"
            color = "#64748b"
        elif status == "failed":
            msg = f"Floorplan #{fp['idx']:02d} failed:\n\n{entry.get('error', '?')}"
            color = "#dc2626"
        else:
            msg = f"Floorplan #{fp['idx']:02d} — click to load"
            color = "#94a3b8"
        self.canvas.create_text(w / 2, h / 2, text=msg,
                                font=("Helvetica", -18), fill=color,
                                justify=tk.CENTER, tags="placeholder")

    def _fit_view_to_current(self):
        if self.current is None:
            return
        rooms = self.current["rooms"]
        if not rooms:
            return
        minx = min(r["bbox_xy"][0] for r in rooms)
        miny = min(r["bbox_xy"][1] for r in rooms)
        maxx = max(r["bbox_xy"][2] for r in rooms)
        maxy = max(r["bbox_xy"][3] for r in rooms)
        # Pad for the dim ring (~4500 mm each side)
        pad = 5500
        minx -= pad; miny -= pad; maxx += pad; maxy += pad
        cw = max(self.canvas.winfo_width(), 100)
        ch = max(self.canvas.winfo_height(), 100)
        self.viewport.fit(minx, miny, maxx, maxy, cw, ch, padding=0.05)

    # ---- Canvas rendering ----

    def _redraw(self):
        self.canvas.delete("all")
        self._item_to_room.clear()
        if self.current is None:
            # Empty state — no file loaded, no in-progress reconstruction.
            # Show a big drop zone hint so the user knows they can just
            # drag a CAD file straight onto the window.
            if not self.entries and not self._is_loading_file:
                self._draw_drop_hint()
        else:
            self._draw_walls()
            self._draw_rooms()
            self._draw_dims()
        # The amber "window inactive" toast is canvas content too, so
        # re-paint it on top of whatever else we just drew.
        if not self._is_app_active:
            self._draw_focus_toast()

    def _draw_drop_hint(self):
        """Centered drop-zone overlay used as the empty-app start screen.
        The entire panel is clickable — opens the file picker on click.
        Files can also be opened by dropping onto the Dock icon (macOS
        ::tk::mac::OpenDocument) or via File → Open / ⌘O."""
        w = max(self.canvas.winfo_width(), 320)
        h = max(self.canvas.winfo_height(), 240)
        cx, cy = w / 2, h / 2

        box_w = min(w * 0.65, 640)
        box_h = min(h * 0.45, 320)
        x1, y1 = cx - box_w / 2, cy - box_h / 2
        x2, y2 = cx + box_w / 2, cy + box_h / 2

        tag = "drop_hint"

        # Soft background panel + dashed border
        self.canvas.create_rectangle(
            x1, y1, x2, y2,
            outline="#94a3b8", width=3, dash=(10, 6),
            fill="#eef2f7",
            tags=(tag,),
        )
        self.canvas.create_text(
            cx, cy - 56,
            text="📂",
            font=("Helvetica", -72),
            fill="#94a3b8",
            tags=(tag,),
        )
        self.canvas.create_text(
            cx, cy + 18,
            text="Click to open a .dxf or .dwg",
            font=("Helvetica", -22, "bold"),
            fill="#0f172a",
            tags=(tag,),
        )
        self.canvas.create_text(
            cx, cy + 46,
            text="or drop a file onto the Dock icon · ⌘O",
            font=("Helvetica", -15),
            fill="#64748b",
            tags=(tag,),
        )
        self.canvas.create_text(
            cx, y2 - 22,
            text="Auto-detects every floorplan · click rooms to dim · drag dims to edit",
            font=("Helvetica", -12),
            fill="#94a3b8",
            tags=(tag,),
        )
        # Make the whole panel clickable — opens the file dialog.
        self.canvas.tag_bind(tag, "<Button-1>", lambda e: self._cmd_open())
        self.canvas.tag_bind(tag, "<Enter>",
                             lambda e: self.canvas.config(cursor="hand2"))
        self.canvas.tag_bind(tag, "<Leave>",
                             lambda e: self.canvas.config(cursor="arrow"))

    def _draw_walls(self):
        segs = self.current["segs"]
        w2c = self.viewport.w2c
        # Single polyline per segment is heavy; batch them into flat coord lists
        # grouped by style. Tkinter create_line accepts a flat coord list and
        # renders a single polyline item — we use many items since wall segments
        # aren't necessarily contiguous, but ~3000 items is fine.
        for a, b in segs:
            x1, y1 = w2c(*a)
            x2, y2 = w2c(*b)
            self.canvas.create_line(x1, y1, x2, y2, fill="#0f172a", width=1.3,
                                    tags="wall")

    @staticmethod
    def _pick_rid(pick):
        """A pick is a (room_idx, part_idx) tuple. Return just the room_idx."""
        return pick[0] if isinstance(pick, tuple) else pick

    def _resolve_pick(self, pick):
        """Return (bbox, w, h) for a (room_idx, part_idx) pick on the current
        floorplan, or None if the pick no longer resolves."""
        if self.current is None:
            return None
        rid = pick[0] if isinstance(pick, tuple) else pick
        pid = pick[1] if isinstance(pick, tuple) else 0
        r = next((x for x in self.current["rooms"] if x["idx"] == rid), None)
        if r is None:
            return None
        parts = r.get("parts") or [{"bbox_xy": r["bbox_xy"], "w": r["w"], "h": r["h"]}]
        if pid >= len(parts):
            return None
        p = parts[pid]
        return p["bbox_xy"], p["w"], p["h"]

    # ---- Dim override helpers ----

    def _floorplate_outer_bbox(self):
        """Outer (minx, maxx, miny, maxy) across every part of every room in
        the current floorplan, used to position the default dim ring."""
        rooms = self.current["rooms"] if self.current else []
        if not rooms:
            return (0.0, 0.0, 0.0, 0.0)
        part_bboxes = [
            p["bbox_xy"]
            for r in rooms
            for p in (r.get("parts") or [{"bbox_xy": r["bbox_xy"]}])
        ]
        return (
            min(b[0] for b in part_bboxes),
            max(b[2] for b in part_bboxes),
            min(b[1] for b in part_bboxes),
            max(b[3] for b in part_bboxes),
        )

    # Distance from the floorplate bbox to the default dim ring on each side.
    _DEFAULT_DIM_OFFSET = 2500.0

    def _effective_dim(self, rid: int, pid: int, side: str):
        """Return the effective (start, end, offset) for a dim on the given
        side, applying any user overrides stored on the current entry.
        A returned `None` means the dim doesn't resolve (pick points at a
        room/part that no longer exists)."""
        resolved = self._resolve_pick((rid, pid))
        if resolved is None:
            return None
        bbox, _w, _h = resolved
        all_minx, all_maxx, all_miny, all_maxy = self._floorplate_outer_bbox()
        OFF = self._DEFAULT_DIM_OFFSET

        # Auto values from the part bbox + floorplate ring
        if side == "h_top":
            auto_start, auto_end, auto_offset = bbox[0], bbox[2], all_maxy + OFF
        elif side == "h_bot":
            auto_start, auto_end, auto_offset = bbox[0], bbox[2], all_miny - OFF
        elif side == "v_left":
            auto_start, auto_end, auto_offset = bbox[1], bbox[3], all_minx - OFF
        elif side == "v_right":
            auto_start, auto_end, auto_offset = bbox[1], bbox[3], all_maxx + OFF
        else:
            return None

        override = {}
        if self.current_entry is not None:
            override = self.current_entry.get("overrides", {}).get((rid, pid, side), {}) or {}

        start = override.get("start", None)
        if start is None:
            start = auto_start
        end = override.get("end", None)
        if end is None:
            end = auto_end
        offset = override.get("offset", None)
        if offset is None:
            offset = auto_offset
        return start, end, offset

    def _get_or_create_override(self, rid: int, pid: int, side: str) -> dict:
        """Return a mutable override dict for a specific dim, creating one
        if none exists yet."""
        entry = self.current_entry
        if entry is None:
            return {}
        overrides = entry.setdefault("overrides", {})
        key = (rid, pid, side)
        ov = overrides.get(key)
        if ov is None:
            ov = {"start": None, "end": None, "offset": None}
            overrides[key] = ov
        return ov

    def _remove_overrides_for(self, rid: int, pid: int | None = None, side: str | None = None):
        """Remove overrides matching a room (and optionally a specific part
        and/or side). Called whenever a pick is removed so we don't leak
        stale overrides into the persisted state."""
        if self.current_entry is None:
            return
        overrides = self.current_entry.get("overrides") or {}
        to_delete = [
            key for key in overrides
            if key[0] == rid
            and (pid is None or key[1] == pid)
            and (side is None or key[2] == side)
        ]
        for key in to_delete:
            del overrides[key]

    def _draw_rooms(self):
        rooms = self.current["rooms"]
        picks = self.current_entry["picks"] if self.current_entry else {}
        # A room is "picked" (outlined red) if ANY part of it has a dim on ANY side.
        picked_ids = set()
        for side in ("h_top", "h_bot", "v_left", "v_right"):
            for pick in picks.get(side, []):
                picked_ids.add(self._pick_rid(pick))

        w2c = self.viewport.w2c
        for i, r in enumerate(rooms):
            hue = (i * 0.137) % 1
            R, G, B = colorsys.hsv_to_rgb(hue, 0.45, 0.97)
            fill = f"#{int(R*255):02x}{int(G*255):02x}{int(B*255):02x}"

            # Polygon
            flat = []
            step = max(1, len(r["poly_xy"]) // 160)
            for (x, y) in r["poly_xy"][::step]:
                cx, cy = w2c(x, y)
                flat.extend([cx, cy])
            if len(flat) < 6:
                continue

            is_picked = r["idx"] in picked_ids
            outline = "#dc2626" if is_picked else "#0f172a"
            width = 2.5 if is_picked else 1.0
            tag = f"room_{r['idx']}"
            item = self.canvas.create_polygon(
                *flat, fill=fill, outline=outline, width=width,
                stipple="", tags=("room", tag),
            )
            # Remember the mapping from canvas item id → room idx so the
            # canvas-level click handler can look it up.
            self._item_to_room[item] = r["idx"]

            # Room label (name + area)
            lcx, lcy = w2c(r["cx"], r["cy"])
            name = r["name"][:22]
            area = f"{r['area_mm2']/1e6:.1f} m²"
            self.canvas.create_text(lcx, lcy - 7, text=name,
                                    font=("Helvetica", -12, "bold"),
                                    fill="#0f172a", tags="label")
            self.canvas.create_text(lcx, lcy + 7, text=area,
                                    font=("Helvetica", -11),
                                    fill="#475569", tags="label")

    def _draw_dims(self):
        self.canvas.delete("dim")
        if self.current is None or self.current_entry is None:
            return
        rooms = self.current["rooms"]
        picks = self.current_entry["picks"]
        if not rooms:
            return

        w2c = self.viewport.w2c
        canvas = self.canvas

        # Visual constants (world units, mm)
        TICK = 300        # half-length of the perpendicular end ticks
        TEXT_OFF = 400
        HIT_PAD_PX = 10   # half-width of each hit region in screen pixels

        def fmt(mm):
            mm = abs(mm)
            return f"{mm/1000:.2f} m" if mm >= 1000 else f"{mm:.0f} mm"

        def draw_one(side: str, rid: int, pid: int):
            eff = self._effective_dim(rid, pid, side)
            if eff is None:
                return
            start, end, offset = eff

            # Tag namespace: "dim_{side}_{rid}_{pid}_{component}"
            base = f"dim_{side}_{rid}_{pid}"
            s_tag = base + "_start"
            e_tag = base + "_end"
            b_tag = base + "_body"

            # Map (side, coord-in-world) → canvas pixel pair for the dim line,
            # for its two tick marks, and for a body-hit rectangle.
            is_horizontal = side in ("h_top", "h_bot")
            if is_horizontal:
                y = offset
                # Dim line
                lx1, ly1 = w2c(start, y)
                lx2, ly2 = w2c(end, y)
                # Ticks
                s_tick = ((start, y - TICK), (start, y + TICK))
                e_tick = ((end,   y - TICK), (end,   y + TICK))
                # Label
                tx, ty = w2c((start + end) / 2,
                             y + (TEXT_OFF if side == "h_top" else -TEXT_OFF))
                text_rot = 0
            else:
                x = offset
                lx1, ly1 = w2c(x, start)
                lx2, ly2 = w2c(x, end)
                s_tick = ((x - TICK, start), (x + TICK, start))
                e_tick = ((x - TICK, end),   (x + TICK, end))
                tx, ty = w2c(
                    x + (-TEXT_OFF if side == "v_left" else TEXT_OFF),
                    (start + end) / 2,
                )
                text_rot = 90 if side == "v_left" else -90

            # Visible dim line + ticks
            canvas.create_line(
                lx1, ly1, lx2, ly2,
                fill="#dc2626", width=2.0, capstyle=tk.ROUND,
                tags=("dim", base, b_tag),
            )
            sx1, sy1 = w2c(*s_tick[0]); sx2, sy2 = w2c(*s_tick[1])
            canvas.create_line(
                sx1, sy1, sx2, sy2,
                fill="#dc2626", width=2.0, capstyle=tk.ROUND,
                tags=("dim", base, s_tag),
            )
            ex1, ey1 = w2c(*e_tick[0]); ex2, ey2 = w2c(*e_tick[1])
            canvas.create_line(
                ex1, ey1, ex2, ey2,
                fill="#dc2626", width=2.0, capstyle=tk.ROUND,
                tags=("dim", base, e_tag),
            )
            # Label — uses the live start/end so it updates as the user drags
            canvas.create_text(
                tx, ty, text=fmt(end - start),
                fill="#dc2626", font=("Helvetica", -14, "bold"),
                angle=text_rot, tags=("dim", base),
            )

            # ---- Invisible hit regions for dragging ----
            # We need the TICK handles (resize cursor) to win over the BODY
            # (move cursor) near the ends of the dim line. Strategy:
            #   1. Shrink the body hit box INWARD by BODY_INSET px at each
            #      end so it doesn't cover the tick zones at all.
            #   2. Draw body first (bottom of z-stack), then ticks on top
            #      with generous padding so the resize cursor zone extends
            #      well past the visible tick mark.
            TICK_HIT_PAD = 18   # px each side of the tick mark
            BODY_INSET = 24     # px trimmed off each end of the body hit box

            def hit_rect(x1, y1, x2, y2, tag):
                canvas.create_rectangle(
                    x1, y1, x2, y2,
                    outline="", fill="", width=0,
                    tags=("dim", "dim_hit", base, tag),
                )

            # Body hit region — inset at each end so it doesn't overlap
            # the tick handle zones.
            if is_horizontal:
                body_x1 = min(lx1, lx2) + BODY_INSET
                body_x2 = max(lx1, lx2) - BODY_INSET
                body_y1 = min(ly1, ly2) - HIT_PAD_PX
                body_y2 = max(ly1, ly2) + HIT_PAD_PX
            else:
                body_x1 = min(lx1, lx2) - HIT_PAD_PX
                body_x2 = max(lx1, lx2) + HIT_PAD_PX
                body_y1 = min(ly1, ly2) + BODY_INSET
                body_y2 = max(ly1, ly2) - BODY_INSET
            if body_x2 > body_x1 and body_y2 > body_y1:
                hit_rect(body_x1, body_y1, body_x2, body_y2, b_tag)

            # Tick handle hit regions — generous pad on all sides so the
            # resize cursor activates well before the user touches the
            # visible 2 px tick mark.
            for (t_cx1, t_cy1, t_cx2, t_cy2, tag) in (
                (sx1, sy1, sx2, sy2, s_tag),
                (ex1, ey1, ex2, ey2, e_tag),
            ):
                hit_rect(
                    min(t_cx1, t_cx2) - TICK_HIT_PAD,
                    min(t_cy1, t_cy2) - TICK_HIT_PAD,
                    max(t_cx1, t_cx2) + TICK_HIT_PAD,
                    max(t_cy1, t_cy2) + TICK_HIT_PAD,
                    tag,
                )

        for pick in picks.get("h_top", []):
            draw_one("h_top", pick[0], pick[1])
        for pick in picks.get("h_bot", []):
            draw_one("h_bot", pick[0], pick[1])
        for pick in picks.get("v_left", []):
            draw_one("v_left", pick[0], pick[1])
        for pick in picks.get("v_right", []):
            draw_one("v_right", pick[0], pick[1])

        # Wire press bindings onto the hit-region tag namespace. We only need
        # to (re)bind once per redraw; motion/release are bound on the canvas.
        # Also bind <Enter>/<Leave> so the cursor changes to a directional
        # resize arrow when the user hovers over an end tick — visual cue
        # that they can drag it to retrim the measurement.
        for side in ("h_top", "h_bot", "v_left", "v_right"):
            is_horizontal = side in ("h_top", "h_bot")
            # End-tick cursor: a horizontal-axis dim's endpoint slides
            # left/right (so we want a horizontal double-arrow), and a
            # vertical-axis dim's endpoint slides up/down (vertical
            # double-arrow). The body cursor is the standard 4-way move.
            tick_cursor = "sb_h_double_arrow" if is_horizontal else "sb_v_double_arrow"
            body_cursor = "fleur"
            for pick in picks.get(side, []):
                base = f"dim_{side}_{pick[0]}_{pick[1]}"
                canvas.tag_bind(
                    base + "_start", "<ButtonPress-1>",
                    lambda e, s=side, r=pick[0], p=pick[1]:
                        self._on_dim_press(e, s, r, p, "start"),
                )
                canvas.tag_bind(
                    base + "_end", "<ButtonPress-1>",
                    lambda e, s=side, r=pick[0], p=pick[1]:
                        self._on_dim_press(e, s, r, p, "end"),
                )
                canvas.tag_bind(
                    base + "_body", "<ButtonPress-1>",
                    lambda e, s=side, r=pick[0], p=pick[1]:
                        self._on_dim_press(e, s, r, p, "body"),
                )
                # Hover cursors — only change while no drag is in progress
                # so we don't fight the press handler that already set the
                # drag cursor.
                for tag, cursor in (
                    (base + "_start", tick_cursor),
                    (base + "_end",   tick_cursor),
                    (base + "_body",  body_cursor),
                ):
                    canvas.tag_bind(
                        tag, "<Enter>",
                        lambda e, c=cursor: self._on_dim_hover_enter(c),
                    )
                    canvas.tag_bind(
                        tag, "<Leave>",
                        lambda e: self._on_dim_hover_leave(),
                    )

    # ---- Interaction ----

    # ---- Skip indicator (visual feedback for blocked dims) ----

    def _show_skip_indicator(self, room: dict, blocked_axes: list[str]):
        """Flash a bright amber highlight around a room + show a warning
        label when its dim was skipped due to overlap. Auto-clears after
        3 seconds. Gives much more obvious feedback than just a status bar
        message — the user can immediately see WHICH room was blocked."""
        self.canvas.delete("skip_indicator")  # clear any previous

        w2c = self.viewport.w2c
        tag = "skip_indicator"

        # Draw a thick amber outline tracing the room polygon
        poly = room.get("poly_xy", [])
        step = max(1, len(poly) // 160)
        flat = []
        for (x, y) in poly[::step]:
            cx, cy = w2c(x, y)
            flat.extend([cx, cy])
        if len(flat) >= 6:
            self.canvas.create_polygon(
                *flat,
                fill="",
                outline="#f59e0b",  # amber-500
                width=4,
                dash=(8, 4),
                tags=(tag,),
            )

        # Warning label at the room centre
        cx, cy = w2c(room["cx"], room["cy"])
        axes_str = " & ".join(blocked_axes)
        label_text = f"⚠ {axes_str} blocked"

        # Background pill for readability
        text_id = self.canvas.create_text(
            cx, cy + 22, text=label_text,
            font=("Helvetica", -14, "bold"),
            fill="#92400e",  # amber-800
            tags=(tag,),
        )
        bbox = self.canvas.bbox(text_id)
        if bbox:
            pad = 6
            self.canvas.create_rectangle(
                bbox[0] - pad, bbox[1] - pad,
                bbox[2] + pad, bbox[3] + pad,
                fill="#fef3c7",   # amber-100
                outline="#f59e0b",
                width=2,
                tags=(tag,),
            )
            # Re-raise text above the rectangle
            self.canvas.tag_raise(text_id)

        # Auto-clear after 3 seconds
        self.root.after(3000, lambda: self.canvas.delete("skip_indicator"))

    # --- helpers for smart overlap avoidance ---

    # Rooms whose dim intervals are within this many mm of each other on the
    # same side count as "overlapping" — same tolerance used by the auto-picker
    # (pick_dims) so manual clicks and auto-picks stay consistent.
    _DIM_OVERLAP_TOL = 50

    def _would_overlap(self, room: dict, part_idx: int, side: str, picks: dict) -> bool:
        """Return True if placing (room, part_idx)'s dim on `side` would
        collide with any already-picked dim on the same side. Uses part
        bboxes so L-shaped rooms correctly detect per-arm overlaps.
        Ignores the (room, part_idx) pair itself."""
        parts = room.get("parts") or [{
            "bbox_xy": room["bbox_xy"], "w": room["w"], "h": room["h"],
        }]
        if part_idx >= len(parts):
            return False
        my_bbox = parts[part_idx]["bbox_xy"]

        if side in ("h_top", "h_bot"):
            s0, e0 = my_bbox[0], my_bbox[2]
        else:
            s0, e0 = my_bbox[1], my_bbox[3]

        tol = self._DIM_OVERLAP_TOL
        for pick in picks.get(side, []):
            rid = pick[0] if isinstance(pick, tuple) else pick
            pid = pick[1] if isinstance(pick, tuple) else 0
            if rid == room["idx"] and pid == part_idx:
                continue
            resolved = self._resolve_pick((rid, pid))
            if resolved is None:
                continue
            other_bbox, _ow, _oh = resolved
            if side in ("h_top", "h_bot"):
                s1, e1 = other_bbox[0], other_bbox[2]
            else:
                s1, e1 = other_bbox[1], other_bbox[3]
            if not (e0 + tol <= s1 or s0 >= e1 + tol):
                return True
        return False

    def _toggle_room(self, room_idx: int, mode: str = "both"):
        """Left-click toggle: add the room's PRIMARY part (index 0, the
        biggest arm) to its nearest h-side and/or v-side.

        If that side is already occupied by an overlapping dim, fall back
        to the opposite side. If BOTH sides overlap, report it in the
        status bar — the user can still force a specific side (or pick
        a different part) via the right-click context menu.
        """
        if self.current is None or self.current_entry is None:
            return
        picks = self.current_entry["picks"]
        rooms = self.current["rooms"]
        room = next((r for r in rooms if r["idx"] == room_idx), None)
        if room is None:
            return

        parts = room.get("parts") or [{
            "bbox_xy": room["bbox_xy"], "w": room["w"], "h": room["h"],
        }]
        primary_part = parts[0]
        primary_pick = (room_idx, 0)

        # Floorplate outer bbox — span every part of every room so L-shapes
        # land on the "correct" side even for their secondary arm.
        all_parts = [p["bbox_xy"] for r in rooms
                     for p in (r.get("parts") or [{"bbox_xy": r["bbox_xy"]}])]
        all_minx = min(b[0] for b in all_parts)
        all_maxx = max(b[2] for b in all_parts)
        all_miny = min(b[1] for b in all_parts)
        all_maxy = max(b[3] for b in all_parts)

        pbbox = primary_part["bbox_xy"]
        d_top = all_maxy - pbbox[3]
        d_bot = pbbox[1] - all_miny
        d_left = pbbox[0] - all_minx
        d_right = all_maxx - pbbox[2]
        h_primary = "h_top" if d_top <= d_bot else "h_bot"
        h_fallback = "h_bot" if h_primary == "h_top" else "h_top"
        v_primary = "v_left" if d_left <= d_right else "v_right"
        v_fallback = "v_right" if v_primary == "v_left" else "v_left"

        blocked = []

        def toggle_axis(primary: str, fallback: str, axis_label: str):
            # Already picked on either side? Remove (off toggle).
            if primary_pick in picks[primary]:
                picks[primary].remove(primary_pick)
                self._remove_overrides_for(room_idx, 0, primary)
                return primary
            if primary_pick in picks[fallback]:
                picks[fallback].remove(primary_pick)
                self._remove_overrides_for(room_idx, 0, fallback)
                return fallback
            for side in (primary, fallback):
                if not self._would_overlap(room, 0, side, picks):
                    picks[side].append(primary_pick)
                    return side
            blocked.append(axis_label)
            return None

        if mode in ("both", "w"):
            toggle_axis(h_primary, h_fallback, "width")
        if mode in ("both", "h"):
            toggle_axis(v_primary, v_fallback, "height")

        self._redraw()
        self._save_entry_picks(self.current_entry)
        n = sum(len(v) for v in picks.values())
        if blocked:
            axes = " & ".join(blocked)
            self.status.set(
                f"'{room['name']}' — {axes} skipped (overlap with existing dims). "
                f"Right-click to force a side or dim another part. {n} dims total."
            )
            self._show_skip_indicator(room, blocked)
        else:
            self.status.set(f"'{room['name']}' toggled — {n} dims on this floorplan.")

    def _room_under_cursor(self, event) -> int | None:
        """Return the idx of the topmost room polygon under the click, or None."""
        x, y = event.x, event.y
        items = self.canvas.find_overlapping(x - 2, y - 2, x + 2, y + 2)
        for item in reversed(items):
            rid = self._item_to_room.get(item)
            if rid is not None:
                return rid
        return None

    # ---- Unified left-button press / motion / release ----
    #
    # Disambiguates click (toggle room) from drag (pan viewport). If the
    # user presses on a room and releases without moving, it's a click
    # that toggles the room's dims. If they drag more than 5 px it
    # becomes a viewport pan — even if they started on a room. Pressing
    # on empty canvas space is always a pan from the start.
    #
    # Dim handle drags are NOT handled here — they use tag_bind in
    # _draw_dims which fires first and returns "break" so these canvas-
    # level handlers never see that press at all.

    _CLICK_VS_DRAG_THRESHOLD = 5  # px

    def _on_canvas_press(self, event):
        if self.current is None:
            return
        if self._dim_drag is not None:
            return
        # Skip if the press landed on a dim hit region (tag_bind should've
        # consumed it but just in case).
        items = self.canvas.find_overlapping(
            event.x - 2, event.y - 2, event.x + 2, event.y + 2)
        for item in reversed(items):
            if "dim_hit" in self.canvas.gettags(item):
                return

        rid = self._room_under_cursor(event)
        if rid is not None:
            # Pressed on a room — wait to see if it's a click or drag.
            self._press_state = {
                "kind": "room_pending",
                "rid": rid,
                "sx": event.x, "sy": event.y,
                "vox": self.viewport.offset_x,
                "voy": self.viewport.offset_y,
            }
        else:
            # Empty space — start panning immediately.
            self._press_state = {
                "kind": "pan",
                "sx": event.x, "sy": event.y,
                "vox": self.viewport.offset_x,
                "voy": self.viewport.offset_y,
            }
            self.canvas.config(cursor="fleur")

    def _on_canvas_motion(self, event):
        # Dim drag takes priority (handled by _on_canvas_b1_motion via
        # the dim-drag state machine set up in _on_dim_press).
        if self._dim_drag is not None:
            self._on_canvas_b1_motion(event)
            return

        ps = self._press_state
        if ps is None:
            return

        if ps["kind"] == "pan":
            # Already panning — update viewport.
            self.viewport.offset_x = ps["vox"] + (event.x - ps["sx"])
            self.viewport.offset_y = ps["voy"] + (event.y - ps["sy"])
            self._redraw()
            return

        if ps["kind"] == "room_pending":
            dx = abs(event.x - ps["sx"])
            dy = abs(event.y - ps["sy"])
            if dx > self._CLICK_VS_DRAG_THRESHOLD or dy > self._CLICK_VS_DRAG_THRESHOLD:
                # Dragged enough — convert to pan.
                ps["kind"] = "pan"
                self.canvas.config(cursor="fleur")
                self.viewport.offset_x = ps["vox"] + (event.x - ps["sx"])
                self.viewport.offset_y = ps["voy"] + (event.y - ps["sy"])
                self._redraw()

    def _on_canvas_release(self, event):
        # Dim drag release
        if self._dim_drag is not None:
            self._on_canvas_b1_release(event)
            return

        ps = self._press_state
        self._press_state = None
        self.canvas.config(cursor="arrow")

        if ps is None:
            return

        if ps["kind"] == "room_pending":
            # Never dragged far enough — treat as a click → toggle the room.
            self._toggle_room(ps["rid"])
        # "pan" → nothing extra to do, viewport already updated in motion.

    def _on_room_context_menu(self, event):
        """Right-click / Ctrl+click: open a popup menu that lets the user
        explicitly place each of the clicked room's parts on any of the
        four sides of the floorplate. L-shaped rooms expose one submenu
        per arm so you can dim the main body and the secondary arm
        independently."""
        if self.current is None or self.current_entry is None:
            return
        rid = self._room_under_cursor(event)
        if rid is None:
            return
        room = next((r for r in self.current["rooms"] if r["idx"] == rid), None)
        if room is None:
            return
        picks = self.current_entry["picks"]
        parts = room.get("parts") or [{
            "bbox_xy": room["bbox_xy"], "w": room["w"], "h": room["h"],
            "area_mm2": room.get("area_mm2", 0),
        }]

        def is_on(side: str, pid: int) -> bool:
            return (rid, pid) in picks[side]

        def set_side(axis: str, side: str | None, pid: int):
            """Place (rid, pid) on `side` — mutually exclusive with the
            opposite side on the same axis. Passing side=None clears both
            sides for this part. Doesn't touch other parts of the room."""
            keys = ("h_top", "h_bot") if axis == "w" else ("v_left", "v_right")
            for k in keys:
                if (rid, pid) in picks[k]:
                    picks[k].remove((rid, pid))
                    self._remove_overrides_for(rid, pid, k)
            if side:
                picks[side].append((rid, pid))
            self._redraw()
            self._save_entry_picks(self.current_entry)

        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label=f"— {room['name'][:30]} —", state=tk.DISABLED)

        multi = len(parts) > 1
        for pid, part in enumerate(parts):
            if multi:
                menu.add_separator()
                part_label = (
                    f"Main body  ({part['w']/1000:.2f} × {part['h']/1000:.2f} m)"
                    if pid == 0 else
                    f"Part {pid + 1}  ({part['w']/1000:.2f} × {part['h']/1000:.2f} m)"
                )
                menu.add_command(label=part_label, state=tk.DISABLED)

            wlbl = f"{part['w']/1000:.2f} m"
            hlbl = f"{part['h']/1000:.2f} m"
            menu.add_command(
                label=f"{'✓' if is_on('h_top', pid) else ' '}  Width on top          {wlbl}",
                command=lambda p=pid: set_side("w", "h_top" if not is_on("h_top", p) else None, p),
            )
            menu.add_command(
                label=f"{'✓' if is_on('h_bot', pid) else ' '}  Width on bottom       {wlbl}",
                command=lambda p=pid: set_side("w", "h_bot" if not is_on("h_bot", p) else None, p),
            )
            menu.add_command(
                label=f"{'✓' if is_on('v_left', pid) else ' '}  Height on left        {hlbl}",
                command=lambda p=pid: set_side("h", "v_left" if not is_on("v_left", p) else None, p),
            )
            menu.add_command(
                label=f"{'✓' if is_on('v_right', pid) else ' '}  Height on right       {hlbl}",
                command=lambda p=pid: set_side("h", "v_right" if not is_on("v_right", p) else None, p),
            )

        def clear_all():
            for k in ("h_top", "h_bot", "v_left", "v_right"):
                picks[k] = [p for p in picks[k]
                            if (p[0] if isinstance(p, tuple) else p) != rid]
            self._remove_overrides_for(rid)
            self._redraw()
            self._save_entry_picks(self.current_entry)

        menu.add_separator()
        menu.add_command(label="Clear all dims for this room", command=clear_all)

        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
            # macOS Tk quirk: after tk_popup / grab_release the main window
            # can end up without input focus, which shows up as "my window
            # keeps going out of focus" after dismissing the menu. Kick the
            # focus back explicitly on the next idle tick.
            self.root.after(10, self._restore_focus)
        # Stop Tk from routing this click event further — we've handled it.
        return "break"

    def _on_room_hover(self, room_idx: int, entering: bool):
        if self.current is None:
            return
        self.hover_idx = room_idx if entering else None
        if entering:
            room = next((r for r in self.current["rooms"] if r["idx"] == room_idx), None)
            if room:
                self.status.set(
                    f"{room['name']} — {room['w']/1000:.2f} × {room['h']/1000:.2f} m "
                    f"({room['area_mm2']/1e6:.1f} m²)"
                )

    def _on_canvas_resize(self, _event):
        if self.current is not None:
            self._fit_view_to_current()
        # Always redraw so the empty-state drop hint re-centres on resize
        # (and so it appears at startup once the canvas has its real size).
        self._redraw()

    def _on_zoom(self, event):
        # Normalize wheel delta across platforms
        if hasattr(event, "delta") and event.delta:
            factor = 1.1 if event.delta > 0 else 1 / 1.1
        elif event.num == 4:
            factor = 1.1
        elif event.num == 5:
            factor = 1 / 1.1
        else:
            return
        # Zoom around the cursor
        wx, wy = self.viewport.c2w(event.x, event.y)
        self.viewport.scale *= factor
        new_cx, new_cy = self.viewport.w2c(wx, wy)
        self.viewport.offset_x += event.x - new_cx
        self.viewport.offset_y += event.y - new_cy
        self._redraw()

    def _on_motion(self, event):
        if self.current is None:
            return
        wx, wy = self.viewport.c2w(event.x, event.y)
        self.status.set(f"x: {wx/1000:7.2f} m    y: {wy/1000:7.2f} m")


# ------------------------------ Entry point ------------------------------

def main():
    root = tk.Tk()
    # Use a slightly nicer ttk theme if available
    try:
        style = ttk.Style()
        if "aqua" in style.theme_names():
            style.theme_use("aqua")
    except Exception:
        pass

    app = FloorplanStudio(root)

    # macOS focus fix: Tk windows launched from the terminal often don't
    # come to the front and therefore never receive mouse or key events
    # until they're explicitly raised. Lift the window, grab focus, and
    # flash -topmost briefly so the OS actually gives us the input focus.
    def _raise_window():
        try:
            root.lift()
            root.attributes("-topmost", True)
            root.after(200, lambda: root.attributes("-topmost", False))
            root.focus_force()
        except Exception:
            pass

    root.after(50, _raise_window)
    root.mainloop()


if __name__ == "__main__":
    main()
