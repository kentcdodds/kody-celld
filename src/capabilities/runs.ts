import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain } from './define.ts'

export const runsDomain = defineDomain({
	name: 'runs',
	description:
		'History of execute/package/job runs: status, console logs, warnings, and the fetch-gateway decisions (forwarded / injected / denied) made on their behalf.',
})

export const runList = defineCapability<{ limit?: number }>({
	domain: 'runs',
	name: 'runList',
	description: 'List recent runs (newest first).',
	tags: ['runs', 'read'],
	keywords: ['recent runs', 'execution history', 'what ran'],
	inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
	readOnly: true,
	async handler(args, ctx) {
		return { runs: await ctx.userCell.runList({ limit: args.limit }) }
	},
})

export const runGet = defineCapability<{ id: string }>({
	domain: 'runs',
	name: 'runGet',
	description: 'Get one run with its result, logs, warnings, and gateway events (secret values are never included).',
	tags: ['runs', 'read'],
	keywords: ['run details', 'run logs', 'gateway events', 'denied host', 'why blocked'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	readOnly: true,
	async handler(args, ctx) {
		const run = await ctx.userCell.runGet({ id: args.id })
		if (!run) throw new KodyError('run_not_found', `Run "${args.id}" was not found.`, { status: 404 })
		const { resultJson, logsJson, ...rest } = run
		return {
			...rest,
			result: resultJson === null ? undefined : (JSON.parse(resultJson) as unknown),
			logs: JSON.parse(logsJson) as Array<unknown>,
		}
	},
})

export const runCapabilities = [runList, runGet]
