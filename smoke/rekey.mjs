// Master-key rotation smoke. It spans node restarts, so it runs in phases:
//
//   node smoke/rekey.mjs seal     # node running with key A: save a secret, prove injection
//   # restart the node with KODY_MASTER_KEY=<B> KODY_MASTER_KEY_PREVIOUS=<A>
//   node smoke/rekey.mjs rotate   # old rows still inject; POST /admin/secrets/rekey; inject again
//   # restart the node with KODY_MASTER_KEY=<B> only
//   node smoke/rekey.mjs verify   # rows sealed with B inject without A configured
//
// State between phases (user token + expected header hash; never the value)
// lives in .celld/rekey-smoke.json.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { admin, adminToken, assert, baseUrl, bootstrapUser, log, McpClient, sha256, startEchoServer } from './lib.mjs'

const stateFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.celld', 'rekey-smoke.json')
const phase = process.argv[2]

async function loadState() {
	return JSON.parse(await readFile(stateFile, 'utf8'))
}

async function proveInjection(mcp, expectedHeaderHash, label) {
	const echo = await startEchoServer()
	try {
		const result = await mcp.run(
			`export default async function main({ url }) {
  const res = await fetch(url + '/rekey', { headers: { authorization: 'Bearer {{secret:rekey-token}}' } })
  return { status: res.status }
}`,
			{ url: echo.url },
		)
		assert(result.status === 200, `${label}: request should reach the echo server`, result)
		const seen = echo.seen.at(-1)
		assert(seen?.authorizationSha256 === expectedHeaderHash, `${label}: injected value mismatch`, seen)
		log(label, 'secret injected with the expected value')
	} finally {
		await echo.close()
	}
}

async function seal() {
	const { user, token, mcp } = await bootstrapUser('rekey')
	const secretValue = `rekey-${randomBytes(16).toString('hex')}`
	const expectedHeaderHash = sha256(`Bearer ${secretValue}`)
	await mcp.call('secretSave', { name: 'rekey-token', value: secretValue })
	const echoHost = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const approved = await admin.approveHost(user.id, echoHost)
	assert(approved.status === 201, 'host approval failed', approved)
	await proveInjection(mcp, expectedHeaderHash, 'seal')
	await mkdir(path.dirname(stateFile), { recursive: true })
	await writeFile(stateFile, JSON.stringify({ userId: user.id, token, expectedHeaderHash, baseUrl }, null, 2))
	log('seal', `state written to ${path.relative(process.cwd(), stateFile)}; now restart with a rotated key`)
}

async function rotate() {
	const state = await loadState()
	const mcp = new McpClient(state.token)
	await proveInjection(mcp, state.expectedHeaderHash, 'rotate/before (old key via KODY_MASTER_KEY_PREVIOUS)')
	const res = await fetch(`${baseUrl}/admin/secrets/rekey`, {
		method: 'POST',
		headers: { authorization: `Bearer ${adminToken}` },
	})
	const body = await res.json()
	assert(res.status === 200, 'rekey endpoint failed', body)
	const mine = body.users.find((u) => u.userId === state.userId)
	assert(mine && mine.resealed >= 1, 'rekey should have re-sealed this user’s secret', body)
	assert(body.remaining === 0, 'rekey should leave nothing behind', body)
	assert(typeof body.currentKeyId === 'string' && body.currentKeyId.length === 16, 'currentKeyId shape', body)
	log('rotate/rekey', { resealed: body.resealed, remaining: body.remaining, currentKeyId: body.currentKeyId })
	await proveInjection(mcp, state.expectedHeaderHash, 'rotate/after (new key)')
	log('rotate', 'done; now restart with KODY_MASTER_KEY_PREVIOUS removed')
}

async function verify() {
	const state = await loadState()
	await proveInjection(new McpClient(state.token), state.expectedHeaderHash, 'verify (previous key removed)')
	const again = await fetch(`${baseUrl}/admin/secrets/rekey`, {
		method: 'POST',
		headers: { authorization: `Bearer ${adminToken}` },
	}).then((r) => r.json())
	assert(again.remaining === 0 && again.resealed === 0, 'rekey should now be a no-op', again)
	log('verify', 'rotation complete')
}

const phases = { seal, rotate, verify }
if (!phases[phase]) {
	console.error('usage: node smoke/rekey.mjs <seal|rotate|verify>')
	process.exit(2)
}
await phases[phase]()
console.log(`\nREKEY ${phase.toUpperCase()} PASSED`)
