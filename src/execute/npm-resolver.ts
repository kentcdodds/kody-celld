import { KodyError } from '../lib/errors.ts'
import { relativeSpecifier } from './module-graph.ts'

// Experimental: resolves bare npm specifiers through esm.sh and inlines the
// resulting ES modules into the Worker Loader module map. There is no bundler
// inside the runtime, so every module in the transitive graph is fetched and
// stored under `npm/<host path>.js`, and absolute imports are rewritten to
// root-anchored module specifiers. Limits keep a runaway graph from exhausting the isolate.

const ESM_ORIGIN = 'https://esm.sh'
const MAX_MODULES = 40
const MAX_TOTAL_BYTES = 6 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

const moduleCache = new Map<string, string>()

const importRegex = /((?:\bimport|\bexport)\b[^'"`;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\2/g

export type NpmResolution = {
	modules: Record<string, string>
	/** bare specifier -> root-relative module path */
	entryPaths: Map<string, string>
	warnings: Array<string>
}

function pathForUrl(url: URL) {
	const cleaned = `${url.host}${url.pathname}${url.search ? `__${url.search.replaceAll(/[^a-zA-Z0-9]+/g, '_')}` : ''}`
	return `npm/${cleaned.replaceAll(/[^a-zA-Z0-9@._/-]/g, '_')}${/\.(?:m?js)$/.test(url.pathname) ? '' : '.js'}`
}

async function fetchModule(url: URL) {
	const cached = moduleCache.get(url.href)
	if (cached !== undefined) return cached
	const response = await fetch(url, {
		headers: { 'user-agent': 'kody-celld/0.1 (workers)', accept: 'application/javascript,*/*' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!response.ok) {
		throw new KodyError('npm_fetch_failed', `esm.sh returned ${response.status} for ${url.href}`, { status: 502 })
	}
	const text = await response.text()
	moduleCache.set(url.href, text)
	return text
}

export async function resolveNpmModules(specifiers: Array<string>): Promise<NpmResolution> {
	const modules: Record<string, string> = {}
	const entryPaths = new Map<string, string>()
	const warnings: Array<string> = []
	const queue: Array<URL> = []
	const seen = new Map<string, string>()
	let totalBytes = 0

	for (const specifier of specifiers) {
		const url = new URL(`/${specifier}`, ESM_ORIGIN)
		url.searchParams.set('target', 'es2022')
		queue.push(url)
		entryPaths.set(specifier, pathForUrl(url))
	}

	while (queue.length > 0) {
		const url = queue.shift()!
		if (seen.has(url.href)) continue
		if (seen.size >= MAX_MODULES) {
			throw new KodyError('npm_graph_too_large', `npm import graph exceeded ${MAX_MODULES} modules.`)
		}
		const path = pathForUrl(url)
		seen.set(url.href, path)
		let source = await fetchModule(url)
		totalBytes += source.length
		if (totalBytes > MAX_TOTAL_BYTES) {
			throw new KodyError('npm_graph_too_large', 'npm import graph exceeded the 6 MiB limit.')
		}
		const deps = new Map<string, URL>()
		for (const match of source.matchAll(importRegex)) {
			const spec = match[3] ?? ''
			if (spec.startsWith('node:') || spec.startsWith('cloudflare:')) continue
			const depUrl = new URL(spec, url)
			if (depUrl.origin !== ESM_ORIGIN) {
				warnings.push(`Skipped cross-origin npm import ${depUrl.href} from ${url.href}.`)
				continue
			}
			deps.set(spec, depUrl)
			queue.push(depUrl)
		}
		source = source.replace(importRegex, (_m, head: string, quote: string, spec: string) => {
			const dep = deps.get(spec)
			if (!dep) return `${head}${quote}${spec}${quote}`
			return `${head}${quote}${relativeSpecifier(path, pathForUrl(dep))}${quote}`
		})
		modules[path] = source
	}

	if (specifiers.length > 0) {
		warnings.push(
			`npm imports (${specifiers.join(', ')}) were resolved through esm.sh; this path is experimental in kody-celld.`,
		)
	}
	return { modules, entryPaths, warnings }
}
