import type { Env } from '../env.ts'
import { limitsFromEnv } from '../lib/limits.ts'

/** Package apps record failures only: a build error, a throw, a >= 500 response, or a timeout. */
export async function recordAppFailure(
	env: Env,
	input: {
		userId: string
		packageName: string
		error: { name: string; message: string }
		logs?: Array<unknown>
	},
) {
	try {
		const userCell = env.USER.getByName(input.userId)
		const { run } = await userCell.runStart({ kind: 'app', packageName: input.packageName })
		await userCell.runFinish({
			id: run.id,
			status: 'error',
			error: input.error,
			logsJson: JSON.stringify((input.logs ?? []).slice(0, limitsFromEnv(env).runLogLimit)),
			durationMs: 0,
		})
	} catch (error) {
		console.warn('[kody-celld] package-app run report failed', error)
	}
}
