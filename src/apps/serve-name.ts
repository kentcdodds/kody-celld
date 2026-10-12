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
