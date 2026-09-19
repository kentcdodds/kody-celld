import type { UserCell } from '../cells/user-cell.ts'
import { KodyError } from '../lib/errors.ts'
import {
	normalizeModulePath,
	parseKodyPackageSpecifier,
	resolvePackageExport,
	type PackageFiles,
} from '../packages/manifest.ts'
import { resolveNpmModules } from './npm-resolver.ts'
import { RUNTIME_MODULE_SOURCE } from './runtime-module.ts'
import { buildWrapperModule } from './wrapper-module.ts'

export const RUNTIME_MODULE_PATH = 'kody-runtime.js'
export const WRAPPER_MODULE_PATH = 'wrapper.js'
export const ADHOC_MODULE_PATH = 'main.js'

const staticImportRegex = /(\b(?:import|export)\b[^'"`;]*?\bfrom\s*)(['"])([^'"\n]+)\2/g
const sideEffectImportRegex = /(^|[^\w.$])(import\s*)(['"])([^'"\n]+)\3/g
const dynamicImportRegex = /(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g

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
 * Every module in the graph is registered under its full path, and every
 * import is rewritten to `./<full path>` regardless of where the importing
 * module lives. celld's Worker Loader resolves specifiers by exact name (it
 * registers each module as `name` and `./name`) and does not walk `../`
 * segments the way workerd does; root-anchored specifiers are valid under
 * both, so this is the portable form.
 */
export function relativeSpecifier(_from: string, to: string) {
	return `./${to.split('/').filter(Boolean).join('/')}`
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

async function rewriteImports(source: string, fromPath: string, rewrite: Rewriter) {
	const replacements = new Map<string, string>()
	const collect = async (specifier: string) => {
		if (!replacements.has(specifier)) replacements.set(specifier, await rewrite(specifier, fromPath))
	}
	for (const match of source.matchAll(staticImportRegex)) await collect(match[3] ?? '')
	for (const match of source.matchAll(sideEffectImportRegex)) await collect(match[4] ?? '')
	for (const match of source.matchAll(dynamicImportRegex)) await collect(match[3] ?? '')
	let out = source.replace(
		staticImportRegex,
		(_m, head: string, quote: string, spec: string) => `${head}${quote}${replacements.get(spec) ?? spec}${quote}`,
	)
	out = out.replace(
		sideEffectImportRegex,
		(_m, pre: string, head: string, quote: string, spec: string) =>
			`${pre}${head}${quote}${replacements.get(spec) ?? spec}${quote}`,
	)
	out = out.replace(
		dynamicImportRegex,
		(_m, head: string, quote: string, spec: string) => `${head}${quote}${replacements.get(spec) ?? spec}${quote}`,
	)
	return out
}

/**
 * Builds the module map handed to the Worker Loader:
 *  - `wrapper.js` (host-owned entry that calls the user's default export)
 *  - `kody-runtime.js` (host-owned `kody:runtime`)
 *  - the ad hoc module or the saved package files under `packages/<name>/`
 *  - transitively imported saved packages (`kody:@scope/pkg/export`)
 *  - npm modules fetched through esm.sh (experimental)
 */
export async function buildModuleGraph(input: {
	entry: GraphEntry
	userCell: DurableObjectStub<UserCell>
	allowNpm: boolean
}): Promise<ModuleGraph> {
	const modules: Record<string, string> = {}
	const sourceOf = (path: string) => modules[path] ?? ''
	const warnings: Array<string> = []
	const includedPackages = new Set<string>()
	const npmSpecifiers = new Set<string>()
	const packageCache = new Map<string, Awaited<ReturnType<UserCell['packageGet']>>>()

	const loadPackage = async (name: string) => {
		if (!packageCache.has(name)) packageCache.set(name, await input.userCell.packageGet(name))
		const pkg = packageCache.get(name)
		if (!pkg) {
			throw new KodyError('package_not_found', `Package "${name}" is not saved for this user.`, { status: 404 })
		}
		return pkg
	}

	const rewriter: Rewriter = async (specifier, fromPath) => {
		if (specifier === 'kody:runtime') return relativeSpecifier(fromPath, RUNTIME_MODULE_PATH)
		const kodyPackage = parseKodyPackageSpecifier(specifier)
		if (kodyPackage) {
			const pkg = await loadPackage(kodyPackage.packageName)
			const exportPath = resolvePackageExport(pkg.manifest, kodyPackage.exportName)
			await includePackage(kodyPackage.packageName)
			return relativeSpecifier(fromPath, packageModulePath(kodyPackage.packageName, exportPath))
		}
		if (specifier.startsWith('kody:')) {
			throw new KodyError('invalid_import', `Unknown kody: import "${specifier}".`)
		}
		if (isBuiltin(specifier)) return specifier
		if (isRelative(specifier)) {
			const target = resolveRelative(fromPath, specifier)
			if (target in modules) return relativeSpecifier(fromPath, target)
			for (const candidate of [`${target}.js`, target.replace(/\.ts$/, '.js'), `${target}/index.js`]) {
				if (candidate in modules) return relativeSpecifier(fromPath, candidate)
			}
			return specifier
		}
		if (!input.allowNpm) {
			throw new KodyError(
				'unsupported_import',
				`Bare import "${specifier}" is not available: npm imports are disabled on this host.`,
			)
		}
		npmSpecifiers.add(specifier)
		return specifier
	}

	const includeFiles = async (files: PackageFiles, toPath: (file: string) => string) => {
		// Register paths first so relative-import checks see sibling modules.
		for (const file of Object.keys(files)) modules[toPath(file)] = ''
		for (const [file, source] of Object.entries(files)) {
			const path = toPath(file)
			// celld's Worker Loader accepts only JS/wasm modules, so JSON becomes an
			// ES module and docs/other assets stay out of the isolate entirely.
			if (/\.(?:m?js|ts)$/.test(file)) modules[path] = await rewriteImports(source, path, rewriter)
			else if (/\.json$/.test(file)) modules[path] = `export default ${JSON.stringify(JSON.parse(source))}`
			else delete modules[path]
		}
	}

	const includePackage = async (name: string) => {
		if (includedPackages.has(name)) return
		includedPackages.add(name)
		const pkg = await loadPackage(name)
		await includeFiles(pkg.files, (file) => packageModulePath(name, file))
		for (const file of Object.keys(pkg.files)) {
			if (!/\.(?:m?js|ts)$/.test(file)) continue
			const path = packageModulePath(name, file)
			modules[path] = stampPackageStorage(sourceOf(path), name)
		}
	}

	let entryPath: string
	let packageName: string | null = null
	if (input.entry.kind === 'adhoc') {
		entryPath = ADHOC_MODULE_PATH
		modules[entryPath] = ''
		modules[entryPath] = await rewriteImports(input.entry.code, entryPath, rewriter)
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
	}

	if (npmSpecifiers.size > 0) {
		const resolved = await resolveNpmModules([...npmSpecifiers])
		for (const [path, source] of Object.entries(resolved.modules)) modules[path] = source
		warnings.push(...resolved.warnings)
		for (const [specifier, path] of resolved.entryPaths) {
			for (const modulePath of Object.keys(modules)) {
				if (modulePath.startsWith('npm/')) continue
				modules[modulePath] = sourceOf(modulePath).replaceAll(
					new RegExp(`(['"])${specifier.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'),
					`$1${relativeSpecifier(modulePath, path)}$1`,
				)
			}
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
