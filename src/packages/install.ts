import { KodyError } from '../lib/errors.ts'
import { isPrivateHostname } from '../lib/private-hosts.ts'
import { hostMatchesApproval } from '../secrets/host-policy.ts'
import type { PackageFiles } from './manifest.ts'
import { gunzip, isGzip, readTar, type TarEntry } from './tar.ts'

/**
 * Installing a package from somewhere else: a GitHub repository (tarball via
 * codeload), a `.tar.gz` / `.tgz` URL, or a JSON file map. The server fetches
 * the source itself, so every hop is checked against KODY_PACKAGE_SOURCE_HOSTS
 * and refused for loopback/private hosts (SSRF guard). The result is a plain
 * file map handed to `UserCell.packageSave`, so provenance, quotas and manifest
 * validation are exactly the same as for a hand-written package.
 */

export type PackageSourceEnv = {
	/** Comma-separated hostnames (or `*.suffix`, or `*` for any public host) packages may be fetched from. */
	KODY_PACKAGE_SOURCE_HOSTS?: string
}

export const defaultPackageSourceHosts = [
	'github.com',
	'codeload.github.com',
	'raw.githubusercontent.com',
	'gist.githubusercontent.com',
	'objects.githubusercontent.com',
]

export const packageSourceLimits = {
	/** Compressed / raw response body. */
	maxDownloadBytes: 8 * 1024 * 1024,
	/** After gunzip. */
	maxArchiveBytes: 24 * 1024 * 1024,
	maxFiles: 400,
	maxRedirects: 3,
	timeoutMs: 20_000,
}

export function packageSourceHostsFromEnv(env: PackageSourceEnv): Array<string> {
	const raw = env.KODY_PACKAGE_SOURCE_HOSTS?.trim()
	if (!raw) return defaultPackageSourceHosts
	const hosts = raw
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
	for (const host of hosts) {
		if (host !== '*' && !/^(\*\.)?[a-z0-9.-]+$/.test(host)) {
			throw new Error(`KODY_PACKAGE_SOURCE_HOSTS: "${host}" is not a hostname or *.suffix pattern.`)
		}
	}
	return hosts
}

export type GithubSource = {
	kind: 'github'
	owner: string
	repo: string
	ref: string | null
	subdir: string | null
}
export type UrlSource = { kind: 'url'; url: string; subdir: string | null }
export type PackageSource = GithubSource | UrlSource

const githubName = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const githubRepo = /^[A-Za-z0-9._-]+$/

function normalizeSubdir(raw: string | null | undefined) {
	if (raw === null || raw === undefined) return null
	const parts = raw
		.split('/')
		.map((p) => p.trim())
		.filter((p) => p !== '' && p !== '.')
	if (parts.length === 0) return null
	if (parts.some((p) => p === '..')) throw new KodyError('invalid_args', 'subdir may not contain "..".')
	return parts.join('/')
}

function githubSource(owner: string, repo: string, ref: string | null, subdir: string | null): GithubSource {
	if (!githubName.test(owner)) throw new KodyError('invalid_args', `"${owner}" is not a GitHub owner name.`)
	const cleanRepo = repo.replace(/\.git$/, '')
	if (!githubRepo.test(cleanRepo) || cleanRepo === '.' || cleanRepo === '..') {
		throw new KodyError('invalid_args', `"${repo}" is not a GitHub repository name.`)
	}
	if (ref !== null && (ref === '' || /[\s\\:?*[\]~^]|\.\.|^-|\/$|^\//.test(ref))) {
		throw new KodyError('invalid_args', `"${ref}" is not a valid git ref.`)
	}
	return { kind: 'github', owner, repo: cleanRepo, ref, subdir: normalizeSubdir(subdir) }
}

/**
 * Accepts `github:owner/repo[/sub/dir][#ref]`, `https://github.com/owner/repo[.git]`,
 * `https://github.com/owner/repo/tree/<ref>/<sub/dir>`, or any other http(s) URL
 * (tarball or JSON file map).
 */
export function parsePackageSource(spec: string, subdir?: string | null): PackageSource {
	const text = spec.trim()
	if (!text) throw new KodyError('invalid_args', 'source must be a non-empty string.')
	if (text.startsWith('github:')) {
		const [pathPart = '', ...refParts] = text.slice('github:'.length).split('#')
		const ref = refParts.length > 0 ? refParts.join('#') : null
		const [owner = '', repo = '', ...rest] = pathPart.split('/')
		if (!owner || !repo) throw new KodyError('invalid_args', 'Use github:owner/repo[/subdir][#ref].')
		return githubSource(owner, repo, ref, subdir ?? (rest.length > 0 ? rest.join('/') : null))
	}
	let url: URL
	try {
		url = new URL(text)
	} catch {
		throw new KodyError('invalid_args', `"${text}" is not a URL or github:owner/repo source.`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new KodyError('invalid_args', 'Only http(s) and github: sources are supported.')
	}
	if (url.username || url.password) throw new KodyError('invalid_args', 'Sources may not embed credentials.')
	if (url.hostname.toLowerCase() === 'github.com' || url.hostname.toLowerCase() === 'www.github.com') {
		const segments = url.pathname.split('/').filter(Boolean)
		const [owner, repo, mode, ref, ...rest] = segments
		if (owner && repo && (segments.length === 2 || (mode === 'tree' && ref))) {
			return githubSource(
				owner,
				repo,
				mode === 'tree' ? (ref ?? null) : null,
				subdir ?? (rest.length > 0 ? rest.join('/') : null),
			)
		}
	}
	url.hash = ''
	return { kind: 'url', url: url.toString(), subdir: normalizeSubdir(subdir) }
}

export function describePackageSource(source: PackageSource) {
	if (source.kind === 'github') {
		const path = source.subdir ? `/${source.subdir}` : ''
		return `github:${source.owner}/${source.repo}${path}${source.ref ? `#${source.ref}` : ''}`
	}
	return source.subdir ? `${source.url}#${source.subdir}` : source.url
}

export function githubTarballUrl(source: GithubSource) {
	return `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(source.ref ?? 'HEAD')}`
}

export function assertAllowedSourceUrl(raw: string, allowedHosts: Array<string>) {
	const url = new URL(raw)
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new KodyError('package_source_refused', `Refusing non-http(s) source ${url.protocol}`, { status: 403 })
	}
	if (url.username || url.password) {
		throw new KodyError('package_source_refused', 'Sources may not embed credentials.', { status: 403 })
	}
	const host = url.hostname.toLowerCase()
	// Private/LAN hosts (a Gitea on the NAS, say) need an exact allowlist entry
	// from the operator; `*` and `*.suffix` patterns never reach them.
	if (isPrivateHostname(host) && !allowedHosts.includes(host)) {
		throw new KodyError(
			'package_source_refused',
			`"${host}" is a loopback/private host; list it exactly in KODY_PACKAGE_SOURCE_HOSTS to allow it.`,
			{ status: 403 },
		)
	}
	const allowed = allowedHosts.some((entry) => entry === '*' || hostMatchesApproval(host, entry))
	if (!allowed) {
		throw new KodyError(
			'package_source_refused',
			`"${host}" is not in KODY_PACKAGE_SOURCE_HOSTS (${allowedHosts.join(', ')}).`,
			{ status: 403 },
		)
	}
	return url
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

async function readBody(response: Response, maxBytes: number) {
	const reader = response.body?.getReader()
	if (!reader) return new Uint8Array(0)
	const chunks: Array<Uint8Array> = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxBytes) {
			await reader.cancel()
			throw new KodyError('invalid_package', `Source is larger than ${maxBytes} bytes.`)
		}
		chunks.push(value)
	}
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out
}

/** Fetches with redirects followed by hand so every hop passes the host checks. */
export async function fetchAllowed(
	raw: string,
	allowedHosts: Array<string>,
	fetchImpl: FetchLike = (input, init) => fetch(input, init),
) {
	let current = assertAllowedSourceUrl(raw, allowedHosts).toString()
	for (let hop = 0; hop <= packageSourceLimits.maxRedirects; hop += 1) {
		const response = await fetchImpl(current, {
			redirect: 'manual',
			headers: {
				'user-agent': 'kody-celld/0.1 (package-install)',
				accept: 'application/octet-stream, application/json, */*',
			},
			signal: AbortSignal.timeout(packageSourceLimits.timeoutMs),
		})
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location')
			if (!location)
				throw new KodyError('package_source_failed', `${current} redirected without a location.`, { status: 502 })
			current = assertAllowedSourceUrl(new URL(location, current).toString(), allowedHosts).toString()
			continue
		}
		if (!response.ok) {
			throw new KodyError(
				'package_source_failed',
				`${new URL(current).host} returned ${response.status} for ${current}.`,
				{
					status: response.status === 404 ? 404 : 502,
				},
			)
		}
		return {
			url: current,
			contentType: response.headers.get('content-type') ?? '',
			bytes: await readBody(response, packageSourceLimits.maxDownloadBytes),
		}
	}
	throw new KodyError('package_source_failed', 'Too many redirects.', { status: 502 })
}

const skippedDirs = new Set(['.git', 'node_modules'])
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function stripCommonRoot(entries: Array<TarEntry>) {
	const paths = entries.map((e) => e.path.replace(/^\.\//, ''))
	const firsts = new Set(paths.map((p) => p.split('/')[0] ?? ''))
	if (firsts.size !== 1 || paths.some((p) => !p.includes('/')))
		return entries.map((e, i) => ({ ...e, path: paths[i]! }))
	return entries.map((e, i) => ({ ...e, path: paths[i]!.slice(paths[i]!.indexOf('/') + 1) }))
}

/** Turns tar entries into a package file map rooted at `subdir` (or the archive root). */
export function filesFromTarEntries(entries: Array<TarEntry>, subdir: string | null) {
	const files: PackageFiles = {}
	const warnings: Array<string> = []
	const manifestDirs = new Set<string>()
	const rooted = stripCommonRoot(entries)
	const prefix = subdir ? `${subdir}/` : ''
	for (const entry of rooted) {
		const segments = entry.path.split('/')
		if (segments.some((s) => s === '..' || s === '')) continue
		if (segments.some((s) => skippedDirs.has(s))) continue
		if (segments.at(-1) === 'package.json') manifestDirs.add(segments.slice(0, -1).join('/'))
		if (!entry.path.startsWith(prefix)) continue
		const relative = entry.path.slice(prefix.length)
		try {
			files[relative] = utf8.decode(entry.bytes)
		} catch {
			warnings.push(`Skipped ${relative}: not UTF-8 text (packages hold text files only).`)
		}
	}
	if (files['package.json'] === undefined) {
		const candidates = [...manifestDirs].filter((d) => d !== '').sort()
		const hint =
			candidates.length > 0
				? ` package.json was found in: ${candidates.slice(0, 8).join(', ')}. Pass one as subdir.`
				: subdir
					? ` Nothing under "${subdir}" in the archive.`
					: ''
		throw new KodyError('invalid_package', `No package.json at the package root.${hint}`)
	}
	return { files, warnings }
}

function isTar(bytes: Uint8Array) {
	if (bytes.length < 512) return false
	const magic = new TextDecoder().decode(bytes.subarray(257, 262))
	return magic === 'ustar'
}

/** Parses a JSON body as `{ files: {...} }` or a bare `{ path: content }` map. */
export function filesFromJson(text: string, subdir: string | null) {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new KodyError('invalid_package', 'Source is neither a tarball nor JSON.')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new KodyError('invalid_package', 'JSON source must be an object.')
	}
	const record = parsed as Record<string, unknown>
	const map =
		typeof record.files === 'object' && record.files !== null && !Array.isArray(record.files)
			? (record.files as Record<string, unknown>)
			: record
	const files: PackageFiles = {}
	const prefix = subdir ? `${subdir}/` : ''
	for (const [path, content] of Object.entries(map)) {
		if (typeof content !== 'string') {
			throw new KodyError('invalid_package', `File "${path}" must be a string.`)
		}
		const clean = path.replace(/^\.\//, '')
		if (!clean.startsWith(prefix)) continue
		files[clean.slice(prefix.length)] = content
	}
	if (files['package.json'] === undefined) {
		throw new KodyError('invalid_package', 'JSON source has no package.json at the package root.')
	}
	return { files, warnings: [] as Array<string> }
}

export type FetchedPackage = {
	files: PackageFiles
	warnings: Array<string>
	/** Provenance string stored as the package `source`. */
	source: string
	fetchedFrom: string
}

export async function fetchPackageSource(
	source: PackageSource,
	options: { allowedHosts: Array<string>; fetch?: FetchLike | undefined },
): Promise<FetchedPackage> {
	const url = source.kind === 'github' ? githubTarballUrl(source) : source.url
	const downloaded = await fetchAllowed(url, options.allowedHosts, options.fetch)
	let result: { files: PackageFiles; warnings: Array<string> }
	if (isGzip(downloaded.bytes)) {
		const archive = await gunzip(downloaded.bytes, packageSourceLimits.maxArchiveBytes)
		const entries = readTar(archive, {
			maxFiles: packageSourceLimits.maxFiles,
			maxTotalBytes: packageSourceLimits.maxArchiveBytes,
		})
		result = filesFromTarEntries(entries, source.subdir)
	} else if (isTar(downloaded.bytes)) {
		const entries = readTar(downloaded.bytes, {
			maxFiles: packageSourceLimits.maxFiles,
			maxTotalBytes: packageSourceLimits.maxArchiveBytes,
		})
		result = filesFromTarEntries(entries, source.subdir)
	} else {
		let text: string
		try {
			text = utf8.decode(downloaded.bytes)
		} catch {
			throw new KodyError('invalid_package', 'Source is neither a tarball nor UTF-8 JSON.')
		}
		result = filesFromJson(text, source.subdir)
	}
	return { ...result, source: describePackageSource(source), fetchedFrom: downloaded.url }
}
