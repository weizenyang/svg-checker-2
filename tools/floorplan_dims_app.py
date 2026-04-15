#!/usr/bin/env python3
"""
Floorplan Dims — desktop UI for floorplan_dims.py (batch DXF/DWG → SVG).

Drag-and-drop requires: pip install tkinterdnd2

Build (macOS): cd tools && pip install -r requirements-gui.txt && pyinstaller floorplan_dims_app.spec
  Then open dist/FloorplanDims.app — use the .app icon, not a raw Terminal command.
"""
from __future__ import annotations

import queue
import re
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk

_TOOLS = Path(__file__).resolve().parent
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))

from floorplan_dims import process_input_file  # noqa: E402

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD

    _HAS_DND = True
except ImportError:
    _HAS_DND = False
    DND_FILES = None  # type: ignore
    TkinterDnD = None  # type: ignore


def _sanitize_stem(stem: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip()
    return s[:120] if s else "drawing"


def _unique_out_dir(base: Path, stem: str) -> Path:
    safe = _sanitize_stem(stem)
    candidate = base / safe
    if not candidate.exists():
        return candidate
    n = 2
    while (base / f"{safe}_{n}").exists():
        n += 1
    return base / f"{safe}_{n}"


class FloorplanApp:
    def __init__(self) -> None:
        if _HAS_DND and TkinterDnD:
            self.root = TkinterDnD.Tk()
        else:
            self.root = tk.Tk()
        self.root.title("Floorplan Dims — DXF/DWG → SVG")
        self.root.minsize(560, 420)
        self.root.geometry("720x520")

        self._files: list[Path] = []
        self._log_q: queue.Queue[str] = queue.Queue()
        self._worker: threading.Thread | None = None

        self._build_ui()

        if _HAS_DND and DND_FILES:
            self.drop_frame.drop_target_register(DND_FILES)
            self.drop_frame.dnd_bind("<<Drop>>", self._on_drop)

        self.root.after(100, self._drain_log_queue)

    def _build_ui(self) -> None:
        pad = {"padx": 8, "pady": 4}
        main = ttk.Frame(self.root, padding=10)
        main.pack(fill=tk.BOTH, expand=True)

        ttk.Label(main, text="Output folder (each file gets a subfolder named after the drawing):").pack(anchor=tk.W)
        row = ttk.Frame(main)
        row.pack(fill=tk.X, **pad)
        self.out_var = tk.StringVar(value=str(Path.home() / "floorplans_out"))
        self.out_entry = ttk.Entry(row, textvariable=self.out_var)
        self.out_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 6))
        ttk.Button(row, text="Browse…", command=self._browse_out).pack(side=tk.RIGHT)

        opts = ttk.Frame(main)
        opts.pack(fill=tk.X, **pad)
        ttk.Label(opts, text="Min labels / floorplan:").pack(side=tk.LEFT)
        self.min_labels = tk.IntVar(value=5)
        ttk.Spinbox(opts, from_=1, to=50, width=6, textvariable=self.min_labels).pack(side=tk.LEFT, padx=6)
        ttk.Label(opts, text="Raster mm/px:").pack(side=tk.LEFT, padx=(16, 0))
        self.raster_mm = tk.DoubleVar(value=20.0)
        ttk.Spinbox(opts, from_=10, to=60, increment=5, width=6, textvariable=self.raster_mm).pack(side=tk.LEFT, padx=6)

        self.drop_frame = tk.LabelFrame(main, text="Files", padx=8, pady=8)
        self.drop_frame.pack(fill=tk.BOTH, expand=True, **pad)
        hint = (
            "Drag DXF/DWG files here"
            if _HAS_DND
            else "Drag-and-drop unavailable (pip install tkinterdnd2). Use the buttons below."
        )
        ttk.Label(self.drop_frame, text=hint, foreground="#555").pack(anchor=tk.W)

        btn_row = ttk.Frame(self.drop_frame)
        btn_row.pack(fill=tk.X, pady=4)
        ttk.Button(btn_row, text="Add files…", command=self._add_files).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Button(btn_row, text="Remove selected", command=self._remove_selected).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Button(btn_row, text="Clear list", command=self._clear).pack(side=tk.LEFT)

        list_frame = ttk.Frame(self.drop_frame)
        list_frame.pack(fill=tk.BOTH, expand=True, pady=4)
        scroll = ttk.Scrollbar(list_frame)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.listbox = tk.Listbox(list_frame, height=8, selectmode=tk.EXTENDED, yscrollcommand=scroll.set)
        self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scroll.config(command=self.listbox.yview)

        run_row = ttk.Frame(main)
        run_row.pack(fill=tk.X, **pad)
        self.run_btn = ttk.Button(run_row, text="Convert all", command=self._run)
        self.run_btn.pack(side=tk.LEFT)
        self.progress = ttk.Progressbar(run_row, mode="indeterminate", length=200)
        self.progress.pack(side=tk.LEFT, padx=12, fill=tk.X, expand=True)

        ttk.Label(main, text="Log:").pack(anchor=tk.W)
        _mono = ("Menlo", 10) if sys.platform == "darwin" else ("Consolas", 10)
        self.log = scrolledtext.ScrolledText(main, height=10, wrap=tk.WORD, font=_mono)
        self.log.pack(fill=tk.BOTH, expand=True, pady=(4, 0))

    def _browse_out(self) -> None:
        d = filedialog.askdirectory(initialdir=self.out_var.get() or str(Path.home()))
        if d:
            self.out_var.set(d)

    def _add_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="DXF / DWG files",
            filetypes=[
                ("CAD", "*.dxf *.dwg"),
                ("DXF", "*.dxf"),
                ("DWG", "*.dwg"),
                ("All", "*.*"),
            ],
        )
        for p in paths:
            self._add_file(Path(p))

    def _add_file(self, path: Path) -> None:
        if not path.is_file():
            return
        if path.suffix.lower() not in (".dxf", ".dwg"):
            return
        rp = path.resolve()
        if rp in self._files:
            return
        self._files.append(rp)
        self.listbox.insert(tk.END, str(rp))

    def _on_drop(self, event) -> None:
        try:
            raw = event.data
            paths = self.root.tk.splitlist(raw)
        except tk.TclError:
            paths = [event.data.strip().strip("{}")]
        for p in paths:
            self._add_file(Path(p))

    def _remove_selected(self) -> None:
        sel = list(self.listbox.curselection())
        sel.reverse()
        for i in sel:
            self.listbox.delete(i)
            del self._files[i]

    def _clear(self) -> None:
        self.listbox.delete(0, tk.END)
        self._files.clear()

    def _append_log(self, line: str) -> None:
        self.log.insert(tk.END, line + "\n")
        self.log.see(tk.END)

    def _drain_log_queue(self) -> None:
        try:
            while True:
                line = self._log_q.get_nowait()
                self._append_log(line)
        except queue.Empty:
            pass
        self.root.after(100, self._drain_log_queue)

    def _run(self) -> None:
        if self._worker and self._worker.is_alive():
            messagebox.showinfo("Busy", "A conversion is already running.")
            return
        if not self._files:
            messagebox.showwarning("No files", "Add at least one DXF or DWG file.")
            return
        out_base = Path(self.out_var.get().strip())
        if not out_base.parts:
            messagebox.showwarning("Output", "Choose an output folder.")
            return
        try:
            out_base.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            messagebox.showerror("Output", f"Cannot create folder:\n{e}")
            return

        ml = int(self.min_labels.get())
        rm = float(self.raster_mm.get())
        files = list(self._files)

        self.run_btn.config(state=tk.DISABLED)
        self.progress.start(12)

        def work() -> None:
            def log(msg: str) -> None:
                self._log_q.put(msg)

            def fp_prog(msg: str) -> None:
                self._log_q.put(f"    {msg}")

            ok_n = 0
            warn_n = 0
            err_n = 0
            for i, fp in enumerate(files, start=1):
                log(f"\n━━ ({i}/{len(files)}) {fp.name} ━━")
                sub = _unique_out_dir(out_base, fp.stem)
                try:
                    sub.mkdir(parents=True, exist_ok=True)
                except OSError as e:
                    log(f"  ERROR: cannot create {sub}: {e}")
                    err_n += 1
                    continue
                log(f"  → output: {sub}")
                r = process_input_file(
                    fp,
                    sub,
                    min_labels=ml,
                    raster_mm=rm,
                    log=log,
                    on_floorplan_progress=fp_prog,
                )
                if r.get("warning"):
                    log(f"  Note: {r['warning']}")
                if not r["ok"]:
                    err_n += 1
                elif r.get("warning"):
                    warn_n += 1
                else:
                    ok_n += 1
            log(f"\nFinished. Completed without error: {ok_n}, with warnings: {warn_n}, errors: {err_n}")
            self.root.after(0, self._run_done)

        self._worker = threading.Thread(target=work, daemon=True)
        self._worker.start()

    def _run_done(self) -> None:
        self.progress.stop()
        self.run_btn.config(state=tk.NORMAL)

    def mainloop(self) -> None:
        self.root.mainloop()


def main() -> None:
    FloorplanApp().mainloop()


if __name__ == "__main__":
    main()
