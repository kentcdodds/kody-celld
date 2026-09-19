import type { NpmCacheCell } from '../cells/npm-cache-cell.ts'
import { KodyError } from '../lib/errors.ts'
import { relativeSpecifier } from './module-graph.ts'
import { defaultEsmCdnOrigin, type NpmConfig } from './npm-config.ts'

// Resolves bare npm specifiers through an esm.sh-compatible CDN and inlines the
// resulting ES modules into the Worker Loader module map. There is no bundler
// inside the runtime, so every module in the transitive graph is fetched and
// stored under `npm/<host path>.js`, and absolute imports are rewritten to
// root-anchored module specifiers. Limits keep a runaway graph from exhausting the isolate.

const MAX_MODULES = 40
const MAX_TOTAL_BYTES = 6 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

/** Per-isolate memo in front of the durable cache; reset once it grows past MEMO_MAX_ENTRIES. */
const MEMO_MAX_ENTRIES = 500
const moduleCache = new Map<string, string>()

function memoize(href: string, source: string) {
	if (moduleCache.size >= MEMO_MAX_ENTRIES) moduleCache.clear()
	moduleCache.set(href, source)
}

const importRegex = /((?:\bimport|\bexport)\b[^'"`;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\2/g

export type NpmResolution = {
	modules: Record<string, string>
	/** bare specifier -> root-relative module path */
	entryPaths: Map<string, string>
	warnings: Array<string>
	/** Modules served from the durable/in-memory cache vs downloaded from the CDN. */
	cached: number
	fetched: number
}

export type NpmResolverOptions = {
	config: NpmConfig
	cache: DurableObjectStub<NpmCacheCell> | null
}

export const defaultNpmResolverOptions: NpmResolverOptions = {
	config: { enabled: true, cdnOrigin: defaultEsmCdnOrigin, cacheMaxBytes: 0, cacheTtlMs: 0 },
	cache: null,
}

function pathForUrl(url: URL) {
	const cleaned = `${url.host}${url.pathname}${url.search ? `__${url.search.replaceAll(/[^a-zA-Z0-9]+/g, '_')}` : ''}`
	return `npm/${cleaned.replaceAll(/[^a-zA-Z0-9@._/-]/g, '_')}${/\.(?:m?js)$/.test(url.pathname) ? '' : '.js'}`
}

async function fetchFromCdn(url: URL, cdnOrigin: string) {
	const response = await fetch(url, {
		headers: { 'user-agent': 'kody-celld/0.1 (workers)', accept: 'application/javascript,*/*' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!response.ok) {
		throw new KodyError('npm_fetch_failed', `${new URL(cdnOrigin).host} returned ${response.status} for ${url.href}`, {
			status: 502,
		})
	}
	return response.text()
}

export async function resolveNpmModules(
	specifiers: Array<string>,
	options: NpmResolverOptions = defaultNpmResolverOptions,
): Promise<NpmResolution> {
	const { config } = options
	const durable = options.cache && config.cacheMaxBytes > 0 ? options.cache : null
	const modules: Record<string, string> = {}
	const entryPaths = new Map<string, string>()
	const warnings: Array<string> = []
	const queue: Array<URL> = []
	const seen = new Map<string, string>()
	const fetchedNow: Record<string, string> = {}
	let totalBytes = 0
	let cached = 0
	let fetched = 0

	for (const specifier of specifiers) {
		const url = new URL(`/${specifier}`, config.cdnOrigin)
		url.searchParams.set('target', 'es2022')
		queue.push(url)
		entryPaths.set(specifier, pathForUrl(url))
	}

	const loadModule = async (url: URL) => {
		const memo = moduleCache.get(url.href)
		if (memo !== undefined) {
			cached += 1
			return memo
		}
		if (durable) {
			const hit = (await durable.getMany([url.href], config.cacheTtlMs))[url.href]
			if (hit !== undefined) {
				memoize(url.href, hit)
				cached += 1
				return hit
			}
		}
		const text = await fetchFromCdn(url, config.cdnOrigin)
		memoize(url.href, text)
		fetchedNow[url.href] = text
		fetched += 1
		return text
	}

	while (queue.length > 0) {
		const url = queue.shift()!
		if (seen.has(url.href)) continue
		if (seen.size >= MAX_MODULES) {
			throw new KodyError('npm_graph_too_large', `npm import graph exceeded ${MAX_MODULES} modules.`)
		}
		const path = pathForUrl(url)
		seen.set(url.href, path)
		let source = await loadModule(url)
		totalBytes += source.length
		if (totalBytes > MAX_TOTAL_BYTES) {
			throw new KodyError('npm_graph_too_large', 'npm import graph exceeded the 6 MiB limit.')
		}
		const deps = new Map<string, URL>()
		for (const match of source.matchAll(importRegex)) {
			const spec = match[3] ?? ''
			if (spec.startsWith('node:') || spec.startsWith('cloudflare:')) continue
			const depUrl = new URL(spec, url)
			if (depUrl.origin !== config.cdnOrigin) {
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

	if (durable && Object.keys(fetchedNow).length > 0) {
		await durable.putMany(fetchedNow, config.cacheMaxBytes)
	}

	if (specifiers.length > 0) {
		warnings.push(
			`npm imports (${specifiers.join(', ')}) were resolved through ${new URL(config.cdnOrigin).host}: ${cached} module(s) from cache, ${fetched} downloaded.`,
		)
	}
	return { modules, entryPaths, warnings, cached, fetched }
}
