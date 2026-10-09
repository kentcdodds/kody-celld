import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertMcpServerName, assertMcpUrl, mcpConfigFromEnv, normalizeBearerToken } from './policy.ts'

const config = mcpConfigFromEnv({ KODY_MCP_ALLOW_PRIVATE_HOSTS: '172.30.0.0/16,ha.home,*.lab.home' })

describe('mcpConfigFromEnv', () => {
	it('defaults to an empty list and 30 s', () => {
		assert.deepEqual(mcpConfigFromEnv({}), {
			allowPrivateHosts: [],
			callTimeoutMs: 30_000,
			dnsResolverUrl: 'https://cloudflare-dns.com/dns-query',
		})
		assert.equal(
			mcpConfigFromEnv({ KODY_DNS_RESOLVER_URL: 'https://pihole.home/dns-query' }).dnsResolverUrl,
			'https://pihole.home/dns-query',
		)
		assert.throws(
			() => mcpConfigFromEnv({ KODY_DNS_RESOLVER_URL: 'http://1.1.1.1/dns-query' }),
			/KODY_DNS_RESOLVER_URL/,
		)
	})
	it('reports bad values as config_error', () => {
		assert.throws(
			() => mcpConfigFromEnv({ KODY_MCP_ALLOW_PRIVATE_HOSTS: '10.0.0.0/40' }),
			/config_error|KODY_MCP_ALLOW_PRIVATE_HOSTS/,
		)
		assert.throws(() => mcpConfigFromEnv({ KODY_MCP_CALL_TIMEOUT_MS: '10' }), /KODY_MCP_CALL_TIMEOUT_MS/)
	})
})

describe('assertMcpUrl', () => {
	it('allows public https and allowlisted private hosts on any scheme', () => {
		assert.equal(assertMcpUrl('https://mcp.example.com/mcp', config).href, 'https://mcp.example.com/mcp')
		assert.equal(assertMcpUrl('http://172.30.1.108:8123/mcp', config).host, '172.30.1.108:8123')
		assert.equal(assertMcpUrl('http://ha.home/mcp', config).hostname, 'ha.home')
		assert.equal(assertMcpUrl('https://x.lab.home/mcp', config).hostname, 'x.lab.home')
	})
	it('refuses private hosts off the list, plain http to public hosts, credentials and odd schemes', () => {
		assert.throws(
			() => assertMcpUrl('http://192.168.1.1/mcp', config),
			/mcp_host_not_allowed|KODY_MCP_ALLOW_PRIVATE_HOSTS/,
		)
		assert.throws(() => assertMcpUrl('https://localhost/mcp', config), /KODY_MCP_ALLOW_PRIVATE_HOSTS/)
		assert.throws(() => assertMcpUrl('http://mcp.example.com/mcp', config), /https/)
		assert.throws(() => assertMcpUrl('https://u:p@mcp.example.com/mcp', config), /credentials/)
		assert.throws(() => assertMcpUrl('ftp://mcp.example.com/', config), /http/)
		assert.throws(() => assertMcpUrl('not a url', config), /valid URL/)
	})
	it('drops the fragment', () => {
		assert.equal(assertMcpUrl('https://mcp.example.com/mcp#x', config).href, 'https://mcp.example.com/mcp')
	})
})

describe('assertMcpServerName', () => {
	it('uses the hosted pattern', () => {
		assert.equal(assertMcpServerName('home'), 'home')
		assert.equal(assertMcpServerName('a-1'), 'a-1')
		for (const bad of ['', 'Home', '-a', 'a-', 'a_b', 'a'.repeat(65), 3])
			assert.throws(() => assertMcpServerName(bad), /name/)
	})
})

describe('normalizeBearerToken', () => {
	it('adds Bearer to bare tokens and keeps scheme-prefixed values', () => {
		assert.equal(normalizeBearerToken('abc.def'), 'Bearer abc.def')
		assert.equal(normalizeBearerToken('Bearer abc'), 'Bearer abc')
		assert.equal(normalizeBearerToken('Token abc'), 'Token abc')
		assert.equal(normalizeBearerToken('Authorization: Basic eDp5'), 'Basic eDp5')
		assert.equal(normalizeBearerToken('  abc  '), 'Bearer abc')
	})
	it('refuses empty, oversized and multi-line values', () => {
		for (const bad of ['', '   ', 'a\nb', 'x'.repeat(8193), 42])
			assert.throws(() => normalizeBearerToken(bad), /bearerToken/)
	})
})
