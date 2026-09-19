import { record } from './lib/record.js'

export default async function stripe({ webhook, request }) {
	const type = request.json?.type ?? 'unknown'
	await record('webhook:stripe', { deliveryId: webhook.deliveryId, type, id: request.json?.id ?? null })
	return { received: true, type }
}
