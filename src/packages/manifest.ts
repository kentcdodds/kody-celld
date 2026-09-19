import { KodyError } from '../lib/errors.ts'

// Mirrors kentcdodds/kody `package.json#kody` shapes for the surfaces this
// runtime supports: exports, jobs, webhooks, subscriptions, dependencies,
// description, and hidden.

export type JobSchedule =
	{ type: 'cron'; expression: string } | { type: 'interval'; every: string } | { type: 'once'; runAt: string }

export type JobDefinition = {
	entry: string
	schedule: JobSchedule
	timezone?: string
	enabled?: boolean
	description?: string
}

export type WebhookVerification = {
	type: 'hmac-sha256'
	header: string
	secretName: string
	encoding: 'hex' | 'base64'
	prefix?: string
	signedPayload: 'body' | 'timestamp.body'
}

export type WebhookReplay = {
	timestampHeader?: string
	timestampFormat?: 'unix-seconds' | 'unix-millis' | 'iso' | 'stripe-signature'
	toleranceSeconds?: number
	deliveryIdHeader?: string
}

export type WebhookDefinition = {
	name: string
	/** export name as declared in `exports` (without the leading `./`) */
	export: string
	entry: string
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification?: WebhookVerification
	replay?: WebhookReplay
	description?: string
}

export type SubscriptionDefinition = {
	topic: string
	handler: string
	description?: string
}

export const subscriptionTopics = [
	'email.message.received',
	'email.message.quarantined',
	'email.message.delivery.updated',
] as const

export type SubscriptionTopic = (typeof subscriptionTopics)[number]

export const webhookNamePattern = /^[a-z0-9][a-z0-9-]*$/
export const webhookDefaultRateLimit = 60
export const webhookMaxRateLimit = 600

export type PackageManifest = {
	name: string
	version: string
	description: string
	/** export name (`.` for the default export) -> normalized relative module path */
	exports: Record<string, string>
	jobs: Record<string, JobDefinition>
	webhooks: Array<WebhookDefinition>
	subscriptions: Array<SubscriptionDefinition>
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

function parseWebhookVerification(raw: unknown, name: string): WebhookVerification {
	const where = `kody.webhooks[${name}].verification`
	if (!isRecord(raw)) throw new KodyError('invalid_manifest', `${where} must be an object.`)
	if (raw.type !== 'hmac-sha256') throw new KodyError('invalid_manifest', `${where}.type must be "hmac-sha256".`)
	if (typeof raw.header !== 'string' || !raw.header.trim()) {
		throw new KodyError('invalid_manifest', `${where}.header is required.`)
	}
	if ('secret' in raw || 'secretValue' in raw) {
		throw new KodyError(
			'invalid_manifest',
			`${where} must not carry a secret value; store it with secretSet and reference it via secretName.`,
		)
	}
	if (typeof raw.secretName !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(raw.secretName)) {
		throw new KodyError('invalid_manifest', `${where}.secretName must name a stored secret (never an inline value).`)
	}
	const encoding = raw.encoding ?? 'hex'
	if (encoding !== 'hex' && encoding !== 'base64') {
		throw new KodyError('invalid_manifest', `${where}.encoding must be "hex" or "base64".`)
	}
	const signedPayload = raw.signedPayload ?? 'body'
	if (signedPayload !== 'body' && signedPayload !== 'timestamp.body') {
		throw new KodyError('invalid_manifest', `${where}.signedPayload must be "body" or "timestamp.body".`)
	}
	if (raw.prefix !== undefined && typeof raw.prefix !== 'string') {
		throw new KodyError('invalid_manifest', `${where}.prefix must be a string.`)
	}
	return {
		type: 'hmac-sha256',
		header: raw.header.trim().toLowerCase(),
		secretName: raw.secretName,
		encoding,
		signedPayload,
		...(typeof raw.prefix === 'string' ? { prefix: raw.prefix } : {}),
	}
}

function parseWebhookReplay(raw: unknown, name: string): WebhookReplay {
	const where = `kody.webhooks[${name}].replay`
	if (!isRecord(raw)) throw new KodyError('invalid_manifest', `${where} must be an object.`)
	const replay: WebhookReplay = {}
	if (raw.timestampHeader !== undefined) {
		if (typeof raw.timestampHeader !== 'string' || !raw.timestampHeader.trim()) {
			throw new KodyError('invalid_manifest', `${where}.timestampHeader must be a header name.`)
		}
		replay.timestampHeader = raw.timestampHeader.trim().toLowerCase()
		const format = raw.timestampFormat ?? 'unix-seconds'
		if (!['unix-seconds', 'unix-millis', 'iso', 'stripe-signature'].includes(String(format))) {
			throw new KodyError('invalid_manifest', `${where}.timestampFormat is invalid.`)
		}
		replay.timestampFormat = format as NonNullable<WebhookReplay['timestampFormat']>
		const tolerance = raw.toleranceSeconds ?? 300
		if (typeof tolerance !== 'number' || !Number.isInteger(tolerance) || tolerance < 1 || tolerance > 86_400) {
			throw new KodyError('invalid_manifest', `${where}.toleranceSeconds must be an integer between 1 and 86400.`)
		}
		replay.toleranceSeconds = tolerance
	}
	if (raw.deliveryIdHeader !== undefined) {
		if (typeof raw.deliveryIdHeader !== 'string' || !raw.deliveryIdHeader.trim()) {
			throw new KodyError('invalid_manifest', `${where}.deliveryIdHeader must be a header name.`)
		}
		replay.deliveryIdHeader = raw.deliveryIdHeader.trim().toLowerCase()
	}
	if (replay.timestampHeader === undefined && replay.deliveryIdHeader === undefined) {
		throw new KodyError('invalid_manifest', `${where} needs timestampHeader and/or deliveryIdHeader.`)
	}
	return replay
}

function parseWebhooks(raw: unknown, exports: Record<string, string>): Array<WebhookDefinition> {
	if (raw === undefined) return []
	if (!Array.isArray(raw)) throw new KodyError('invalid_manifest', 'kody.webhooks must be an array.')
	const webhooks: Array<WebhookDefinition> = []
	const seen = new Set<string>()
	for (const item of raw) {
		if (!isRecord(item) || typeof item.name !== 'string') {
			throw new KodyError('invalid_manifest', 'Each kody.webhooks entry needs a string name.')
		}
		const name = item.name
		if (!webhookNamePattern.test(name) || name.length > 64) {
			throw new KodyError('invalid_manifest', `Webhook name "${name}" must be a lowercase slug.`)
		}
		if (seen.has(name)) throw new KodyError('invalid_manifest', `Webhook name "${name}" is declared twice.`)
		seen.add(name)
		if (typeof item.export !== 'string' || item.export === '*') {
			throw new KodyError('invalid_manifest', `kody.webhooks[${name}].export must name one declared export.`)
		}
		const exportName = item.export === '.' ? '.' : item.export.replace(/^\.\//, '')
		const entry = exports[exportName]
		if (!entry) {
			throw new KodyError(
				'invalid_manifest',
				`kody.webhooks[${name}].export "${item.export}" is not in package.json#exports.`,
			)
		}
		const responseMode = item.responseMode ?? 'ack'
		if (responseMode !== 'ack' && responseMode !== 'sync') {
			throw new KodyError('invalid_manifest', `kody.webhooks[${name}].responseMode must be "ack" or "sync".`)
		}
		const inputMode = item.inputMode ?? 'request'
		if (inputMode !== 'request' && inputMode !== 'params') {
			throw new KodyError('invalid_manifest', `kody.webhooks[${name}].inputMode must be "request" or "params".`)
		}
		const rate = item.rateLimitPerMinute ?? webhookDefaultRateLimit
		if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1 || rate > webhookMaxRateLimit) {
			throw new KodyError(
				'invalid_manifest',
				`kody.webhooks[${name}].rateLimitPerMinute must be an integer between 1 and ${webhookMaxRateLimit}.`,
			)
		}
		const verification = item.verification !== undefined ? parseWebhookVerification(item.verification, name) : undefined
		const replay = item.replay !== undefined ? parseWebhookReplay(item.replay, name) : undefined
		if (verification?.signedPayload === 'timestamp.body' && replay?.timestampHeader === undefined) {
			throw new KodyError(
				'invalid_manifest',
				`kody.webhooks[${name}]: signedPayload "timestamp.body" needs replay.timestampHeader.`,
			)
		}
		webhooks.push({
			name,
			export: exportName,
			entry,
			responseMode,
			inputMode,
			rateLimitPerMinute: rate,
			...(verification ? { verification } : {}),
			...(replay ? { replay } : {}),
			...(typeof item.description === 'string' ? { description: item.description } : {}),
		})
	}
	return webhooks
}

function parseSubscriptions(raw: unknown, files: PackageFiles): Array<SubscriptionDefinition> {
	if (raw === undefined) return []
	if (!isRecord(raw)) throw new KodyError('invalid_manifest', 'kody.subscriptions must be an object keyed by topic.')
	const subscriptions: Array<SubscriptionDefinition> = []
	for (const [topic, item] of Object.entries(raw)) {
		if (!(subscriptionTopics as ReadonlyArray<string>).includes(topic)) {
			throw new KodyError(
				'invalid_manifest',
				`kody.subscriptions["${topic}"]: unknown topic. Supported: ${subscriptionTopics.join(', ')}.`,
			)
		}
		if (!isRecord(item) || typeof item.handler !== 'string') {
			throw new KodyError('invalid_manifest', `kody.subscriptions["${topic}"].handler is required.`)
		}
		const handler = normalizeModulePath(item.handler)
		if (!(handler in files)) {
			throw new KodyError(
				'invalid_manifest',
				`kody.subscriptions["${topic}"].handler "${handler}" is not in the package files.`,
			)
		}
		subscriptions.push({
			topic,
			handler,
			...(typeof item.description === 'string' ? { description: item.description } : {}),
		})
	}
	return subscriptions
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
		webhooks: parseWebhooks(kody.webhooks, exports),
		subscriptions: parseSubscriptions(kody.subscriptions, files),
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
