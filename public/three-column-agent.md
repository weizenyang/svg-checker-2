# Three-column dimension tables — agent guide

The `/three-column/` page turns room dimensions into 4096×4096 dimension-table images
(transparent PNG and SVG, plus optional CSV). This guide is for agents that generate those
files in bulk and hand them back **named exactly after their source**.

## Pick a path

| You are | Use | You get |
| --- | --- | --- |
| A shell agent (Claude Code, Cursor, a script) | The CLI: `npm run three-column:agent` | Files written to a folder + a JSON summary |
| A browser agent (Claude in Chrome, Playwright) | `window.threeColumn` on the page | One ZIP download (or base64) + a JSON result |

Both drive the same page code, so the output is identical to the page's own Export buttons.

## Naming rules

- Output files are `<name>.png`, `<name>.svg` and `<name>.csv`, with exactly the item's name and
  no size suffix.
- An image item's name defaults to its filename without the extension. Input
  `dims_a_s_1b_d651_s1_0.png` produces `dims_a_s_1b_d651_s1_0.png` (and `.svg`) in the output.
- A trailing file extension in a name is dropped, so `foo.png` and `foo` name the same output.
- Only characters that are illegal in filenames (`\ / : * ? " < > |`) are changed (to `-`).
- **Duplicate names are errors**, compared case-insensitively. Nothing is ever renamed for you.
- Default formats are **PNG + SVG**. Add CSV with `formats: ["png", "svg", "csv"]`.

## Getting the dimensions

**1. Read them yourself (recommended if you can see images).** Put the rows in the job. No API key
is needed, and you stay in control of accuracy.

**2. Let the page's AI read the image ("upload image mode").** Give the item an image. This needs
a Gemini or OpenRouter API key.

A row is `[room, metric, imperial]`:

| Column | Example | Notes |
| --- | --- | --- |
| room | `LIVING / DINING / KITCHEN` | Uppercase; join combined spaces with ` / ` |
| metric | `5.05m  x  5.49m` | `5.05m 5.49m` or `5.05 x 5.49` is fine; it is reformatted |
| imperial | `16’7’’  x  18’0’’` | ASCII `16'7" 18'0"` is fine; quotes become `’` / `’’` |

A room with one dimension uses a single value in each column (`1.50m`, `4’11’’`).

**Verification runs on every row.** Each imperial value is checked against its metric value
(1 m = 3.281 ft, within about 5%):

- Imperial values swapped between adjacent rows are **fixed automatically**. These show up in
  `autoFixed` and `warnings`.
- Rows that still disagree are listed in **`flaggedSheets`**. Check them before delivering.

## CLI (shell agents)

Requires Node 18+ (puppeteer) and an `npm install`. With nvm, run `source ~/.nvm/nvm.sh && nvm use 20`.

```bash
# Rows / CSV you prepared (no API key needed)
npm run three-column:agent -- --job job.json --out ./dims-out

# Floorplan images read by the page's AI; names come from the image filenames
GEMINI_API_KEY=... npm run three-column:agent -- --images ./floorplans --out ./dims-out

# Check what would be generated, without writing anything
npm run three-column:agent -- --job job.json --validate-only
```

| Option | Meaning |
| --- | --- |
| `--job FILE` | Job JSON (see below). `imagePath` / `csvPath` resolve relative to the job file. |
| `--images PATH...` | Image files or folders (PNG, JPEG, WebP, GIF), one item per image |
| `--csv PATH...` | CSV files or folders (`room,metric,imperial` per line), one item per file |
| `--out DIR` | Output folder (default `./three-column-out`) |
| `--formats LIST` | `png,svg,csv` (default `png,svg`) |
| `--overwrite` | Replace files that already exist in `--out` |
| `--validate-only` | Read and verify only; prints rows, writes nothing |
| `--provider`, `--model`, `--api-key` | AI settings for image items. The key can come from `GEMINI_API_KEY` / `OPENROUTER_API_KEY`. |
| `--url URL` | Page to drive (default `http://localhost:4321/three-column/`) |
| `--no-server` | Don't auto-start `astro dev` when a local URL isn't answering |
| `--batch-size N`, `--timeout MS`, `--headful`, `--verbose` | Tuning and debugging |

**Safety.** Before any browser or AI work starts, the CLI refuses to run if:

- an output would overwrite an input file,
- an output already exists (unless you pass `--overwrite`), or
- two items share a name.

If nothing is serving the local URL, it starts `astro dev` and stops it again afterwards.

**Output.** Progress goes to stderr. stdout is one JSON object:

```json
{
  "ok": true,
  "outDir": "/abs/dims-out",
  "formats": ["png", "svg"],
  "files": [{ "sheet": "dims_a_s_1b_d651_s1_0", "path": "/abs/dims-out/dims_a_s_1b_d651_s1_0.png", "format": "png", "bytes": 345581 }],
  "sheets": [{ "name": "dims_a_s_1b_d651_s1_0", "source": "rows", "rowCount": 2, "rows": [["..."]], "warnings": [], "autoFixed": 0, "flagged": 0, "files": ["..."] }],
  "flaggedSheets": [],
  "errors": []
}
```

Exit codes:

- **0** — everything exported.
- **1** — some items failed; the others were still written.
- **2** — usage or setup error; nothing ran.

## Job file

```json
{
  "formats": ["png", "svg"],
  "items": [
    { "name": "dims_a_s_1b_d651_s1_0", "rows": [["LIVING / DINING / KITCHEN", "5.05m 5.49m", "16'7\" 18'0\""]] },
    { "name": "dims_a_s_1b_d651_s1_1", "csv": "BEDROOM,3.41m 3.80m,11'2\" 12'6\"" },
    { "imagePath": "./floorplans/dims_d_s_2b_d758_s1_0.png" },
    { "name": "dims_d_s_3b_d801_s1_1", "imagePath": "./scans/IMG_0042.jpg" }
  ],
  "ai": { "provider": "gemini", "model": "gemini-2.0-flash-001" },
  "typography": { "col0": { "weight": "bold", "tracking": -0.6 } }
}
```

Each item supplies **one** of `rows`, `csv`, `image` (a data URL; in-page only), `imagePath`
(CLI only) or `csvPath` (CLI only). `name` is required except for images, where it defaults to
the filename. Use `name` to rename: the last example reads `IMG_0042.jpg` but outputs
`dims_d_s_3b_d801_s1_1.png`.

| Field | Default | Meaning |
| --- | --- | --- |
| `formats` | `["png","svg"]` | Any of `png`, `svg`, `csv` |
| `ai` | page settings | `provider` (`gemini` / `openrouter`), `model`, `apiKey`, `concurrency` (default 3) |
| `typography` | page settings | Per column (`col0`–`col2`): `weight` (`bold` / `regular`), `tracking` (px) |
| `normalize` | `true` | `false` keeps `rows` items exactly as given (no clean-up or metric/imperial check). CSV and image items are always normalised. |
| `validateOnly` | `false` | Read and verify only |

## Browser agents: `window.threeColumn`

Open `/three-column/` and run code in the page. Call `threeColumn.help()` for a quick reference.

```js
const result = await threeColumn.run({
  items: [{ name: 'dims_a_s_1b_d651_s1_0', rows: [['LIVING / DINING / KITCHEN', '5.05m 5.49m', '16’7’’ 18’0’’']] }],
  formats: ['png', 'svg'], // default
  deliver: 'zip',          // default: one ZIP download. 'base64' returns file data; 'none' skips export.
  replace: false           // default: keep the user's open sheets; same-name sheets are updated
});
```

**Upload image mode in a browser.**

1. Put the floorplan images on the hidden file input `#ai-image-input` (the page's
   "Attach image" button) using your file-upload tool.
2. Call `threeColumn.listAttachments()` to confirm they arrived.
3. Call `await threeColumn.run({ fromAttachments: true })`. Each sheet and file is named after its
   image file. The AI uses the key and model already set in the page unless you pass `ai`.

| Method | Does |
| --- | --- |
| `run(job)` | Load, verify and export. Returns `{ ok, sheets, files, zip?, flaggedSheets, errors }`. |
| `parseImage({ image, ai })` | Have the page's AI read one image. Returns `{ rows, warnings, autoFixed, flagged }` and changes nothing on the page. |
| `verifyRows(rows)` | Normalise and cross-check rows you read yourself, without exporting |
| `listSheets()` | Sheets currently loaded, with their rows and output filenames |
| `listAttachments()` | Images currently attached via "Attach image" |
| `renameSheet(from, to)` | Rename a sheet, which sets its output filenames. Clashing names are rejected. |
| `exportSheets({ names, formats, deliver, zipName })` | Export sheets that are already loaded |
| `clear()` | Reset the page to one empty sheet. Destructive, so only use it when asked to. |
| `filenameFor(name, format)` | The exact filename a name will produce |

A run loads at most 40 sheets at a time. Larger jobs keep working, because the oldest sheets
from the same run are unloaded once they've been exported. Each sheet holds up to 200 rows.

## Recommended agent workflow

1. Collect the inputs and decide every output name up front. Names are final.
2. Get the rows: read them yourself, or use the page's AI.
3. Run with `validateOnly: true` (CLI: `--validate-only`). Check `flaggedSheets` and `warnings`,
   and fix any rows that are wrong.
4. Run for real. Check `ok`, `errors` and `flaggedSheets`.
5. Hand back the output folder or ZIP, plus the list of filenames and anything flagged.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Needs Node 18+ for puppeteer` | `source ~/.nvm/nvm.sh && nvm use 20` |
| `Refusing to run: … already exists` | Pick a new `--out`, or pass `--overwrite` |
| `… would overwrite an input file` | Write outputs to a different folder from the source images |
| `duplicate output name` | Give the items distinct names |
| `No Gemini API key` / `No OpenRouter API key` | Set `GEMINI_API_KEY` / `OPENROUTER_API_KEY`, or pass `--api-key` / `ai.apiKey` |
| `Unsupported image format` | Convert HEIC, AVIF, BMP, TIFF or SVG images to PNG or JPEG first |
| `Page is not reachable` | Start `npm run dev`, or pass a working `--url` |
