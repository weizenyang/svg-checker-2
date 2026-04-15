/**
 * CSV paste: inch marks are often written as ASCII " which breaks RFC 4180 comma-splitting.
 * Temporarily replace closing inch " with U+2033 so the line splits on commas only between columns.
 */
export function protectInchMarksInCsvLine(line: string): string {
	let s = String(line ?? '');
	// e.g. 20' - 4"
	s = s.replace(/(\d+'\s*-\s*\d+)"/g, '$1\u2033');
	// e.g. 10'10" or 20'4"
	s = s.replace(/(\d+'\d+)"/g, '$1\u2033');
	// remaining digit(s) + inch quote (single-digit inches already handled above when paired with ')
	s = s.replace(/(\d+)"/g, '$1\u2033');
	return s;
}

const APOS = '\u2019'; // ’

/**
 * Metric column: no space before the metres unit (6.67m not "6.67 m"), including each side of "  x  ".
 */
export function normalizeMetricTypography(s: string): string {
	let t = String(s ?? '');
	t = t.replace(/(\d+(?:\.\d+)?)\s+m\b/g, '$1m');
	return t;
}

/**
 * Imperial column: use ’ for feet and ’’ for inches (two U+2019), not straight ' or ".
 * Also tightens signage spacing: no space between ’ and inch digits, or between inch digits and ’’.
 */
export function normalizeImperialTypography(s: string): string {
	let t = String(s ?? '');
	// From protectInchMarksInCsvLine: U+2033 → ’’
	t = t.split('\u2033').join(`${APOS}${APOS}`);
	// Digit + straight double-quote (inch) still in cell
	t = t.replace(/(\d)"/g, `$1${APOS}${APOS}`);
	// Any remaining ASCII " as inch primes
	t = t.replace(/"/g, `${APOS}${APOS}`);
	// Feet / apostrophes: straight ' → ’
	t = t.replace(/'/g, APOS);
	// e.g. 21’ 11’’ → 21’11’’ ; 12’ 4 ’’ → 12’4’’
	t = t.replace(/\u2019\s+(\d+)/g, `${APOS}$1`);
	t = t.replace(/(\d+)\s+(\u2019\u2019)/g, '$1$2');
	return t;
}
