import { sha256Hex } from '../lib/crypto.ts'

/** One isolate per (user, package version, mount); re-saving the package changes the name. */
export async function appIsolateName(input: {
	userId: string
	packageName: string
	updatedAt: string
	hostedUrl: string
}) {
	return `kody-app-${await sha256Hex([input.userId, input.packageName, input.updatedAt, input.hostedUrl].join('\u0000'))}`
}

/** The loader isolate name: content-addressed like `executeRun`, so any changed module gets a fresh isolate. */
export async function appIsolateNameForGraph(input: {
	userId: string
	hostedUrl: string
	modules: Record<string, string>
}) {
	const parts = Object.keys(input.modules)
		.sort()
		.map((key) => `${key}\u0000${input.modules[key] ?? ''}`)
	return `kody-app-${await sha256Hex(`${input.userId}\u0000${input.hostedUrl}\u0000${parts.join('\u0001')}`)}`
}

/** True when two `packageStamps` snapshots name the same packages at the same `updated_at`. */
export function stampsMatch(a: Record<string, string>, b: Record<string, string>) {
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) return false
	return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}
