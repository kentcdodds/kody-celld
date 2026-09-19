import type { WebhookRecord } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { executeRun, getUserCell } from '../execute/engine.ts'
import { sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { limitsFromEnv } from '../lib/limits.ts'
import type { WebhookDefinition } from '../packages/manifest.ts'
import { parseSignatureHeader, parseTimestamp, signedMessage, withinTolerance } from './verify.ts'

const IDEMPOTENCY_HEADER = 'idempotency-key'
const MAX_IDEMPOTENCY_KEY = 200

type Admitted = { webhook: WebhookRecord; definition: WebhookDefinition; usedPrevious: boolean }

function json(payload: unknown, status: number, headers: Record<string, string> = {}) {
	return Response.json(payload, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

/** Providers only ever see generic failures; the reason lives in the delivery ledger. */
function rejected(status: number, reason: string, deliveryId: string | null) {
	const body =
		status === 429
			? { error: 'rate_limited', message: 'Too many deliveries for this webhook; retry later.' }
			: status === 413
				? { error: 'payload_too_large', message: 'Webhook body exceeds the configured limit.' }
				: status === 401
					? { error: 'unauthorized', message: 'Webhook signature verification failed.' }
					: status === 409
						? { error: reason, message: 'This delivery conflicts with a previous one.' }
						: status === 400
							? { error: reason, message: 'The webhook request could not be interpreted.' }
							: { error: 'not_found', message: 'No such webhook.' }
	return json(deliveryId ? { ...body, deliveryId } : body, status, status === 429 ? { 'retry-after': '60' } : {})
}

function headersToObject(headers: Headers) {
	const out: Record<string, string> = {}
	for (const [key, value] of headers) {
		if (key === 'authorization' || key === 'cookie') continue
		out[key] = value
	}
	return out
}

function parseJson(body: string): unknown | undefined {
	if (!body.trim()) return undefined
	try {
		return JSON.parse(body) as unknown
	} catch {
		return undefined
	}
}

function redactedUrl(url: URL) {
	const segments = url.pathname.split('/').filter(Boolean)
	segments[3] = '<secret>'
	return `${url.origin}/${segments.join('/')}${url.search}`
}

/**
 * `POST /webhooks/:userId/:handle/:secret` — provider ingress. No bearer
 * token: the opaque URL secret is the credential, optionally backed by an
 * HMAC signature the package declared. Every decision is written to the
 * delivery ledger so `webhookDeliveries` explains what a provider saw.
 */
export async function handleWebhookIngress(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	const segments = url.pathname.split('/').filter(Boolean) // ['webhooks', userId, handle, secret]
	const userId = decodeURIComponent(segments[1] ?? '')
	const handle = decodeURIComponent(segments[2] ?? '')
	const secret = decodeURIComponent(segments[3] ?? '')
	if (segments.length !== 4 || !userId || !handle || !secret) return rejected(404, 'malformed', null)
	if (request.method !== 'POST') {
		return json({ error: 'method_not_allowed', message: 'Webhooks accept POST.' }, 405, { allow: 'POST' })
	}

	const registry = env.REGISTRY.getByName('registry')
	const user = await registry.getUser(userId)
	if (!user) return rejected(404, 'unknown_user', null)
	const userCell = getUserCell(env, user.id)
	await userCell.init(user.id)
	const now = new Date()
	const admission = await userCell.webhookAdmit({ handle, secret, now: now.toISOString() })
	if (!admission.ok) {
		if (admission.reason !== 'unknown_handle') {
			await userCell.webhookDeliveryRecord({
				handle,
				status: 'rejected',
				httpStatus: admission.status,
				reason: admission.reason,
				bodyBytes: 0,
			})
		}
		return rejected(admission.status, admission.reason, null)
	}

	const limits = limitsFromEnv(env)
	const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null
	const declaredLength = Number(request.headers.get('content-length') ?? 0)
	if (declaredLength > limits.webhookMaxBodyBytes) {
		return reject(userCell, admission, 413, 'body_too_large', declaredLength, contentType)
	}
	const body = await request.text()
	const bodyBytes = new TextEncoder().encode(body).byteLength
	if (bodyBytes > limits.webhookMaxBodyBytes) {
		return reject(userCell, admission, 413, 'body_too_large', bodyBytes, contentType)
	}

	const { definition } = admission
	const replay = definition.replay
	const timestampRaw = replay?.timestampHeader ? request.headers.get(replay.timestampHeader) : null
	if (replay?.timestampHeader) {
		const format = replay.timestampFormat ?? 'unix-seconds'
		const timestamp = parseTimestamp(timestampRaw, format)
		if (!timestamp) return reject(userCell, admission, 401, 'timestamp_missing', bodyBytes, contentType)
		if (!withinTolerance(timestamp, now, replay.toleranceSeconds ?? 300)) {
			return reject(userCell, admission, 401, 'timestamp_out_of_window', bodyBytes, contentType)
		}
	}

	if (definition.verification) {
		const verification = definition.verification
		const candidates = parseSignatureHeader(request.headers.get(verification.header), verification)
		if (candidates.length === 0) return reject(userCell, admission, 401, 'signature_missing', bodyBytes, contentType)
		const message = signedMessage(verification, body, timestampRaw, replay?.timestampFormat)
		if (message === null) return reject(userCell, admission, 401, 'timestamp_missing', bodyBytes, contentType)
		const check = await userCell.webhookSignatureCheck({
			packageName: admission.webhook.packageName,
			secretName: verification.secretName,
			message,
			candidates,
			encoding: verification.encoding,
		})
		if (!check.ok) return reject(userCell, admission, 401, 'secret_missing', bodyBytes, contentType)
		if (!check.matches) return reject(userCell, admission, 401, 'signature_mismatch', bodyBytes, contentType)
	}

	const parsed = parseJson(body)
	let params: unknown
	if (definition.inputMode === 'params') {
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return reject(userCell, admission, 400, 'invalid_params', bodyBytes, contentType)
		}
		const record = parsed as Record<string, unknown>
		params =
			typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
				? record.params
				: record
	}

	// Idempotency: the provider's delivery id wins (match by key only); otherwise an
	// explicit Idempotency-Key / params.idempotencyKey must carry the same payload.
	let idempotency: { key: string; payloadHash: string | null } | null = null
	const deliveryIdValue = replay?.deliveryIdHeader ? request.headers.get(replay.deliveryIdHeader) : null
	const explicitKey =
		request.headers.get(IDEMPOTENCY_HEADER) ??
		(definition.inputMode === 'params' && typeof (params as Record<string, unknown>).idempotencyKey === 'string'
			? ((params as Record<string, unknown>).idempotencyKey as string)
			: null)
	if (deliveryIdValue) {
		idempotency = { key: `delivery:${deliveryIdValue.slice(0, MAX_IDEMPOTENCY_KEY)}`, payloadHash: null }
	} else if (explicitKey) {
		if (explicitKey.length > MAX_IDEMPOTENCY_KEY) {
			return reject(userCell, admission, 400, 'idempotency_key_too_long', bodyBytes, contentType)
		}
		idempotency = { key: `client:${explicitKey}`, payloadHash: await sha256Hex(body) }
	}
	if (idempotency) {
		const claim = await userCell.webhookIdempotencyClaim({ handle, ...idempotency })
		if (claim.state === 'conflict') {
			return reject(userCell, admission, 409, 'idempotency_mismatch', bodyBytes, contentType)
		}
		if (claim.state === 'in_progress') {
			await userCell.webhookDeliveryRecord({
				handle,
				status: 'replayed',
				httpStatus: definition.responseMode === 'ack' ? 202 : 409,
				reason: 'in_progress',
				idempotencyKey: idempotency.key,
				bodyBytes,
				contentType,
			})
			return definition.responseMode === 'ack'
				? json({ accepted: true, replayed: true }, 202)
				: reject(userCell, admission, 409, 'invocation_in_progress', bodyBytes, contentType, false)
		}
		if (claim.state === 'replay') {
			await userCell.webhookDeliveryRecord({
				handle,
				status: 'replayed',
				httpStatus: definition.responseMode === 'ack' ? 202 : 200,
				reason: 'replay',
				runId: claim.runId,
				idempotencyKey: idempotency.key,
				bodyBytes,
				contentType,
			})
			if (definition.responseMode === 'ack') return json({ accepted: true, replayed: true, runId: claim.runId }, 202)
			const previous = claim.resultJson !== null ? (JSON.parse(claim.resultJson) as unknown) : undefined
			return json(
				{ ok: claim.status === 'success', replayed: true, runId: claim.runId, result: previous },
				claim.status === 'success' ? 200 : 500,
				{ 'x-kody-replayed': 'true' },
			)
		}
	}

	const deliveryId = await userCell.webhookDeliveryRecord({
		handle,
		status: 'accepted',
		httpStatus: definition.responseMode === 'ack' ? 202 : 200,
		idempotencyKey: idempotency?.key ?? null,
		bodyBytes,
		contentType,
	})

	if (definition.inputMode === 'request') {
		params = {
			webhook: {
				handle,
				name: definition.name,
				packageName: admission.webhook.packageName,
				deliveryId,
				receivedAt: now.toISOString(),
				usedPreviousSecret: admission.usedPrevious,
			},
			request: {
				method: request.method,
				url: redactedUrl(url),
				headers: headersToObject(request.headers),
				body,
				json: parsed ?? null,
			},
		}
	}

	const run = async () => {
		let result
		try {
			result = await executeRun(env, ctx.exports, {
				kind: 'webhook',
				user: { id: user.id, email: user.email },
				entry: { kind: 'package', packageName: admission.webhook.packageName, exportName: definition.export },
				params,
				trigger: 'webhook',
			})
		} catch (error) {
			const kodyError =
				KodyError.fromUnknown(error) ??
				new KodyError('internal_error', error instanceof Error ? error.message : String(error), { status: 500 })
			await userCell.webhookDeliveryFinish({ id: deliveryId, status: 'error', runId: null, reason: kodyError.message })
			if (idempotency) {
				await userCell.webhookIdempotencyFinish({
					handle,
					...idempotency,
					status: 'error',
					runId: null,
					resultJson: null,
				})
			}
			throw kodyError
		}
		await userCell.webhookDeliveryFinish({
			id: deliveryId,
			status: result.ok ? 'success' : 'error',
			runId: result.runId,
			reason: result.ok ? null : (result.error?.message ?? 'error'),
		})
		if (idempotency) {
			await userCell.webhookIdempotencyFinish({
				handle,
				key: idempotency.key,
				status: result.ok ? 'success' : 'error',
				runId: result.runId,
				resultJson: result.ok ? (JSON.stringify(result.result) ?? null) : null,
			})
		}
		return result
	}

	if (definition.responseMode === 'ack') {
		ctx.waitUntil(
			run().catch((error) => {
				console.error('[kody-celld] webhook run failed', handle, error instanceof Error ? error.message : error)
			}),
		)
		return json({ accepted: true, deliveryId }, 202)
	}

	const result = await run()
	return json(
		{
			ok: result.ok,
			deliveryId,
			runId: result.runId,
			...(result.ok ? { result: result.result } : { error: result.error }),
		},
		result.ok ? 200 : 500,
	)
}

async function reject(
	userCell: ReturnType<typeof getUserCell>,
	admission: Admitted,
	status: 400 | 401 | 409 | 413,
	reason: string,
	bodyBytes: number,
	contentType: string | null,
	record = true,
) {
	if (record) {
		await userCell.webhookDeliveryRecord({
			handle: admission.webhook.handle,
			status: 'rejected',
			httpStatus: status,
			reason,
			bodyBytes,
			contentType,
		})
	}
	return rejected(status, reason, null)
}
