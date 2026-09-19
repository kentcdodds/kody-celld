import { KodyError } from '../lib/errors.ts'

// Mirrors kentcdodds/kody `package.json#kody` shapes for the surfaces this
// runtime supports: exports, jobs, dependencies, description, and hidden.

export type JobSchedule =
	{ type: 'cron'; expression: string } | { type: 'interval'; every: string } | { type: 'once'; runAt: string }

export type JobDefinition = {
	entry: string
	schedule: JobSchedule
	timezone?: string
	enabled?: boolean
	description?: string
}

export type PackageManifest = {
	name: string
	version: string
	description: string
	/** export name (`.` for the default export) -> normalized relative module path */
	exports: Record<string, string>
	jobs: Record<string, JobDefinition>
	dependencies: Record<string, string>
	hidden: boolean
	keywords: Array<string>
}

export type PackageFiles = Record<string, string>

export const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

export function normalizeModulePath(path: string) {
	let next = path.trim().replaceAll('\\', '/')
	if (next.startsWith('./')) next = next.slice(2)
	if (next.startsWith('/')) next = next.slice(1)
	const parts: Array<string> = []
	for (const segment of next.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			if (parts.length === 0) {
				throw new KodyError('invalid_path', `Path "${path}" escapes the package root.`)
			}
			parts.pop()
			continue
		}
		parts.push(segment)
	}
	if (parts.length === 0) throw new KodyError('invalid_path', `Path "${path}" is empty.`)
	return parts.join('/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSchedule(raw: unknown, jobName: string): JobSchedule {
	if (!isRecord(raw)) {
		throw new KodyError('invalid_manifest', `kody.jobs.${jobName}.schedule must be an object.`)
	}
	if (raw.type === 'cron' && typeof raw.expression === 'string' && raw.expression.trim()) {
		return { type: 'cron', expression: raw.expression.trim() }
	}
	if (raw.type === 'interval' && typeof raw.every === 'string' && raw.every.trim()) {
		return { type: 'interval', every: raw.every.trim() }
	}
	if (raw.type === 'once' && typeof raw.runAt === 'string' && raw.runAt.trim()) {
		return { type: 'once', runAt: raw.runAt.trim() }
	}
	throw new KodyError(
		'invalid_manifest',
		`kody.jobs.${jobName}.schedule must be {type:'cron',expression} | {type:'interval',every} | {type:'once',runAt}.`,
	)
}

export function parsePackageManifest(files: PackageFiles): PackageManifest {
	const source = files['package.json']
	if (!source) throw new KodyError('invalid_manifest', 'package.json is required.')
	let json: unknown
	try {
		json = JSON.parse(source)
	} catch (error) {
		throw new KodyError('invalid_manifest', `package.json is not valid JSON: ${String(error)}`)
	}
	if (!isRecord(json)) throw new KodyError('invalid_manifest', 'package.json must be an object.')
	const name = json.name
	if (typeof name !== 'string' || !packageNamePattern.test(name)) {
		throw new KodyError('invalid_manifest', 'package.json#name must be an npm-style package name (optionally scoped).')
	}
	const kody = isRecord(json.kody) ? json.kody : {}

	const exports: Record<string, string> = {}
	if (typeof json.exports === 'string') {
		exports['.'] = normalizeModulePath(json.exports)
	} else if (isRecord(json.exports)) {
		for (const [key, value] of Object.entries(json.exports)) {
			if (typeof value !== 'string') {
				throw new KodyError('invalid_manifest', `exports["${key}"] must be a module path string.`)
			}
			const exportName = key === '.' ? '.' : key.replace(/^\.\//, '')
			exports[exportName] = normalizeModulePath(value)
		}
	} else if (typeof json.main === 'string') {
		exports['.'] = normalizeModulePath(json.main)
	}
	for (const [exportName, path] of Object.entries(exports)) {
		if (!(path in files)) {
			throw new KodyError(
				'invalid_manifest',
				`exports["${exportName}"] points to "${path}" which is not in the package files.`,
			)
		}
	}

	const jobs: Record<string, JobDefinition> = {}
	if (kody.jobs !== undefined) {
		if (!isRecord(kody.jobs)) {
			throw new KodyError('invalid_manifest', 'kody.jobs must be an object keyed by job name.')
		}
		for (const [jobName, raw] of Object.entries(kody.jobs)) {
			if (!/^[a-z0-9][a-z0-9._-]*$/i.test(jobName)) {
				throw new KodyError('invalid_manifest', `Job name "${jobName}" is invalid.`)
			}
			if (!isRecord(raw) || typeof raw.entry !== 'string') {
				throw new KodyError('invalid_manifest', `kody.jobs.${jobName}.entry is required.`)
			}
			const entry = normalizeModulePath(raw.entry)
			if (!(entry in files)) {
				throw new KodyError('invalid_manifest', `kody.jobs.${jobName}.entry "${entry}" is not in the package files.`)
			}
			jobs[jobName] = {
				entry,
				schedule: parseSchedule(raw.schedule, jobName),
				...(typeof raw.timezone === 'string' ? { timezone: raw.timezone } : {}),
				...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
				...(typeof raw.description === 'string' ? { description: raw.description } : {}),
			}
		}
	}

	const dependencies: Record<string, string> = {}
	if (isRecord(kody.dependencies)) {
		for (const [dep, range] of Object.entries(kody.dependencies)) {
			if (!packageNamePattern.test(dep) || typeof range !== 'string') {
				throw new KodyError('invalid_manifest', `kody.dependencies["${dep}"] is invalid.`)
			}
			dependencies[dep] = range
		}
	}

	const readme = files['README.md']?.trim() ?? ''
	const agents = files['AGENTS.md']?.trim() ?? ''
	if (!readme) throw new KodyError('invalid_manifest', 'A non-empty README.md is required.')
	if (!agents) throw new KodyError('invalid_manifest', 'A non-empty AGENTS.md is required.')

	return {
		name,
		version: typeof json.version === 'string' ? json.version : '0.0.0',
		description:
			typeof kody.description === 'string'
				? kody.description
				: typeof json.description === 'string'
					? json.description
					: '',
		exports,
		jobs,
		dependencies,
		hidden: kody.hidden === true,
		keywords: Array.isArray(json.keywords) ? json.keywords.filter((k): k is string => typeof k === 'string') : [],
	}
}

/** Resolves `kody:@scope/pkg/export` or `kody:pkg` into package + export name. */
export function parseKodyPackageSpecifier(specifier: string) {
	if (!specifier.startsWith('kody:') || specifier === 'kody:runtime') return null
	const rest = specifier.slice('kody:'.length)
	const segments = rest.split('/')
	let packageName: string
	let exportName: string
	if (rest.startsWith('@')) {
		if (segments.length < 2) return null
		packageName = `${segments[0]}/${segments[1]}`
		exportName = segments.slice(2).join('/') || '.'
	} else {
		packageName = segments[0] ?? ''
		exportName = segments.slice(1).join('/') || '.'
	}
	if (!packageNamePattern.test(packageName)) return null
	return { packageName, exportName }
}

export function resolvePackageExport(manifest: PackageManifest, exportName: string) {
	const key = exportName === '' ? '.' : exportName.replace(/^\.\//, '')
	const path = manifest.exports[key]
	if (!path) {
		throw new KodyError(
			'unknown_export',
			`Package ${manifest.name} has no export "${key}". Available: ${Object.keys(manifest.exports).join(', ') || '(none)'}.`,
			{ status: 404 },
		)
	}
	return path
}
