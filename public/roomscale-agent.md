# Roomscale-4 headless API (reversed normals)

Page: `/roomscale-4`. Exposed as `window.roomscale` (same object as `window.svgChecker.roomscale`).
Wait for `window.roomscale?.ready === true` (or `await window.roomscale.whenReady()`).

| Call | Returns |
|---|---|
| `loadMesh(src, {cameraCsv?})` | `src` = File/Blob/ArrayBuffer/URL of a `.glb`; optional camera CSV (text or URL). Resolves `{name, objects, cameras, meshes, faces}` |
| `detectReversed({method?, positions?})` | Selects reversed faces. `method: "render"` (default when cameras are loaded; same as the *Select all reversed* button, 8K render compare per camera) or `"geometric"` (dot-product test from camera markers, `positions:[{x,y,z}]`, or the viewport camera). Returns `{method, count}` |
| `flipReversed()` | Flips the selected faces via `flipSelectedNormals`; returns number flipped |
| `exportGLB({scene?})` | `Promise<ArrayBuffer>` of the model (no download triggered) |
| `run(src, opts?)` | load → detect → flip → re-detect → export. `{method, reversedBefore, flipped, reversedAfter, glb: ArrayBuffer}` |

Lower-level calls already on main: `detectReversedNormalsFromCamera(pos)`, `selectAllReversedFaces()`, `flipSelectedNormals()`, `getSummary()`.

Note: positions are in scene units; loaded GLBs are scaled ×100.

## Playwright (Python, headless Chromium)

```python
import base64
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page()
    pg.goto("https://svg-checker-2.vercel.app/roomscale-4")
    pg.wait_for_function("window.roomscale?.ready", timeout=60000)
    data = base64.b64encode(open("model.glb", "rb").read()).decode()
    res = pg.evaluate("""async (b64) => {
        const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
        const r = await window.roomscale.run(buf, { method: "geometric" });
        const bytes = new Uint8Array(r.glb); let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { ...r, glb: btoa(s) };
    }""", data)
    open("model_fixed.glb", "wb").write(base64.b64decode(res["glb"]))
    print(res["reversedBefore"], res["flipped"], res["reversedAfter"])
    b.close()
```
