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
export type ImportSpecifierRange = {
	specifier: string
	start: number
	end: number
	/** `static` imports are linked with the module; `dynamic` ones load (and can fail) at call time. */
	kind: 'static' | 'dynamic'
	/**
	 * kody-celld: TypeScript `import type` / `export type … from` are erased
	 * before link time (kody skips them in collectModuleImportNodes). They may
	 * still be rewritten, but must not be required to resolve.
	 */
	typeOnly: boolean
}

/**
 * True for TypeScript `import type …` / `export type … from`.
 * `import type from '…'` is a value import (binding name `type`), not type-only.
 */
function isTypeOnlyImportStatement(source: string, statementStart: number) {
	const stmt = source.slice(statementStart)
	if (/^export\s+type\b/.test(stmt)) return true
	const importType = stmt.match(/^import\s+type\b/)
	if (!importType) return false
	const after = stmt.slice(importType[0].length)
	// `import type { … }` / `import type * as …` / `import type Name from …`
	if (/^\s*[{*]/.test(after)) return true
	return /^\s*[A-Za-z_$][\w$]*\s+from\b/.test(after)
}

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
			ranges.push({
				specifier: entry.n,
				start: entry.s,
				end: entry.e,
				kind: 'static',
				typeOnly: isTypeOnlyImportStatement(source, entry.ss),
			})
			continue
		}
		// A literal dynamic import's range includes its quotes.
		const quote = source[entry.s]
		if ((quote === "'" || quote === '"' || quote === '`') && source[entry.e - 1] === quote) {
			ranges.push({
				specifier: entry.n,
				start: entry.s + 1,
				end: entry.e - 1,
				kind: 'dynamic',
				typeOnly: false,
			})
		}
	}
	return ranges
}

/**
 * Replaces each import specifier `replace` maps (null keeps it). Pass `ranges`
 * from a prior `lexImportSpecifiers` to avoid lexing the same source twice.
 */
export function replaceImportSpecifiers(
	source: string,
	modulePath: string,
	replace: (specifier: string) => string | null,
	ranges: Array<ImportSpecifierRange> = lexImportSpecifiers(source, modulePath),
): string {
	const sorted = [...ranges].sort((a, b) => a.start - b.start)
	let out = ''
	let cursor = 0
	for (const range of sorted) {
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
