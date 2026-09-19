import { KODY_CELLD_VERSION } from '../env.ts'
import { defineCapability, defineDomain } from './define.ts'

export const systemDomain = defineDomain({
	name: 'system',
	description: 'Information about this self-hosted Kody runtime: identity, version, and what is supported or deferred.',
})

export const whoami = defineCapability<Record<string, never>>({
	domain: 'system',
	name: 'whoami',
	description: 'Return the authenticated user, runtime version, and package context of the current run.',
	tags: ['system', 'read', 'identity'],
	keywords: ['who am i', 'current user', 'identity', 'version', 'runtime'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.whoami()
}`,
	async handler(_args, ctx) {
		return {
			user: ctx.user,
			runtime: 'kody-celld',
			version: KODY_CELLD_VERSION,
			packageName: ctx.packageName,
			runId: ctx.runId,
			baseUrl: ctx.baseUrl,
		}
	},
})

export const ping = defineCapability<{ message?: string }>({
	domain: 'system',
	name: 'ping',
	description: 'Echo a message with the server time. Useful for connectivity smoke tests.',
	tags: ['system', 'read'],
	keywords: ['ping', 'echo', 'health', 'smoke'],
	inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
	readOnly: true,
	async handler(args) {
		return { pong: args.message ?? 'pong', at: new Date().toISOString() }
	},
})

export const systemCapabilities = [whoami, ping]
