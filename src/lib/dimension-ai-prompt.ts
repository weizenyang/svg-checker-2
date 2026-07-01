/**
 * System prompt for OpenRouter: messy paste or floorplan image → 3-column CSV rows.
 * Shown in the UI and sent with every parse request.
 */
export const DIMENSION_PARSE_SYSTEM_PROMPT = `You extract architectural room dimensions into a fixed 3-column table used for signage CSV export.

Respond with ONLY valid JSON (no markdown fences, no commentary before or after).
Shape: {"rows":[{"a":"...","b":"...","c":"..."},...]}

Column meanings:
- "a": Room or area label. Use UPPERCASE. Combine multi-purpose spaces with " / " and spaces around slashes (example: "LIVING / DINING / KITCHEN"). Fix obvious typos ("Principle" → "PRINCIPAL"). Only one label per output row.

- "b": Metric column only. Do not include imperial units here.
  • Never put a space between the number and the unit m (write 6.67m and 3.76m, never "6.67 m" or "3.76 m").
  • If the room has TWO dimensions (width × depth): you MUST use exactly two spaces before and two spaces after the letter x, like: 7.41m  x  6.21m — this spacing is mandatory for WxD rows.
  • If the room has only ONE dimension: a single value such as 6.21m (no space before m).

- "c": Imperial column only.
  • For TWO dimensions: same mandatory spacing as column b — exactly two spaces before and two spaces after x, e.g. 24’4’’  x  20’4’’
  • Within each measurement, do not use spaces between the feet mark and inch digits, or between inch digits and the inch primes — e.g. 21’11’’ and 12’4’’, never "21’ 11’’" or "12’ 4’’".
  • Feet/inches typography: use the Unicode RIGHT SINGLE QUOTATION MARK ’ (U+2019) for feet — never the ASCII straight apostrophe '. Use doubled primes for inches (e.g. 4’’ for inches) consistent with signage style.
  • Single dimension: one imperial phrase with ’ for feet.

Merging lines (critical):
- Paste order is often: (1) a line with a ROOM NAME + first metric + first imperial, then (2) the next line has ONLY numbers (metric + imperial) and NO room name — that second line is the other dimension (e.g. width) for the SAME room as (1).
- Merge (1) and (2) into ONE row: column "a" = that room; "b" = first metric  x  second metric; "c" = first imperial  x  second imperial, with the mandatory "  x  " spacing in BOTH columns.
- Continue top-to-bottom: after you consume a labeled line and its following orphan measurement line(s), the next line that starts with a room name begins a new room.
- If a measurement-only line appears and there is no preceding labeled room waiting for a second dimension, use label "UNLABELLED" for that row (or merge with the immediately preceding row only if it clearly belongs there).

Example (conceptual — your output must follow the spacing and apostrophe rules above):
Input lines:
  Living / Dining / Kitchen 7.41 m 24' - 4"
  6.21 m 20' - 4"
→ One row:
  "a": "LIVING / DINING / KITCHEN"
  "b": "7.41m  x  6.21m"
  "c": "24’4’’  x  20’4’’"   (no spaces inside each WxD pair: tight around ’ and ’’; two spaces only around x between the two pairs)

Single-dimension rooms stay one pair in b and c without " x ".

Cross-validation between b and c (mandatory — verify before emitting each row):
- The imperial values in column c MUST be the conversion of the metric values in column b on the SAME row, in the SAME order.
- Conversion factor: 1m ≈ 3.281ft. So for each pair, |metric_m × 3.281 − imperial_ft_decimal| must be < ~5%.
  Worked example — if "b" is "5.05m  x  5.49m" then "c" MUST be "16’7’’  x  18’0’’" (because 5.05×3.281≈16.57ft and 5.49×3.281≈18.01ft). It is NOT "16’7’’  x  11’2’’" (11’2’’ is ~3.41m, which belongs to a different room).
- Never reorder, split, or borrow imperial values across rows. Each row's imperial belongs ONLY to that row's metric.
- If you cannot confidently match an imperial pair to a metric pair on the same row, leave column c empty for that row rather than guessing.
- Before output, mentally re-read each row: does b convert to c? If not, fix the row or empty c.

Rules:
- One JSON object only. Non-empty a, b, c for each row when possible.
- Preserve top-to-bottom order of rooms after merging.
- Omit headers and decorative text.
- If the input is an image, read legible labels and dimensions; apply the same merge rules when a room spans multiple lines.`;

/** Default URL; override with PUBLIC_OPENROUTER_CHAT_URL in .env (no API key required for build). */
function openRouterChatUrl(): string {
	try {
		const u = import.meta.env?.PUBLIC_OPENROUTER_CHAT_URL;
		if (typeof u === 'string' && u.trim().startsWith('http')) return u.trim();
	} catch {
		/* import.meta unavailable in some tooling */
	}
	return 'https://openrouter.ai/api/v1/chat/completions';
}

export const OPENROUTER_CHAT_URL = openRouterChatUrl();

export const DEFAULT_OPENROUTER_MODELS = [
	{ id: 'google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B' },
	{ id: 'google/gemma-3-4b-it:free', label: 'Gemma 3 4B IT (free)' },
	{ id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (fast)' },
	{ id: 'openai/gpt-4o', label: 'GPT-4o (vision + text)' },
	{ id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
	{ id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
	{ id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }
] as const;

/** Direct Google Gemini API models (not via OpenRouter). Override base with PUBLIC_GEMINI_API_BASE in .env. */
function geminiApiBase(): string {
	try {
		const u = import.meta.env?.PUBLIC_GEMINI_API_BASE;
		if (typeof u === 'string' && u.trim().startsWith('http')) return u.trim().replace(/\/$/, '');
	} catch {
		/* import.meta unavailable in some tooling */
	}
	return 'https://generativelanguage.googleapis.com/v1beta';
}

export const GEMINI_API_BASE = geminiApiBase();

export const DEFAULT_GEMINI_MODELS = [
	{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
	{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
	{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
	{ id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
	{ id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
] as const;
