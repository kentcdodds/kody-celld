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

export type EncryptedValue = { iv: string; ciphertext: string; keyId?: string | undefined }

/** Short, non-reversible identifier for a master key so rows can say which key sealed them. */
export async function masterKeyId(masterKey: string) {
	return (await sha256Hex(`kody-celld-master-key:${masterKey}`)).slice(0, 16)
}

export type MasterKeyring = {
	/** The key new values are sealed with. */
	current: { id: string; key: string }
	/** Every key that may still decrypt, current first. */
	all: Array<{ id: string; key: string }>
}

/**
 * Builds the keyring from KODY_MASTER_KEY (current) and KODY_MASTER_KEY_PREVIOUS
 * (comma-separated retired keys kept only until every row is re-sealed).
 */
export async function buildMasterKeyring(current: string, previous?: string | undefined): Promise<MasterKeyring> {
	const keys = [current, ...(previous ?? '').split(',')].map((k) => k.trim()).filter(Boolean)
	const all = await Promise.all(keys.map(async (key) => ({ id: await masterKeyId(key), key })))
	const unique = all.filter((entry, index) => all.findIndex((other) => other.id === entry.id) === index)
	return { current: unique[0]!, all: unique }
}

export async function encryptSecretValue(
	masterKey: string,
	userId: string,
	plaintext: string,
): Promise<EncryptedValue> {
	const key = await deriveUserKey(masterKey, userId)
	const iv = new Uint8Array(12)
	crypto.getRandomValues(iv)
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
	return { iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(ciphertext)), keyId: await masterKeyId(masterKey) }
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

/**
 * Decrypts with whichever keyring entry sealed the value. Rows written before
 * key ids existed carry no keyId and are tried against every key in order.
 */
export async function decryptWithKeyring(keyring: MasterKeyring, userId: string, value: EncryptedValue) {
	const candidates = value.keyId ? keyring.all.filter((k) => k.id === value.keyId) : keyring.all
	if (candidates.length === 0) {
		throw new Error(`No master key with id ${value.keyId} is configured (KODY_MASTER_KEY_PREVIOUS).`)
	}
	let lastError: unknown
	for (const candidate of candidates) {
		try {
			return await decryptSecretValue(candidate.key, userId, value)
		} catch (error) {
			lastError = error
		}
	}
	throw lastError instanceof Error ? lastError : new Error('Secret value could not be decrypted.')
}
