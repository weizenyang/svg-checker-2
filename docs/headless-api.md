# svg-checker-2 headless API

Thin `window` wrappers around the existing page functions so headless automation (Playwright, SAS QA jobs) can drive the tools without clicking. UI behaviour is unchanged; buttons still download.

`window.svgChecker.version` -> `"1.0.0"`

## `/refactored/` — `window.svgChecker.labels`

| Member | Signature | Wraps |
|---|---|---|
| `ready` | `boolean` | |
| `whenReady()` | `Promise<api>` | |
| `loadPair({csv, backplate?, stem?})` | `csv`: URL / CSV text / Blob / ArrayBuffer; `backplate`: URL / Blob / ArrayBuffer -> `Promise<{loaded, stem}>` | `handleBulkQAImport` + `loadBulkPairIntoViewer` |
| `runQA()` | `Promise<QA>` (same shape as the "Export qa.json" button) | `computeCurrentQAMetrics` |
| `getCollisionsCsv()` | `string` (`label_a,label_b` rows) | same format as `exportCollisionCSV` |
| `exportLabeledSvg()` | `Promise<string>` | `renderLabeledSvgString` |
| `exportLabeledPng()` | `Promise<Blob>` | `renderLabeledPngBlob` |
| `runBatch(pairs, {png?=true})` | `pairs`: `{csv, backplate?, stem?}[]` -> `Promise<{results, zip: Blob}>` | bulk QA + batch labeled SVG/PNG path |

Batch ZIP layout: `<stem>/qa.json`, `<stem>/collisions.csv`, `<stem>/<csv>`, `<stem>_labeled.svg`, `<stem>_labeled.png`.
Each result: `{stem, imageName, csvName, bulkQa, qa, collisionsCsv, labeledSvg, labeledPng, status}`.

## `/roomscale-4` — `window.svgChecker.roomscale`

| Member | Signature | Wraps |
|---|---|---|
| `ready`, `whenReady()` | | |
| `loadMesh(source, {format?: 'glb', cameraCsv?})` | `source`: URL / ArrayBuffer / Blob; `cameraCsv`: CSV text or URL -> `Promise<{name, objects, cameras, meshes, faces}>` | `loadModelFile`, `loadCSVFile` |
| `detectReversedNormalsFromCamera(pos?)` | `{x,y,z}` (default: current camera) -> `{count, faces}` | same name |
| `selectAllReversedFaces()` | `Promise<{selected}>` (needs cameras from `cameraCsv`) | same name |
| `flipSelectedNormals()` | `{flipped}` | same name |
| `getSelectedCount()`, `getSummary()` | | |
| `exportGLB({scene?})` | `Promise<ArrayBuffer>` (Draco GLB, first model or whole scene) | `exportToGLB` (new optional callback arg, no download) |

FBX loading is not exposed (the page's FBX path is tied to its file-input UI); use GLB.

## Playwright example

```js
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto('https://admirable-pastelito-032aac.netlify.app/refactored/');
await page.waitForFunction(() => window.svgChecker?.labels?.ready);
const qa = await page.evaluate(async ({ csvText, pngUrl }) => {
  const L = window.svgChecker.labels;
  await L.loadPair({ csv: csvText, backplate: pngUrl, stem: 'v_s_4b_a1_s1_0' });
  return { qa: await L.runQA(), svg: await L.exportLabeledSvg() };
}, { csvText, pngUrl });

const glb = await page2.evaluate(async (url) => {
  const R = window.svgChecker.roomscale;
  await R.whenReady();
  await R.loadMesh(url, { cameraCsv });
  await R.selectAllReversedFaces();
  R.flipSelectedNormals();
  return Array.from(new Uint8Array(await R.exportGLB()));
}, meshUrl);
```
