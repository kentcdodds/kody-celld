import type { RunRecord } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { buildModuleGraph, type GraphEntry } from './module-graph.ts'

export const defaultResponseLimitBytes = 100_000
export const executeTimeoutMs = 60_000
export const runRecordMaxIdempotencyKeyLength = 200

export type ExecuteInput = {
	kind: RunRecord['kind']
	user: { id: string; email: string }
	entry: GraphEntry
	params: unknown
	responseLimit?: number | undefined
	idempotencyKey?: string | undefined
	trigger?: string | undefined
}

export type ExecuteResult = {
	runId: string
	ok: boolean
	replayed: boolean
	result?: unknown
	truncated?: boolean
	note?: string
	error?: { name: string; message: string; stack?: string } | undefined
	logs: Array<unknown>
	warnings: Array<string>
	gateway: Array<RunRecord['gateway'][number]>
	durationMs: number
	packages: Array<string>
}

type WrapperResponse =
	| { ok: true; result: unknown; logs: Array<unknown> }
	| { ok: false; error: { name: string; message: string; stack?: string }; logs: Array<unknown> }

export function getUserCell(env: Env, userId: string) {
	return env.USER.getByName(userId)
}

function truncateResult(result: unknown, limit: number) {
	const json = JSON.stringify(result) ?? 'null'
	if (json.length <= limit) return { result, truncated: false as const }
	return {
		result: json.slice(0, limit),
		truncated: true as const,
		note: `Result JSON (${json.length} bytes) exceeded responseLimit (${limit}); returned the leading ${limit} characters as a string.`,
	}
}

async function graphHash(userId: string, modules: Record<string, string>) {
	const parts = Object.keys(modules)
		.sort()
		.map((key) => `${key}\u0000${modules[key] ?? ''}`)
	return sha256Hex(`${userId}\u0000${parts.join('\u0001')}`)
}

/**
 * Runs a module graph in a Worker Loader isolate. Isolates are keyed by the
 * hash of (user, module graph) so repeated calls with the same code reuse the
 * same isolate; per-run identity travels in the request/RPC context instead.
 */
export async function executeRun(
	env: Env,
	exports: ExecutionContext['exports'],
	input: ExecuteInput,
): Promise<ExecuteResult> {
	const userCell = getUserCell(env, input.user.id)
	const packageName = input.entry.kind === 'package' ? input.entry.packageName : null
	if (input.idempotencyKey !== undefined && input.idempotencyKey.length > runRecordMaxIdempotencyKeyLength) {
		throw new KodyError('invalid_args', `idempotencyKey must be at most ${runRecordMaxIdempotencyKeyLength} chars.`)
	}
	const { run, replayed } = await userCell.runStart({
		kind: input.kind,
		packageName,
		idempotencyKey: input.idempotencyKey ?? null,
	})
	if (replayed) return runToResult(run, true)

	const started = Date.now()
	const finish = async (
		status: 'success' | 'error',
		fields: {
			result?: unknown
			error?: ExecuteResult['error']
			logs?: Array<unknown>
			warnings?: Array<string>
		},
	) => {
		const record = await userCell.runFinish({
			id: run.id,
			status,
			resultJson: fields.result === undefined ? null : JSON.stringify(fields.result),
			error: fields.error ? { name: fields.error.name, message: fields.error.message } : null,
			logsJson: JSON.stringify((fields.logs ?? []).slice(0, 200)),
			warnings: fields.warnings,
			durationMs: Date.now() - started,
		})
		return runToResult(record, false, fields.error)
	}

	let graph
	try {
		graph = await buildModuleGraph({ entry: input.entry, userCell, allowNpm: true })
	} catch (error) {
		return finish('error', { error: toErrorShape(error) })
	}

	const isolateName = `kody-${await graphHash(input.user.id, graph.modules)}`
	const packageVersion =
		input.entry.kind === 'package' ? ((await userCell.packageGet(input.entry.packageName))?.version ?? null) : null
	const props = { userId: input.user.id, email: input.user.email, packageName }

	const worker = env.LOADER.get(isolateName, () => ({
		compatibilityDate: '2026-01-01',
		compatibilityFlags: ['nodejs_compat'],
		mainModule: graph.mainModule,
		modules: graph.modules,
		env: { KODY: exports.RuntimeHost({ props }) },
		globalOutbound: exports.FetchGateway({ props }),
	}))

	const timeout = new Promise<never>((_resolve, reject) => {
		setTimeout(
			() =>
				reject(new KodyError('execute_timeout', `Execution exceeded ${executeTimeoutMs / 1000}s.`, { status: 504 })),
			executeTimeoutMs,
		)
	})

	try {
		const response = await Promise.race([
			worker.getEntrypoint().fetch('https://kody-celld.invalid/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					params: input.params ?? {},
					context: { runId: run.id, packageName, packageVersion, trigger: input.trigger ?? null },
				}),
			}),
			timeout,
		])
		const payload = (await response.json()) as WrapperResponse
		const warnings = [...graph.warnings]
		if (!payload.ok) {
			return finish('error', { error: payload.error, logs: payload.logs, warnings })
		}
		const limit = input.responseLimit ?? defaultResponseLimitBytes
		const truncated = truncateResult(payload.result, limit)
		if (truncated.truncated) warnings.push(truncated.note)
		const result = await finish('success', { result: truncated.result, logs: payload.logs, warnings })
		return truncated.truncated ? { ...result, truncated: true, note: truncated.note } : result
	} catch (error) {
		return finish('error', { error: toErrorShape(error), warnings: graph.warnings })
	}
}

function toErrorShape(error: unknown): ExecuteResult['error'] {
	const kody = KodyError.fromUnknown(error)
	if (kody) return { name: kody.code, message: kody.message }
	if (error instanceof Error) return { name: error.name, message: error.message }
	return { name: 'Error', message: String(error) }
}

function runToResult(run: RunRecord, replayed: boolean, error?: ExecuteResult['error']): ExecuteResult {
	return {
		runId: run.id,
		ok: run.status === 'success',
		replayed,
		result: run.resultJson === null ? undefined : (JSON.parse(run.resultJson) as unknown),
		error: error ?? run.error ?? undefined,
		logs: JSON.parse(run.logsJson) as Array<unknown>,
		warnings: run.warnings,
		gateway: run.gateway,
		durationMs: run.durationMs ?? 0,
		packages: run.packageName ? [run.packageName] : [],
	}
}
