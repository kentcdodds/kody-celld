import type { UserCell } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { KodyError } from '../lib/errors.ts'

export type JsonSchema = {
	type?: string | Array<string>
	description?: string
	properties?: Record<string, JsonSchema>
	required?: Array<string>
	items?: JsonSchema
	enum?: Array<unknown>
	additionalProperties?: boolean | JsonSchema
	default?: unknown
	[key: string]: unknown
}

export type CapabilityContext = {
	env: Env
	exports: ExecutionContext['exports']
	user: { id: string; email: string }
	userCell: DurableObjectStub<UserCell>
	/** Package whose code is running, or null for ad hoc execute / MCP-direct calls. */
	packageName: string | null
	runId: string | null
	baseUrl: string
	/** Set when the caller is executing inside the Worker Loader sandbox. */
	fromRuntime: boolean
}

export type CapabilityDefinition<Args = Record<string, unknown>, Result = unknown> = {
	domain: string
	name: string
	description: string
	tags: Array<string>
	keywords: Array<string>
	inputSchema: JsonSchema
	outputSchema?: JsonSchema
	/** Short execute snippet shown by search entity detail. */
	example?: string
	readOnly?: boolean
	handler: (args: Args, ctx: CapabilityContext) => Promise<Result>
}

export type DomainDefinition = {
	name: string
	description: string
	guide?: string
}

export function defineDomain(domain: DomainDefinition) {
	return domain
}

export function defineCapability<Args = Record<string, unknown>, Result = unknown>(
	definition: CapabilityDefinition<Args, Result>,
) {
	return definition as CapabilityDefinition<Record<string, unknown>, unknown>
}

function typeMatches(value: unknown, type: string) {
	switch (type) {
		case 'string':
			return typeof value === 'string'
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
		case 'integer':
			return Number.isInteger(value)
		case 'boolean':
			return typeof value === 'boolean'
		case 'object':
			return typeof value === 'object' && value !== null && !Array.isArray(value)
		case 'array':
			return Array.isArray(value)
		case 'null':
			return value === null
		default:
			return true
	}
}

/** Minimal JSON-schema check: required keys plus top-level property types and enums. */
export function validateArgs(schema: JsonSchema, args: unknown, capabilityName: string) {
	if (args === undefined || args === null) args = {}
	if (typeof args !== 'object' || Array.isArray(args)) {
		throw new KodyError('invalid_args', `${capabilityName} expects an object of arguments.`)
	}
	const record = args as Record<string, unknown>
	for (const key of schema.required ?? []) {
		if (record[key] === undefined) {
			throw new KodyError('invalid_args', `${capabilityName} requires "${key}".`, {
				details: { missing: key },
			})
		}
	}
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		const value = record[key]
		if (value === undefined) continue
		const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []
		if (types.length > 0 && !types.some((t) => typeMatches(value, t))) {
			throw new KodyError('invalid_args', `${capabilityName}.${key} must be of type ${types.join(' | ')}.`)
		}
		if (prop.enum && !prop.enum.includes(value)) {
			throw new KodyError(
				'invalid_args',
				`${capabilityName}.${key} must be one of ${prop.enum.map(String).join(', ')}.`,
			)
		}
	}
	if (schema.additionalProperties === false) {
		for (const key of Object.keys(record)) {
			if (!(key in (schema.properties ?? {}))) {
				throw new KodyError('invalid_args', `${capabilityName} does not accept "${key}".`)
			}
		}
	}
	return record
}
