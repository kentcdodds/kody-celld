import stripJsonComments from 'strip-json-comments'
import { transform, type Transform } from 'sucrase'
import { KodyError } from '../lib/errors.ts'

/**
 * kody-celld: TypeScript and JSX package files, and ad hoc code, are compiled
 * to plain JS before celld's Worker Loader sees them (it accepts only JS).
 * Hosted kody compiles with esbuild-wasm through @cloudflare/worker-bundler
 * (packages/worker/src/package-runtime/module-graph-bundle-builders.ts);
 * sucrase's transforms are pure JS and small enough for the Worker. They keep
 * line numbers, leave modern JS as written (disableESTransforms), emit enums
 * and parameter properties, and drop imports used only as types, as tsc and
 * esbuild do.
 */
export type TranspileKind = 'ts' | 'tsx' | 'jsx'

export type JsxOptions = { runtime: 'automatic' | 'classic' | 'preserve'; importSource?: string }

const classicJsx: JsxOptions = { runtime: 'classic' }

const transformsByKind: Record<TranspileKind, Array<Transform>> = {
	ts: ['typescript'],
	tsx: ['typescript', 'jsx'],
	jsx: ['jsx'],
}

/** The transform a package file needs, or null for JS, JSON, docs and declaration files. */
export function transpileKind(path: string): TranspileKind | null {
	if (/\.d\.m?ts$/.test(path)) return null
	if (/\.m?ts$/.test(path)) return 'ts'
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.jsx')) return 'jsx'
	return null
}

/** Files that become isolate modules: JS, TypeScript and JSX, never declaration files. */
export function isCodeModulePath(path: string): boolean {
	return /\.m?js$/.test(path) || transpileKind(path) !== null
}

/**
 * The comments that open a file, before its first statement (after an
 * optional `#!` line). Pragmas count only here, as in TypeScript, so text in
 * strings, template literals or later code is never read as one.
 */
function leadingComments(source: string): Array<string> {
	const comments: Array<string> = []
	let i = source.startsWith('#!') ? source.indexOf('\n') + 1 || source.length : 0
	while (i < source.length) {
		const rest = source.slice(i)
		const space = /^\s+/.exec(rest)
		if (space) {
			i += space[0].length
			continue
		}
		if (rest.startsWith('//')) {
			const end = rest.indexOf('\n')
			comments.push(end === -1 ? rest : rest.slice(0, end))
			i += end === -1 ? rest.length : end
		} else if (rest.startsWith('/*')) {
			const end = rest.indexOf('*/', 2)
			if (end === -1) break
			comments.push(rest.slice(0, end + 2))
			i += end + 2
		} else {
			break
		}
	}
	return comments
}

/**
 * esbuild honours `@jsxRuntime` / `@jsxImportSource` comments per file; sucrase
 * does not, so read them here from the file's leading comments. As in
 * TypeScript, `@jsxImportSource` alone selects the automatic runtime.
 */
function withPragmas(source: string, jsx: JsxOptions): JsxOptions {
	let runtime: JsxOptions['runtime'] | undefined
	let importSource: string | undefined
	for (const comment of leadingComments(source)) {
		runtime = (/@jsxRuntime\s+(classic|automatic)\b/.exec(comment)?.[1] as JsxOptions['runtime'] | undefined) ?? runtime
		importSource = /@jsxImportSource\s+(\S+?)(?:\s|\*\/|$)/.exec(comment)?.[1] ?? importSource
	}
	if (runtime === 'classic') return classicJsx
	if (importSource) return { runtime: 'automatic', importSource }
	if (runtime === 'automatic')
		return { runtime: 'automatic', ...(jsx.importSource ? { importSource: jsx.importSource } : {}) }
	return jsx
}

export function stripTypes(
	source: string,
	where: string,
	kind: TranspileKind = 'ts',
	jsx: JsxOptions = classicJsx,
): string {
	const options = kind === 'ts' ? null : withPragmas(source, jsx)
	try {
		return transform(source, {
			transforms: transformsByKind[kind],
			disableESTransforms: true,
			...(options
				? {
						jsxRuntime: options.runtime,
						production: true,
						...(options.importSource ? { jsxImportSource: options.importSource } : {}),
					}
				: {}),
		}).code
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new KodyError(
			'invalid_module',
			`Cannot read the ${kind === 'jsx' ? 'JSX' : 'TypeScript'} in ${where}: ${message}.`,
		)
	}
}

const runtimeByTsconfigJsx: Record<string, JsxOptions['runtime']> = {
	'react-jsx': 'automatic',
	'react-jsxdev': 'automatic',
	react: 'classic',
	preserve: 'preserve',
}

/**
 * JSX options from the package's root `tsconfig.json`, as hosted kody reads
 * them (packages/worker/src/package-runtime/package-app-tsconfig.ts). Without
 * one, JSX uses the classic `React.createElement`, esbuild's default.
 */
export function jsxOptionsFromFiles(files: Record<string, string>): JsxOptions {
	const raw = files['tsconfig.json']
	if (raw === undefined) return classicJsx
	let compilerOptions: Record<string, unknown>
	try {
		// tsconfig.json is JSONC: comments and trailing commas are legal.
		const parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, ''), { trailingCommas: true })) as {
			compilerOptions?: unknown
		} | null
		if (!parsed || typeof parsed.compilerOptions !== 'object' || parsed.compilerOptions === null) return classicJsx
		compilerOptions = parsed.compilerOptions as Record<string, unknown>
	} catch {
		return classicJsx
	}
	const runtime = typeof compilerOptions.jsx === 'string' ? runtimeByTsconfigJsx[compilerOptions.jsx] : undefined
	if (!runtime) return classicJsx
	const importSource = compilerOptions.jsxImportSource
	return typeof importSource === 'string' && importSource.length > 0 ? { runtime, importSource } : { runtime }
}
