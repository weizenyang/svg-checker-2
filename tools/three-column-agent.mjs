#!/usr/bin/env node
/**
 * Headless runner for the /three-column page's agent API (window.threeColumn).
 *
 * Turns rows, CSVs or floorplan images into 4096×4096 dimension-table files named
 * exactly after their source (e.g. dims_a_s_1b_d651_s1_0.png / .svg) and writes them
 * to an output folder. Prints a JSON summary on stdout; progress goes to stderr.
 *
 * Docs: public/three-column-agent.md · Example job: tools/three-column-job.example.json
 * Requires Node 18+ (puppeteer). With nvm: `source ~/.nvm/nvm.sh && nvm use 20`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://localhost:4321/three-column/';
const DEFAULT_FORMATS = ['png', 'svg'];
const IMAGE_MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif'
};

const USAGE = `three-column-agent — generate dimension-table files named exactly after their source

Usage:
  npm run three-column:agent -- --job job.json [--out DIR]
  npm run three-column:agent -- --images ./floorplans [--provider gemini] [--out DIR]
  npm run three-column:agent -- --csv ./tables [--formats png,svg,csv]

Inputs (combine freely):
  --job FILE           Job JSON. Items: { name, rows } | { name, csv } | { name?, imagePath }
                       | { name?, csvPath }. Paths resolve relative to the job file.
  --images PATH...     Image files or folders (PNG/JPEG/WebP/GIF). The page's AI reads each one;
                       output name = image filename without its extension.
  --csv PATH...        CSV files or folders (room,metric,imperial). Output name = CSV filename.

Output:
  --out DIR            Output folder (default ./three-column-out). Never writes over an input file.
  --formats LIST       png,svg,csv (default png,svg)
  --overwrite          Replace files that already exist in --out
  --validate-only      Read + verify rows and print them; write nothing

AI (only needed for images):
  --provider NAME      gemini | openrouter
  --model ID           Model id (default: the page's first model for that provider)
  --api-key KEY        Or set GEMINI_API_KEY / OPENROUTER_API_KEY (PUBLIC_* variants also work)

Runtime:
  --url URL            Page URL (default ${DEFAULT_URL}). A local URL that isn't
                       responding gets an 'astro dev' server started automatically.
  --no-server          Never start a dev server
  --batch-size N       Items per page run (default 10)
  --timeout MS         Per-batch timeout (default 600000)
  --headful            Show the browser window
  --verbose            Forward page console + dev-server logs to stderr

Exit code: 0 = everything exported; 1 = some items failed (the rest are still written);
2 = usage or setup error.`;

class UsageError extends Error {}

function log(msg) {
	process.stderr.write(`[three-column] ${msg}\n`);
}

/** Must match outputBasename() in src/pages/three-column.astro. */
function outputBasename(name) {
	const s = String(name ?? '')
		.trim()
		.replace(/\.(png|svg|csv|jpe?g|webp|gif)$/i, '')
		.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
		.replace(/^[\s.]+|[\s.]+$/g, '');
	return s || 'three-column';
}

function parseArgs(argv) {
	const opts = { images: [], csv: [] };
	const BOOL = new Set(['overwrite', 'validate-only', 'headful', 'verbose', 'no-server', 'help']);
	const MULTI = new Set(['images', 'csv']);
	const VALUE = new Set(['job', 'out', 'formats', 'provider', 'model', 'api-key', 'url', 'batch-size', 'timeout']);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h') {
			opts.help = true;
			continue;
		}
		if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument "${arg}"`);
		const eq = arg.indexOf('=');
		const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
		const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
		if (BOOL.has(key)) {
			opts[key] = true;
		} else if (MULTI.has(key)) {
			if (inline !== undefined) opts[key].push(inline);
			while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key].push(argv[++i]);
		} else if (VALUE.has(key)) {
			const v = inline ?? argv[++i];
			if (v === undefined || v.startsWith('--')) throw new UsageError(`--${key} needs a value`);
			opts[key] = v;
		} else {
			throw new UsageError(`Unknown option --${key}`);
		}
	}
	return opts;
}

function parseFormats(raw) {
	const list = (Array.isArray(raw) ? raw : String(raw).split(','))
		.map((f) => String(f).trim().toLowerCase())
		.filter(Boolean);
	for (const f of list) {
		if (!['png', 'svg', 'csv'].includes(f)) throw new UsageError(`Unknown format "${f}" — use png, svg or csv`);
	}
	if (!list.length) throw new UsageError('No formats given');
	return [...new Set(list)];
}

function listFiles(paths, exts, kind) {
	const out = [];
	for (const p of paths) {
		const abs = path.resolve(p);
		if (!fs.existsSync(abs)) throw new UsageError(`${kind} not found: ${p}`);
		if (fs.statSync(abs).isDirectory()) {
			for (const f of fs.readdirSync(abs).sort()) {
				const fp = path.join(abs, f);
				if (fs.statSync(fp).isFile() && exts.includes(path.extname(f).toLowerCase())) out.push(fp);
			}
		} else {
			out.push(abs);
		}
	}
	return out;
}

function imageItem(file, name) {
	const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
	if (!mime) throw new UsageError(`Unsupported image type: ${file} (use PNG, JPEG, WebP or GIF)`);
	const item = {
		image: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`,
		imageName: path.basename(file)
	};
	if (name != null) item.name = name;
	return item;
}

function csvItem(file, name) {
	return { name: name ?? path.basename(file, path.extname(file)), csv: fs.readFileSync(file, 'utf8') };
}

/** Builds the page job from --job / --images / --csv. Returns the job and every input path read. */
function buildJob(opts) {
	const inputs = [];
	let job = {};
	const items = [];

	if (opts.job) {
		const jobPath = path.resolve(opts.job);
		if (!fs.existsSync(jobPath)) throw new UsageError(`Job file not found: ${opts.job}`);
		try {
			job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
		} catch (e) {
			throw new UsageError(`Job file is not valid JSON: ${e.message}`);
		}
		const baseDir = path.dirname(jobPath);
		for (const [i, raw] of (Array.isArray(job.items) ? job.items : []).entries()) {
			if (!raw || typeof raw !== 'object') throw new UsageError(`items[${i}] must be an object`);
			const { imagePath, csvPath, ...rest } = raw;
			if (imagePath) {
				const file = path.resolve(baseDir, imagePath);
				if (!fs.existsSync(file)) throw new UsageError(`items[${i}].imagePath not found: ${imagePath}`);
				inputs.push(file);
				items.push({ ...rest, ...imageItem(file, rest.name) });
			} else if (csvPath) {
				const file = path.resolve(baseDir, csvPath);
				if (!fs.existsSync(file)) throw new UsageError(`items[${i}].csvPath not found: ${csvPath}`);
				inputs.push(file);
				items.push({ ...rest, ...csvItem(file, rest.name) });
			} else {
				items.push(rest);
			}
		}
	}
	for (const file of listFiles(opts.images, Object.keys(IMAGE_MIME), 'Image')) {
		inputs.push(file);
		items.push(imageItem(file));
	}
	for (const file of listFiles(opts.csv, ['.csv'], 'CSV')) {
		inputs.push(file);
		items.push(csvItem(file));
	}
	if (!items.length) throw new UsageError('Nothing to do — pass --job, --images or --csv');

	const { items: _ignored, deliver: _d, replace: _r, zipName: _z, fromAttachments: _f, ...jobBase } = job;
	jobBase.formats = parseFormats(opts.formats ?? job.formats ?? DEFAULT_FORMATS);
	if (opts['validate-only']) jobBase.validateOnly = true;

	const env = process.env;
	const provider = opts.provider ?? job.ai?.provider ??
		(env.GEMINI_API_KEY || env.PUBLIC_GEMINI_API_KEY ? 'gemini'
			: env.OPENROUTER_API_KEY || env.PUBLIC_OPENROUTER_API_KEY ? 'openrouter' : undefined);
	if (provider && !['gemini', 'openrouter'].includes(provider)) {
		throw new UsageError(`--provider must be gemini or openrouter (got "${provider}")`);
	}
	const apiKey = opts['api-key'] ?? job.ai?.apiKey ??
		(provider === 'gemini' ? env.GEMINI_API_KEY || env.PUBLIC_GEMINI_API_KEY
			: provider === 'openrouter' ? env.OPENROUTER_API_KEY || env.PUBLIC_OPENROUTER_API_KEY : undefined);
	const ai = { ...(job.ai ?? {}) };
	if (provider) ai.provider = provider;
	if (apiKey) ai.apiKey = apiKey;
	if (opts.model) ai.model = opts.model;
	if (Object.keys(ai).length) jobBase.ai = ai;

	return { jobBase, items, inputs };
}

/**
 * Fails fast — before any browser or AI work — on duplicate output names, outputs that
 * would overwrite an input file, and existing outputs (unless --overwrite).
 */
function checkPlannedOutputs(items, formats, outDir, inputs, overwrite) {
	const sameFs = process.platform === 'darwin' || process.platform === 'win32'; // case-insensitive
	const key = (p) => (sameFs ? p.toLowerCase() : p);
	const inputSet = new Set(inputs.map((p) => key(path.resolve(p))));
	const seen = new Map();
	const problems = [];
	for (const [i, item] of items.entries()) {
		const raw = item.name ?? item.imageName;
		if (raw == null || !String(raw).trim()) continue; // the page reports missing names
		const base = outputBasename(raw);
		const prev = seen.get(base.toLowerCase());
		if (prev !== undefined) {
			problems.push(`duplicate output name "${base}" (items ${prev} and ${i})`);
			continue;
		}
		seen.set(base.toLowerCase(), i);
		for (const fmt of formats) {
			const dest = path.join(outDir, `${base}.${fmt}`);
			if (inputSet.has(key(dest))) problems.push(`${dest} would overwrite an input file — use a different --out`);
			else if (!overwrite && fs.existsSync(dest)) problems.push(`${dest} already exists (pass --overwrite to replace)`);
		}
	}
	if (problems.length) {
		const shown = problems.slice(0, 15).map((p) => `  - ${p}`).join('\n');
		const more = problems.length > 15 ? `\n  …and ${problems.length - 15} more` : '';
		throw new UsageError(`Refusing to run:\n${shown}${more}`);
	}
}

const RELOAD_ERROR = /Execution context was destroyed|Cannot find context|frame was detached|navigat/i;

/**
 * Waits until the page API is ready AND the page has stopped reloading. A dev server
 * reloads every page once when it first optimizes a dependency (Vite: "optimized
 * dependencies changed. reloading"); without this, that reload can land mid-run.
 */
async function waitForStablePage(page) {
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			await page.waitForFunction(() => window.threeColumn?.ready === true, { timeout: 120000 });
			const token = await page.evaluate(() => (window.__tcStable = Math.random().toString(36).slice(2)));
			await new Promise((r) => setTimeout(r, 2500));
			if ((await page.evaluate(() => window.__tcStable)) === token) return;
		} catch (e) {
			if (!RELOAD_ERROR.test(e.message)) throw e;
		}
		log('Page reloaded while warming up (dev server optimizing dependencies) — waiting…');
	}
	throw new Error('The page kept reloading — is the dev server stable?');
}

/** Runs one batch; if a dev-server reload interrupts it, waits for the page and retries. */
async function runBatch(page, job) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await page.evaluate((j) => window.threeColumn.run(j), job);
		} catch (e) {
			if (attempt >= 3 || !RELOAD_ERROR.test(e.message)) throw e;
			log(`Page reloaded mid-batch — retrying (attempt ${attempt + 1}/3)…`);
			await waitForStablePage(page);
		}
	}
}

async function isUp(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Starts `astro dev` with this same Node binary; resolves with the base URL it prints. */
function startDevServer(port, verbose) {
	const astroBin = path.join(REPO_ROOT, 'node_modules', 'astro', 'astro.js');
	if (!fs.existsSync(astroBin)) throw new UsageError('astro is not installed — run npm install');
	const child = spawn(process.execPath, [astroBin, 'dev', '--port', String(port)], {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }
	});
	const ready = new Promise((resolve, reject) => {
		let buf = '';
		const timer = setTimeout(() => reject(new Error('astro dev did not start within 90s')), 90000);
		const onData = (chunk) => {
			const text = chunk.toString();
			if (verbose) process.stderr.write(text);
			buf += text.replace(/\x1b\[[0-9;]*m/g, '');
			const m = buf.match(/Local\s+(https?:\/\/\S+)/);
			if (m) {
				clearTimeout(timer);
				resolve(m[1].replace(/\/$/, ''));
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`astro dev exited before it was ready (code ${code})`));
		});
	});
	return { child, ready };
}

async function main() {
	const major = Number(process.versions.node.split('.')[0]);
	if (major < 18) {
		throw new UsageError(
			`Needs Node 18+ for puppeteer (found ${process.versions.node}).\n` +
				'With nvm: source ~/.nvm/nvm.sh && nvm use 20'
		);
	}

	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || process.argv.length <= 2) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	const { jobBase, items, inputs } = buildJob(opts);
	const formats = jobBase.formats;
	const validateOnly = Boolean(jobBase.validateOnly);
	const outDir = path.resolve(opts.out ?? 'three-column-out');
	if (!validateOnly) checkPlannedOutputs(items, formats, outDir, inputs, Boolean(opts.overwrite));

	const batchSize = Math.max(1, Number.parseInt(opts['batch-size'] ?? '10', 10) || 10);
	const timeout = Math.max(30000, Number.parseInt(opts.timeout ?? '600000', 10) || 600000);

	// Page URL — start a dev server if a local URL isn't answering.
	let url = opts.url ?? DEFAULT_URL;
	let server = null;
	const stopServer = () => {
		if (server && server.exitCode === null) server.kill('SIGTERM');
	};
	process.on('exit', stopServer);
	for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopServer(), process.exit(130)));

	if (!(await isUp(url))) {
		const u = new URL(url);
		const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
		if (!local || opts['no-server']) throw new UsageError(`Page is not reachable: ${url}`);
		log(`Starting astro dev (no server answered at ${u.origin})…`);
		const dev = startDevServer(u.port || 4321, opts.verbose);
		server = dev.child;
		url = (await dev.ready) + u.pathname;
		log(`Dev server ready: ${url}`);
	}

	const { default: puppeteer } = await import('puppeteer');
	const browser = await puppeteer.launch({
		headless: !opts.headful,
		protocolTimeout: timeout,
		args: process.getuid?.() === 0 ? ['--no-sandbox'] : []
	});

	const summary = {
		ok: true,
		url,
		outDir: validateOnly ? null : outDir,
		formats,
		validateOnly,
		files: [],
		sheets: [],
		flaggedSheets: [],
		errors: []
	};

	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1400, height: 1000 });
		page.on('pageerror', (e) => log(`page error: ${e.message}`));
		if (opts.verbose) page.on('console', (m) => log(`page ${m.type()}: ${m.text()}`));
		await page.goto(url, { waitUntil: 'load', timeout: 120000 });
		await waitForStablePage(page);
		const version = await page.evaluate(() => window.threeColumn.version);
		log(`Page API v${version} ready — ${items.length} item(s), formats ${formats.join(', ')}`);

		if (!validateOnly) fs.mkdirSync(outDir, { recursive: true });
		const batches = Math.ceil(items.length / batchSize);
		for (let b = 0; b < batches; b++) {
			const batch = items.slice(b * batchSize, (b + 1) * batchSize);
			log(`Batch ${b + 1}/${batches}: ${batch.length} item(s)…`);
			const res = await runBatch(page, {
				...jobBase,
				items: batch,
				replace: true, // fresh browser profile: nothing of the user's to keep
				deliver: validateOnly ? 'none' : 'base64'
			});
			for (const f of res.files) {
				if (!f.base64) continue;
				if (path.basename(f.filename) !== f.filename) throw new Error(`Unsafe filename from page: ${f.filename}`);
				const dest = path.join(outDir, f.filename);
				fs.writeFileSync(dest, Buffer.from(f.base64, 'base64'));
				summary.files.push({ sheet: f.sheet, path: dest, format: f.format, bytes: f.bytes });
				log(`  wrote ${f.filename}`);
			}
			summary.sheets.push(...res.sheets);
			summary.flaggedSheets.push(...res.flaggedSheets);
			summary.errors.push(...res.errors);
		}
	} finally {
		await browser.close();
		stopServer();
	}

	summary.ok = summary.errors.length === 0;
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (summary.flaggedSheets.length) {
		log(`Review needed — metric/imperial still disagree in: ${summary.flaggedSheets.join(', ')}`);
	}
	log(
		validateOnly
			? `Validated ${summary.sheets.length} item(s), ${summary.errors.length} error(s).`
			: `Wrote ${summary.files.length} file(s) to ${outDir}, ${summary.errors.length} error(s).`
	);
	return summary.ok ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		process.stderr.write(`${e instanceof UsageError ? '' : 'Error: '}${e.message}\n`);
		if (e instanceof UsageError && !/^Refusing|^Needs Node|not reachable|not installed/.test(e.message)) {
			process.stderr.write('Run with --help for usage.\n');
		}
		process.exit(e instanceof UsageError ? 2 : 1);
	}
);
