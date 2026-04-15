# PyInstaller spec — run from the tools/ directory:
#   cd tools && rm -rf dist build && pip install -r requirements-gui.txt && pyinstaller floorplan_dims_app.spec -y
#
# macOS: dist/FloorplanDims.app (onedir bundle; much smaller than collect_all(numpy,scipy,skimage))
#
# floorplan_dims.py only uses:
#   numpy, PIL.Image/Draw, scipy.ndimage, skimage.measure/segmentation/morphology
# so we bundle those dependency chains — not whole SciPy / all of skimage.

import sys

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules


def _merge_unique(*lists):
    seen = set()
    out = []
    for lst in lists:
        for x in lst:
            if x not in seen:
                seen.add(x)
                out.append(x)
    return out


# Subtrees touched by scipy.ndimage + what it pulls (linalg/special) and skimage pipeline.
_SCI_PACKAGES = (
    "scipy.ndimage",
    "scipy.linalg",
    "scipy.special",
    "scipy.sparse",
    "scipy._lib",
)
_SK_PACKAGES = (
    "skimage.measure",
    "skimage.segmentation",
    "skimage.morphology",
    "skimage.util",
    "skimage._shared",
)

_hidden = []
for pkg in _SCI_PACKAGES + _SK_PACKAGES:
    try:
        _hidden.extend(collect_submodules(pkg))
    except Exception:
        pass

# C extension bridges (SciPy lazy imports) — keep explicit for PyInstaller
_explicit = [
    "scipy._cyutility",
    "tkinterdnd2",
    "ezdxf",
    "PIL",
    "PIL._tkinter_finder",
    "rich",
    "colorsys",
]

_hidden = _merge_unique(_hidden, _explicit)

# Shared libs (OpenBLAS / Fortran runtime live under scipy/.dylibs on macOS, etc.)
_binaries = []
for pkg in ("numpy", "scipy", "skimage"):
    try:
        _binaries.extend(collect_dynamic_libs(pkg))
    except Exception:
        pass

# No extra package data dirs — floorplan_dims does not read skimage sample images
_datas = []

# Drop unrelated heavy stacks if they appear as optional deps
_excludes = [
    "matplotlib",
    "pandas",
    "pytest",
    "IPython",
    "jupyter",
    "torch",
    "tensorflow",
]

block_cipher = None

a = Analysis(
    ["floorplan_dims_app.py"],
    pathex=["."],
    binaries=_binaries,
    datas=_datas,
    hiddenimports=_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=_excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="FloorplanDims",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=True,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="FloorplanDims",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="FloorplanDims.app",
        icon=None,
        bundle_identifier="com.svgchecker.floorplandims",
        info_plist={
            "NSHighResolutionCapable": True,
            "CFBundleName": "Floorplan Dims",
            "CFBundleDisplayName": "Floorplan Dims",
        },
    )
