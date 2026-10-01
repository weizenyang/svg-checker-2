# Agent notes

## Dimension tables (`/three-column/`)

To generate dimension-table PNG/SVG/CSV files named exactly after their source (for example
`dims_a_s_1b_d651_s1_0.png`), use the headless runner. Don't click through the UI.

```bash
source ~/.nvm/nvm.sh && nvm use 20   # puppeteer needs Node 18+
npm run three-column:agent -- --job job.json --out ./dims-out
```

- Full guide (job format, naming rules, CLI options, in-page API): `public/three-column-agent.md`,
  also served at `/three-column-agent.md`.
- Runnable example job: `tools/three-column-job.example.json`.
- Browser agents on the page use `window.threeColumn`; call `threeColumn.help()`.
- Check `flaggedSheets` in the result. It lists rows whose metric and imperial values still
  disagree after auto-correction.
