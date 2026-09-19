// MCP transport + search + execute smoke.
import { assert, log } from './lib.mjs'

export async function smokeMcp({ mcp }) {
	const init = await mcp.initialize()
	assert(init.serverInfo?.name === 'kody-celld', 'unexpected serverInfo', init)
	log('initialize', { protocolVersion: init.protocolVersion, server: init.serverInfo.name })

	const tools = await mcp.rpc('tools/list')
	const names = tools.tools.map((tool) => tool.name).sort()
	assert(names.join(',') === 'execute,search', 'expected exactly the compact search+execute tool surface', names)
	log('tools/list', names)

	const everything = await mcp.search({})
	assert(everything.total > 10, 'empty search should list the whole catalog', everything.total)
	const secretHit = await mcp.search({ query: 'approve a host for a secret', limit: 3 })
	assert(
		secretHit.results.some(
			(hit) => hit.id === 'secretHostList' || hit.id === 'guide:secrets' || hit.domain === 'secrets',
		),
		'search should surface the secrets domain',
		secretHit.results.map((hit) => hit.id),
	)
	const onlyPackages = await mcp.search({ entity: 'capability', domain: 'packages' })
	assert(
		onlyPackages.results.every((hit) => hit.entity === 'capability' && hit.domain === 'packages'),
		'entity/domain filters should apply',
	)
	log('search', { total: everything.total, top: secretHit.results.map((hit) => hit.id) })

	const result = await mcp.run(
		`import { kody } from 'kody:runtime'
export default async function main({ a, b }) {
  console.log('adding', a, b)
  const me = await kody.whoami()
  return { sum: a + b, user: me.user.id, runtime: me.runtime }
}`,
		{ a: 40, b: 2 },
	)
	assert(result.sum === 42 && result.runtime === 'kody-celld', 'execute result mismatch', result)
	log('execute', result)

	const failing = await mcp.execute(`export default async function main() { throw new TypeError('boom') }`)
	assert(
		!failing.ok && failing.error?.name === 'TypeError' && failing.error.message === 'boom',
		'errors should be structured',
		failing,
	)
	log('execute error surfaced', failing.error)

	const invalid = await mcp.execute(`this is not javascript`)
	assert(!invalid.ok, 'syntax errors should be reported, not crash the server', invalid)
	log('syntax error surfaced', invalid.error?.name)

	const key = `smoke-${Date.now()}`
	const first = await mcp.execute(
		`export default async function main() { return { at: Math.random() } }`,
		{},
		{ idempotencyKey: key },
	)
	const second = await mcp.execute(
		`export default async function main() { return { at: Math.random() } }`,
		{},
		{ idempotencyKey: key },
	)
	assert(
		first.ok && second.ok && second.replayed && first.result.at === second.result.at,
		'idempotency replay failed',
		{
			first,
			second,
		},
	)
	log('idempotency replay', { runId: first.runId, replayed: second.replayed })

	const big = await mcp.execute(
		`export default async function main() { return 'x'.repeat(5000) }`,
		{},
		{ responseLimit: 1000 },
	)
	assert(big.ok && big.truncated === true, 'responseLimit should truncate oversized results', {
		truncated: big.truncated,
	})
	log('responseLimit truncation', big.note)

	const runs = await mcp.call('runList', { limit: 5 })
	assert(runs.runs.length >= 5, 'run history should be recorded', runs)
	const detail = await mcp.call('runGet', { id: first.runId })
	assert(
		detail.status === 'success' && detail.result.at === first.result.at,
		'runGet should return the persisted result',
		detail,
	)
	log('run history', { recorded: runs.runs.length })
}
