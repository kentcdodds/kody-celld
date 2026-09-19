import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseKodyPackageSpecifier, parsePackageManifest, resolvePackageExport } from './manifest.ts'

const baseFiles = {
	'README.md': '# pkg',
	'AGENTS.md': 'Use it.',
	'index.js': 'export default () => 1',
	'lib/other.js': 'export default () => 2',
}

function manifest(overrides: Record<string, unknown>) {
	return { 'package.json': JSON.stringify({ name: '@scope/pkg', version: '1.2.3', ...overrides }), ...baseFiles }
}

describe('parsePackageManifest', () => {
	it('normalizes exports, jobs, and metadata', () => {
		const parsed = parsePackageManifest(
			manifest({
				description: 'Demo',
				exports: { '.': './index.js', './other': './lib/other.js' },
				kody: {
					jobs: { nightly: { entry: './lib/other.js', schedule: { type: 'cron', expression: '0 3 * * *' } } },
					dependencies: { '@scope/dep': '^1.0.0' },
					hidden: true,
				},
			}),
		)
		assert.deepEqual(parsed.exports, { '.': 'index.js', other: 'lib/other.js' })
		assert.equal(parsed.jobs.nightly?.entry, 'lib/other.js')
		assert.deepEqual(parsed.dependencies, { '@scope/dep': '^1.0.0' })
		assert.equal(parsed.hidden, true)
		assert.equal(resolvePackageExport(parsed, './other'), 'lib/other.js')
		assert.equal(resolvePackageExport(parsed, ''), 'index.js')
		assert.throws(() => resolvePackageExport(parsed, 'nope'), /unknown_export/)
	})

	it('falls back to a string export or main', () => {
		assert.equal(parsePackageManifest(manifest({ exports: './index.js' })).exports['.'], 'index.js')
		assert.equal(parsePackageManifest(manifest({ main: 'index.js' })).exports['.'], 'index.js')
	})

	it('rejects bad names, missing files, docs, and schedules', () => {
		assert.throws(() => parsePackageManifest(manifest({ name: 'Not Valid' })), /invalid_manifest/)
		assert.throws(() => parsePackageManifest(manifest({ exports: './missing.js' })), /missing\.js/)
		assert.throws(() => parsePackageManifest({ ...manifest({ exports: './index.js' }), 'README.md': '  ' }), /README/)
		assert.throws(
			() =>
				parsePackageManifest(
					manifest({ kody: { jobs: { bad: { entry: './index.js', schedule: { type: 'weekly' } } } } }),
				),
			/invalid_manifest/,
		)
		assert.throws(() => parsePackageManifest({ 'README.md': 'x' }), /package\.json is required/)
	})
})

describe('kody.webhooks + kody.subscriptions', () => {
	const exportsMap = { '.': './index.js', './hook': './lib/other.js' }

	it('parses declarations with defaults', () => {
		const parsed = parsePackageManifest(
			manifest({
				exports: exportsMap,
				kody: {
					webhooks: [
						{ name: 'github', export: './hook' },
						{
							name: 'stripe',
							export: '.',
							responseMode: 'sync',
							inputMode: 'params',
							rateLimitPerMinute: 5,
							verification: {
								type: 'hmac-sha256',
								header: 'stripe-signature',
								secretName: 'stripeSecret',
								signedPayload: 'timestamp.body',
							},
							replay: {
								timestampHeader: 'stripe-signature',
								timestampFormat: 'stripe-signature',
								toleranceSeconds: 60,
							},
						},
					],
					subscriptions: { 'email.message.received': { handler: './lib/other.js' } },
				},
			}),
		)
		assert.equal(parsed.webhooks.length, 2)
		assert.deepEqual(parsed.webhooks[0], {
			name: 'github',
			export: 'hook',
			entry: 'lib/other.js',
			responseMode: 'ack',
			inputMode: 'request',
			rateLimitPerMinute: 60,
		})
		assert.equal(parsed.webhooks[1]?.verification?.encoding, 'hex')
		assert.equal(parsed.webhooks[1]?.replay?.toleranceSeconds, 60)
		assert.deepEqual(parsed.subscriptions, [{ topic: 'email.message.received', handler: 'lib/other.js' }])
	})

	it('rejects invalid declarations', () => {
		const bad = (webhooks: unknown) => () => parsePackageManifest(manifest({ exports: exportsMap, kody: { webhooks } }))
		assert.throws(bad([{ name: 'Bad Name', export: '.' }]), /invalid_manifest/)
		assert.throws(bad([{ name: 'a', export: './nope' }]), /not in package\.json#exports/)
		assert.throws(
			bad([
				{ name: 'a', export: '.' },
				{ name: 'a', export: '.' },
			]),
			/invalid_manifest/,
		)
		assert.throws(bad([{ name: 'a', export: '.', responseMode: 'later' }]), /responseMode/)
		assert.throws(bad([{ name: 'a', export: '.', rateLimitPerMinute: 0 }]), /rateLimitPerMinute/)
		assert.throws(
			bad([{ name: 'a', export: '.', verification: { type: 'md5', header: 'x', secretName: 's' } }]),
			/invalid_manifest/,
		)
		assert.throws(
			bad([
				{
					name: 'a',
					export: '.',
					verification: { type: 'hmac-sha256', header: 'x', secretName: 's', secret: 'inline' },
				},
			]),
			/invalid_manifest/,
		)
		assert.throws(
			bad([
				{
					name: 'a',
					export: '.',
					verification: { type: 'hmac-sha256', header: 'x', secretName: 's', signedPayload: 'timestamp.body' },
				},
			]),
			/replay\.timestampHeader/,
		)
		assert.throws(
			() =>
				parsePackageManifest(
					manifest({ exports: exportsMap, kody: { subscriptions: { 'email.bogus': { handler: './index.js' } } } }),
				),
			/unknown topic/,
		)
	})
})

describe('parseKodyPackageSpecifier', () => {
	it('splits scoped and unscoped specifiers', () => {
		assert.deepEqual(parseKodyPackageSpecifier('kody:@scope/pkg/create'), {
			packageName: '@scope/pkg',
			exportName: 'create',
		})
		assert.deepEqual(parseKodyPackageSpecifier('kody:@scope/pkg'), { packageName: '@scope/pkg', exportName: '.' })
		assert.deepEqual(parseKodyPackageSpecifier('kody:pkg/a/b'), { packageName: 'pkg', exportName: 'a/b' })
	})

	it('ignores the runtime module and non-kody specifiers', () => {
		assert.equal(parseKodyPackageSpecifier('kody:runtime'), null)
		assert.equal(parseKodyPackageSpecifier('node:fs'), null)
		assert.equal(parseKodyPackageSpecifier('kody:@scope'), null)
	})
})
