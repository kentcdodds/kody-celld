// M2 hardening smoke: usageGet, per-user quotas (429 quota_exceeded), admin
// quota override, execute timeout, and the admin audit log (never values).
//
// Set SMOKE_EXPECT_TIMEOUT_MS=<n> when the server runs with
// KODY_EXECUTE_TIMEOUT_MS=<n> to also prove a long run is cut off at n ms.
import { randomBytes } from 'node:crypto'
import { admin, assert, bootstrapUser, log } from './lib.mjs'

const busyLoop = `export default async function main({ ms }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { slept: ms }
}`

export async function smokeLimits({ mcp, user }) {
	const limitsRes = await admin.limits()
	assert(limitsRes.status === 200, 'GET /admin/limits failed', limitsRes.json)
	const { limits, quotaDefaults } = limitsRes.json
	assert(Number.isInteger(limits.executeTimeoutMs) && limits.executeTimeoutMs >= 1000, 'limits missing', limits)
	log('limits', { timeoutMs: limits.executeTimeoutMs, retention: limits.runRetentionCount, quotaDefaults })

	const before = await mcp.call('usageGet', { days: 2 })
	assert(before.today.runs >= 1, 'usageGet should count the run that called it', before.today)
	assert(before.limits.executeTimeoutMs === limits.executeTimeoutMs, 'usageGet limits mismatch', before.limits)
	assert(before.quotaOverride === null, 'fresh user should have no override', before.quotaOverride)
	log('usageGet', { today: before.today, counts: before.counts })

	// A separate user so the quota clamp cannot interfere with other scenarios.
	const quotaUser = await bootstrapUser('quota')
	await quotaUser.mcp.initialize()
	const seen = await quotaUser.mcp.call('usageGet')
	const runsSoFar = seen.today.runs
	const set = await admin.setQuota(quotaUser.user.id, { runsPerDay: runsSoFar + 1, secrets: 1 })
	assert(set.status === 200 && set.json.quotas.runsPerDay === runsSoFar + 1, 'quota override failed', set.json)
	const secretValue = randomBytes(24).toString('hex')
	const first = await quotaUser.mcp.execute(
		`import { kody } from 'kody:runtime'
export default async function main({ value }) {
  await kody.secretSave({ name: 'quota-one', value })
  try {
    await kody.secretSave({ name: 'quota-two', value })
    return { secondSaved: true }
  } catch (error) {
    return { secondSaved: false, error: String(error.message) }
  }
}`,
		{ value: secretValue },
	)
	assert(first.ok, 'run within quota should succeed', first.error)
	assert(
		first.result.secondSaved === false && /quota/i.test(first.result.error),
		'secrets quota not enforced',
		first.result,
	)
	const blocked = await quotaUser.mcp.tool('execute', { code: busyLoop, params: { ms: 1 } })
	assert(blocked.isError, 'run over the daily quota should be rejected', blocked.payload)
	const blockedText = JSON.stringify(blocked.payload ?? blocked.content)
	assert(/quota_exceeded/.test(blockedText), 'expected quota_exceeded', blocked.payload ?? blocked.content)
	const usage = await admin.usage(quotaUser.user.id)
	assert(
		usage.status === 200 && usage.json.today.runs === runsSoFar + 1,
		'rejected run must not count',
		usage.json.today,
	)
	assert(usage.json.counts.secrets === 1, 'exactly one secret should exist', usage.json.counts)
	const cleared = await admin.clearQuota(quotaUser.user.id)
	assert(cleared.status === 200 && cleared.json.override === null, 'clearing the override failed', cleared.json)
	const afterClear = await quotaUser.mcp.run(busyLoop, { ms: 1 })
	assert(afterClear.slept === 1, 'run after clearing quota should succeed', afterClear)
	log('quotas', { runsPerDay: runsSoFar + 1, blocked: 'quota_exceeded', cleared: true })

	const expectTimeout = Number(process.env.SMOKE_EXPECT_TIMEOUT_MS ?? 0)
	if (expectTimeout > 0) {
		assert(limits.executeTimeoutMs === expectTimeout, 'server timeout differs from SMOKE_EXPECT_TIMEOUT_MS', limits)
		const started = Date.now()
		const slow = await mcp.execute(busyLoop, { ms: expectTimeout * 3 })
		const elapsed = Date.now() - started
		assert(!slow.ok && /execute_timeout/.test(slow.error?.name ?? ''), 'expected execute_timeout', slow.error)
		assert(elapsed < expectTimeout * 2.5, 'timeout fired too late', { elapsed, expectTimeout })
		log('timeout', { configuredMs: expectTimeout, elapsedMs: elapsed, error: slow.error.name })
	} else {
		log('timeout', 'skipped (set SMOKE_EXPECT_TIMEOUT_MS with KODY_EXECUTE_TIMEOUT_MS to verify)')
	}

	const auditRes = await admin.audit({ limit: 200 })
	assert(auditRes.status === 200, 'GET /admin/audit failed', auditRes.json)
	const entries = auditRes.json.entries
	const actions = new Set(entries.map((entry) => entry.action))
	for (const expected of ['user.create', 'quota.set', 'quota.clear', 'secret.save']) {
		assert(actions.has(expected), `audit log is missing ${expected}`, [...actions])
	}
	const quotaEntries = entries.filter((entry) => entry.target === quotaUser.user.id)
	assert(
		quotaEntries.some((entry) => entry.action === 'quota.set' && entry.actor === 'admin'),
		'admin actor missing',
	)
	assert(
		entries.some((entry) => entry.actor === `user:${quotaUser.user.id}` && entry.target === 'quota-one'),
		'user secret.save should be audited by name',
	)
	const serialized = JSON.stringify(entries)
	assert(!serialized.includes(secretValue), 'AUDIT LOG LEAKED A SECRET VALUE')
	assert(!serialized.includes(quotaUser.token), 'AUDIT LOG LEAKED A USER TOKEN')
	const filtered = await admin.audit({ action: 'quota.', actor: 'admin' })
	assert(
		filtered.json.entries.every((entry) => entry.action.startsWith('quota.')),
		'audit action filter failed',
	)
	log('audit', { entries: entries.length, actions: [...actions].sort() })

	const finalUsage = await mcp.call('usageGet')
	assert(finalUsage.today.runs > before.today.runs, 'usage should grow with runs', {
		before: before.today,
		after: finalUsage.today,
	})
	// Only finished runs are pruned; the run calling usageGet is still in flight.
	assert(finalUsage.counts.runsRetained <= limits.runRetentionCount + 1, 'retention count exceeded', finalUsage.counts)
	void user
}
