import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { passwordProblem } from './password-form.ts'

describe('passwordProblem', () => {
	it('checks confirmation and strength before any one-time token is spent', () => {
		assert.equal(passwordProblem({ password: 'correct horse battery', confirm: 'correct horse battery' }), null)
		assert.equal(
			passwordProblem({ password: 'correct horse battery', confirm: 'different' }),
			'Passwords do not match.',
		)
		assert.equal(passwordProblem({ confirm: 'x' }), 'Passwords do not match.')
		assert.match(passwordProblem({ password: 'short', confirm: 'short' }) ?? '', /at least 12/)
		const long = 'x'.repeat(300)
		assert.match(passwordProblem({ password: long, confirm: long }) ?? '', /at most 256/)
	})
})
