import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	hostMatchesAllowlist,
	isPrivateHostname,
	isPrivateIp,
	normalizeAllowlistEntry,
	parseHostAllowlist,
	parseIpLiteral,
} from './host-allowlist.ts'

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
		assert.equal(normalizeAllowlistEntry('my_service'), 'my_service')
		assert.equal(normalizeAllowlistEntry('*.my_lab.home'), '*.my_lab.home')
	})
	it('refuses IPv4-mapped CIDR entries and suggests the IPv4 form', () => {
		assert.throws(() => normalizeAllowlistEntry('::ffff:0:0/96'), /"::ffff:0:0\/96".*IPv4.*0\.0\.0\.0\/0/)
		assert.throws(() => normalizeAllowlistEntry('::ffff:10.0.0.0/104'), /"::ffff:10\.0\.0\.0\/104".*10\.0\.0\.0\/8/)
		assert.throws(
			() => parseHostAllowlist('[::ffff:10.0.0.0]/104', 'KODY_PRIVATE_HOSTS'),
			/KODY_PRIVATE_HOSTS: .*IPv4.*10\.0\.0\.0\/8/,
		)
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
			() => parseHostAllowlist('ok.home,10.0.0.0/40', 'KODY_PRIVATE_HOSTS'),
			/KODY_PRIVATE_HOSTS: "10\.0\.0\.0\/40"/,
		)
	})
})

describe('isPrivateIp', () => {
	it('flags private v4 ranges and v6 forms that embed or are private space', () => {
		for (const host of [
			'0.1.2.3',
			'10.0.0.5',
			'100.64.0.1',
			'127.0.0.1',
			'169.254.169.254',
			'172.16.0.1',
			'192.0.0.8',
			'192.168.1.1',
			'198.18.0.1',
			'224.0.0.1',
			'240.0.0.1',
			'255.255.255.255',
			'::',
			'::1',
			'0:0:0:0:0:0:0:1',
			'[::ffff:0:a00:1]',
			'[64:ff9b::a00:1]',
			'64:ff9b:1::1',
			'[::a00:1]',
			'[fe90::1]',
			'fe80::1',
			'fec0::1',
			'fc00::1',
			'fd12:3456::1',
			'ff02::1',
			'[0:0:0:0:0:ffff:a00:5]',
			'2002:a00:1::1',
			'100::1',
		]) {
			assert.equal(isPrivateIp(host), true, host)
		}
	})
	it('passes public addresses and names', () => {
		for (const host of [
			'2606:4700::1111',
			'[2606:4700::1111]',
			'8.8.8.8',
			'[64:ff9b::808:808]',
			'2002:808:808::1',
			'ha.home',
		]) {
			assert.equal(isPrivateIp(host), false, host)
		}
	})
})

describe('isPrivateHostname', () => {
	it('flags private names, single-label hosts, and every private IP literal', () => {
		for (const host of [
			'localhost',
			'Foo.Localhost',
			'nas.local',
			'router.internal',
			'gitea',
			'host.docker.internal',
			'10.0.0.5',
			'127.0.0.1',
			'169.254.169.254',
			'172.30.1.1',
			'192.168.0.1',
			'100.64.0.1',
			'192.0.0.8',
			'198.18.0.1',
			'224.0.0.1',
			'::1',
			'[::1]',
			'fe80::1',
			'fc00::1',
			'[::ffff:10.0.0.5]',
			'[64:ff9b::a00:1]',
			'2002:a00:1::1',
		]) {
			assert.equal(isPrivateHostname(host), true, host)
		}
	})
	it('passes public DNS names and public addresses', () => {
		for (const host of ['example.com', 'ha.home.arpa', '8.8.8.8', '2606:4700::1111', '[64:ff9b::808:808]']) {
			assert.equal(isPrivateHostname(host), false, host)
		}
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
