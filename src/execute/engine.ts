import type { RunRecord } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { defaultLimits, limitsFromEnv } from '../lib/limits.ts'
import { extractMcpContent, mcpContentKey, summarizeMcpContent, type McpContentBlock } from '../mcp/content.ts'
import { normalizeModulePath, resolvePackageExport, type PackageManifest } from '../packages/manifest.ts'
import { buildModuleGraph, type GraphEntry } from './module-graph.ts'
import { npmConfigFromEnv } from './npm-config.ts'

export const defaultResponseLimitBytes = defaultLimits.responseLimitBytes
export const runRecordMaxIdempotencyKeyLength = 200

export type ExecuteInput = {
	kind: RunRecord['kind']
	user: { id: string; email: string }
	entry: GraphEntry
	params: unknown
	responseLimit?: number | undefined
	idempotencyKey?: string | undefined
	trigger?: string | undefined
	/**
	 * Sealed runs return their result only to the host caller: run history keeps
	 * the record (kind, status, duration, gateway events) but stores no result or
	 * console output, because the value is a secret on its way to the gateway.
	 */
	sealed?: boolean | undefined
	timeoutMs?: number | undefined
}

export type ExecuteResult = {
	runId: string
	ok: boolean
	replayed: boolean
	result?: unknown
	/** Raw MCP content blocks returned via `{ __mcpContent: [...] }`; passed through as tool content. */
	mcpContent?: Array<McpContentBlock>
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
	const limits = limitsFromEnv(env)
	const userCell = getUserCell(env, input.user.id)
	const packageName = input.entry.kind === 'package' ? input.entry.packageName : null
	if (input.idempotencyKey !== undefined && input.idempotencyKey.length > runRecordMaxIdempotencyKeyLength) {
		throw new KodyError('invalid_args', `idempotencyKey must be at most ${runRecordMaxIdempotencyKeyLength} chars.`)
	}
	const pkg = input.entry.kind === 'package' ? await userCell.packageGet(input.entry.packageName) : null
	if (input.entry.kind === 'package' && pkg && !input.sealed && isSecretProviderEntry(pkg.manifest, input.entry)) {
		// The provider export returns a secret value; only the gateway may run it (sealed).
		throw new KodyError(
			'secret_provider_entry_sealed',
			`"${pkg.manifest.name}"'s secretProvider export is invoked by Kody only, when a {{secret/${pkg.manifest.secretProvider?.id}:...}} placeholder is resolved. It cannot be run directly.`,
			{ status: 403 },
		)
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
			resultJson: fields.result === undefined || input.sealed ? null : JSON.stringify(fields.result),
			error: fields.error ? { name: fields.error.name, message: fields.error.message } : null,
			logsJson: input.sealed ? '[]' : JSON.stringify((fields.logs ?? []).slice(0, limits.runLogLimit)),
			warnings: fields.warnings,
			durationMs: Date.now() - started,
		})
		const result = runToResult(record, false, fields.error)
		return input.sealed ? { ...result, result: fields.result, logs: [] } : result
	}

	let graph
	try {
		const npm = npmConfigFromEnv(env)
		graph = await buildModuleGraph({
			entry: input.entry,
			userCell,
			allowNpm: npm.enabled,
			npm: { config: npm, cache: env.NPM_CACHE.get(env.NPM_CACHE.idFromName('npm-cache')) },
			sealed: input.sealed === true,
		})
	} catch (error) {
		return finish('error', { error: toErrorShape(error) })
	}

	const isolateName = `kody-${await graphHash(input.user.id, graph.modules)}`
	const packageVersion = pkg?.version ?? null
	const props = { userId: input.user.id, email: input.user.email, packageName }

	const worker = env.LOADER.get(isolateName, () => ({
		compatibilityDate: '2026-01-01',
		compatibilityFlags: ['nodejs_compat'],
		mainModule: graph.mainModule,
		modules: graph.modules,
		env: { KODY: exports.RuntimeHost({ props }) },
		globalOutbound: exports.FetchGateway({ props }),
	}))

	const timeoutMs = input.timeoutMs ?? limits.executeTimeoutMs
	const timeout = new Promise<never>((_resolve, reject) => {
		setTimeout(
			() => reject(new KodyError('execute_timeout', `Execution exceeded ${timeoutMs / 1000}s.`, { status: 504 })),
			timeoutMs,
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
		const limit = input.responseLimit ?? limits.responseLimitBytes
		const content = extractMcpContent(payload.result, limits.mcpContentLimitBytes)
		if (content) {
			// Media blocks are capped separately and never truncated; run history
			// keeps a size summary instead of megabytes of base64.
			const truncated = truncateResult(content.rest, limit)
			if (truncated.truncated) warnings.push(truncated.note)
			const result = await finish('success', {
				result: {
					...(truncated.truncated ? { rest: truncated.result } : (content.rest ?? {})),
					[mcpContentKey]: summarizeMcpContent(content.blocks),
				},
				logs: payload.logs,
				warnings,
			})
			return {
				...result,
				result: truncated.result,
				mcpContent: content.blocks,
				...(truncated.truncated ? { truncated: true, note: truncated.note } : {}),
			}
		}
		const truncated = truncateResult(payload.result, limit)
		if (truncated.truncated) warnings.push(truncated.note)
		const result = await finish('success', { result: truncated.result, logs: payload.logs, warnings })
		return truncated.truncated ? { ...result, truncated: true, note: truncated.note } : result
	} catch (error) {
		return finish('error', { error: toErrorShape(error), warnings: graph.warnings })
	}
}

function isSecretProviderEntry(manifest: PackageManifest, entry: GraphEntry & { kind: 'package' }) {
	if (!manifest.secretProvider) return false
	try {
		const path = entry.entryPath
			? normalizeModulePath(entry.entryPath)
			: resolvePackageExport(manifest, entry.exportName ?? '.')
		return path === manifest.secretProvider.entry
	} catch {
		return false
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
