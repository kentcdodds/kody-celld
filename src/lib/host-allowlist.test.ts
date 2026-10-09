import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hostMatchesAllowlist, normalizeAllowlistEntry, parseHostAllowlist, parseIpLiteral } from './host-allowlist.ts'

describe('normalizeAllowlistEntry', () => {
	it('accepts hosts, suffixes, IPs and CIDR ranges', () => {
		assert.equal(normalizeAllowlistEntry(' HA.Home '), 'ha.home')
		assert.equal(normalizeAllowlistEntry('*.Home'), '*.home')
		assert.equal(normalizeAllowlistEntry('localhost'), 'localhost')
		assert.equal(normalizeAllowlistEntry('172.30.1.108'), '172.30.1.108')
		assert.equal(normalizeAllowlistEntry('[::1]'), '::1')
		assert.equal(normalizeAllowlistEntry('172.30.0.0/16'), '172.30.0.0/16')
		assert.equal(normalizeAllowlistEntry('172.30.1.9/16'), '172.30.1.9/16')
		assert.equal(normalizeAllowlistEntry('FD00::/8'), 'fd00::/8')
		assert.equal(normalizeAllowlistEntry('0.0.0.0/0'), '0.0.0.0/0')
		assert.equal(normalizeAllowlistEntry('::/0'), '::/0')
		assert.equal(normalizeAllowlistEntry('10.0.0.1/32'), '10.0.0.1/32')
		assert.equal(normalizeAllowlistEntry('::1/128'), '::1/128')
	})
	it('rejects anything else', () => {
		for (const bad of [
			'',
			'http://x',
			'a b',
			'10.0.0.0/33',
			'::/129',
			'10.0.0.0/x',
			'300.1.1.1/8',
			'x/8',
			'*.',
			'*',
			'host:8080',
			'1.2.3.4/',
		]) {
			assert.throws(() => normalizeAllowlistEntry(bad), Error, bad)
		}
	})
})

describe('parseHostAllowlist', () => {
	it('splits, normalizes and drops empty entries', () => {
		assert.deepEqual(parseHostAllowlist(' a.home , ,172.30.0.0/16,', 'X'), ['a.home', '172.30.0.0/16'])
		assert.deepEqual(parseHostAllowlist(undefined, 'X'), [])
	})
	it('names the variable and the bad entry', () => {
		assert.throws(
			() => parseHostAllowlist('ok.home,10.0.0.0/40', 'KODY_MCP_ALLOW_PRIVATE_HOSTS'),
			/KODY_MCP_ALLOW_PRIVATE_HOSTS: "10\.0\.0\.0\/40"/,
		)
	})
})

describe('parseIpLiteral', () => {
	it('parses v4, v6, brackets and IPv4-mapped v6', () => {
		assert.deepEqual(parseIpLiteral('10.0.0.1'), { version: 4, value: 0x0a000001n })
		assert.deepEqual(parseIpLiteral('[::1]'), { version: 6, value: 1n })
		assert.deepEqual(parseIpLiteral('::ffff:172.30.1.5'), { version: 4, value: 0xac1e0105n })
		assert.deepEqual(parseIpLiteral('::ffff:ac1e:105'), { version: 4, value: 0xac1e0105n })
		assert.equal(parseIpLiteral('ha.home'), null)
		assert.equal(parseIpLiteral('1.2.3'), null)
		assert.equal(parseIpLiteral('1::2::3'), null)
	})
})

describe('hostMatchesAllowlist', () => {
	const entries = ['ha.home', '*.lab.internal', '172.30.0.0/16', 'fd00::/8', '192.168.1.10', '::1']
	it('matches exact names, suffix subdomains and IPs inside ranges', () => {
		assert.equal(hostMatchesAllowlist('HA.home', entries), true)
		assert.equal(hostMatchesAllowlist('nas.lab.internal', entries), true)
		assert.equal(hostMatchesAllowlist('172.30.1.108', entries), true)
		assert.equal(hostMatchesAllowlist('172.30.255.255', entries), true)
		assert.equal(hostMatchesAllowlist('[fd12::5]', entries), true)
		assert.equal(hostMatchesAllowlist('192.168.1.10', entries), true)
		assert.equal(hostMatchesAllowlist('[::1]', entries), true)
		assert.equal(hostMatchesAllowlist('[::ffff:172.30.1.5]', entries), true)
	})
	it('does not match neighbours, bare suffixes or names against CIDRs', () => {
		assert.equal(hostMatchesAllowlist('172.31.0.1', entries), false)
		assert.equal(hostMatchesAllowlist('lab.internal', entries), false)
		assert.equal(hostMatchesAllowlist('192.168.1.11', entries), false)
		assert.equal(hostMatchesAllowlist('[fe80::1]', entries), false)
		assert.equal(hostMatchesAllowlist('172.30.ha.home', ['172.30.0.0/16']), false)
		assert.equal(hostMatchesAllowlist('anything.example', ['0.0.0.0/0']), false)
		assert.equal(hostMatchesAllowlist('8.8.8.8', ['0.0.0.0/0']), true)
	})
})
