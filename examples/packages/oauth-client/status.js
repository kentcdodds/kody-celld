import { recent } from './lib/record.js'

export default async function status({ limit = 20 } = {}) {
	return { events: await recent(limit) }
}
