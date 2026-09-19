// Default export: non-secret health check of the Connect server (no door secret involved).
export default async function status({ baseUrl }) {
	const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/heartbeat`)
	return { ok: response.ok, status: response.status }
}
