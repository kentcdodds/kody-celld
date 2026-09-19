import { packageStorage } from 'kody:runtime'
import { recordEvent } from './lib/events.js'

export default async function tick(params = {}) {
	const storage = packageStorage()
	const ticks = ((await storage.get('ticks')) ?? 0) + 1
	await storage.set('ticks', ticks)
	await recordEvent(`tick:${params.trigger ?? 'manual'}`)
	console.log('tick', ticks, params.trigger ?? null)
	return { ticks, trigger: params.trigger ?? null, jobId: params.jobId ?? null }
}
