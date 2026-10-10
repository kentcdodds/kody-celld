// Regression: single-node Docker runs `celld dev`, which loads wrangler.jsonc
// vars and lets .dev.vars override only what the entrypoint writes. Dev-only
// email / private-host / insecure-host values must not live in wrangler.jsonc
// or a default install inherits them (reported by Alan Żur).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { emailConfigFromEnv } from '../../src/email/config.ts'

function parseJsonc(text: string): unknown {
	return JSON.parse(
		text
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
			.replace(/,(\s*[}\]])/g, '$1'),
	)
}

const wrangler = parseJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as {
	vars: Record<string, string>
}

const forbiddenExact = new Set(['KODY_PRIVATE_HOSTS'])

describe('wrangler.jsonc vars (single-node inheritance)', () => {
	it('does not ship email, private-host, or insecure-host smoke defaults', () => {
		for (const name of Object.keys(wrangler.vars)) {
			assert.ok(
				!name.startsWith('KODY_EMAIL_') && !forbiddenExact.has(name),
				`${name} must not live in wrangler.jsonc (use .dev.vars.example / operator env)`,
			)
		}
		assert.equal(emailConfigFromEnv(wrangler.vars), null)
	})

	it('keeps only the loopback operator placeholders required to boot celld dev', () => {
		assert.deepEqual(Object.keys(wrangler.vars).sort(), ['KODY_ADMIN_TOKEN', 'KODY_MASTER_KEY', 'KODY_PUBLIC_URL'])
	})
})
