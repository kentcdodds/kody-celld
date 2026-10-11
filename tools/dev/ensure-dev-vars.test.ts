import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ensureDevVars, localPrivateHosts, mergeLocalPrivateHosts } from './ensure-dev-vars.ts'

const exampleBody = `# example
KODY_PRIVATE_HOSTS=127.0.0.1,localhost,host.docker.internal
`

describe('mergeLocalPrivateHosts', () => {
	it('is a no-op when loopback hosts are already listed', () => {
		assert.equal(mergeLocalPrivateHosts(exampleBody, exampleBody), null)
	})

	it('appends missing loopback hosts to an existing allowlist', () => {
		const older = 'KODY_PRIVATE_HOSTS=10.0.0.0/8\n'
		assert.equal(
			mergeLocalPrivateHosts(older, exampleBody),
			`KODY_PRIVATE_HOSTS=10.0.0.0/8,${localPrivateHosts.join(',')}\n`,
		)
	})

	it('copies the example allowlist when the key is missing entirely', () => {
		const older = 'KODY_EMAIL_DOMAIN=kody.local.test\n'
		assert.equal(
			mergeLocalPrivateHosts(older, exampleBody),
			`${older}KODY_PRIVATE_HOSTS=127.0.0.1,localhost,host.docker.internal\n`,
		)
	})

	it('preserves CRLF when rewriting an existing allowlist', () => {
		const older = 'KODY_PRIVATE_HOSTS=10.0.0.0/8\r\n'
		assert.equal(
			mergeLocalPrivateHosts(older, exampleBody),
			`KODY_PRIVATE_HOSTS=10.0.0.0/8,${localPrivateHosts.join(',')}\r\n`,
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

			writeFileSync(targetPath, 'KODY_PRIVATE_HOSTS=10.0.0.0/8\n')
			const second = ensureDevVars({ targetPath, examplePath })
			assert.equal(second.wrote, false)
			assert.equal(second.mergedHosts, true)
			assert.equal(readFileSync(targetPath, 'utf8'), `KODY_PRIVATE_HOSTS=10.0.0.0/8,${localPrivateHosts.join(',')}\n`)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
