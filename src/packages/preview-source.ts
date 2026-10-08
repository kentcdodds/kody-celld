import { KodyError } from '../lib/errors.ts'

export type PreviewSourceRef = { source: string; subdir: string | null }

const maxSourceLength = 2048
const utf8 = new TextEncoder()

/**
 * kody's files explorer links every entry as `filesBasePath/<path>`, so the
 * preview route keeps the package source in one path segment:
 * base64url(UTF-8 JSON `[source]` or `[source, subdir]`).
 */
export function encodePreviewSource(ref: PreviewSourceRef): string {
	const json = JSON.stringify(ref.subdir ? [ref.source, ref.subdir] : [ref.source])
	let binary = ''
	for (const byte of utf8.encode(json)) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodePreviewSource(segment: string): PreviewSourceRef {
	const invalid = () =>
		new KodyError('invalid_preview_source', 'This package preview link is not valid.', { status: 400 })
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw invalid()
	let parsed: unknown
	try {
		const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
	} catch {
		throw invalid()
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2) throw invalid()
	const [source, subdir] = parsed as Array<unknown>
	if (typeof source !== 'string' || !source || source.length > maxSourceLength) throw invalid()
	if (subdir !== undefined && (typeof subdir !== 'string' || !subdir || subdir.length > maxSourceLength)) {
		throw invalid()
	}
	return { source, subdir: typeof subdir === 'string' ? subdir : null }
}
