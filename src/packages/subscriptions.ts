import type { Env } from '../env.ts'
import { executeRun, getUserCell } from '../execute/engine.ts'
import type { SubscriptionTopic } from './manifest.ts'

type Exports = ExecutionContext['exports']

/** Runs every package handler subscribed to `topic` for this user; failures land in run history, not here. */
export async function dispatchTopic(
	env: Env,
	exports: Exports,
	user: { id: string; email: string },
	topic: SubscriptionTopic,
	payload: Record<string, unknown>,
) {
	const userCell = getUserCell(env, user.id)
	const subscriptions = await userCell.subscriptionList({ topic })
	await Promise.all(
		subscriptions.map(async (subscription) => {
			try {
				await executeRun(env, exports, {
					kind: 'subscription',
					user: { id: user.id, email: user.email },
					entry: { kind: 'package', packageName: subscription.packageName, entryPath: subscription.handler },
					params: { topic, packageName: subscription.packageName, ...payload },
					trigger: `subscription:${topic}`,
				})
			} catch (error) {
				console.error(`subscription ${subscription.packageName} (${topic}) failed:`, error)
			}
		}),
	)
}
