import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
	assertAllowedSourceUrl,
	defaultPackageSourceHosts,
	describePackageSource,
	fetchAllowed,
	fetchPackageSource,
	filesFromJson,
	githubTarballUrl,
	packageSourceHostsFromEnv,
	parsePackageSource,
	type FetchLike,
} from './install.ts'
import { gunzip, readTar } from './tar.ts'

const manifest = JSON.stringify({ name: '@t/hello', version: '1.2.3', exports: { '.': './main.js' } })

/** Builds a GitHub-shaped tarball (`repo-ref/…` root dir) with the system tar. */
function githubTarball(files: Record<string, string | Uint8Array>, root = 'hello-HEAD') {
	const dir = mkdtempSync(join(tmpdir(), 'kody-tar-'))
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, root, path)
		mkdirSync(join(full, '..'), { recursive: true })
		writeFileSync(full, content)
	}
	const out = join(dir, 'archive.tgz')
	execFileSync('tar', ['-czf', out, '-C', dir, root])
	return new Uint8Array(readFileSync(out))
}

const packageFiles = {
	'package.json': manifest,
	'README.md': '# hello',
	'AGENTS.md': 'agents',
	'main.js': 'export default async () => "hi"',
	'.git/config': '[core]',
	'node_modules/x/index.js': 'nope',
	'image.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
}

function fetchFor(routes: Record<string, () => Response>): FetchLike & { calls: Array<string> } {
	const calls: Array<string> = []
	const impl: FetchLike = async (input) => {
		calls.push(input)
		const route = routes[input]
		return route ? route() : new Response('not found', { status: 404 })
	}
	return Object.assign(impl, { calls })
}

const tgzResponse = (bytes: Uint8Array) => () =>
	new Response(bytes, { status: 200, headers: { 'content-type': 'application/x-gzip' } })

describe('parsePackageSource', () => {
	it('parses github: shorthand with subdir and ref', () => {
		assert.deepEqual(parsePackageSource('github:kentcdodds/kody-celld'), {
			kind: 'github',
			owner: 'kentcdodds',
			repo: 'kody-celld',
			ref: null,
			subdir: null,
		})
		const full = parsePackageSource('github:kentcdodds/kody-celld/examples/hello#v1.0.0')
		assert.deepEqual(full, {
			kind: 'github',
			owner: 'kentcdodds',
			repo: 'kody-celld',
			ref: 'v1.0.0',
			subdir: 'examples/hello',
		})
		assert.equal(describePackageSource(full), 'github:kentcdodds/kody-celld/examples/hello#v1.0.0')
		assert.ok(full.kind === 'github')
		assert.equal(githubTarballUrl(full), 'https://codeload.github.com/kentcdodds/kody-celld/tar.gz/v1.0.0')
		const bare = parsePackageSource('github:a/b')
		assert.ok(bare.kind === 'github')
		assert.equal(githubTarballUrl(bare), 'https://codeload.github.com/a/b/tar.gz/HEAD')
	})

	it('parses github.com URLs including /tree/<ref>/<subdir>', () => {
		assert.deepEqual(parsePackageSource('https://github.com/kentcdodds/kody-celld.git'), {
			kind: 'github',
			owner: 'kentcdodds',
			repo: 'kody-celld',
			ref: null,
			subdir: null,
		})
		assert.deepEqual(parsePackageSource('https://github.com/kentcdodds/kody-celld/tree/main/examples/hello'), {
			kind: 'github',
			owner: 'kentcdodds',
			repo: 'kody-celld',
			ref: 'main',
			subdir: 'examples/hello',
		})
		// Other github.com paths (releases, raw blobs) are plain URLs.
		assert.equal(parsePackageSource('https://github.com/a/b/releases/download/v1/pkg.tgz').kind, 'url')
	})

	it('treats everything else as a URL source and strips the fragment', () => {
		const source = parsePackageSource('https://example.com/pkg.json#frag', 'sub/')
		assert.deepEqual(source, { kind: 'url', url: 'https://example.com/pkg.json', subdir: 'sub' })
		assert.equal(describePackageSource(source), 'https://example.com/pkg.json#sub')
	})

	it('rejects malformed sources', () => {
		assert.throws(() => parsePackageSource(''), /non-empty/)
		assert.throws(() => parsePackageSource('github:onlyowner'), /github:owner\/repo/)
		assert.throws(() => parsePackageSource('github:a/b#../x'), /valid git ref/)
		assert.throws(() => parsePackageSource('github:a/b#-flag'), /valid git ref/)
		assert.throws(() => parsePackageSource('github:a/b/../etc'), /may not contain/)
		assert.throws(() => parsePackageSource('github:bad owner/b'), /owner name/)
		assert.throws(() => parsePackageSource('ftp://example.com/x.tgz'), /Only http\(s\)/)
		assert.throws(() => parsePackageSource('https://user:pw@example.com/x.tgz'), /credentials/)
		assert.throws(() => parsePackageSource('not a url'), /not a URL/)
	})
})

describe('source host policy', () => {
	it('defaults to GitHub hosts and validates the env list', () => {
		assert.deepEqual(packageSourceHostsFromEnv({}), defaultPackageSourceHosts)
		assert.deepEqual(packageSourceHostsFromEnv({ KODY_PACKAGE_SOURCE_HOSTS: ' Example.com, *.pkgs.test ,*' }), [
			'example.com',
			'*.pkgs.test',
			'*',
		])
		assert.throws(
			() => packageSourceHostsFromEnv({ KODY_PACKAGE_SOURCE_HOSTS: 'http://x' }),
			/KODY_PACKAGE_SOURCE_HOSTS/,
		)
	})

	it('refuses private hosts even when the allowlist is *', () => {
		for (const url of [
			'http://localhost/pkg.tgz',
			'http://127.0.0.1/pkg.tgz',
			'http://10.1.2.3/pkg.tgz',
			'http://169.254.169.254/latest',
			'http://[::1]/pkg.tgz',
			'http://minio/pkg.tgz',
			'http://kody.internal/pkg.tgz',
		]) {
			assert.throws(() => assertAllowedSourceUrl(url, ['*']), /package_source_refused/, url)
		}
	})

	it('lets the operator allowlist a LAN host by exact name only', () => {
		assert.ok(assertAllowedSourceUrl('http://gitea.local/pkg.tgz', ['gitea.local']))
		assert.ok(assertAllowedSourceUrl('http://192.168.1.20:3000/pkg.tgz', ['192.168.1.20']))
		assert.throws(() => assertAllowedSourceUrl('http://gitea.local/pkg.tgz', ['*.local']), /private host/)
		assert.throws(() => assertAllowedSourceUrl('http://gitea.local/pkg.tgz', ['*']), /private host/)
	})

	it('enforces the allowlist with exact and wildcard entries', () => {
		assert.throws(
			() => assertAllowedSourceUrl('https://evil.example/x.tgz', defaultPackageSourceHosts),
			/not in KODY_PACKAGE_SOURCE_HOSTS/,
		)
		assert.ok(assertAllowedSourceUrl('https://codeload.github.com/a/b/tar.gz/HEAD', defaultPackageSourceHosts))
		assert.ok(assertAllowedSourceUrl('https://cdn.pkgs.test/x.tgz', ['*.pkgs.test']))
		assert.throws(() => assertAllowedSourceUrl('https://pkgs.test/x.tgz', ['*.pkgs.test']), /not in/)
		assert.throws(() => assertAllowedSourceUrl('https://u:p@github.com/x', ['*']), /credentials/)
	})

	it('re-checks every redirect hop and caps the chain', async () => {
		const bytes = new TextEncoder().encode('{}')
		const fetchImpl = fetchFor({
			'https://github.com/a/b/archive/main.tar.gz': () =>
				new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/a/b/tar.gz/main' } }),
			'https://codeload.github.com/a/b/tar.gz/main': () => new Response(bytes, { status: 200 }),
			'https://github.com/a/b/evil': () =>
				new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
			'https://github.com/a/b/loop': () => new Response(null, { status: 302, headers: { location: '/a/b/loop' } }),
		})
		const ok = await fetchAllowed('https://github.com/a/b/archive/main.tar.gz', defaultPackageSourceHosts, fetchImpl)
		assert.equal(ok.url, 'https://codeload.github.com/a/b/tar.gz/main')
		await assert.rejects(
			fetchAllowed('https://github.com/a/b/evil', defaultPackageSourceHosts, fetchImpl),
			/private host/,
		)
		await assert.rejects(
			fetchAllowed('https://github.com/a/b/loop', defaultPackageSourceHosts, fetchImpl),
			/Too many redirects/,
		)
		await assert.rejects(
			fetchAllowed('https://github.com/a/b/missing', defaultPackageSourceHosts, fetchImpl),
			(error: Error) => {
				assert.equal(error.name, 'KodyError:package_source_failed:404')
				return true
			},
		)
	})
})

describe('tar reading', () => {
	it('extracts regular files from a gzip tarball, including long paths', async () => {
		const longPath = `${'deeply/'.repeat(20)}file.js`
		const bytes = githubTarball({ 'a.txt': 'A', [longPath]: 'long' })
		const entries = readTar(await gunzip(bytes, 1024 * 1024), { maxFiles: 10, maxTotalBytes: 1024 })
		assert.deepEqual(
			entries.map((e) => [e.path, new TextDecoder().decode(e.bytes)]).sort(),
			[
				['hello-HEAD/a.txt', 'A'],
				[`hello-HEAD/${longPath}`, 'long'],
			].sort(),
		)
	})

	it('enforces file-count and byte limits', async () => {
		const bytes = await gunzip(githubTarball({ 'a.txt': 'A'.repeat(600), 'b.txt': 'B' }), 1024 * 1024)
		assert.throws(() => readTar(bytes, { maxFiles: 1, maxTotalBytes: 10_000 }), /more than 1 files/)
		assert.throws(() => readTar(bytes, { maxFiles: 10, maxTotalBytes: 100 }), /exceed 100 bytes/)
	})

	it('caps gunzip output', async () => {
		const bytes = githubTarball({ 'a.txt': 'A'.repeat(50_000) })
		await assert.rejects(gunzip(bytes, 10_000), /expands beyond/)
	})
})

describe('fetchPackageSource', () => {
	it('installs a GitHub tarball: strips the root dir, skips .git/node_modules/binary files', async () => {
		const fetchImpl = fetchFor({
			'https://codeload.github.com/o/hello/tar.gz/HEAD': tgzResponse(githubTarball(packageFiles)),
		})
		const result = await fetchPackageSource(parsePackageSource('github:o/hello'), {
			allowedHosts: defaultPackageSourceHosts,
			fetch: fetchImpl,
		})
		assert.deepEqual(Object.keys(result.files).sort(), ['AGENTS.md', 'README.md', 'main.js', 'package.json'])
		assert.equal(result.files['package.json'], manifest)
		assert.equal(result.source, 'github:o/hello')
		assert.equal(result.fetchedFrom, 'https://codeload.github.com/o/hello/tar.gz/HEAD')
		assert.deepEqual(result.warnings, ['Skipped image.png: not UTF-8 text (packages hold text files only).'])
	})

	it('roots the package at subdir and suggests directories when package.json is elsewhere', async () => {
		const nested = Object.fromEntries(Object.entries(packageFiles).map(([p, c]) => [`packages/hello/${p}`, c]))
		nested['packages/other/package.json'] = '{}'
		const tarball = githubTarball(nested, 'mono-main')
		const fetchImpl = fetchFor({ 'https://codeload.github.com/o/mono/tar.gz/main': tgzResponse(tarball) })
		const ok = await fetchPackageSource(parsePackageSource('github:o/mono/packages/hello#main'), {
			allowedHosts: defaultPackageSourceHosts,
			fetch: fetchImpl,
		})
		assert.equal(ok.files['main.js'], packageFiles['main.js'])
		assert.equal(ok.source, 'github:o/mono/packages/hello#main')
		await assert.rejects(
			fetchPackageSource(parsePackageSource('github:o/mono#main'), {
				allowedHosts: defaultPackageSourceHosts,
				fetch: fetchImpl,
			}),
			/package\.json was found in: packages\/hello, packages\/other/,
		)
		await assert.rejects(
			fetchPackageSource(parsePackageSource('github:o/mono/nowhere#main'), {
				allowedHosts: defaultPackageSourceHosts,
				fetch: fetchImpl,
			}),
			/package\.json was found in: packages\/hello, packages\/other/,
		)
	})

	it('accepts JSON file maps, wrapped or bare', () => {
		const bare = filesFromJson(JSON.stringify({ 'package.json': manifest, 'README.md': 'r' }), null)
		assert.deepEqual(Object.keys(bare.files).sort(), ['README.md', 'package.json'])
		const wrapped = filesFromJson(JSON.stringify({ files: { './package.json': manifest }, source: 'x' }), null)
		assert.deepEqual(Object.keys(wrapped.files), ['package.json'])
		assert.throws(() => filesFromJson('[1]', null), /must be an object/)
		assert.throws(() => filesFromJson(JSON.stringify({ 'package.json': 1 }), null), /must be a string/)
		assert.throws(() => filesFromJson(JSON.stringify({ 'README.md': 'x' }), null), /no package\.json/)
		assert.throws(() => filesFromJson('garbage', null), /neither a tarball nor JSON/)
	})

	it('fetches JSON sources from allowlisted URLs', async () => {
		const fetchImpl = fetchFor({
			'https://raw.githubusercontent.com/o/r/main/pkg.json': () =>
				new Response(JSON.stringify({ 'package.json': manifest, 'README.md': 'r', 'AGENTS.md': 'a', 'main.js': 'x' }), {
					status: 200,
					headers: { 'content-type': 'text/plain' },
				}),
		})
		const result = await fetchPackageSource(parsePackageSource('https://raw.githubusercontent.com/o/r/main/pkg.json'), {
			allowedHosts: defaultPackageSourceHosts,
			fetch: fetchImpl,
		})
		assert.equal(result.files['main.js'], 'x')
		assert.equal(result.source, 'https://raw.githubusercontent.com/o/r/main/pkg.json')
	})

	it('never contacts hosts outside the allowlist', async () => {
		const fetchImpl = fetchFor({})
		await assert.rejects(
			fetchPackageSource(parsePackageSource('https://evil.example/pkg.tgz'), {
				allowedHosts: defaultPackageSourceHosts,
				fetch: fetchImpl,
			}),
			/package_source_refused/,
		)
		assert.deepEqual(fetchImpl.calls, [])
	})
})
