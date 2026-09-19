import type { EmailAddress, EmailMessageRecord } from '../cells/user-cell.ts'
import { describeEmailConfig } from '../email/config.ts'
import { attachmentFromInput, isEmailAddress, maxAttachments, toAddressInput } from '../email/message.ts'
import type { OutboundAttachment } from '../email/outbound.ts'
import { loadEmailConfig, requireEmailConfig, sendUserEmail } from '../email/service.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const emailDomain = defineDomain({
	name: 'email',
	description:
		'Per-user email inboxes on the deployment domain (<name>@<KODY_EMAIL_DOMAIN>, plus-addressing supported), stored inbound messages with sender rules and quarantine, verified outbound destinations, sending and replying through the configured provider, and delivery events. Packages subscribe to email.message.received / .quarantined / .delivery.updated in package.json#kody.subscriptions.',
	guide: `Receive: emailInboxClaim({ local }) → give out <local>@<domain> (or <local>+tag@<domain>) → messages appear in emailMessageList; sender rules (emailSenderRuleSet) route mail to inbox or quarantine. Send: recipients must be your account email, one of your inboxes, or a destination verified via emailDestinationAdd + emailDestinationVerify; emailReply answers a stored message without that check. Attachments are fetched separately with emailAttachmentGet. emailStatus shows which adapters the operator enabled.`,
})

function requireDirect(ctx: CapabilityContext, what: string) {
	if (ctx.fromRuntime) {
		throw new KodyError(
			'forbidden_from_runtime',
			`${what} is only available from MCP execute or the API, not from package code.`,
			{ status: 403 },
		)
	}
}

function registry(ctx: CapabilityContext) {
	return ctx.env.REGISTRY.getByName('registry')
}

function addressList(value: unknown, field: string, required = false): Array<EmailAddress> {
	const list = toAddressInput(value)
	if (required && list.length === 0)
		throw new KodyError('invalid_args', `"${field}" needs at least one valid email address.`)
	if (list.length > 50) throw new KodyError('invalid_args', `"${field}" may list at most 50 addresses.`)
	return list
}

function optionalText(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null
	if (typeof value !== 'string') throw new KodyError('invalid_args', `"${field}" must be a string.`)
	return value.length > 0 ? value : null
}

function headersInput(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {}
	if (typeof value !== 'object' || Array.isArray(value))
		throw new KodyError('invalid_args', '"headers" must be an object.')
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v !== 'string') throw new KodyError('invalid_args', `headers.${k} must be a string.`)
		out[k] = v
	}
	return out
}

function attachmentsInput(value: unknown): Array<OutboundAttachment> {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) throw new KodyError('invalid_args', '"attachments" must be an array.')
	if (value.length > maxAttachments) throw new KodyError('invalid_args', `At most ${maxAttachments} attachments.`)
	return value.map((item, index) => {
		if (!item || typeof item !== 'object')
			throw new KodyError('invalid_args', `attachments[${index}] must be an object.`)
		const r = item as Record<string, unknown>
		if (typeof r.contentBase64 !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(r.contentBase64)) {
			throw new KodyError('invalid_args', `attachments[${index}].contentBase64 must be base64.`)
		}
		return attachmentFromInput(
			{
				filename: typeof r.filename === 'string' ? r.filename : null,
				contentType: typeof r.contentType === 'string' ? r.contentType : null,
				contentBase64: r.contentBase64,
				contentId: typeof r.contentId === 'string' ? r.contentId : null,
				disposition: r.disposition === 'inline' ? 'inline' : 'attachment',
			},
			index,
		)
	})
}

function subjectInput(value: unknown) {
	if (typeof value !== 'string' || !value.trim()) throw new KodyError('invalid_args', '"subject" is required.')
	return value
		.replace(/[\r\n]+/g, ' ')
		.trim()
		.slice(0, 998)
}

async function ensureAccountDestination(ctx: CapabilityContext) {
	await ctx.userCell.emailDestinationBegin({ address: ctx.user.email, preVerified: true })
}

function assertInbound(message: EmailMessageRecord | null, id: string): EmailMessageRecord {
	if (!message) throw new KodyError('email_not_found', `Message "${id}" was not found.`, { status: 404 })
	return message
}

// ------------------------------------------------------------------- status

export const emailStatus = defineCapability<Record<string, never>>({
	domain: 'email',
	name: 'emailStatus',
	description:
		'Show whether email is enabled on this deployment, the inbox domain, and which inbound/outbound adapters are configured (no tokens).',
	tags: ['email', 'read', 'system'],
	keywords: ['email status', 'email configured', 'email domain', 'email provider'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const config = loadEmailConfig(ctx.env)
		const inboxes = config ? await registry(ctx).inboxListForUser(ctx.user.id) : []
		return {
			...describeEmailConfig(config),
			inboxes: inboxes.map((inbox) => `${inbox.local}@${config?.domain}`),
			inboundRoute: config ? `${ctx.baseUrl}/email/inbound/<provider>` : null,
			eventsRoute: config ? `${ctx.baseUrl}/email/events/<provider>` : null,
		}
	},
})

// ------------------------------------------------------------------ inboxes

export const emailInboxList = defineCapability<Record<string, never>>({
	domain: 'email',
	name: 'emailInboxList',
	description:
		'List the inbox addresses you own on the deployment domain. Mail to <local>+anything@<domain> lands in the same inbox.',
	tags: ['email', 'read'],
	keywords: ['my email address', 'inbox address', 'list inboxes', 'kody email'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const config = requireEmailConfig(ctx.env)
		const inboxes = await registry(ctx).inboxListForUser(ctx.user.id)
		return {
			domain: config.domain,
			inboxes: inboxes.map((inbox) => ({
				local: inbox.local,
				address: `${inbox.local}@${config.domain}`,
				createdAt: inbox.createdAt,
			})),
		}
	},
})

export const emailInboxClaim = defineCapability<{ local: string }>({
	domain: 'email',
	name: 'emailInboxClaim',
	description:
		'Claim <local>@<domain> as one of your inbox addresses (2-63 chars of a-z 0-9 . _ -). Reserved role names are refused.',
	tags: ['email', 'write'],
	keywords: ['claim inbox', 'create email address', 'new inbox', 'email alias'],
	inputSchema: { type: 'object', properties: { local: { type: 'string' } }, required: ['local'] },
	example: `const { address } = await kody.email.emailInboxClaim({ local: 'kent' })`,
	async handler(args, ctx) {
		requireDirect(ctx, 'emailInboxClaim')
		const config = requireEmailConfig(ctx.env)
		const claimed = await registry(ctx).inboxClaim({ userId: ctx.user.id, local: args.local })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'email.inbox.claim',
			target: claimed.local,
			details: null,
		})
		return { local: claimed.local, address: `${claimed.local}@${config.domain}`, createdAt: claimed.createdAt }
	},
})

export const emailInboxRelease = defineCapability<{ local: string }>({
	domain: 'email',
	name: 'emailInboxRelease',
	description: 'Release an inbox address you own. Stored messages stay; new mail to it is rejected.',
	tags: ['email', 'write'],
	keywords: ['release inbox', 'delete email address', 'remove inbox'],
	inputSchema: { type: 'object', properties: { local: { type: 'string' } }, required: ['local'] },
	async handler(args, ctx) {
		requireDirect(ctx, 'emailInboxRelease')
		requireEmailConfig(ctx.env)
		const result = await registry(ctx).inboxRelease({ userId: ctx.user.id, local: args.local })
		if (result.deleted) {
			await recordAudit(ctx.env, {
				actor: `user:${ctx.user.id}`,
				action: 'email.inbox.release',
				target: args.local,
				details: null,
			})
		}
		return result
	},
})

// ----------------------------------------------------------------- messages

export const emailMessageList = defineCapability<{
	direction?: 'inbound' | 'outbound'
	classification?: 'inbox' | 'quarantine'
	inboxAddress?: string
	limit?: number
}>({
	domain: 'email',
	name: 'emailMessageList',
	description:
		'List stored messages newest first (summaries with a snippet; bodies via emailMessageGet). Filter by direction, inbox|quarantine, or inbox address.',
	tags: ['email', 'read'],
	keywords: ['list email', 'inbox', 'recent emails', 'quarantine', 'sent mail'],
	inputSchema: {
		type: 'object',
		properties: {
			direction: { type: 'string', enum: ['inbound', 'outbound'] },
			classification: { type: 'string', enum: ['inbox', 'quarantine'] },
			inboxAddress: { type: 'string' },
			limit: { type: 'integer', default: 20 },
		},
	},
	readOnly: true,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		return { messages: await ctx.userCell.emailMessageList(args) }
	},
})

export const emailMessageSearch = defineCapability<{
	query: string
	direction?: 'inbound' | 'outbound'
	limit?: number
}>({
	domain: 'email',
	name: 'emailMessageSearch',
	description: 'Substring search over subject, sender, and text body of stored messages.',
	tags: ['email', 'read', 'search'],
	keywords: ['search email', 'find email', 'email from'],
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string' },
			direction: { type: 'string', enum: ['inbound', 'outbound'] },
			limit: { type: 'integer', default: 20 },
		},
		required: ['query'],
	},
	readOnly: true,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		return {
			messages: await ctx.userCell.emailMessageList({
				query: args.query,
				direction: args.direction,
				limit: args.limit,
			}),
		}
	},
})

export const emailMessageGet = defineCapability<{ id: string }>({
	domain: 'email',
	name: 'emailMessageGet',
	description:
		'Get one stored message with text/html bodies, safe headers, and attachment metadata (content via emailAttachmentGet).',
	tags: ['email', 'read'],
	keywords: ['read email', 'email body', 'email details'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	readOnly: true,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		return assertInbound(await ctx.userCell.emailMessageGet(args.id), args.id)
	},
})

export const emailMessageDelete = defineCapability<{ id: string }>({
	domain: 'email',
	name: 'emailMessageDelete',
	description: 'Delete a stored message with its attachments and delivery events.',
	tags: ['email', 'write'],
	keywords: ['delete email', 'remove message'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		return ctx.userCell.emailMessageDelete(args.id)
	},
})

export const emailMessageRelease = defineCapability<{ id: string; allowSender?: boolean }>({
	domain: 'email',
	name: 'emailMessageRelease',
	description:
		'Move a quarantined message to the inbox; optionally add an allow rule for its sender so future mail skips quarantine.',
	tags: ['email', 'write'],
	keywords: ['release quarantine', 'not spam', 'allow sender', 'unquarantine'],
	inputSchema: {
		type: 'object',
		properties: { id: { type: 'string' }, allowSender: { type: 'boolean', default: false } },
		required: ['id'],
	},
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		const released = await ctx.userCell.emailMessageRelease(args.id)
		if (args.allowSender) {
			await ctx.userCell.emailSenderRuleSet({
				kind: 'address',
				value: released.from.address,
				effect: 'allow',
				note: `released ${released.id}`,
			})
		}
		return released
	},
})

export const emailAttachmentGet = defineCapability<{ messageId: string; attachmentId: string }>({
	domain: 'email',
	name: 'emailAttachmentGet',
	description:
		'Fetch one attachment as base64 with its metadata. Large attachments count against the execute response limit; store them with blobPut if needed.',
	tags: ['email', 'read'],
	keywords: ['email attachment', 'download attachment', 'attachment content'],
	inputSchema: {
		type: 'object',
		properties: { messageId: { type: 'string' }, attachmentId: { type: 'string' } },
		required: ['messageId', 'attachmentId'],
	},
	readOnly: true,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		const attachment = await ctx.userCell.emailAttachmentGet(args)
		if (!attachment)
			throw new KodyError('email_attachment_not_found', 'No such attachment on that message.', { status: 404 })
		return attachment
	},
})

export const emailDeliveryEventList = defineCapability<{ id: string }>({
	domain: 'email',
	name: 'emailDeliveryEventList',
	description:
		'Delivery history for an outbound message (accepted, delivered, bounced, complained, ...) as reported by the provider.',
	tags: ['email', 'read'],
	keywords: ['email delivered', 'bounce', 'delivery status', 'email events'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	readOnly: true,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		const message = assertInbound(await ctx.userCell.emailMessageGet(args.id), args.id)
		return {
			id: message.id,
			deliveryStatus: message.deliveryStatus,
			events: await ctx.userCell.emailDeliveryEventList(args.id),
		}
	},
})

// ------------------------------------------------------------- sender rules

export const emailSenderRuleList = defineCapability<Record<string, never>>({
	domain: 'email',
	name: 'emailSenderRuleList',
	description:
		'List sender rules (address or domain → allow | quarantine | block). First match wins; address rules beat domain rules.',
	tags: ['email', 'read'],
	keywords: ['sender rules', 'email filters', 'blocklist', 'allowlist'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		requireEmailConfig(ctx.env)
		return { rules: await ctx.userCell.emailSenderRuleList() }
	},
})

export const emailSenderRuleSet = defineCapability<{
	kind: 'address' | 'domain'
	value: string
	effect: 'allow' | 'quarantine' | 'block'
	note?: string
}>({
	domain: 'email',
	name: 'emailSenderRuleSet',
	description:
		'Create or update a sender rule. Blocked and quarantined mail is still stored (classification=quarantine) so nothing is silently lost.',
	tags: ['email', 'write'],
	keywords: ['block sender', 'allow sender', 'quarantine domain', 'email rule'],
	inputSchema: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: ['address', 'domain'] },
			value: { type: 'string' },
			effect: { type: 'string', enum: ['allow', 'quarantine', 'block'] },
			note: { type: 'string' },
		},
		required: ['kind', 'value', 'effect'],
	},
	example: `await kody.email.emailSenderRuleSet({ kind: 'domain', value: 'newsletters.example', effect: 'quarantine' })`,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		return ctx.userCell.emailSenderRuleSet(args)
	},
})

export const emailSenderRuleDelete = defineCapability<{ id: string }>({
	domain: 'email',
	name: 'emailSenderRuleDelete',
	description: 'Delete a sender rule by id.',
	tags: ['email', 'write'],
	keywords: ['delete email rule', 'remove sender rule'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		return ctx.userCell.emailSenderRuleDelete(args.id)
	},
})

// ------------------------------------------------------------- destinations

export const emailDestinationList = defineCapability<Record<string, never>>({
	domain: 'email',
	name: 'emailDestinationList',
	description:
		'List addresses you may send to. Your account email is always verified; others show pending until emailDestinationVerify succeeds.',
	tags: ['email', 'read'],
	keywords: ['email destinations', 'allowed recipients', 'verified addresses'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		requireEmailConfig(ctx.env)
		await ensureAccountDestination(ctx)
		return { destinations: await ctx.userCell.emailDestinationList() }
	},
})

export const emailDestinationAdd = defineCapability<{ address: string }>({
	domain: 'email',
	name: 'emailDestinationAdd',
	description:
		'Start verifying a new destination: a 6-digit code is emailed to the address from your inbox. Confirm with emailDestinationVerify within 30 minutes.',
	tags: ['email', 'write'],
	keywords: ['add destination', 'verify email address', 'send to new address'],
	inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
	example: `await kody.email.emailDestinationAdd({ address: 'friend@example.com' })`,
	async handler(args, ctx) {
		requireDirect(ctx, 'emailDestinationAdd')
		const config = requireEmailConfig(ctx.env)
		await ensureAccountDestination(ctx)
		const address = args.address.trim().toLowerCase()
		if (!isEmailAddress(address))
			throw new KodyError('invalid_email_address', `"${args.address}" is not a valid email address.`)
		const { destination, code } = await ctx.userCell.emailDestinationBegin({ address })
		if (code === null) return { destination, sent: false }
		await sendUserEmail(ctx.env, ctx.user, ctx.userCell, {
			to: [{ address, name: null }],
			cc: [],
			subject: `${config.fromName}: confirm this address`,
			text: `Your ${config.fromName} verification code is ${code}. It expires in 30 minutes. If you did not request this, ignore this message.`,
			html: null,
			fromLocal: null,
			replyTo: [],
			headers: { 'auto-submitted': 'auto-generated' },
			attachments: [],
			inReplyTo: null,
			packageName: null,
			trustRecipients: true,
		})
		return { destination, sent: true }
	},
})

export const emailDestinationVerify = defineCapability<{ address: string; code: string }>({
	domain: 'email',
	name: 'emailDestinationVerify',
	description: 'Confirm a destination with the code that was emailed to it.',
	tags: ['email', 'write'],
	keywords: ['verify destination', 'confirmation code', 'email code'],
	inputSchema: {
		type: 'object',
		properties: { address: { type: 'string' }, code: { type: 'string' } },
		required: ['address', 'code'],
	},
	async handler(args, ctx) {
		requireDirect(ctx, 'emailDestinationVerify')
		requireEmailConfig(ctx.env)
		const destination = await ctx.userCell.emailDestinationVerify(args)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'email.destination.verify',
			target: destination.address,
			details: null,
		})
		return destination
	},
})

export const emailDestinationSetDefault = defineCapability<{ address: string }>({
	domain: 'email',
	name: 'emailDestinationSetDefault',
	description: 'Make a verified destination the default recipient for emailSend calls that omit "to".',
	tags: ['email', 'write'],
	keywords: ['default destination', 'default recipient'],
	inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		await ensureAccountDestination(ctx)
		return ctx.userCell.emailDestinationSetDefault(args.address)
	},
})

export const emailDestinationRemove = defineCapability<{ address: string }>({
	domain: 'email',
	name: 'emailDestinationRemove',
	description: 'Remove a destination (your account email cannot be removed).',
	tags: ['email', 'write'],
	keywords: ['remove destination', 'delete recipient'],
	inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
	async handler(args, ctx) {
		requireDirect(ctx, 'emailDestinationRemove')
		requireEmailConfig(ctx.env)
		if (args.address.trim().toLowerCase() === ctx.user.email.toLowerCase()) {
			throw new KodyError('invalid_args', 'The account email is always a destination.')
		}
		return ctx.userCell.emailDestinationRemove(args.address)
	},
})

// ------------------------------------------------------------------ sending

type SendArgs = {
	to?: unknown
	cc?: unknown
	subject: string
	text?: unknown
	html?: unknown
	from?: string
	replyTo?: unknown
	headers?: unknown
	attachments?: unknown
}

export const emailSend = defineCapability<SendArgs>({
	domain: 'email',
	name: 'emailSend',
	description:
		'Send an email from one of your inbox addresses. "to" defaults to your default destination; every recipient must be your account email, one of your inboxes, or a verified destination. Attachments are { filename, contentType, contentBase64 }.',
	tags: ['email', 'write', 'send'],
	keywords: ['send email', 'email me', 'notify by email', 'mail'],
	inputSchema: {
		type: 'object',
		properties: {
			to: {
				type: ['string', 'array'],
				description: 'Address string(s) or { address, name } objects. Defaults to your default destination.',
			},
			cc: { type: ['string', 'array'] },
			subject: { type: 'string' },
			text: { type: 'string' },
			html: { type: 'string' },
			from: { type: 'string', description: 'Inbox local part to send from; defaults to your first inbox.' },
			replyTo: { type: ['string', 'array'] },
			headers: {
				type: 'object',
				description: 'Only x-entity-ref-id, x-kody-tag, list-unsubscribe, precedence, auto-submitted are forwarded.',
			},
			attachments: { type: 'array' },
		},
		required: ['subject'],
	},
	example: `await kody.email.emailSend({ subject: 'Build finished', text: 'All green.' })`,
	async handler(args, ctx) {
		requireEmailConfig(ctx.env)
		await ensureAccountDestination(ctx)
		let to = addressList(args.to, 'to')
		if (to.length === 0) {
			const destinations = await ctx.userCell.emailDestinationList()
			const fallback = destinations.find((d) => d.isDefault && d.verified) ?? destinations.find((d) => d.verified)
			if (!fallback) throw new KodyError('invalid_args', '"to" is required (no default destination).')
			to = [{ address: fallback.address, name: null }]
		}
		return sendUserEmail(ctx.env, ctx.user, ctx.userCell, {
			to,
			cc: addressList(args.cc, 'cc'),
			subject: subjectInput(args.subject),
			text: optionalText(args.text, 'text'),
			html: optionalText(args.html, 'html'),
			fromLocal: typeof args.from === 'string' && args.from.trim() ? args.from.trim().toLowerCase() : null,
			replyTo: addressList(args.replyTo, 'replyTo'),
			headers: headersInput(args.headers),
			attachments: attachmentsInput(args.attachments),
			inReplyTo: null,
			packageName: ctx.packageName,
			trustRecipients: false,
		})
	},
})

export const emailReply = defineCapability<{
	id: string
	text?: unknown
	html?: unknown
	subject?: string
	attachments?: unknown
	headers?: unknown
}>({
	domain: 'email',
	name: 'emailReply',
	description:
		'Reply to a stored inbound message. The recipient is the original Reply-To/From (no destination check), threading headers are set, and the reply goes out from the inbox that received it.',
	tags: ['email', 'write', 'send'],
	keywords: ['reply email', 'answer email', 'respond to message'],
	inputSchema: {
		type: 'object',
		properties: {
			id: { type: 'string' },
			text: { type: 'string' },
			html: { type: 'string' },
			subject: { type: 'string', description: 'Defaults to "Re: <original subject>".' },
			attachments: { type: 'array' },
			headers: { type: 'object' },
		},
		required: ['id'],
	},
	example: `await kody.email.emailReply({ id: message.id, text: 'Thanks, got it.' })`,
	async handler(args, ctx) {
		const config = requireEmailConfig(ctx.env)
		const original = assertInbound(await ctx.userCell.emailMessageGet(args.id), args.id)
		if (original.direction !== 'inbound')
			throw new KodyError('invalid_args', 'Only inbound messages can be replied to.')
		const recipient = original.replyTo[0] ?? original.from
		const inboxLocal = original.inboxAddress?.endsWith(`@${config.domain}`)
			? (original.inboxAddress.split('@')[0]?.split('+')[0] ?? null)
			: null
		return sendUserEmail(ctx.env, ctx.user, ctx.userCell, {
			to: [recipient],
			cc: [],
			subject:
				typeof args.subject === 'string' && args.subject.trim()
					? subjectInput(args.subject)
					: /^re:/i.test(original.subject)
						? original.subject
						: `Re: ${original.subject}`,
			text: optionalText(args.text, 'text'),
			html: optionalText(args.html, 'html'),
			fromLocal: inboxLocal,
			replyTo: [],
			headers: headersInput(args.headers),
			attachments: attachmentsInput(args.attachments),
			inReplyTo: original,
			packageName: ctx.packageName,
			trustRecipients: true,
		})
	},
})

export const emailCapabilities = [
	emailStatus,
	emailInboxList,
	emailInboxClaim,
	emailInboxRelease,
	emailMessageList,
	emailMessageSearch,
	emailMessageGet,
	emailMessageDelete,
	emailMessageRelease,
	emailAttachmentGet,
	emailDeliveryEventList,
	emailSenderRuleList,
	emailSenderRuleSet,
	emailSenderRuleDelete,
	emailDestinationList,
	emailDestinationAdd,
	emailDestinationVerify,
	emailDestinationSetDefault,
	emailDestinationRemove,
	emailSend,
	emailReply,
]
