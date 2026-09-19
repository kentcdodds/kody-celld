import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	collectPlaceholders,
	containsSecretPlaceholder,
	decodeSecretPlaceholderDelimiters,
	parseBasicAuthSecretPlaceholders,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
} from './placeholders.ts'

describe('secret placeholders', () => {
	it('parses {{secret:name}} with optional scope', () => {
		const refs = parseSecretPlaceholders('Bearer {{secret:api-key}} and {{secret:other|scope=package}}')
		assert.deepEqual(
			refs.map((r) => [r.name, r.scope]),
			[
				['api-key', null],
				['other', 'package'],
			],
		)
	})

	it('parses basic-auth pairs', () => {
		const [basic] = parseBasicAuthSecretPlaceholders('{{secret-basic:username=user,password=pass|scope=user}}')
		assert.equal(basic?.username, 'user')
		assert.equal(basic?.password, 'pass')
		assert.equal(basic?.scope, 'user')
	})

	it('detects every placeholder kind', () => {
		assert.equal(containsSecretPlaceholder('{{secret:x}}'), true)
		assert.equal(containsSecretPlaceholder('{{secret-basic:username=a,password=b}}'), true)
		assert.equal(containsSecretPlaceholder('{{integration-token:github}}'), true)
		assert.equal(containsSecretPlaceholder('{{secret/openai:sk}}'), true)
		assert.equal(containsSecretPlaceholder('{{not-a-secret}}'), false)
		const grouped = collectPlaceholders('{{secret:a}} {{integration-token:gh}} {{secret/p:v}}')
		assert.equal(grouped.secrets.length, 1)
		assert.equal(grouped.integrationTokens.length, 1)
		assert.equal(grouped.providerSecrets.length, 1)
	})

	it('decodes percent-encoded delimiters from URL paths', () => {
		assert.equal(decodeSecretPlaceholderDelimiters('/q?t=%7B%7Bsecret:a%7D%7D'), '/q?t={{secret:a}}')
	})

	it('replaces every occurrence in insertion order', () => {
		const replacements = new Map([
			['Basic {{secret-basic:username=u,password=p}}', 'Basic dTpw'],
			['{{secret-basic:username=u,password=p}}', 'Basic dTpw'],
			['{{secret:a}}', 'A'],
		])
		assert.equal(
			replaceSecretPlaceholders(
				'Basic {{secret-basic:username=u,password=p}} / {{secret:a}}{{secret:a}}',
				replacements,
			),
			'Basic dTpw / AA',
		)
	})
})
