import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ensureDevVars, localPackageSourceHosts, mergeLocalPackageSourceHosts } from './ensure-dev-vars.ts'

const exampleBody = `# example
KODY_ALLOW_INSECURE_SECRET_HOSTS=127.0.0.1,localhost
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
})

describe('ensureDevVars', () => {
	it('copies the example when missing, then merges into an older file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'kody-dev-vars-'))
		const examplePath = join(dir, '.dev.vars.example')
		const targetPath = join(dir, '.dev.vars')
		writeFileSync(examplePath, exampleBody)

		const first = ensureDevVars({ targetPath, examplePath })
		assert.equal(first.wrote, true)
		assert.equal(readFileSync(targetPath, 'utf8'), exampleBody)

		writeFileSync(targetPath, 'KODY_PACKAGE_SOURCE_HOSTS=github.com\n')
		const second = ensureDevVars({ targetPath, examplePath })
		assert.equal(second.wrote, false)
		assert.equal(second.mergedHosts, true)
		assert.equal(
			readFileSync(targetPath, 'utf8'),
			`KODY_PACKAGE_SOURCE_HOSTS=github.com,${localPackageSourceHosts.join(',')}\n`,
		)
	})
})
