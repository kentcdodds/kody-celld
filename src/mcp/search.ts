import type { CapabilityContext } from '../capabilities/define.ts'
import { capabilities, domains } from '../capabilities/registry.ts'
import { KODY_CELLD_VERSION } from '../env.ts'
import { KodyError } from '../lib/errors.ts'

export type SearchEntity = 'capability' | 'domain' | 'package' | 'job' | 'guide'

export type SearchInput = {
	query?: string | undefined
	entity?: SearchEntity | undefined
	domain?: string | undefined
	limit?: number | undefined
	maxResponseSize?: number | undefined
	includeHiddenPackages?: boolean | undefined
}

type Indexed = {
	id: string
	entity: SearchEntity
	title: string
	summary: string
	domain: string | null
	haystack: string
	exactNames: Array<string>
	detail: Record<string, unknown>
}

const executeContract = `execute takes { code, params?, responseLimit?, idempotencyKey? }. \`code\` is one ES module whose default export receives params:
import { kody } from 'kody:runtime'
export default async function main(params) {
  return await kody.<capabilityId>({ ...args })
}
Capability ids are the \`id\` values below (e.g. kody.secretSave). Saved package exports: import fn from 'kody:<package>/<export>'.`

const guides: Array<Omit<Indexed, 'haystack'>> = [
	{
		id: 'guide:execute',
		entity: 'guide',
		title: 'How to call capabilities with execute',
		summary: 'Module shape, params, kody:runtime, package imports, response limits.',
		domain: null,
		exactNames: ['execute', 'how to', 'usage'],
		detail: { text: executeContract },
	},
	{
		id: 'guide:secrets',
		entity: 'guide',
		title: 'Secrets and host approval',
		summary:
			'Save values with kody.secretSave, reference them as {{secret:name}} in fetch URLs/headers/bodies; the gateway injects them only for admin-approved https hosts.',
		domain: 'secrets',
		exactNames: ['secret', 'placeholder', 'approval'],
		detail: {
			text: `1. await kody.secretSave({ name: 'github', value: '<token>' })
2. In code: await fetch('https://api.github.com/user', { headers: { authorization: 'Bearer {{secret:github}}' } })
3. If the response is 403 secret_host_not_approved, stop and ask an account admin to approve the host via POST /admin/users/<userId>/secret-hosts { "host": "api.github.com" }.
Secret values never appear in results, logs, or run records. Basic auth: authorization: '{{secret-basic:username=u,password=p}}'.`,
		},
	},
	{
		id: 'guide:packages',
		entity: 'guide',
		title: 'Packages, packageStorage(), and jobs',
		summary:
			'Save a package with kody.packageSave({ files }); declare jobs in package.json#kody.jobs; use packageStorage() for durable state.',
		domain: 'packages',
		exactNames: ['package', 'job', 'storage', 'cron'],
		detail: {
			text: `files = { 'package.json': JSON.stringify({ name: '@me/counter', exports: { '.': './index.js', increment: './increment.js' }, kody: { jobs: { tick: { entry: './tick.js', schedule: { type: 'interval', every: '1m' } } } } }), 'index.js': ..., 'increment.js': ..., 'tick.js': ..., 'README.md': '...', 'AGENTS.md': '...' }
Inside modules: import { packageStorage } from 'kody:runtime'; const store = packageStorage(); await store.set('k', v); await store.get('k'); await store.sql('CREATE TABLE IF NOT EXISTS t (...)').
Run: kody.packageRun({ name: '@me/counter', export: 'increment', params }) or import fn from 'kody:@me/counter/increment'.`,
		},
	},
	{
		id: 'guide:deferred',
		entity: 'guide',
		title: 'What kody-celld v1 does not do',
		summary:
			'Vectorize/semantic search, Workers AI, email routing, OAuth integrations, memories, workflows, and the web UI are deferred.',
		domain: 'system',
		exactNames: ['deferred', 'gaps', 'unsupported', 'vectorize', 'ai', 'email', 'memory'],
		detail: {
			text: `kody-celld ${KODY_CELLD_VERSION} runs on celld (self-hosted Workers + Durable Objects). Search is lexical (no Vectorize). No Workers AI / AI Gateway, no email inboxes, no OAuth integrations ({{integration-token:...}}), no memories, no Workflows, no web UI. The kody:runtime exports for those (createAuthenticatedFetch, oauthClientCredentials, email, workflows) throw or are null.`,
		},
	},
]

function tokens(text: string) {
	return text
		.toLowerCase()
		.replaceAll(/[^a-z0-9@/._-]+/g, ' ')
		.split(' ')
		.filter((t) => t.length > 1)
}

function score(item: Indexed, queryTokens: Array<string>, rawQuery: string) {
	if (queryTokens.length === 0) return 1
	let total = 0
	const lowerQuery = rawQuery.toLowerCase().trim()
	if (item.exactNames.some((n) => n.toLowerCase() === lowerQuery) || item.id.toLowerCase() === lowerQuery) total += 10
	if (item.title.toLowerCase().includes(lowerQuery)) total += 4
	for (const token of queryTokens) {
		if (item.id.toLowerCase().includes(token)) total += 3
		if (item.title.toLowerCase().includes(token)) total += 2
		if (item.exactNames.some((n) => n.toLowerCase().includes(token))) total += 2
		if (item.haystack.includes(token)) total += 1
		// crude stemming: match "secrets" against "secret"
		if (token.endsWith('s') && item.haystack.includes(token.slice(0, -1))) total += 0.5
	}
	return total
}

async function buildIndex(ctx: CapabilityContext, includeHidden: boolean): Promise<Array<Indexed>> {
	const items: Array<Indexed> = []
	for (const domain of domains) {
		const caps = capabilities.filter((c) => c.domain === domain.name).map((c) => c.name)
		const detail: Record<string, unknown> = { capabilities: caps }
		if (domain.guide) detail.guide = domain.guide
		items.push({
			id: `domain:${domain.name}`,
			entity: 'domain',
			title: domain.name,
			summary: domain.description,
			domain: domain.name,
			exactNames: [domain.name],
			haystack: tokens(`${domain.name} ${domain.description} ${domain.guide ?? ''} ${caps.join(' ')}`).join(' '),
			detail,
		})
	}
	for (const cap of capabilities) {
		const detail: Record<string, unknown> = {
			inputSchema: cap.inputSchema,
			readOnly: cap.readOnly ?? false,
		}
		if (cap.outputSchema) detail.outputSchema = cap.outputSchema
		if (cap.example) detail.example = cap.example
		items.push({
			id: cap.name,
			entity: 'capability',
			title: `kody.${cap.name}`,
			summary: cap.description,
			domain: cap.domain,
			exactNames: [cap.name, `kody.${cap.name}`, ...cap.keywords],
			haystack: tokens(
				`${cap.name} ${cap.domain} ${cap.description} ${cap.tags.join(' ')} ${cap.keywords.join(' ')} ${Object.keys(cap.inputSchema.properties ?? {}).join(' ')}`,
			).join(' '),
			detail,
		})
	}
	const packages = await ctx.userCell.packageList()
	for (const pkg of packages) {
		if (pkg.manifest.hidden && !includeHidden) continue
		const exportNames = Object.keys(pkg.manifest.exports)
		items.push({
			id: `package:${pkg.name}`,
			entity: 'package',
			title: pkg.name,
			summary: pkg.manifest.description || `Saved package with exports: ${exportNames.join(', ')}`,
			domain: 'packages',
			exactNames: [pkg.name, ...exportNames.map((e) => `${pkg.name}/${e}`)],
			haystack: tokens(
				`${pkg.name} ${pkg.manifest.description} ${pkg.manifest.keywords.join(' ')} ${exportNames.join(' ')} ${Object.keys(pkg.manifest.jobs).join(' ')}`,
			).join(' '),
			detail: {
				version: pkg.version,
				exports: pkg.manifest.exports,
				jobs: pkg.manifest.jobs,
				importExamples: exportNames.map((e) => `import fn from 'kody:${pkg.name}${e === '.' ? '' : `/${e}`}'`),
				run: `kody.packageRun({ name: '${pkg.name}', export: '${exportNames[0] ?? '.'}', params: {} })`,
				hidden: pkg.manifest.hidden,
			},
		})
	}
	const jobs = await ctx.userCell.jobList()
	for (const job of jobs) {
		items.push({
			id: `job:${job.id}`,
			entity: 'job',
			title: job.id,
			summary: `${job.enabled ? 'enabled' : 'disabled'} ${job.schedule.type} job (${describeSchedule(job.schedule)}); next ${job.nextRunAt ?? 'never'}; last ${job.lastStatus ?? 'never'}`,
			domain: 'jobs',
			exactNames: [job.id, job.jobName, job.packageName],
			haystack: tokens(
				`${job.id} ${job.jobName} ${job.packageName} ${job.description ?? ''} ${job.schedule.type} job cron`,
			).join(' '),
			detail: { job },
		})
	}
	for (const guide of guides) {
		items.push({
			...guide,
			haystack: tokens(`${guide.title} ${guide.summary} ${JSON.stringify(guide.detail)}`).join(' '),
		})
	}
	return items
}

function describeSchedule(schedule: { type: string; expression?: string; every?: string; runAt?: string }) {
	return schedule.expression ?? schedule.every ?? schedule.runAt ?? ''
}

export async function search(input: SearchInput, ctx: CapabilityContext) {
	const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
	const maxResponseSize = Math.min(Math.max(input.maxResponseSize ?? 20_000, 1_000), 200_000)
	if (input.entity && !['capability', 'domain', 'package', 'job', 'guide'].includes(input.entity)) {
		throw new KodyError('invalid_args', `Unknown entity "${input.entity}".`)
	}
	const index = await buildIndex(ctx, input.includeHiddenPackages ?? false)
	const query = input.query?.trim() ?? ''
	const queryTokens = tokens(query)
	const scored = index
		.filter((item) => !input.entity || item.entity === input.entity)
		.filter((item) => !input.domain || item.domain === input.domain)
		.map((item) => ({ item, score: score(item, queryTokens, query) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
	const top = scored.slice(0, limit)
	const results = top.map(({ item, score: itemScore }, rank) => ({
		id: item.id,
		entity: item.entity,
		title: item.title,
		summary: item.summary,
		domain: item.domain,
		score: itemScore,
		...(rank === 0 || item.id.toLowerCase() === query.toLowerCase() ? { detail: item.detail } : {}),
	}))
	const payload = {
		query,
		total: scored.length,
		results,
		usage: executeContract,
		domains: domains.map((d) => d.name),
	}
	let text = JSON.stringify(payload)
	while (text.length > maxResponseSize && payload.results.length > 1) {
		payload.results.pop()
		text = JSON.stringify(payload)
	}
	if (text.length > maxResponseSize) {
		for (const result of payload.results) delete (result as { detail?: unknown }).detail
	}
	return payload
}
