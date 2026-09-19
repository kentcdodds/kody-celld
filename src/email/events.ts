import { KodyError } from '../lib/errors.ts'
import { outboundProviders, type OutboundProvider } from './config.ts'
import { stripAngle } from './message.ts'

/** Provider-independent delivery update for an outbound message. */
export type DeliveryEvent = {
	providerMessageId: string
	/** Provider's own event name, lower-cased. */
	event: string
	/** Coarse status used for `deliveryStatus`. */
	status: 'queued' | 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'opened' | 'clicked'
	detail: string | null
	at: string | null
}

export function isOutboundProvider(value: string): value is OutboundProvider {
	return (outboundProviders as ReadonlyArray<string>).includes(value)
}

function rec(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function str(value: unknown) {
	return typeof value === 'string' && value ? value : null
}

function isoOrNull(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return new Date(value > 1e12 ? value : value * 1000).toISOString()
	}
	if (typeof value === 'string' && value) {
		const parsed = new Date(value)
		return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
	}
	return null
}

const statusByEvent: Record<string, DeliveryEvent['status']> = {
	queued: 'queued',
	accepted: 'queued',
	processed: 'queued',
	sent: 'sent',
	delivered: 'delivered',
	delivery: 'delivered',
	delayed: 'delayed',
	deferred: 'delayed',
	delivery_delayed: 'delayed',
	bounce: 'bounced',
	bounced: 'bounced',
	dropped: 'failed',
	failed: 'failed',
	rejected: 'failed',
	complained: 'complained',
	spamcomplaint: 'complained',
	spamreport: 'complained',
	complaint: 'complained',
	open: 'opened',
	opened: 'opened',
	click: 'clicked',
	clicked: 'clicked',
}

export function statusFor(event: string): DeliveryEvent['status'] {
	const key = event
		.toLowerCase()
		.replace(/^email\./, '')
		.replace(/[.\s-]/g, '_')
	return statusByEvent[key] ?? statusByEvent[key.replace(/_/g, '')] ?? 'sent'
}

/** Turns one provider webhook body into zero or more delivery events. */
export function normalizeDeliveryEvents(provider: OutboundProvider, body: unknown): Array<DeliveryEvent> {
	switch (provider) {
		case 'bridge': {
			const b = rec(body)
			const id = stripAngle(str(b?.messageId))
			if (!b || !id) throw new KodyError('invalid_email_payload', 'bridge events need { messageId, event }.')
			const event = (str(b.event) ?? 'sent').toLowerCase()
			return [{ providerMessageId: id, event, status: statusFor(event), detail: str(b.detail), at: isoOrNull(b.at) }]
		}
		case 'resend': {
			const b = rec(body)
			const data = rec(b?.data)
			const id = stripAngle(str(data?.email_id))
			const type = str(b?.type)
			if (!id || !type) return []
			const event = type.replace(/^email\./, '').toLowerCase()
			const bounce = rec(data?.bounce)
			return [
				{
					providerMessageId: id,
					event,
					status: statusFor(event),
					detail: str(bounce?.message) ?? str(bounce?.type) ?? null,
					at: isoOrNull(b?.created_at),
				},
			]
		}
		case 'postmark': {
			const b = rec(body)
			const id = stripAngle(str(b?.MessageID))
			const type = str(b?.RecordType)
			if (!id || !type) return []
			const event = type.toLowerCase()
			return [
				{
					providerMessageId: id,
					event,
					status: statusFor(event),
					detail: str(b?.Description) ?? str(b?.Details) ?? str(b?.Type) ?? null,
					at: isoOrNull(b?.DeliveredAt ?? b?.BouncedAt ?? b?.ReceivedAt),
				},
			]
		}
		case 'mailgun': {
			const b = rec(body)
			const data = rec(b?.['event-data'])
			const message = rec(data?.message)
			const headers = rec(message?.headers)
			const id = stripAngle(str(headers?.['message-id']))
			const event = str(data?.event)?.toLowerCase()
			if (!id || !event) return []
			const deliveryStatus = rec(data?.['delivery-status'])
			return [
				{
					providerMessageId: id,
					event,
					status: statusFor(event),
					detail: str(deliveryStatus?.description) ?? str(deliveryStatus?.message) ?? str(data?.reason) ?? null,
					at: isoOrNull(data?.timestamp),
				},
			]
		}
		case 'sendgrid': {
			const items = Array.isArray(body) ? body : body ? [body] : []
			const out: Array<DeliveryEvent> = []
			for (const item of items) {
				const b = rec(item)
				const sgId = str(b?.sg_message_id)
				const event = str(b?.event)?.toLowerCase()
				if (!b || !sgId || !event) continue
				out.push({
					providerMessageId: sgId.split('.')[0] ?? sgId,
					event,
					status: statusFor(event),
					detail: str(b.reason) ?? str(b.response) ?? str(b.type) ?? null,
					at: isoOrNull(b.timestamp),
				})
			}
			return out
		}
	}
}
