/**
 * CSV paste: inch marks are often written as ASCII " which breaks RFC 4180 comma-splitting.
 * Temporarily replace closing inch " with U+2033 so the line splits on commas only between columns.
 */
export function protectInchMarksInCsvLine(line: string): string {
	let s = String(line ?? '');
	// e.g. 20' - 4"
	s = s.replace(/(\d+'\s*-\s*\d+)"/g, '$1″');
	// e.g. 10'10" or 20'4"
	s = s.replace(/(\d+'\d+)"/g, '$1″');
	// remaining digit(s) + inch quote (single-digit inches already handled above when paired with ')
	s = s.replace(/(\d+)"/g, '$1″');
	return s;
}

const APOS = '’'; // ’

/**
 * Metric column: no space before the metres unit (6.67m not "6.67 m"), including each side of "  x  ".
 *
 * Also auto-formats two-value entries so the user doesn't have to type "  x  " manually.
 *  • "6.15m 5.70m"   → "6.15m  x  5.70m"
 *  • "6.15  5.70"    → "6.15m  x  5.70m" (adds missing m)
 *  • "6.15 x 5.70"   → "6.15m  x  5.70m"
 *  • "6.15m×5.70m"   → "6.15m  x  5.70m"
 */
export function normalizeMetricTypography(s: string): string {
	let t = String(s ?? '');
	t = t.replace(/(\d+(?:\.\d+)?)\s+m\b/g, '$1m');

	const trimmed = t.trim();
	// Two values separated by x/×/X, "by", or just whitespace. Each value is digits
	// with optional decimals and an optional trailing "m".
	const twoValRe =
		/^(\d+(?:\.\d+)?)\s*m?\s*(?:[x×X]|by|\s)\s*(\d+(?:\.\d+)?)\s*m?\s*$/i;
	const m = trimmed.match(twoValRe);
	if (m) {
		return `${m[1]}m  x  ${m[2]}m`;
	}
	return t;
}

/**
 * Imperial column: use ’ for feet and ’’ for inches (two U+2019), not straight ' or ".
 * Also tightens signage spacing: no space between ’ and inch digits, or between inch digits and ’’.
 *
 * Auto-inserts "  x  " between two imperial values so the user doesn't have to type it:
 *  • "16'7'' 18'0''"   → "16’7’’  x  18’0’’"
 *  • '16\'7" 18\'0"'   → "16’7’’  x  18’0’’"
 *  • "16'7 x 18'0"     → "16’7  x  18’0"
 */
export function normalizeImperialTypography(s: string): string {
	let t = String(s ?? '');
	// From protectInchMarksInCsvLine: U+2033 → ’’
	t = t.split('″').join(`${APOS}${APOS}`);
	// Digit + straight double-quote (inch) still in cell
	t = t.replace(/(\d)"/g, `$1${APOS}${APOS}`);
	// Any remaining ASCII " as inch primes
	t = t.replace(/"/g, `${APOS}${APOS}`);
	// Feet / apostrophes: straight ' → ’
	t = t.replace(/'/g, APOS);

	// Two-value detection FIRST — single-value space-tightening below would otherwise
	// collapse the separator between two whitespace-separated values.
	// Each value: digits + ’ (feet), optionally followed by digits + ’’ (inches).
	const value = `\\d+\\u2019(?:\\d+\\u2019\\u2019)?`;
	const twoValRe = new RegExp(
		`^(${value})\\s*(?:[x\\u00d7X]|by|\\s)\\s*(${value})\\s*$`,
		'i'
	);
	const trimmed = t.trim();
	const m = trimmed.match(twoValRe);
	if (m) {
		return `${m[1]}  x  ${m[2]}`;
	}

	// Single-value space tightening: "21’ 11’’" → "21’11’’" ; "12’ 4 ’’" → "12’4’’"
	t = t.replace(/’\s+(\d+)/g, `${APOS}$1`);
	t = t.replace(/(\d+)\s+(’’)/g, '$1$2');
	return t;
}
