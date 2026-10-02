import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	applyIndividualClaSigningComment,
	checkClaIdentities,
	formatClaFailure,
	individualClaSigningPhrase,
	isIndividualClaSigningComment,
	parseClaSignersFile,
	serializeClaSignersFile,
	type ClaSignersFile,
} from './check-cla.ts'

function signersFile(overrides: Partial<ClaSignersFile> = {}): ClaSignersFile {
	return {
		version: 1,
		document: 'docs/legal/individual-cla.md',
		allowlist: {
			github: ['kentcdodds', 'kody-bot', 'cursoragent'],
			email: ['me@kentcdodds.com', 'me+github@kentcdodds.com'],
		},
		signers: [],
		...overrides,
	}
}

describe('check-cla', () => {
	it('allowlists the Licensor, bots, signed humans, and rejects everyone else', () => {
		const file = signersFile({
			signers: [{ github: 'ExampleSigner', signedAt: '2026-08-16', cla: 'individual' }],
		})

		const identity = (githubLogin: string | null, name: string, email: string | null = null) => ({
			githubLogin,
			name,
			email,
		})

		assert.deepEqual(
			checkClaIdentities(
				[
					identity('kentcdodds', 'Kent'),
					identity('kody-bot', 'Kody'),
					identity('cursoragent', 'Cursor Agent', 'cursoragent@cursor.com'),
					identity('cursor[bot]', 'cursor[bot]'),
					identity('app/imgbot', 'ImgBot'),
					identity(null, 'Kent C. Dodds', 'me+github@kentcdodds.com'),
					identity('examplesigner', 'Example Signer', 'signer@example.com'),
				],
				file,
			),
			{ ok: true },
		)

		const failing = checkClaIdentities(
			[
				identity('kentcdodds', 'Kent'),
				identity('mirkosalvato1-ctrl', 'Mirko', 'mirkosalvato1@gmail.com'),
				identity(null, 'Someone', 'someone@example.com'),
			],
			file,
		)
		assert.equal(failing.ok, false)
		if (failing.ok) {
			throw new Error('expected missing signatures')
		}
		assert.deepEqual(
			failing.missing.map((entry) => entry.reason),
			[
				'@mirkosalvato1-ctrl has not signed the CLA',
				'someone@example.com has no GitHub login and is not a Licensor email',
			],
		)
		assert.match(formatClaFailure(failing), new RegExp(individualClaSigningPhrase))
	})

	it('records the signing comment once and ignores everything else', () => {
		const empty = signersFile()
		assert.equal(isIndividualClaSigningComment(`  ${individualClaSigningPhrase}  `), true)
		assert.equal(isIndividualClaSigningComment('I agree'), false)

		const ignored = applyIndividualClaSigningComment({
			file: empty,
			github: 'ExampleSigner',
			signedAt: '2026-08-16',
			comment: 'I agree',
		})
		assert.deepEqual(ignored, {
			file: empty,
			status: 'ignored',
			reason: 'not_signing_comment',
		})

		const recorded = applyIndividualClaSigningComment({
			file: empty,
			github: 'ExampleSigner',
			signedAt: '2026-08-16',
			comment: individualClaSigningPhrase,
		})
		assert.equal(recorded.status, 'recorded')
		if (recorded.status !== 'recorded') {
			throw new Error('expected a new signature')
		}
		assert.equal(recorded.github, 'ExampleSigner')
		assert.deepEqual(recorded.file.signers, [
			{
				github: 'ExampleSigner',
				signedAt: '2026-08-16',
				cla: 'individual',
			},
		])
		assert.deepEqual(
			checkClaIdentities([{ githubLogin: 'examplesigner', name: 'Example', email: null }], recorded.file),
			{ ok: true },
		)

		const again = applyIndividualClaSigningComment({
			file: recorded.file,
			github: 'examplesigner',
			signedAt: '2026-08-17',
			comment: individualClaSigningPhrase,
		})
		assert.deepEqual(again, {
			file: recorded.file,
			status: 'already_signed',
			github: 'examplesigner',
		})
		const serialized = serializeClaSignersFile(recorded.file)
		assert.match(serialized, /"ExampleSigner"/)
		assert.equal(serialized.endsWith('\n'), true)
		assert.deepEqual(parseClaSignersFile(serialized), recorded.file)
		assert.throws(() => parseClaSignersFile('{"version":2}'), /version 1/)
		assert.deepEqual(
			applyIndividualClaSigningComment({
				file: empty,
				github: '   ',
				signedAt: '2026-08-16',
				comment: individualClaSigningPhrase,
			}),
			{ file: empty, status: 'ignored', reason: 'missing_login' },
		)
	})
})
