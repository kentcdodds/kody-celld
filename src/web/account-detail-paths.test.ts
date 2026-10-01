import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { routes } from '#universal/routes.ts'
import { matchAccountDetailPath } from './account-detail-paths.ts'

describe('matchAccountDetailPath', () => {
	it('round-trips package names through the typed detail route', () => {
		const href = routes.accountPackageDetail.href({ name: '@oz/ops-jobs' })
		assert.deepEqual(matchAccountDetailPath(new URL(href, 'http://localhost')), {
			kind: 'package',
			name: '@oz/ops-jobs',
		})
	})

	it('round-trips job ids containing encoded delimiters', () => {
		for (const jobId of ['@scope/pkg#job', '@scope/pkg/job']) {
			const href = routes.accountJobDetail.href({ jobId })
			assert.deepEqual(matchAccountDetailPath(new URL(href, 'http://localhost')), { kind: 'job', jobId })
		}
	})

	it('matches nested files and a files page without a selected path', () => {
		const nestedHref = routes.accountPackageFiles.href({
			name: '@oz/ops-jobs',
			relativePath: 'src/lib/a.js',
		})
		assert.deepEqual(matchAccountDetailPath(new URL(nestedHref, 'http://localhost')), {
			kind: 'packageFiles',
			name: '@oz/ops-jobs',
			relativePath: 'src/lib/a.js',
		})

		const filesHref = routes.accountPackageFiles.href({ name: '@oz/ops-jobs' })
		assert.deepEqual(matchAccountDetailPath(new URL(filesHref, 'http://localhost')), {
			kind: 'packageFiles',
			name: '@oz/ops-jobs',
			relativePath: null,
		})
	})

	it('does not match package or job list paths', () => {
		assert.equal(matchAccountDetailPath(new URL('/account/packages', 'http://localhost')), null)
		assert.equal(matchAccountDetailPath(new URL('/account/jobs', 'http://localhost')), null)
	})

	it('treats malformed percent-encoding as no match', () => {
		assert.doesNotThrow(() => matchAccountDetailPath(new URL('/account/packages/%E0%A4%A', 'http://localhost')))
		assert.equal(matchAccountDetailPath(new URL('/account/packages/%E0%A4%A', 'http://localhost')), null)
	})
})
