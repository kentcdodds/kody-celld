import { packageStorage } from 'kody:runtime'
import { recordEvent } from './lib/events.js'

export default async function increment({ by = 1 } = {}) {
	const storage = packageStorage()
	const count = ((await storage.get('count')) ?? 0) + by
	await storage.set('count', count)
	await recordEvent('increment')
	return { count }
}
