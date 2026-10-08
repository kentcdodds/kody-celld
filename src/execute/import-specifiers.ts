import { parse } from 'es-module-lexer/js'
import { KodyError } from '../lib/errors.ts'

/**
 * One import specifier in a module: `start`/`end` cover the specifier text
 * without its quotes. kody finds these from an AST (packages/worker/src/
 * package-runtime/import-specifiers.ts); kody-celld uses es-module-lexer's
 * JS build, which reports the same ranges without a full parser in the
 * Worker. Text inside strings, template literals and comments is never an
 * import, so it is never reported or rewritten.
 */
export type ImportSpecifierRange = { specifier: string; start: number; end: number }

export function lexImportSpecifiers(source: string, modulePath: string): Array<ImportSpecifierRange> {
	let imports
	try {
		;[imports] = parse(source, modulePath)
	} catch (error) {
		throw new KodyError(
			'invalid_module',
			`Cannot read the imports of ${modulePath}: ${error instanceof Error ? error.message : String(error)}.`,
		)
	}
	const ranges: Array<ImportSpecifierRange> = []
	for (const entry of imports) {
		// d === -2 is import.meta; a dynamic import of a computed value has no name.
		if (entry.d === -2 || entry.n === undefined) continue
		if (entry.d === -1) {
			ranges.push({ specifier: entry.n, start: entry.s, end: entry.e })
			continue
		}
		// A literal dynamic import's range includes its quotes.
		const quote = source[entry.s]
		if ((quote === "'" || quote === '"' || quote === '`') && source[entry.e - 1] === quote) {
			ranges.push({ specifier: entry.n, start: entry.s + 1, end: entry.e - 1 })
		}
	}
	return ranges
}

/** Replaces each import specifier `replace` maps (null keeps it); everything else stays byte-for-byte. */
export function replaceImportSpecifiers(
	source: string,
	modulePath: string,
	replace: (specifier: string) => string | null,
): string {
	const ranges = lexImportSpecifiers(source, modulePath).sort((a, b) => a.start - b.start)
	let out = ''
	let cursor = 0
	for (const range of ranges) {
		const next = replace(range.specifier)
		if (next === null || next === range.specifier) continue
		out += source.slice(cursor, range.start) + next
		cursor = range.end
	}
	return cursor === 0 ? source : out + source.slice(cursor)
}

/** Module paths a relative import resolving to `target` may name, in lookup order. */
export function relativeImportCandidates(target: string): Array<string> {
	return [...new Set([target, `${target}.js`, target.replace(/\.ts$/, '.js'), `${target}/index.js`])]
}
