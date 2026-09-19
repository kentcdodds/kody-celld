import { bytesToHex, hexToBytes } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'

const encoder = new TextEncoder()

export const passwordMinLength = 12
export const passwordMaxLength = 256
/** PBKDF2-HMAC-SHA256 work factor (OWASP 2023 guidance is 600k; celld nodes are not browsers). */
export const passwordIterations = 600_000
const saltBytes = 16
const keyBytes = 32

export function validatePassword(password: unknown): string {
	if (typeof password !== 'string') throw new KodyError('invalid_password', 'A password is required.')
	if (password.length < passwordMinLength) {
		throw new KodyError('invalid_password', `Passwords need at least ${passwordMinLength} characters.`)
	}
	if (password.length > passwordMaxLength) {
		throw new KodyError('invalid_password', `Passwords may have at most ${passwordMaxLength} characters.`)
	}
	return password
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, [
		'deriveBits',
	])
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		key,
		keyBytes * 8,
	)
	return new Uint8Array(bits)
}

/** `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>` — self-describing so the work factor can grow later. */
export async function hashPassword(password: string, iterations = passwordIterations) {
	const salt = new Uint8Array(saltBytes)
	crypto.getRandomValues(salt)
	const hash = await derive(password, salt, iterations)
	return `pbkdf2-sha256$${iterations}$${bytesToHex(salt)}$${bytesToHex(hash)}`
}

export async function verifyPassword(password: string, stored: string) {
	const [scheme, iterationsRaw, saltHex, hashHex] = stored.split('$')
	if (scheme !== 'pbkdf2-sha256' || !iterationsRaw || !saltHex || !hashHex) return false
	const iterations = Number(iterationsRaw)
	if (!Number.isInteger(iterations) || iterations < 1_000) return false
	const expected = hexToBytes(hashHex)
	const actual = await derive(password, hexToBytes(saltHex), iterations)
	return constantTimeEqual(expected, actual)
}

/** Byte-wise comparison without early exit; portable to Node for tests (no `subtle.timingSafeEqual` there). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
	if (a.byteLength !== b.byteLength) return false
	let diff = 0
	for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
	return diff === 0
}

export function constantTimeEqualString(a: string, b: string) {
	return constantTimeEqual(encoder.encode(a), encoder.encode(b))
}

/** True when a stored hash uses an older work factor and should be re-hashed on next sign-in. */
export function passwordNeedsRehash(stored: string, iterations = passwordIterations) {
	const [, iterationsRaw] = stored.split('$')
	return !(Number(iterationsRaw) >= iterations)
}
