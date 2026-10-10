import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mcpSearchItems } from './search-items.ts'
import type { McpServerRecord } from './store.ts'

const server = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
	id: 'mcp_1',
	name: 'home',
	url: 'http://172.30.1.108:8123/mcp',
	enabled: true,
	usage: { mode: 'any' },
	auth: { kind: 'bearer' },
	status: 'ready',
	oauth: null,
	lastError: null,
	serverInfo: {
		name: 'Home Assistant',
		version: '1',
		protocolVersion: null,
		instructions: 'Control lights and climate.',
	},
	tools: [
		{
			name: 'HassTurnOn',
			description: 'Turn on a device',
			inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
		},
	],
	toolsRefreshedAt: 'now',
	createdAt: 'now',
	updatedAt: 'now',
	...over,
})

describe('mcpSearchItems', () => {
	it('emits a server entity and one capability per tool with the exact accessor', () => {
		const items = mcpSearchItems([server()], null)
		assert.deepEqual(
			items.map((i) => i.id),
			['mcp-server:home', 'mcp:home:HassTurnOn'],
		)
		const tool = items[1]!
		assert.equal(tool.entity, 'capability')
		assert.equal(tool.domain, 'mcp:home')
		assert.equal(tool.detail.accessor, 'kody.mcp["home"]["HassTurnOn"](input)')
		assert.match(tool.text, /name/)
		assert.match(items[0]!.text, /lights/)
	})
	it('hides disabled servers and servers locked away from the caller', () => {
		assert.equal(mcpSearchItems([server({ enabled: false })], null).length, 0)
		const locked = server({ usage: { mode: 'packages', packages: ['@me/lights'] } })
		assert.equal(mcpSearchItems([locked], null).length, 0)
		assert.equal(mcpSearchItems([locked], '@me/lights').length, 2)
	})
	it('lists an error server as an entity only, with its last error', () => {
		const items = mcpSearchItems(
			[server({ status: 'error', lastError: { phase: 'connect', message: 'HTTP 401', at: 'now' } })],
			null,
		)
		assert.equal(items.length, 1)
		assert.deepEqual(items[0]!.detail.lastError, { phase: 'connect', message: 'HTTP 401', at: 'now' })
	})
})
