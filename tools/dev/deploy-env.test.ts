// Regression: Docker deployments and CI only see the KODY_* vars that the
// compose files forward and the entrypoint's tunable_vars() regex passes on.
// The external MCP server vars must reach every deployment shape.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

function read(relative: string): string {
	return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
}

const mcpVars = [
	'KODY_MCP_ALLOW_PRIVATE_HOSTS',
	'KODY_MCP_CALL_TIMEOUT_MS',
	'KODY_DNS_RESOLVER_URL',
	'KODY_QUOTA_MCP_SERVERS',
] as const

function tunableRegex(): RegExp {
	const entrypoint = read('docker/entrypoint.sh')
	const match = /grep -E '(\^KODY_[^']+)'/.exec(entrypoint)
	assert.ok(match, 'tunable_vars() grep pattern not found in docker/entrypoint.sh')
	return new RegExp(match[1]!)
}

describe('deployment env forwarding (external MCP servers)', () => {
	for (const file of ['compose.yaml', 'compose.fleet.yaml']) {
		it(`${file} forwards the MCP server vars`, () => {
			const body = read(file)
			for (const name of mcpVars) {
				assert.ok(body.includes(`${name}: \${${name}:-}`), `${file} must forward ${name}`)
			}
		})
	}

	it('docker/entrypoint.sh tunable_vars() passes the MCP server vars on', () => {
		const regex = tunableRegex()
		for (const name of mcpVars) assert.match(name, regex)
	})

	for (const file of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
		it(`${file} allowlists the smoke MCP mock host`, () => {
			assert.match(read(file), /KODY_MCP_ALLOW_PRIVATE_HOSTS: 127\.0\.0\.1,localhost,host\.docker\.internal/)
		})
	}
})
