import { record } from './lib/record.js'

// inputMode "request": receives { webhook, request: { method, url, headers, body, json } }
export default async function github({ webhook, request }) {
	const event = request.headers['x-github-event'] ?? 'unknown'
	await record('webhook:github', {
		deliveryId: webhook.deliveryId,
		event,
		ref: request.json?.ref ?? null,
		bodyLength: request.body.length,
	})
	return { event }
}
