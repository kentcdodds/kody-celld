import { KodyError } from '../lib/errors.ts'
import { validateArgs, type CapabilityContext, type CapabilityDefinition, type DomainDefinition } from './define.ts'
import { aiCapabilities, aiDomain } from './ai.ts'
import { jobCapabilities, jobsDomain } from './jobs.ts'
import { memoryCapabilities, memoryDomain } from './memory.ts'
import { packageCapabilities, packagesDomain } from './packages.ts'
import { runCapabilities, runsDomain } from './runs.ts'
import { secretCapabilities, secretsDomain } from './secrets.ts'
import { storageCapabilities, storageDomain } from './storage.ts'
import { systemCapabilities, systemDomain } from './system.ts'

export const domains: Array<DomainDefinition> = [
	systemDomain,
	secretsDomain,
	packagesDomain,
	jobsDomain,
	storageDomain,
	runsDomain,
	memoryDomain,
	aiDomain,
]

export const capabilities: Array<CapabilityDefinition> = [
	...systemCapabilities,
	...secretCapabilities,
	...packageCapabilities,
	...jobCapabilities,
	...storageCapabilities,
	...runCapabilities,
	...memoryCapabilities,
	...aiCapabilities,
]

const byName = new Map(capabilities.map((c) => [c.name, c]))

export function getCapability(name: string) {
	return byName.get(name) ?? null
}

export async function runCapability(name: string, args: unknown, ctx: CapabilityContext) {
	const capability = byName.get(name)
	if (!capability) {
		throw new KodyError('unknown_capability', `Unknown capability "${name}". Use search to discover capability ids.`, {
			status: 404,
		})
	}
	const validated = validateArgs(capability.inputSchema, args, name)
	return capability.handler(validated, ctx)
}
