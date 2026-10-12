import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { packageAppLinks } from './links.ts'

const uid = 'user_0123456789abcdef0123456789abcdef'

describe('packageAppLinks', () => {
	it('returns the app URL and the Kody open link', () => {
		assert.deepEqual(
			packageAppLinks(
				{ KODY_APP_BASE_URL: 'https://apps.example', KODY_PUBLIC_URL: 'https://kody.example/' },
				uid,
				'@s/notes',
			),
			{
				url: `https://apps.example/u/${uid}/packages/@s/notes/`,
				openUrl: 'https://kody.example/apps/open?package=%40s%2Fnotes',
			},
		)
	})
	it('explains why there is no link', () => {
		assert.equal(
			(packageAppLinks({ KODY_PUBLIC_URL: 'https://kody.example' }, uid, 'n') as { error: string }).error,
			'apps_disabled',
		)
		assert.equal(
			(
				packageAppLinks(
					{ KODY_APP_BASE_URL: 'https://kody.example', KODY_PUBLIC_URL: 'https://kody.example' },
					uid,
					'n',
				) as { error: string }
			).error,
			'app_origin_misconfigured',
		)
		assert.equal(
			(
				packageAppLinks(
					{ KODY_APP_BASE_URL: 'https://*.apps.example', KODY_PUBLIC_URL: 'https://kody.example' },
					'admin',
					'n',
				) as { error: string }
			).error,
			'app_origin_unmappable',
		)
	})
})
