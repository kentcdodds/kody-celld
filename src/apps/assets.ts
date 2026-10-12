// `/_assets/*` for package apps: files under `kody.app.assets`, answered by the
// host before the app's fetch handler runs. Packages hold UTF-8 text only, so
// binary assets cannot exist yet (docs/known-gaps.md).
import { sha256Hex } from '../lib/crypto.ts'

const contentTypes: Record<string, string> = {
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	map: 'application/json; charset=utf-8',
	webmanifest: 'application/manifest+json; charset=utf-8',
	svg: 'image/svg+xml',
	html: 'text/html; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	xml: 'application/xml; charset=utf-8',
}

export function isAssetPath(restPath: string) {
	return restPath === '/_assets' || restPath.startsWith('/_assets/')
}

function plain(status: number, message: string, extra: Record<string, string> = {}) {
	return new Response(message, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			...extra,
		},
	})
}

function relativeAssetPath(restPath: string): string | null {
	let decoded: string
	try {
		decoded = decodeURIComponent(restPath.slice('/_assets/'.length))
	} catch {
		return null
	}
	const segments = decoded.split('/')
	if (decoded === '' || segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) return null
	return segments.join('/')
}

function matchesEtag(header: string | null, etag: string) {
	if (!header) return false
	return header.split(',').some((entry) => {
		const value = entry.trim()
		return value === '*' || value.replace(/^W\//, '') === etag
	})
}

export async function serveAppAsset(input: {
	request: Request
	restPath: string
	files: Record<string, string>
	assetsDir: string | null
}): Promise<Response> {
	if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
		return plain(405, 'Assets accept GET and HEAD.', { allow: 'GET, HEAD' })
	}
	if (!input.assetsDir) return plain(404, 'Not found.')
	const relative = relativeAssetPath(input.restPath)
	// __version.json answers 404: this host does not build kody.app.client bundles.
	if (!relative || relative === '__version.json') return plain(404, 'Not found.')
	const content = input.files[`${input.assetsDir}/${relative}`]
	if (content === undefined) return plain(404, 'Not found.')
	const etag = `"${await sha256Hex(content)}"`
	const headers = {
		'content-type': contentTypes[relative.split('.').pop()?.toLowerCase() ?? ''] ?? 'text/plain; charset=utf-8',
		'cache-control': 'private, max-age=300',
		etag,
		'x-content-type-options': 'nosniff',
	}
	if (matchesEtag(input.request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })
	return new Response(input.request.method === 'HEAD' ? null : content, { status: 200, headers })
}
