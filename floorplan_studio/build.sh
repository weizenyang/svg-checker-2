#!/bin/bash
#
# Build Floorplan Studio as a standalone macOS .app bundle.
#
# Usage (from the repo root):
#     bash floorplan_studio/build.sh
#
# Output:
#     dist/Floorplan Studio.app
#
# To install:
#     cp -r "dist/Floorplan Studio.app" /Applications/
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Floorplan Studio build ==="
echo ""

# Use the Xcode-bundled Python which has all our runtime deps installed.
# Override by setting PYTHON env var before running this script.
PYTHON="${PYTHON:-/Applications/Xcode.app/Contents/Developer/usr/bin/python3}"
echo "Using Python: $PYTHON ($($PYTHON --version 2>&1))"

# 1. Make sure we're using a Python that has all the runtime deps.
echo "Checking deps…"
$PYTHON -c "
import ezdxf, numpy, scipy, skimage, PIL
print(f'  ezdxf   {ezdxf.__version__}')
print(f'  numpy   {numpy.__version__}')
print(f'  scipy   {scipy.__version__}')
print(f'  skimage {skimage.__version__}')
print(f'  Pillow  {PIL.__version__}')
"

# 2. Install PyInstaller if not present.
if ! $PYTHON -m PyInstaller --version >/dev/null 2>&1; then
    echo ""
    echo "Installing PyInstaller…"
    $PYTHON -m pip install -q pyinstaller
fi
echo "  PyInstaller $($PYTHON -m PyInstaller --version 2>&1)"

# 3. Clean previous build artifacts.
echo ""
echo "Building…"
$PYTHON -m PyInstaller \
    --noconfirm \
    --clean \
    --log-level WARN \
    floorplan_studio/floorplan_studio.spec

# 4. Report result.
APP="dist/Floorplan Studio.app"
if [ -d "$APP" ]; then
    SIZE=$(du -sh "$APP" | cut -f1)
    echo ""
    echo "=== Build succeeded ==="
    echo "  $APP  ($SIZE)"
    echo ""
    echo "To install:"
    echo "  cp -r \"$APP\" /Applications/"
    echo ""
    echo "To run directly:"
    echo "  open \"$APP\""
else
    echo ""
    echo "=== Build FAILED — dist/Floorplan Studio.app not found ==="
    exit 1
fi
