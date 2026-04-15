# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Floorplan Studio.

Bundles ONLY the dependencies the app actually uses — ezdxf, numpy, scipy,
scikit-image, Pillow — and excludes everything else (rich,
matplotlib, pandas, jupyter, pytest, etc.) to keep the .app slim.

Build from the repo root:
    python -m PyInstaller --noconfirm --clean floorplan_studio/floorplan_studio.spec
"""
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# SPECPATH is the directory containing this .spec file (floorplan_studio/).
# REPO_ROOT is one level up — all paths below are relative to REPO_ROOT.
REPO_ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))

# ---- Collect packages that have data files / native libs ----

# ezdxf ships internal template/encoding data files that must be bundled.
ezdxf_datas, ezdxf_binaries, ezdxf_hidden = collect_all('ezdxf')


# scikit-image uses lazy submodule imports that PyInstaller can't trace.
skimage_hidden = collect_submodules('skimage')

a = Analysis(
    [os.path.join(REPO_ROOT, 'floorplan_studio', '__main__.py')],
    pathex=[REPO_ROOT],
    binaries=ezdxf_binaries,
    datas=[
        # tools/floorplan_dims.py is imported via sys.path at runtime,
        # not as a proper package, so PyInstaller won't find it by tracing.
        (os.path.join(REPO_ROOT, 'tools'), 'tools'),
    ] + ezdxf_datas,
    hiddenimports=[
        # scikit-image submodules used directly
        'skimage.draw',
        'skimage.morphology',
        'skimage.measure',
        'skimage.segmentation',
        # scipy submodules
        'scipy.ndimage',
        'scipy.ndimage._ni_support',
        # Pillow
        'PIL.Image',
        'PIL.ImageDraw',
    ] + ezdxf_hidden + skimage_hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # ---- CLI-only / unused deps — strip to reduce bloat ----
        'rich',
        'matplotlib', 'matplotlib.pyplot',
        'pandas',
        'jupyter', 'jupyter_core', 'jupyter_client',
        'IPython', 'ipykernel', 'ipywidgets',
        'notebook', 'nbformat', 'nbconvert',
        'pytest', 'pytest_cov', '_pytest',
        'docutils', 'sphinx',
        'pygments',
        'cv2', 'opencv',
        'torch', 'tensorflow', 'keras',
        'sqlalchemy',
        'flask', 'django',
        'puppeteer',
        'lunr',
        'gsap',
        'nanostores',
    ],
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
    name='Floorplan Studio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    upx=True,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=True,
    upx=True,
    upx_exclude=[],
    name='Floorplan Studio',
)

app = BUNDLE(
    coll,
    name='Floorplan Studio.app',
    icon=None,
    bundle_identifier='com.local.floorplan-studio',
    info_plist={
        'NSHighResolutionCapable': 'True',
        'CFBundleShortVersionString': '0.1.0',
        'CFBundleName': 'Floorplan Studio',
        'NSRequiresAquaSystemAppearance': 'False',
    },
)
