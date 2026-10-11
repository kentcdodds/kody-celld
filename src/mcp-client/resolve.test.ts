import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mcpConfigFromEnv } from './policy.ts'
import { assertResolvedHostAllowed } from './resolve.ts'

const resolver = (answers: Record<string, Array<{ type: number; data: string }>>, status = 0) =>
	(async (input: RequestInfo | URL) => {
		const u = new URL(String(input))
		const key = `${u.searchParams.get('name')}/${u.searchParams.get('type')}`
		return Response.json({ Status: status, Answer: answers[key] ?? [] })
	}) as typeof fetch

const config = mcpConfigFromEnv({ KODY_PRIVATE_HOSTS: '172.30.0.0/16,ha.home' })

describe('assertResolvedHostAllowed', () => {
	it('passes public answers and allowlisted private ranges', async () => {
		await assertResolvedHostAllowed(
			new URL('https://mcp.example.com/mcp'),
			config,
			resolver({ 'mcp.example.com/A': [{ type: 1, data: '93.184.216.34' }] }),
		)
		await assertResolvedHostAllowed(
			new URL('https://lan.example.com/mcp'),
			config,
			resolver({ 'lan.example.com/A': [{ type: 1, data: '172.30.1.5' }] }),
		)
	})
	it('refuses a public name that resolves into unlisted private space (rebinding target)', async () => {
		await assert.rejects(
			assertResolvedHostAllowed(
				new URL('https://evil.example.com/mcp'),
				config,
				resolver({
					'evil.example.com/A': [
						{ type: 1, data: '93.184.216.34' },
						{ type: 1, data: '10.0.0.5' },
					],
				}),
			),
			/10\.0\.0\.5/,
		)
		await assert.rejects(
			assertResolvedHostAllowed(
				new URL('https://v6.example.com/mcp'),
				config,
				resolver({ 'v6.example.com/AAAA': [{ type: 28, data: 'fd00::1' }] }),
			),
			/fd00::1/,
		)
	})
	it('refuses answers in private IPv6 forms the name check misses', async () => {
		for (const address of ['::ffff:0:a00:1', '64:ff9b::a00:1', '::a00:1', 'fe90::1', '0:0:0:0:0:0:0:1']) {
			await assert.rejects(
				assertResolvedHostAllowed(
					new URL('https://v6.example.com/mcp'),
					config,
					resolver({ 'v6.example.com/AAAA': [{ type: 28, data: address }] }),
				),
				(error: Error) => error.message.includes(address),
				address,
			)
		}
		await assertResolvedHostAllowed(
			new URL('https://pub.example.com/mcp'),
			config,
			resolver({ 'pub.example.com/AAAA': [{ type: 28, data: '2606:4700::1111' }] }),
		)
	})
	it('skips IP literals and names trusted by name; refuses unresolvable names', async () => {
		const failing = (async () => {
			throw new Error('resolver must not be called')
		}) as typeof fetch
		await assertResolvedHostAllowed(new URL('http://172.30.1.5/mcp'), config, failing)
		await assertResolvedHostAllowed(new URL('http://ha.home/mcp'), config, failing)
		await assert.rejects(
			assertResolvedHostAllowed(new URL('https://nx.example.com/mcp'), config, resolver({}, 3)),
			/could not resolve/i,
		)
		await assert.rejects(
			assertResolvedHostAllowed(new URL('https://down.example.com/mcp'), config, failing),
			/could not resolve/i,
		)
	})
})

describe('per-call DoH memo (#47)', () => {
	const counting = (answers: Record<string, Array<{ type: number; data: string }>>, failFirst = 0) => {
		const calls: Array<string> = []
		let failures = failFirst
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const u = new URL(String(input))
			calls.push(`${u.searchParams.get('name')}/${u.searchParams.get('type')}`)
			if (failures > 0) {
				failures--
				return new Response('down', { status: 503 })
			}
			return Response.json({
				Status: 0,
				Answer: answers[`${u.searchParams.get('name')}/${u.searchParams.get('type')}`] ?? [],
			})
		}) as typeof fetch
		return { calls, fetchImpl }
	}

	it('one A and one AAAA lookup per host for every hop sharing a memo; none shared across memos', async () => {
		const { calls, fetchImpl } = counting({ 'mcp.example.com/A': [{ type: 1, data: '93.184.216.34' }] })
		const memo = new Map()
		const url = new URL('https://mcp.example.com/mcp')
		await Promise.all([
			assertResolvedHostAllowed(url, config, fetchImpl, memo),
			assertResolvedHostAllowed(url, config, fetchImpl, memo),
		])
		await assertResolvedHostAllowed(url, config, fetchImpl, memo)
		assert.deepEqual(calls.sort(), ['mcp.example.com/A', 'mcp.example.com/AAAA'])
		await assertResolvedHostAllowed(url, config, fetchImpl, new Map())
		assert.equal(calls.length, 4, 'a new memo (a new call) resolves again')
	})

	it('a failed lookup is not cached', async () => {
		const { calls, fetchImpl } = counting({ 'mcp.example.com/A': [{ type: 1, data: '93.184.216.34' }] }, 2)
		const memo = new Map()
		const url = new URL('https://mcp.example.com/mcp')
		await assert.rejects(assertResolvedHostAllowed(url, config, fetchImpl, memo), /Could not resolve/)
		await assertResolvedHostAllowed(url, config, fetchImpl, memo)
		assert.equal(calls.length, 4)
	})

	it('a cached private answer is still refused on every hop', async () => {
		const { calls, fetchImpl } = counting({ 'evil.example.com/A': [{ type: 1, data: '10.0.0.5' }] })
		const memo = new Map()
		const url = new URL('https://evil.example.com/mcp')
		await assert.rejects(assertResolvedHostAllowed(url, config, fetchImpl, memo), /10\.0\.0\.5/)
		await assert.rejects(assertResolvedHostAllowed(url, config, fetchImpl, memo), /10\.0\.0\.5/)
		assert.equal(calls.length, 2)
	})

	it('an empty answer is not cached either', async () => {
		const { calls, fetchImpl } = counting({})
		const memo = new Map()
		const url = new URL('https://empty.example.com/mcp')
		await assert.rejects(assertResolvedHostAllowed(url, config, fetchImpl, memo), /no A\/AAAA records/)
		await assert.rejects(assertResolvedHostAllowed(url, config, fetchImpl, memo), /no A\/AAAA records/)
		assert.equal(calls.length, 4)
	})
})
