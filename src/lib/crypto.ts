const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
	return bytesToHex(new Uint8Array(digest))
}

export function bytesToHex(bytes: Uint8Array) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string) {
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}

export function randomToken(prefix: string, bytes = 24) {
	const raw = new Uint8Array(bytes)
	crypto.getRandomValues(raw)
	return `${prefix}_${bytesToHex(raw)}`
}

export function randomId(prefix: string) {
	return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function deriveUserKey(masterKey: string, userId: string) {
	const ikm = await crypto.subtle.importKey('raw', encoder.encode(masterKey), 'HKDF', false, ['deriveKey'])
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(`kody-celld:${userId}`),
			info: encoder.encode('kody-celld-secret-values'),
		},
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	)
}

export type EncryptedValue = { iv: string; ciphertext: string }

export async function encryptSecretValue(masterKey: string, userId: string, plaintext: string) {
	const key = await deriveUserKey(masterKey, userId)
	const iv = new Uint8Array(12)
	crypto.getRandomValues(iv)
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
	return { iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(ciphertext)) }
}

export async function decryptSecretValue(masterKey: string, userId: string, value: EncryptedValue) {
	const key = await deriveUserKey(masterKey, userId)
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: hexToBytes(value.iv) },
		key,
		hexToBytes(value.ciphertext),
	)
	return decoder.decode(plaintext)
}
