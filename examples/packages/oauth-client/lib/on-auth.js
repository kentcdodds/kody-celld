import { record } from './record.js'

// Subscription handler for integration.auth.succeeded / integration.auth.failed:
// { topic, integration: { name, provider, status, expiresAt, ... }, source, reason? }.
// The payload is metadata only; no token ever reaches package code.
export default async function onAuth({ topic, integration, source, reason }) {
	await record(topic, { name: integration.name, status: integration.status, source, reason: reason ?? null })
	return { recorded: integration.name }
}
