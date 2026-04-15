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
 * Imperial column: use ’ for feet and ’’ for inches (two U+2019), not straight ' or ".
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
	return t;
}
