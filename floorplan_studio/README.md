# Floorplan Studio

Interactive desktop app for extracting dimensioned floorplans from DXF/DWG files.

Built on the same pipeline as `tools/floorplan_dims.py` (shared module), with
a Tkinter GUI for:

- **Drag-and-drop** a DXF or DWG onto the window (DWG auto-converted via ODA
  File Converter), or use File → Open
- Auto-detecting every floorplan in the file
- Visualising rooms as clickable coloured polygons over the wall drawing
- **Click any room to toggle whether its dimension is shown** on the nearest
  side of the floorplate
- **Right-click / Ctrl+click / two-finger-click** a room to pick exactly
  which side each dim (and each L-shape arm) goes on
- **Every selection is cached** — reopening the file restores your edits
- Exporting each floorplan to SVG with your selected dims

## Running

From the repository root:

```bash
python -m floorplan_studio                            # empty window
python -m floorplan_studio ~/Downloads/apartment.dxf  # open a file at startup
```

## Interaction

| Gesture | Action |
|---|---|
| **Left-click** a room | toggle both width & height dims for that room |
| **Shift+click** a room | toggle only the width (horizontal) dim |
| **Alt/Option+click** | toggle only the height (vertical) dim |
| **Mouse wheel** | zoom around cursor |
| **Middle or right drag** | pan |
| "Auto-pick dims" button | reset to the gap-based tier selection |
| "Clear all dims" | remove every dim from the current floorplan |
| "Fit view" | recentre and rescale the current floorplan to fill the canvas |

Rooms with active dimensions are outlined in red; unselected rooms in slate.

## File menu

- **Open DXF/DWG…** (⌘O)
- **Save current as SVG…** (⌘S) — writes the currently selected floorplan
- **Save all floorplans…** (⌘⇧S) — writes every floorplan to a directory

## Requirements

```bash
python3 -m pip install -r ../tools/requirements.txt
```

That installs `ezdxf`, `numpy`, `scipy`, `scikit-image`, `Pillow`, and `rich`.
Tkinter ships with Python.

For DWG input you additionally need the free
**[ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter)**
installed at `/Applications/ODAFileConverter.app` (macOS) — the app invokes it
in the background to convert DWG → DXF. DXF input needs nothing extra.

## Building a standalone `.app`

```bash
python3 -m pip install pyinstaller
pyinstaller --windowed --name "Floorplan Studio" \
    --osx-bundle-identifier com.local.floorplan-studio \
    floorplan_studio/__main__.py
```

This produces `dist/Floorplan Studio.app`. Drop it into `/Applications` to use
it without opening a terminal.
