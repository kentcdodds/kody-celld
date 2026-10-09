import type { UserCell } from '../cells/user-cell.ts'
import { KodyError } from '../lib/errors.ts'
import {
	normalizeModulePath,
	parseKodyPackageSpecifier,
	resolvePackageExport,
	type PackageFiles,
} from '../packages/manifest.ts'
import { lexImportSpecifiers, relativeImportCandidates, replaceImportSpecifiers } from './import-specifiers.ts'
import { resolveNpmModules, type NpmResolverOptions } from './npm-resolver.ts'
import { RUNTIME_MODULE_SOURCE } from './runtime-module.ts'
import {
	isCodeModulePath,
	jsxOptionsFromFiles,
	stripTypes,
	transpileKind,
	type JsxOptions,
	type TranspileKind,
} from './strip-types.ts'
import { buildWrapperModule } from './wrapper-module.ts'

export const RUNTIME_MODULE_PATH = 'kody-runtime.js'
export const WRAPPER_MODULE_PATH = 'wrapper.js'
export const ADHOC_MODULE_PATH = 'main.js'
/** Stands in for a kody.secretProvider entry wherever user code tries to import one. */
export const SEALED_MODULE_PATH = 'kody-sealed.js'

export const SEALED_ENTRY_ERROR = 'secret_provider_entry_sealed'
const sealedEntryMessage =
	'is a kody.secretProvider entry, which Kody runs only in a sealed run while resolving a {{secret/...}} placeholder. It cannot be imported or run directly.'
// Linked like a real entry (default export) so the error surfaces at evaluation, not as a bare link SyntaxError.
const SEALED_MODULE_SOURCE = `const error = new Error(${JSON.stringify(`This module ${sealedEntryMessage}`)})
error.name = ${JSON.stringify(`KodyError:${SEALED_ENTRY_ERROR}:403`)}
throw error
export default undefined
`

export type ModuleGraph = {
	modules: Record<string, string>
	mainModule: string
	entryPath: string
	packages: Array<string>
	npmModules: Array<string>
	warnings: Array<string>
}

export type GraphEntry =
	{ kind: 'adhoc'; code: string } | { kind: 'package'; packageName: string; exportName?: string; entryPath?: string }

function dirname(path: string) {
	const idx = path.lastIndexOf('/')
	return idx === -1 ? '' : path.slice(0, idx)
}

/**
 * Import specifier that reaches module `to` from module `from`.
 *
 * celld 0.6 resolves relative imports from the importing module's directory
 * (workerd parity, denoland/celld#227). A root-anchored `./<full path>` from a
 * file under `packages/<name>/` would look for that path inside the package.
 */
export function relativeSpecifier(from: string, to: string) {
	const fromParts = dirname(from).split('/').filter(Boolean)
	const toParts = to.split('/').filter(Boolean)
	let shared = 0
	while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
		shared++
	}
	const parts = [...Array.from({ length: fromParts.length - shared }, () => '..'), ...toParts.slice(shared)]
	const spec = parts.join('/')
	return spec.startsWith('.') ? spec : `./${spec}`
}

function resolveRelative(from: string, specifier: string) {
	const base = dirname(from)
	return normalizeModulePath(base ? `${base}/${specifier}` : specifier)
}

function isRelative(specifier: string) {
	return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
}

function isBuiltin(specifier: string) {
	return specifier.startsWith('node:') || specifier.startsWith('cloudflare:')
}

export function packageModulePath(packageName: string, filePath: string) {
	return `packages/${packageName}/${filePath}`
}

type Rewriter = (specifier: string, fromPath: string) => Promise<string>

/** `packageStorage()` in a saved package module always refers to that package. */
export function stampPackageStorage(source: string, packageName: string) {
	return source.replaceAll(/\bpackageStorage\(\s*\)/g, `packageStorage(${JSON.stringify(packageName)})`)
}

/**
 * Rewrites the specifiers of real imports only (static, `export … from`,
 * side-effect and literal `import()`), found by the lexer. Text that merely
 * looks like an import inside a string, template literal or comment is left
 * as written, so package files built inside `execute` survive packageSave.
 */
async function rewriteImports(source: string, fromPath: string, rewrite: Rewriter) {
	const ranges = lexImportSpecifiers(source, fromPath)
	const replacements = new Map<string, string>()
	// Skip type-only ranges for resolution (they are erased); a value import of
	// the same specifier still populates replacements and rewrites both sites.
	for (const { specifier, typeOnly } of ranges) {
		if (typeOnly || replacements.has(specifier)) continue
		replacements.set(specifier, await rewrite(specifier, fromPath))
	}
	return replaceImportSpecifiers(source, fromPath, (specifier) => replacements.get(specifier) ?? null, ranges)
}

/**
 * celld links only what the entry reaches through static imports. Walk that
 * graph and name the first module that cannot be read or the first static
 * relative import that resolves to nothing, instead of celld's opaque
 * `instantiate: <none>`. Unreached files and dynamic `import()`s stay as
 * they were: they never fail the isolate up front.
 */
function assertReachableImportsResolve(
	modules: Record<string, string>,
	entryPath: string,
	unreadable: Map<string, KodyError>,
) {
	const known = new Set([...Object.keys(modules), RUNTIME_MODULE_PATH])
	const queue = [entryPath]
	const seen = new Set<string>()
	while (queue.length > 0) {
		const path = queue.shift() as string
		if (seen.has(path)) continue
		seen.add(path)
		const failure = unreadable.get(path)
		if (failure) throw failure
		if (path === RUNTIME_MODULE_PATH || path.endsWith('.json')) continue
		for (const { specifier, kind, typeOnly } of lexImportSpecifiers(modules[path] ?? '', path)) {
			// Type-only imports are erased before link time (kody skips them too).
			if (kind !== 'static' || typeOnly || !isRelative(specifier)) continue
			let target: string
			try {
				target = resolveRelative(path, specifier)
			} catch {
				throw new KodyError(
					'invalid_import',
					`Cannot resolve "${specifier}" from ${describeModule(path)}: it points outside the package.`,
				)
			}
			if (!known.has(target)) {
				throw new KodyError('invalid_import', `Cannot resolve "${specifier}" from ${describeModule(path)}.`)
			}
			queue.push(target)
		}
	}
}

/**
 * Modules the entry can load: reached through static or literal dynamic
 * relative imports (after rewriting, `kody:` package imports are relative
 * too). Only these fetch their npm imports, so unreached client files of a
 * package app cost nothing.
 */
function loadableModules(modules: Record<string, string>, entryPath: string) {
	const queue = [entryPath]
	const seen = new Set<string>()
	while (queue.length > 0) {
		const path = queue.shift() as string
		if (seen.has(path) || !(path in modules)) continue
		seen.add(path)
		if (path.endsWith('.json')) continue
		let ranges
		try {
			ranges = lexImportSpecifiers(modules[path] ?? '', path)
		} catch {
			continue
		}
		for (const { specifier, typeOnly } of ranges) {
			if (typeOnly || !isRelative(specifier)) continue
			try {
				queue.push(resolveRelative(path, specifier))
			} catch {
				// Points outside the package: assertReachableImportsResolve names static ones.
			}
		}
	}
	return seen
}

/** "lib/main.js in package @scope/pkg", or "your execute code" for the ad hoc module. */
function describeModule(path: string) {
	if (path === ADHOC_MODULE_PATH) return 'your execute code'
	if (!path.startsWith('packages/')) return path
	const rest = path.slice('packages/'.length)
	const parts = rest.split('/')
	const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
	return `${rest.slice(name.length + 1)} in package ${name}`
}

/**
 * Builds the module map handed to the Worker Loader:
 *  - `wrapper.js` (host-owned entry that calls the user's default export)
 *  - `kody-runtime.js` (host-owned `kody:runtime`)
 *  - the ad hoc module or the saved package files under `packages/<name>/`
 *  - transitively imported saved packages (`kody:@scope/pkg/export`)
 *  - npm modules fetched through an esm.sh-compatible CDN (durable fleet cache)
 */
export async function buildModuleGraph(input: {
	entry: GraphEntry
	userCell: DurableObjectStub<UserCell>
	allowNpm: boolean
	/** CDN origin + durable cache for bare npm specifiers (defaults to esm.sh without a durable cache). */
	npm?: NpmResolverOptions | undefined
	/** True only for the gateway's provider runs: the provider entry may then be the graph entry. */
	sealed?: boolean | undefined
}): Promise<ModuleGraph> {
	const modules: Record<string, string> = {}
	const sourceOf = (path: string) => modules[path] ?? ''
	const warnings: Array<string> = []
	const includedPackages = new Set<string>()
	// Bare npm specifiers per importing module: only modules the entry can load fetch theirs.
	const npmByModule = new Map<string, Set<string>>()
	const packageCache = new Map<string, Awaited<ReturnType<UserCell['packageGet']>>>()

	const loadPackage = async (name: string) => {
		if (!packageCache.has(name)) packageCache.set(name, await input.userCell.packageGet(name))
		const pkg = packageCache.get(name)
		if (!pkg) {
			throw new KodyError('package_not_found', `Package "${name}" is not saved for this user.`, { status: 404 })
		}
		return pkg
	}

	// A secretProvider entry returns a secret value, so it may only ever be the
	// entry of a sealed run. Imports of it (`kody:` or relative, from any package
	// including its own) are pointed at a module that throws when evaluated, so
	// the rest of the package keeps working while that one path fails closed.
	const providerEntryPaths = new Set<string>()
	let sealedStubNeeded = false
	const importTarget = (fromPath: string, targetPath: string) => {
		if (!providerEntryPaths.has(targetPath)) return relativeSpecifier(fromPath, targetPath)
		sealedStubNeeded = true
		return relativeSpecifier(fromPath, SEALED_MODULE_PATH)
	}

	const rewriter: Rewriter = async (specifier, fromPath) => {
		if (specifier === 'kody:runtime') return relativeSpecifier(fromPath, RUNTIME_MODULE_PATH)
		const kodyPackage = parseKodyPackageSpecifier(specifier)
		if (kodyPackage) {
			const pkg = await loadPackage(kodyPackage.packageName)
			const exportPath = resolvePackageExport(pkg.manifest, kodyPackage.exportName)
			await includePackage(kodyPackage.packageName)
			return importTarget(fromPath, packageModulePath(kodyPackage.packageName, exportPath))
		}
		if (specifier.startsWith('kody:')) {
			throw new KodyError('invalid_import', `Unknown kody: import "${specifier}".`)
		}
		if (isBuiltin(specifier)) return specifier
		if (isRelative(specifier)) {
			let target: string
			try {
				target = resolveRelative(fromPath, specifier)
			} catch {
				return specifier
			}
			for (const candidate of relativeImportCandidates(target)) {
				if (!(candidate in modules)) continue
				return importTarget(fromPath, candidate)
			}
			// Left as written; assertReachableImportsResolve names it if the entry reaches it.
			return specifier
		}
		if (!input.allowNpm) {
			throw new KodyError(
				'unsupported_import',
				`Bare import "${specifier}" is not available: npm imports are disabled on this host.`,
			)
		}
		const set = npmByModule.get(fromPath) ?? new Set<string>()
		set.add(specifier)
		npmByModule.set(fromPath, set)
		return specifier
	}

	// Modules that cannot be read or linked (JSX in .js client files, TypeScript
	// or JSX sucrase cannot parse, an import this host refuses) stay as written
	// and only fail the run if the entry reaches them. TypeScript and JSX are
	// compiled first, so imports used only as types are gone before the import
	// rewrite and the reachability check.
	const unreadable = new Map<string, KodyError>()
	const rewriteModule = async (source: string, path: string, kind: TranspileKind | null, jsx?: JsxOptions) => {
		try {
			const code = kind ? stripTypes(source, describeModule(path), kind, jsx) : source
			return await rewriteImports(code, path, rewriter)
		} catch (error) {
			const kody = KodyError.fromUnknown(error)
			if (!kody) throw error
			unreadable.set(path, kody)
			return source
		}
	}

	// JSON that does not parse (a JSONC tsconfig.json) only fails a run that imports it.
	const jsonModule = (source: string, path: string) => {
		try {
			return `export default ${JSON.stringify(JSON.parse(source))}`
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			unreadable.set(
				path,
				new KodyError('invalid_module', `Cannot read the JSON in ${describeModule(path)}: ${message}.`),
			)
			return 'export default undefined'
		}
	}

	const includeFiles = async (files: PackageFiles, toPath: (file: string) => string) => {
		const jsx = jsxOptionsFromFiles(files)
		// Register module paths first so relative-import checks see sibling
		// modules; files that never become modules (docs, .d.ts) are not targets.
		for (const file of Object.keys(files)) {
			if (isCodeModulePath(file) || file.endsWith('.json')) modules[toPath(file)] = ''
		}
		for (const [file, source] of Object.entries(files)) {
			const path = toPath(file)
			// celld's Worker Loader accepts only JS/wasm modules: TypeScript and JSX
			// are compiled, JSON becomes an ES module, and docs, declaration files and
			// other assets stay out of the isolate entirely.
			if (isCodeModulePath(file)) modules[path] = await rewriteModule(source, path, transpileKind(file), jsx)
			else if (file.endsWith('.json')) modules[path] = jsonModule(source, path)
			else delete modules[path]
		}
	}

	const includePackage = async (name: string) => {
		if (includedPackages.has(name)) return
		includedPackages.add(name)
		const pkg = await loadPackage(name)
		if (pkg.manifest.secretProvider) providerEntryPaths.add(packageModulePath(name, pkg.manifest.secretProvider.entry))
		await includeFiles(pkg.files, (file) => packageModulePath(name, file))
		for (const file of Object.keys(pkg.files)) {
			if (!isCodeModulePath(file)) continue
			const path = packageModulePath(name, file)
			modules[path] = stampPackageStorage(sourceOf(path), name)
		}
	}

	let entryPath: string
	let packageName: string | null = null
	if (input.entry.kind === 'adhoc') {
		entryPath = ADHOC_MODULE_PATH
		modules[entryPath] = ''
		// Ad hoc code is read as TypeScript (not JSX: it has no tsconfig.json to choose a runtime).
		modules[entryPath] = await rewriteModule(input.entry.code, entryPath, 'ts')
	} else {
		packageName = input.entry.packageName
		const pkg = await loadPackage(packageName)
		const filePath = input.entry.entryPath
			? normalizeModulePath(input.entry.entryPath)
			: resolvePackageExport(pkg.manifest, input.entry.exportName ?? '.')
		if (!(filePath in pkg.files)) {
			throw new KodyError('unknown_export', `Package ${packageName} has no file "${filePath}".`, { status: 404 })
		}
		await includePackage(packageName)
		entryPath = packageModulePath(packageName, filePath)
		if (!input.sealed && providerEntryPaths.has(entryPath)) {
			throw new KodyError(SEALED_ENTRY_ERROR, `"${filePath}" of ${packageName} ${sealedEntryMessage}`, { status: 403 })
		}
	}
	if (sealedStubNeeded) modules[SEALED_MODULE_PATH] = SEALED_MODULE_SOURCE
	assertReachableImportsResolve(modules, entryPath, unreadable)

	const npmSpecifiers = new Set<string>()
	for (const path of loadableModules(modules, entryPath)) {
		for (const specifier of npmByModule.get(path) ?? []) npmSpecifiers.add(specifier)
	}
	if (npmSpecifiers.size > 0) {
		const resolved = await resolveNpmModules([...npmSpecifiers], input.npm)
		for (const [path, source] of Object.entries(resolved.modules)) modules[path] = source
		warnings.push(...resolved.warnings)
		const npmPaths = new Map<string, string>(resolved.entryPaths)
		for (const modulePath of Object.keys(modules)) {
			if (modulePath.startsWith('npm/') || unreadable.has(modulePath)) continue
			modules[modulePath] = replaceImportSpecifiers(sourceOf(modulePath), modulePath, (specifier) => {
				const path = npmPaths.get(specifier)
				return path ? relativeSpecifier(modulePath, path) : null
			})
		}
	}

	modules[RUNTIME_MODULE_PATH] = RUNTIME_MODULE_SOURCE
	modules[WRAPPER_MODULE_PATH] = buildWrapperModule(relativeSpecifier(WRAPPER_MODULE_PATH, entryPath))

	return {
		modules,
		mainModule: WRAPPER_MODULE_PATH,
		entryPath,
		packages: [...includedPackages],
		npmModules: [...npmSpecifiers],
		warnings,
	}
}
