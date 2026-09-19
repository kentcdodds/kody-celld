import type { EmailAddress, EmailMessageRecord, UserCell } from '../cells/user-cell.ts'
import type { UserRecord } from '../cells/registry-cell.ts'
import type { Env } from '../env.ts'
import { executeRun, getUserCell } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { limitsFromEnv } from '../lib/limits.ts'
import type { SubscriptionTopic } from '../packages/manifest.ts'
import { emailConfigFromEnv, type EmailConfig } from './config.ts'
import { isOutboundProvider, normalizeDeliveryEvents, type DeliveryEvent } from './events.ts'
import {
	isInboundProvider,
	normalizeInbound,
	readInboundPayload,
	verifyMailgunSignature,
	type InboundEmail,
} from './inbound.ts'
import { snippetOf, splitInboxAddress } from './message.ts'
import { sendOutbound, type OutboundAttachment, type OutboundMessage } from './outbound.ts'

type Exports = ExecutionContext['exports']

function json(payload: unknown, status: number, headers: Record<string, string> = {}) {
	return Response.json(payload, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

export function loadEmailConfig(env: Env): EmailConfig {
	try {
		return emailConfigFromEnv(env)
	} catch (error) {
		throw new KodyError('email_misconfigured', error instanceof Error ? error.message : String(error), { status: 500 })
	}
}

export function requireEmailConfig(env: Env): NonNullable<EmailConfig> {
	const config = loadEmailConfig(env)
	if (!config) {
		throw new KodyError(
			'email_not_configured',
			'Email is not enabled on this deployment: set KODY_EMAIL_DOMAIN (and an inbound/outbound adapter). See docs/email.md.',
			{ status: 501 },
		)
	}
	return config
}

/**
 * Inbound/event adapters authenticate with the deployment-wide
 * KODY_EMAIL_INBOUND_TOKEN, presented however the provider allows: bearer
 * header, HTTP basic password (Postmark), or `?token=` (Mailgun/SendGrid URLs).
 */
export function inboundAuthorized(request: Request, url: URL, config: NonNullable<EmailConfig>) {
	const expected = config.inboundToken
	if (!expected) return false
	const candidates: Array<string> = []
	const auth = request.headers.get('authorization') ?? ''
	if (/^bearer /i.test(auth)) candidates.push(auth.slice(7).trim())
	if (/^basic /i.test(auth)) {
		try {
			const decoded = atob(auth.slice(6).trim())
			const colon = decoded.indexOf(':')
			candidates.push(colon === -1 ? decoded : decoded.slice(colon + 1))
		} catch {
			// not base64
		}
	}
	const query = url.searchParams.get('token')
	if (query) candidates.push(query)
	const header = request.headers.get('x-kody-email-token')
	if (header) candidates.push(header)
	return candidates.some((candidate) => constantTimeEqual(candidate, expected))
}

export type InboundOutcome = {
	accepted: Array<{ userId: string; inboxAddress: string; messageId: string; classification: 'inbox' | 'quarantine' }>
	rejected: Array<{ address: string; reason: string }>
}

/** `POST /email/inbound/:provider` — provider or forwarder delivers one message. */
export async function handleEmailInbound(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	const segments = url.pathname.split('/').filter(Boolean) // ['email', 'inbound', provider]
	const provider = segments[2] ?? ''
	if (segments.length !== 3 || !isInboundProvider(provider)) {
		return json({ error: 'not_found', message: 'Unknown inbound email adapter.' }, 404)
	}
	if (request.method !== 'POST') {
		return json({ error: 'method_not_allowed', message: 'Inbound email accepts POST.' }, 405, { allow: 'POST' })
	}
	const config = loadEmailConfig(env)
	if (!config) return json({ error: 'email_not_configured', message: 'KODY_EMAIL_DOMAIN is not set.' }, 501)
	if (!inboundAuthorized(request, url, config)) {
		return json({ error: 'unauthorized', message: 'Missing or invalid inbound email token.' }, 401)
	}
	const limits = limitsFromEnv(env)
	const payload = await readInboundPayload(request, limits.emailMaxBytes * 2)
	if (provider === 'mailgun' && config.mailgunSigningKey) {
		if (payload.kind !== 'form' || !(await verifyMailgunSignature(payload.fields, config.mailgunSigningKey))) {
			return json({ error: 'unauthorized', message: 'Mailgun signature verification failed.' }, 401)
		}
	}
	const inbound = await normalizeInbound(provider, payload)
	const outcome = await deliverInbound(env, ctx, config, inbound)
	if (outcome.accepted.length === 0) {
		const reasons = new Set(outcome.rejected.map((r) => r.reason))
		const status = reasons.has('quota_exceeded')
			? 429
			: reasons.has('too_large')
				? 413
				: reasons.has('duplicate')
					? 200
					: 404
		return json({ error: status === 200 ? 'duplicate' : 'not_accepted', ...outcome }, status)
	}
	return json(outcome, 200)
}

/**
 * Routes one normalized message to every recipient inbox on our domain,
 * classifies it per user, stores it, and fans out to package subscriptions.
 */
export async function deliverInbound(
	env: Env,
	ctx: ExecutionContext,
	config: NonNullable<EmailConfig>,
	inbound: InboundEmail,
): Promise<InboundOutcome> {
	const registry = env.REGISTRY.getByName('registry')
	const limits = limitsFromEnv(env)
	const outcome: InboundOutcome = { accepted: [], rejected: [] }
	const seenUsers = new Set<string>()
	for (const address of inbound.recipients) {
		const split = splitInboxAddress(address, config.domain)
		if (!split) {
			outcome.rejected.push({ address, reason: 'foreign_domain' })
			continue
		}
		const user = await registry.inboxResolve(split.local)
		if (!user) {
			outcome.rejected.push({ address, reason: 'no_inbox' })
			continue
		}
		if (seenUsers.has(user.id)) continue
		seenUsers.add(user.id)
		const userCell = getUserCell(env, user.id)
		await userCell.init(user.id)
		const { classification, reason } = await userCell.emailClassify(inbound.message.from.address)
		let stored: EmailMessageRecord
		try {
			stored = await userCell.emailMessageStore({
				direction: 'inbound',
				inboxAddress: address.toLowerCase(),
				from: inbound.message.from,
				to: inbound.message.to,
				cc: inbound.message.cc,
				replyTo: inbound.message.replyTo,
				subject: inbound.message.subject,
				messageId: inbound.message.messageId,
				inReplyTo: inbound.message.inReplyTo,
				references: inbound.message.references,
				text: inbound.message.text,
				html: inbound.message.html,
				headers: {
					...inbound.message.headers,
					...(inbound.envelopeFrom ? { 'return-path': inbound.envelopeFrom } : {}),
					...(split.tag ? { 'x-kody-plus-tag': split.tag } : {}),
				},
				attachments: inbound.message.attachments,
				classification,
				classificationReason: reason,
				provider: inbound.provider,
				providerMessageId: inbound.providerMessageId ?? inbound.message.messageId,
				receivedAt: inbound.message.date ? safeIso(inbound.message.date) : undefined,
				maxBytes: limits.emailMaxBytes,
			})
		} catch (error) {
			const kodyError = KodyError.fromUnknown(error)
			const code = kodyError?.code ?? 'store_failed'
			outcome.rejected.push({
				address,
				reason:
					code === 'email_duplicate'
						? 'duplicate'
						: code === 'email_too_large'
							? 'too_large'
							: code === 'quota_exceeded'
								? 'quota_exceeded'
								: code,
			})
			continue
		}
		outcome.accepted.push({
			userId: user.id,
			inboxAddress: stored.inboxAddress ?? address,
			messageId: stored.id,
			classification,
		})
		ctx.waitUntil(
			dispatchEmailTopic(
				env,
				ctx.exports,
				user,
				classification === 'inbox' ? 'email.message.received' : 'email.message.quarantined',
				{ message: subscriptionMessage(stored) },
			),
		)
	}
	return outcome
}

function safeIso(value: string) {
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

/** What subscription handlers receive: metadata + bodies, never attachment bytes (fetch via emailAttachmentGet). */
export function subscriptionMessage(record: EmailMessageRecord) {
	return { ...record, snippet: snippetOf(record.text, record.html) }
}

/** Runs every package handler subscribed to `topic` for this user; failures land in run history, not here. */
export async function dispatchEmailTopic(
	env: Env,
	exports: Exports,
	user: UserRecord,
	topic: SubscriptionTopic,
	payload: Record<string, unknown>,
) {
	const userCell = getUserCell(env, user.id)
	const subscriptions = await userCell.subscriptionList({ topic })
	await Promise.all(
		subscriptions.map(async (subscription) => {
			try {
				await executeRun(env, exports, {
					kind: 'subscription',
					user: { id: user.id, email: user.email },
					entry: { kind: 'package', packageName: subscription.packageName, entryPath: subscription.handler },
					params: { topic, packageName: subscription.packageName, ...payload },
					trigger: `subscription:${topic}`,
				})
			} catch (error) {
				console.error(`subscription ${subscription.packageName} (${topic}) failed:`, error)
			}
		}),
	)
}

/** `POST /email/events/:provider` — outbound delivery status webhooks. */
export async function handleEmailEvents(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	const segments = url.pathname.split('/').filter(Boolean) // ['email', 'events', provider]
	const provider = segments[2] ?? ''
	if (segments.length !== 3 || !isOutboundProvider(provider)) {
		return json({ error: 'not_found', message: 'Unknown email events adapter.' }, 404)
	}
	if (request.method !== 'POST') {
		return json({ error: 'method_not_allowed', message: 'Email events accept POST.' }, 405, { allow: 'POST' })
	}
	const config = loadEmailConfig(env)
	if (!config) return json({ error: 'email_not_configured', message: 'KODY_EMAIL_DOMAIN is not set.' }, 501)
	if (!inboundAuthorized(request, url, config)) {
		return json({ error: 'unauthorized', message: 'Missing or invalid inbound email token.' }, 401)
	}
	const payload = await readInboundPayload(request, 1_048_576)
	let body: unknown
	if (payload.kind === 'json') body = payload.body
	else if (payload.kind === 'form') body = Object.fromEntries(payload.fields)
	else {
		try {
			body = JSON.parse(new TextDecoder().decode(payload.bytes))
		} catch {
			return json({ error: 'invalid_email_payload', message: 'Events must be JSON.' }, 400)
		}
	}
	const events = normalizeDeliveryEvents(provider, body)
	const applied = await applyDeliveryEvents(env, ctx, provider, events)
	return json({ received: events.length, ...applied }, 200)
}

export async function applyDeliveryEvents(
	env: Env,
	ctx: ExecutionContext,
	provider: string,
	events: Array<DeliveryEvent>,
) {
	const registry = env.REGISTRY.getByName('registry')
	let matched = 0
	const unmatched: Array<string> = []
	for (const event of events) {
		const owner = await registry.outboundEmailIndexResolve({ provider, providerMessageId: event.providerMessageId })
		if (!owner) {
			unmatched.push(event.providerMessageId)
			continue
		}
		const user = await registry.getUser(owner.userId)
		if (!user) continue
		const userCell = getUserCell(env, user.id)
		const updated = await userCell.emailMessageSetDelivery({
			id: owner.messageId,
			provider,
			status: event.status,
			event: event.event,
			detail: event.detail,
			at: event.at ?? undefined,
		})
		if (!updated) continue
		matched++
		ctx.waitUntil(
			dispatchEmailTopic(env, ctx.exports, user, 'email.message.delivery.updated', {
				message: subscriptionMessage(updated),
				delivery: { event: event.event, status: event.status, detail: event.detail, at: event.at },
			}),
		)
	}
	return { matched, unmatched }
}

// ------------------------------------------------------------------ outbound

export type SendInput = {
	to: Array<EmailAddress>
	cc: Array<EmailAddress>
	subject: string
	text: string | null
	html: string | null
	fromLocal: string | null
	replyTo: Array<EmailAddress>
	headers: Record<string, string>
	attachments: Array<OutboundAttachment>
	inReplyTo: EmailMessageRecord | null
	packageName: string | null
	/** Skip the verified-destination check (used for replies: the recipient comes from the stored message). */
	trustRecipients: boolean
}

/**
 * Sends on behalf of a user from one of their claimed inbox addresses. Non-reply
 * recipients must be verified destinations so a package can never turn a user's
 * inbox into a relay.
 */
export async function sendUserEmail(
	env: Env,
	user: { id: string; email: string },
	userCell: DurableObjectStub<UserCell>,
	input: SendInput,
): Promise<EmailMessageRecord> {
	const config = requireEmailConfig(env)
	if (!config.outbound) {
		throw new KodyError(
			'email_outbound_not_configured',
			'No outbound email adapter: set KODY_EMAIL_OUTBOUND_PROVIDER (bridge, resend, postmark, mailgun, sendgrid).',
			{ status: 501 },
		)
	}
	const registry = env.REGISTRY.getByName('registry')
	const locals = await registry.inboxListForUser(user.id)
	if (locals.length === 0) {
		throw new KodyError('email_no_inbox', 'Claim an inbox address first (emailInboxClaim) to send email.', {
			status: 409,
		})
	}
	const local = input.fromLocal ?? locals[0]!.local
	if (!locals.some((l) => l.local === local)) {
		throw new KodyError('email_inbox_not_owned', `"${local}@${config.domain}" is not one of your inbox addresses.`, {
			status: 403,
		})
	}
	if (input.to.length === 0) throw new KodyError('invalid_args', 'At least one recipient is required.')
	if (input.text === null && input.html === null) throw new KodyError('invalid_args', 'Provide text and/or html.')
	if (!input.trustRecipients) {
		for (const recipient of [...input.to, ...input.cc]) {
			const ok =
				recipient.address === user.email.toLowerCase() ||
				splitInboxAddress(recipient.address, config.domain) !== null ||
				(await userCell.emailDestinationIsVerified(recipient.address))
			if (!ok) {
				throw new KodyError(
					'email_destination_unverified',
					`"${recipient.address}" is not a verified destination. Add it with emailDestinationAdd and confirm the code with emailDestinationVerify.`,
					{ status: 403 },
				)
			}
		}
	}
	const limits = limitsFromEnv(env)
	const from: EmailAddress = { address: `${local}@${config.domain}`, name: config.fromName }
	const outbound: OutboundMessage = {
		from,
		to: input.to,
		cc: input.cc,
		replyTo: input.replyTo,
		subject: input.subject,
		text: input.text,
		html: input.html,
		headers: input.headers,
		inReplyTo: input.inReplyTo?.messageId ?? null,
		references: input.inReplyTo
			? [...input.inReplyTo.references, ...(input.inReplyTo.messageId ? [input.inReplyTo.messageId] : [])]
			: [],
		attachments: input.attachments,
	}
	const stored = await userCell.emailMessageStore({
		direction: 'outbound',
		inboxAddress: from.address,
		from,
		to: outbound.to,
		cc: outbound.cc,
		replyTo: outbound.replyTo,
		subject: outbound.subject,
		inReplyTo: outbound.inReplyTo,
		references: outbound.references,
		text: outbound.text,
		html: outbound.html,
		headers: outbound.headers,
		attachments: outbound.attachments,
		provider: config.outbound.provider,
		deliveryStatus: 'sending',
		packageName: input.packageName,
		inReplyToMessageId: input.inReplyTo?.id ?? null,
		maxBytes: limits.emailMaxBytes,
	})
	try {
		const result = await sendOutbound(config.outbound, outbound)
		if (result.providerMessageId) {
			await registry.outboundEmailIndexSet({
				provider: config.outbound.provider,
				providerMessageId: result.providerMessageId,
				userId: user.id,
				messageId: stored.id,
			})
		}
		const updated = await userCell.emailMessageSetDelivery({
			id: stored.id,
			provider: config.outbound.provider,
			providerMessageId: result.providerMessageId ?? undefined,
			status: result.status,
			event: 'accepted',
			detail: null,
		})
		await recordAudit(env, {
			actor: `user:${user.id}`,
			action: 'email.send',
			target: stored.id,
			details: {
				provider: config.outbound.provider,
				recipients: outbound.to.length + outbound.cc.length,
				packageName: input.packageName,
			},
		})
		return updated ?? stored
	} catch (error) {
		const kodyError =
			KodyError.fromUnknown(error) ??
			new KodyError('email_provider_error', error instanceof Error ? error.message : String(error), { status: 502 })
		await userCell.emailMessageSetDelivery({
			id: stored.id,
			provider: config.outbound.provider,
			status: 'failed',
			event: 'send_failed',
			detail: kodyError.message.slice(0, 500),
		})
		throw kodyError
	}
}
