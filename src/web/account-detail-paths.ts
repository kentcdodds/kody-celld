import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'

const packageMatcher = createMatcher(routes.accountPackageDetail.pattern)
const packageFilesMatcher = createMatcher(routes.accountPackageFiles.pattern)
const jobMatcher = createMatcher(routes.accountJobDetail.pattern)

export type AccountDetailPath =
	| { kind: 'package'; name: string }
	| { kind: 'packageFiles'; name: string; relativePath: string | null }
	| { kind: 'job'; jobId: string }

export function matchAccountDetailPath(url: URL): AccountDetailPath | null {
	try {
		const packageFiles = packageFilesMatcher.match(url)
		if (packageFiles) {
			return {
				kind: 'packageFiles',
				name: packageFiles.params.name,
				relativePath: packageFiles.params.relativePath ?? null,
			}
		}

		const job = jobMatcher.match(url)
		if (job) return { kind: 'job', jobId: job.params.jobId }

		const pkg = packageMatcher.match(url)
		if (pkg) return { kind: 'package', name: pkg.params.name }
	} catch {
		return null
	}

	return null
}
