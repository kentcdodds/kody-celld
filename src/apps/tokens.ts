// Cross-site auth for package apps (hosted kody `app/package-app-handoff.ts`).
// The Kody origin mints a one-minute, single-use token bound to one user and
// one package; the app origin swaps it for its own host-only cookie. Both
// values are `<base64url JSON>.<base64url HMAC-SHA256>` keyed by
// KODY_MASTER_KEY, with a purpose string so one can never stand in for the other.

const encoder = new TextEncoder()
const handoffPurpose = 'kody-celld:app-handoff:v1'
const sessionPurpose = 'kody-celld:app-session:v1'

export const handoffTtlMs = 60_000
export const appSessionMaxMs = 12 * 60 * 60 * 1000

export type HandoffClaims = { v: 1; uid: string; pkg: string; sid: string; exp: number; jti: string }
export type HandoffResult =
	| { ok: true; claims: HandoffClaims }
	| { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' | 'replay' }
export type AppSessionClaims = { v: 1; uid: string; sid: string; exp: number }

function toBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
	try {
		const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
		return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
	} catch {
		return null
	}
}

async function hmacKey(masterKey: string) {
	return crypto.subtle.importKey('raw', encoder.encode(masterKey), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify',
	])
}

async function seal(masterKey: string, purpose: string, claims: object) {
	const payload = toBase64Url(encoder.encode(JSON.stringify(claims)))
	const signature = await crypto.subtle.sign('HMAC', await hmacKey(masterKey), encoder.encode(`${purpose}.${payload}`))
	return `${payload}.${toBase64Url(new Uint8Array(signature))}`
}

async function unseal(
	masterKey: string,
	purpose: string,
	value: string,
): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; reason: 'malformed' | 'signature' }> {
	const parts = value.split('.')
	if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' }
	const [payload, signature] = parts as [string, string]
	const signatureBytes = fromBase64Url(signature)
	if (!signatureBytes) return { ok: false, reason: 'malformed' }
	const valid = await crypto.subtle.verify(
		'HMAC',
		await hmacKey(masterKey),
		signatureBytes,
		encoder.encode(`${purpose}.${payload}`),
	)
	if (!valid) return { ok: false, reason: 'signature' }
	const bytes = fromBase64Url(payload)
	if (!bytes) return { ok: false, reason: 'malformed' }
	try {
		const claims = JSON.parse(new TextDecoder().decode(bytes)) as unknown
		if (typeof claims !== 'object' || claims === null || Array.isArray(claims))
			return { ok: false, reason: 'malformed' }
		return { ok: true, claims: claims as Record<string, unknown> }
	} catch {
		return { ok: false, reason: 'malformed' }
	}
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export async function mintHandoff(
	masterKey: string,
	input: { uid: string; pkg: string; sid: string },
	now = Date.now(),
): Promise<string> {
	const claims: HandoffClaims = { v: 1, ...input, exp: now + handoffTtlMs, jti: crypto.randomUUID() }
	return seal(masterKey, handoffPurpose, claims)
}

/**
 * Signature → expiry → user/package binding → burn. The binding is checked
 * before the burn so a mistyped URL does not waste the owner's token.
 */
export async function consumeHandoff(input: {
	masterKey: string
	token: string
	expected: { uid: string; pkg: string }
	burn: (jti: string, expiresAtMs: number) => Promise<boolean>
	now?: number
}): Promise<HandoffResult> {
	const now = input.now ?? Date.now()
	const opened = await unseal(input.masterKey, handoffPurpose, input.token)
	if (!opened.ok) return opened
	const c = opened.claims
	if (c.v !== 1 || !isText(c.uid) || !isText(c.pkg) || !isText(c.sid) || !isText(c.jti) || !isTime(c.exp)) {
		return { ok: false, reason: 'malformed' }
	}
	if (c.exp <= now) return { ok: false, reason: 'expired' }
	if (c.uid !== input.expected.uid || c.pkg !== input.expected.pkg) return { ok: false, reason: 'mismatch' }
	if (!(await input.burn(c.jti, c.exp))) return { ok: false, reason: 'replay' }
	return { ok: true, claims: { v: 1, uid: c.uid, pkg: c.pkg, sid: c.sid, exp: c.exp, jti: c.jti } }
}

export async function signAppSession(masterKey: string, input: { uid: string; sid: string; exp: number }) {
	const claims: AppSessionClaims = { v: 1, ...input }
	return seal(masterKey, sessionPurpose, claims)
}

export async function verifyAppSession(
	masterKey: string,
	value: string,
	now = Date.now(),
): Promise<AppSessionClaims | null> {
	const opened = await unseal(masterKey, sessionPurpose, value)
	if (!opened.ok) return null
	const c = opened.claims
	if (c.v !== 1 || !isText(c.uid) || !isText(c.sid) || !isTime(c.exp) || c.exp <= now) return null
	return { v: 1, uid: c.uid, sid: c.sid, exp: c.exp }
}
