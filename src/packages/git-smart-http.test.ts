import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
	cloneGitSmartHttp,
	discoverGitRefs,
	filesFromGitObjects,
	normalizeGitUrl,
	unpackGitPack,
} from './git-smart-http.ts'
import type { FetchLike } from './git-smart-http.ts'

function makeBarePackage() {
	const dir = mkdtempSync(join(tmpdir(), 'kody-git-http-'))
	const work = join(dir, 'work')
	mkdirSync(work)
	execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: work })
	execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: work })
	execFileSync('git', ['config', 'user.name', 't'], { cwd: work })
	writeFileSync(
		join(work, 'package.json'),
		JSON.stringify({
			name: '@t/hello',
			version: '1.2.3',
			description: 'hi',
			exports: { '.': './main.js' },
		}),
	)
	writeFileSync(join(work, 'README.md'), '# Hello\n')
	writeFileSync(join(work, 'AGENTS.md'), 'agents\n')
	writeFileSync(join(work, 'main.js'), 'export default async () => "hi"\n')
	mkdirSync(join(work, 'nested'))
	writeFileSync(
		join(work, 'nested', 'package.json'),
		JSON.stringify({ name: '@t/nested', version: '0.1.0', description: 'n', exports: { '.': './x.js' } }),
	)
	writeFileSync(join(work, 'nested', 'README.md'), '# Nested\n')
	writeFileSync(join(work, 'nested', 'AGENTS.md'), 'agents\n')
	writeFileSync(join(work, 'nested', 'x.js'), 'export default async () => 1\n')
	execFileSync('git', ['add', '.'], { cwd: work })
	execFileSync('git', ['commit', '-qm', 'init'], { cwd: work })
	const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work }).toString().trim()
	const bare = join(dir, 'hello.git')
	execFileSync('git', ['clone', '--bare', '-q', work, bare])
	return { bare, sha, gitUrl: `https://kody.codes/@t/hello.git` }
}

/** Serves smart-HTTP discovery + upload-pack from a local bare repo. */
function gitFetch(bare: string): FetchLike {
	return async (input, init) => {
		const url = new URL(input)
		if (url.pathname.endsWith('/info/refs') && url.searchParams.get('service') === 'git-upload-pack') {
			const advertisement = execFileSync('git', ['upload-pack', '--advertise-refs', bare])
			const header = Buffer.from('001e# service=git-upload-pack\n0000')
			return new Response(Buffer.concat([header, advertisement]), {
				status: 200,
				headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
			})
		}
		if (url.pathname.endsWith('/git-upload-pack') && init?.method === 'POST') {
			const body =
				typeof init.body === 'string'
					? Buffer.from(init.body)
					: init.body instanceof Uint8Array
						? Buffer.from(init.body)
						: Buffer.from(await new Response(init.body as BodyInit).arrayBuffer())
			const pack = execFileSync('git', ['upload-pack', '--stateless-rpc', bare], { input: body })
			return new Response(pack, {
				status: 200,
				headers: { 'content-type': 'application/x-git-upload-pack-result' },
			})
		}
		return new Response('not found', { status: 404 })
	}
}

describe('git-smart-http', () => {
	it('normalizes listing URLs to .git', () => {
		assert.equal(normalizeGitUrl('https://kody.codes/@t/hello'), 'https://kody.codes/@t/hello.git')
		assert.equal(normalizeGitUrl('https://kody.codes/@t/hello.git/'), 'https://kody.codes/@t/hello.git')
	})

	it('unpacks a packfile into package files', async () => {
		const { bare, sha } = makeBarePackage()
		const want = Buffer.concat([Buffer.from(`0032want ${sha}\n`), Buffer.from('0000'), Buffer.from('0009done\n')])
		const packOut = execFileSync('git', ['upload-pack', '--stateless-rpc', bare], { input: want })
		const idx = packOut.indexOf(Buffer.from('PACK'))
		const objects = await unpackGitPack(new Uint8Array(packOut.subarray(idx)))
		const { files } = filesFromGitObjects(objects, sha, null)
		assert.equal(files['package.json']?.includes('"@t/hello"'), true)
		assert.ok(files['README.md'])
	})

	it('clones via smart-HTTP and supports subdir', async () => {
		const { bare, sha, gitUrl } = makeBarePackage()
		const fetchImpl = gitFetch(bare)
		const discovery = await discoverGitRefs(gitUrl, {
			assertAllowed: (u) => u,
			fetch: fetchImpl,
		})
		assert.equal(discovery.head, sha)
		const root = await cloneGitSmartHttp(gitUrl, {
			assertAllowed: (u) => u,
			fetch: fetchImpl,
		})
		assert.equal(root.commit, sha)
		assert.equal(JSON.parse(root.files['package.json']!).name, '@t/hello')
		const nested = await cloneGitSmartHttp(gitUrl, {
			subdir: 'nested',
			assertAllowed: (u) => u,
			fetch: fetchImpl,
		})
		assert.equal(JSON.parse(nested.files['package.json']!).name, '@t/nested')
	})
})
