"""Entry point: `python -m floorplan_studio [file.dxf|file.dwg]`

IMPORTANT: the tkinter-importing `app` module is only loaded inside the
`__name__ == "__main__"` guard below. When the ProcessPoolExecutor worker
spawns on macOS it re-imports this module to unpickle function references;
if we imported `app` (and transitively `tkinter`) at module top level the
worker would register itself as a second macOS GUI app and steal focus from
the real Studio window every time it woke up. Deferring the import keeps
the child process headless.
"""
import sys
from pathlib import Path

# Allow running straight from the repo checkout without installing.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

if __name__ == "__main__":
    from floorplan_studio.app import main
    main()
