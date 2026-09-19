/** `<base>/webhooks/<userId>/<handle>/<secret>` — the secret is the credential; treat the whole URL as one. */
export function webhookUrl(baseUrl: string, userId: string, handle: string, secret: string) {
	return `${baseUrl.replace(/\/$/, '')}/webhooks/${encodeURIComponent(userId)}/${encodeURIComponent(handle)}/${encodeURIComponent(secret)}`
}
