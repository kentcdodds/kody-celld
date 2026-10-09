import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
	ensureDevVars,
	localMcpHosts,
	localPackageSourceHosts,
	mergeLocalMcpHosts,
	mergeLocalPackageSourceHosts,
} from './ensure-dev-vars.ts'

const exampleBody = `# example
KODY_ALLOW_INSECURE_SECRET_HOSTS=127.0.0.1,localhost
KODY_MCP_ALLOW_PRIVATE_HOSTS=127.0.0.1,localhost,host.docker.internal
KODY_PACKAGE_SOURCE_HOSTS=github.com,api.github.com,codeload.github.com,raw.githubusercontent.com,gist.githubusercontent.com,objects.githubusercontent.com,kody.codes,127.0.0.1,localhost,host.docker.internal
`

describe('mergeLocalPackageSourceHosts', () => {
	it('is a no-op when loopback hosts are already listed', () => {
		assert.equal(mergeLocalPackageSourceHosts(exampleBody, exampleBody), null)
	})

	it('appends missing loopback hosts to an existing allowlist', () => {
		const older = 'KODY_PACKAGE_SOURCE_HOSTS=github.com,kody.codes\n'
		const merged = mergeLocalPackageSourceHosts(older, exampleBody)
		assert.equal(merged, `KODY_PACKAGE_SOURCE_HOSTS=github.com,kody.codes,${localPackageSourceHosts.join(',')}\n`)
	})

	it('copies the example allowlist when the key is missing entirely', () => {
		const older = 'KODY_ALLOW_INSECURE_SECRET_HOSTS=127.0.0.1,localhost\n'
		const merged = mergeLocalPackageSourceHosts(older, exampleBody)
		assert.ok(merged)
		assert.match(merged, /KODY_PACKAGE_SOURCE_HOSTS=github\.com.*,127\.0\.0\.1,localhost/)
	})

	it('preserves CRLF when rewriting an existing allowlist', () => {
		const older = 'KODY_PACKAGE_SOURCE_HOSTS=github.com,kody.codes\r\n'
		const merged = mergeLocalPackageSourceHosts(older, exampleBody)
		assert.equal(merged, `KODY_PACKAGE_SOURCE_HOSTS=github.com,kody.codes,${localPackageSourceHosts.join(',')}\r\n`)
	})
})

describe('mergeLocalMcpHosts', () => {
	it('is a no-op when loopback hosts are already listed', () => {
		assert.equal(mergeLocalMcpHosts(exampleBody, exampleBody), null)
	})

	it('appends missing loopback hosts to an existing MCP allowlist', () => {
		const older = 'KODY_MCP_ALLOW_PRIVATE_HOSTS=10.0.0.0/8\n'
		assert.equal(
			mergeLocalMcpHosts(older, exampleBody),
			`KODY_MCP_ALLOW_PRIVATE_HOSTS=10.0.0.0/8,${localMcpHosts.join(',')}\n`,
		)
	})

	it('copies the example MCP allowlist when the key is missing entirely', () => {
		const older = 'KODY_ALLOW_INSECURE_SECRET_HOSTS=127.0.0.1,localhost\n'
		assert.equal(
			mergeLocalMcpHosts(older, exampleBody),
			`${older}KODY_MCP_ALLOW_PRIVATE_HOSTS=127.0.0.1,localhost,host.docker.internal\n`,
		)
	})
})

describe('ensureDevVars', () => {
	it('copies the example when missing, then merges into an older file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'kody-dev-vars-'))
		try {
			const examplePath = join(dir, '.dev.vars.example')
			const targetPath = join(dir, '.dev.vars')
			writeFileSync(examplePath, exampleBody)

			const first = ensureDevVars({ targetPath, examplePath })
			assert.equal(first.wrote, true)
			assert.equal(readFileSync(targetPath, 'utf8'), exampleBody)

			writeFileSync(targetPath, 'KODY_PACKAGE_SOURCE_HOSTS=github.com\nKODY_MCP_ALLOW_PRIVATE_HOSTS=\n')
			const second = ensureDevVars({ targetPath, examplePath })
			assert.equal(second.wrote, false)
			assert.equal(second.mergedHosts, true)
			assert.equal(
				readFileSync(targetPath, 'utf8'),
				`KODY_PACKAGE_SOURCE_HOSTS=github.com,${localPackageSourceHosts.join(',')}\nKODY_MCP_ALLOW_PRIVATE_HOSTS=${localMcpHosts.join(',')}\n`,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
