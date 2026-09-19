// Default export: unauthenticated vault health check.
export default async function status({ baseUrl }) {
	const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/health`)
	return { ok: response.ok }
}
