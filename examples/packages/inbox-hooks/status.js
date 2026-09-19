import { recent } from './lib/record.js'

export default async function status({ limit = 20 } = {}) {
	const rows = await recent(limit)
	return {
		deliveries: rows.filter((row) => row.kind.startsWith('webhook:')).length,
		emails: rows.filter((row) => row.kind === 'email').length,
		recent: rows,
	}
}
