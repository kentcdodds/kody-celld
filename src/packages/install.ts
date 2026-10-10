import { KodyError } from '../lib/errors.ts'
import { isPrivateHostname } from '../lib/host-allowlist.ts'
import { hostMatchesApproval } from '../secrets/host-policy.ts'
import { cloneGitSmartHttp, normalizeGitUrl } from './git-smart-http.ts'
import { parsePackageManifest, type PackageFiles, type PackageManifest } from './manifest.ts'
import { gunzip, isGzip, readTar, type TarEntry } from './tar.ts'

/**
 * Installing a package from somewhere else: a GitHub repository (tarball via
 * codeload), a public kody.codes package (read-only smart-HTTP `.git` clone), a
 * `.tar.gz` / `.tgz` URL, or a JSON file map. The server fetches the source
 * itself, so every hop is checked against KODY_PACKAGE_SOURCE_HOSTS and refused
 * for loopback/private hosts (SSRF guard). The result is a plain file map handed
 * to `UserCell.packageSave`, so provenance, quotas and manifest validation are
 * exactly the same as for a hand-written package. Secrets are never transferred.
 */

export type PackageSourceEnv = {
	/** Comma-separated hostnames (or `*.suffix`, or `*` for any public host) packages may be fetched from. */
	KODY_PACKAGE_SOURCE_HOSTS?: string
}

export const defaultPackageSourceHosts = [
	'github.com',
	'api.github.com',
	'codeload.github.com',
	'raw.githubusercontent.com',
	'gist.githubusercontent.com',
	'objects.githubusercontent.com',
	'kody.codes',
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
/** Public hosted package cloned read-only via smart-HTTP (`…/@owner/leaf.git`). */
export type KodySource = {
	kind: 'kody'
	/** Origin without trailing slash, e.g. `https://kody.codes`. */
	origin: string
	owner: string
	name: string
	ref: string | null
	subdir: string | null
	/** Canonical clone URL (`…/@owner/name.git`). */
	gitUrl: string
}
export type UrlSource = { kind: 'url'; url: string; subdir: string | null }
export type PackageSource = GithubSource | KodySource | UrlSource

const githubName = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const githubRepo = /^[A-Za-z0-9._-]+$/
const kodyOwner = /^[a-z0-9][a-z0-9._-]{0,38}$/i
const kodyLeaf = /^[a-z0-9][a-z0-9._-]{0,63}$/i

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

function assertGitRef(ref: string | null) {
	if (ref !== null && (ref === '' || /[\s\\:?*[\]~^]|\.\.|^-|\/$|^\//.test(ref))) {
		throw new KodyError('invalid_args', `"${ref}" is not a valid git ref.`)
	}
}

function githubSource(owner: string, repo: string, ref: string | null, subdir: string | null): GithubSource {
	if (!githubName.test(owner)) throw new KodyError('invalid_args', `"${owner}" is not a GitHub owner name.`)
	const cleanRepo = repo.replace(/\.git$/, '')
	if (!githubRepo.test(cleanRepo) || cleanRepo === '.' || cleanRepo === '..') {
		throw new KodyError('invalid_args', `"${repo}" is not a GitHub repository name.`)
	}
	assertGitRef(ref)
	return { kind: 'github', owner, repo: cleanRepo, ref, subdir: normalizeSubdir(subdir) }
}

function kodySource(
	origin: string,
	owner: string,
	name: string,
	ref: string | null,
	subdir: string | null,
): KodySource {
	if (!kodyOwner.test(owner)) throw new KodyError('invalid_args', `"${owner}" is not a Kody package owner.`)
	const leaf = name.replace(/\.git$/i, '')
	if (!kodyLeaf.test(leaf)) throw new KodyError('invalid_args', `"${name}" is not a Kody package name.`)
	assertGitRef(ref)
	const base = origin.replace(/\/+$/, '')
	return {
		kind: 'kody',
		origin: base,
		owner,
		name: leaf,
		ref,
		subdir: normalizeSubdir(subdir),
		gitUrl: normalizeGitUrl(`${base}/@${owner}/${leaf}.git`),
	}
}

/** True when the path looks like a public package listing / `.git` URL (`/@owner/leaf`). */
export function isKodyPackagePath(pathname: string) {
	const segments = pathname.split('/').filter(Boolean)
	if (segments.length < 2) return false
	const owner = segments[0]!
	if (!owner.startsWith('@')) return false
	return kodyOwner.test(owner.slice(1)) && kodyLeaf.test(segments[1]!.replace(/\.git$/i, ''))
}

function parseKodyPath(url: URL, subdir?: string | null): KodySource | null {
	const segments = url.pathname.split('/').filter(Boolean)
	if (segments.length < 2) return null
	const ownerSeg = segments[0]!
	if (!ownerSeg.startsWith('@')) return null
	const owner = ownerSeg.slice(1)
	const leafSeg = segments[1]!
	const leaf = leafSeg.replace(/\.git$/i, '')
	if (!kodyOwner.test(owner) || !kodyLeaf.test(leaf)) return null
	const mode = segments[2]
	const hashRef = url.hash ? url.hash.replace(/^#/, '') : null
	if (mode === 'tree') {
		const ref = segments[3] ?? null
		const pathSubdir = segments.length > 4 ? segments.slice(4).join('/') : null
		return kodySource(url.origin, owner, leaf, ref, subdir ?? pathSubdir)
	}
	if (mode === 'blob') {
		return kodySource(url.origin, owner, leaf, hashRef, subdir ?? null)
	}
	if (mode !== undefined) return null
	return kodySource(url.origin, owner, leaf, hashRef, subdir ?? null)
}

/**
 * Accepts `github:owner/repo[/sub/dir][#ref]`, `https://github.com/owner/repo[.git]`,
 * `https://github.com/owner/repo/tree/<ref>/<sub/dir>`, public Kody package URLs
 * (`https://kody.codes/@owner/leaf[.git]`, `kody:@owner/leaf[#ref]`), or any other
 * http(s) URL (tarball or JSON file map).
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
	if (text.startsWith('kody:')) {
		const [pathPart = '', ...refParts] = text.slice('kody:'.length).split('#')
		const ref = refParts.length > 0 ? refParts.join('#') : null
		const cleaned = pathPart.replace(/^\/+/, '')
		const [ownerRaw = '', name = '', ...rest] = cleaned.split('/')
		const owner = ownerRaw.startsWith('@') ? ownerRaw.slice(1) : ownerRaw
		if (!owner || !name) throw new KodyError('invalid_args', 'Use kody:@owner/leaf[#ref].')
		return kodySource('https://kody.codes', owner, name, ref, subdir ?? (rest.length > 0 ? rest.join('/') : null))
	}
	let url: URL
	try {
		url = new URL(text)
	} catch {
		throw new KodyError('invalid_args', `"${text}" is not a URL, github:owner/repo, or kody:@owner/leaf source.`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new KodyError('invalid_args', 'Only http(s), github:, and kody: sources are supported.')
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
	const kody = parseKodyPath(url, subdir)
	if (kody) return kody
	url.hash = ''
	return { kind: 'url', url: url.toString(), subdir: normalizeSubdir(subdir) }
}

export function describePackageSource(source: PackageSource) {
	if (source.kind === 'github') {
		const path = source.subdir ? `/${source.subdir}` : ''
		return `github:${source.owner}/${source.repo}${path}${source.ref ? `#${source.ref}` : ''}`
	}
	if (source.kind === 'kody') {
		if (source.subdir) {
			return `${source.origin}/@${source.owner}/${source.name}/tree/${source.ref ?? 'HEAD'}/${source.subdir}`
		}
		return `${source.gitUrl}${source.ref ? `#${source.ref}` : ''}`
	}
	return source.subdir ? `${source.url}#${source.subdir}` : source.url
}

const fullCommitSha = /^[0-9a-f]{40}$/i

/** Commit SHA embedded in a final codeload URL after GitHub resolves HEAD/branch → SHA. */
export function commitShaFromCodeloadUrl(url: string): string | undefined {
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean)
		const tar = parts.findIndex((part) => part === 'tar.gz' || part === 'legacy.tar.gz')
		const ref = tar >= 0 ? parts[tar + 1] : undefined
		return ref && fullCommitSha.test(ref) ? ref.toLowerCase() : undefined
	} catch {
		return undefined
	}
}

/**
 * Codeload often answers 200 for HEAD/branch without putting the SHA in the URL
 * (root dir is `repo-ref/`). Resolve via the commits API *before* downloading so
 * preview pins the same tree Install will save.
 */
export async function resolveGithubCommitSha(
	source: GithubSource,
	options: { allowedHosts: Array<string>; fetch?: FetchLike | undefined },
): Promise<string | undefined> {
	const ref = source.ref ?? 'HEAD'
	if (fullCommitSha.test(ref)) return ref.toLowerCase()
	const apiUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`
	try {
		assertAllowedSourceUrl(apiUrl, options.allowedHosts)
	} catch {
		return undefined
	}
	try {
		const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
		const response = await fetchImpl(apiUrl, {
			headers: {
				accept: 'application/vnd.github.sha',
				'user-agent': 'kody-celld/0.1 (package-install)',
			},
			signal: AbortSignal.timeout(packageSourceLimits.timeoutMs),
		})
		if (!response.ok) return undefined
		const sha = (await response.text()).trim()
		return fullCommitSha.test(sha) ? sha.toLowerCase() : undefined
	} catch {
		return undefined
	}
}

/**
 * Rewrite a github:/kody: source string so its ref is an immutable commit SHA.
 * Preview links and install forms use this so Install fetches the same tree the
 * explorer showed (HEAD may have moved). Non-git sources are returned unchanged.
 */
export function pinPackageSourceToCommit(sourceText: string, commit: string | null | undefined): string {
	if (!commit || !fullCommitSha.test(commit)) return sourceText
	const sha = commit.toLowerCase()
	try {
		const source = parsePackageSource(sourceText)
		if (source.kind === 'github') {
			if (source.ref?.toLowerCase() === sha) return describePackageSource(source)
			return describePackageSource({ ...source, ref: sha })
		}
		if (source.kind === 'kody') {
			if (source.ref?.toLowerCase() === sha) return describePackageSource(source)
			return describePackageSource({ ...source, ref: sha })
		}
	} catch {
		return sourceText
	}
	return sourceText
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
	/** Immutable commit SHA when the source resolved to a git commit (clone or codeload). */
	commit?: string
}

export type PackagePreview = {
	source: string
	fetchedFrom: string
	commit: string | null
	name: string
	version: string
	description: string
	readme: string
	agents: string
	fileList: Array<string>
	fileCount: number
	/** Declared package surfaces (jobs / webhooks / subscriptions / secret provider / deps) — not runtime host approvals. */
	permissions: {
		jobs: Array<string>
		webhooks: Array<string>
		subscriptions: Array<string>
		secretProvider: string | null
		dependencies: Array<string>
	}
	manifest: PackageManifest
	warnings: Array<string>
	/** Full file map for an explicit follow-up install/fork (not persisted until then). */
	files: PackageFiles
}

export function packagePreviewFromFetched(fetched: FetchedPackage): PackagePreview {
	const manifest = parsePackageManifest(fetched.files)
	return {
		source: fetched.source,
		fetchedFrom: fetched.fetchedFrom,
		commit: fetched.commit ?? null,
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		readme: fetched.files['README.md'] ?? '',
		agents: fetched.files['AGENTS.md'] ?? '',
		fileList: Object.keys(fetched.files).sort(),
		fileCount: Object.keys(fetched.files).length,
		permissions: {
			jobs: Object.keys(manifest.jobs),
			webhooks: manifest.webhooks.map((w) => w.name),
			subscriptions: manifest.subscriptions.map((s) => s.topic),
			secretProvider: manifest.secretProvider?.id ?? null,
			dependencies: Object.keys(manifest.dependencies),
		},
		manifest,
		warnings: fetched.warnings,
		files: fetched.files,
	}
}

export async function fetchPackageSource(
	source: PackageSource,
	options: { allowedHosts: Array<string>; fetch?: FetchLike | undefined },
): Promise<FetchedPackage> {
	if (source.kind === 'kody') {
		const cloned = await cloneGitSmartHttp(source.gitUrl, {
			ref: source.ref,
			subdir: source.subdir,
			fetch: options.fetch,
			limits: {
				maxDownloadBytes: packageSourceLimits.maxDownloadBytes,
				maxFiles: packageSourceLimits.maxFiles,
				maxTotalBytes: packageSourceLimits.maxArchiveBytes,
				timeoutMs: packageSourceLimits.timeoutMs,
				maxRedirects: packageSourceLimits.maxRedirects,
			},
			assertAllowed: (raw) => assertAllowedSourceUrl(raw, options.allowedHosts).toString(),
		})
		return {
			files: cloned.files,
			warnings: cloned.warnings,
			source: describePackageSource(source),
			fetchedFrom: cloned.fetchedFrom,
			commit: cloned.commit,
		}
	}
	// Resolve mutable github refs to a SHA *before* downloading so the pin
	// names the same tree the tarball contains (codeload often returns 200 for
	// HEAD/branch without embedding the SHA; a later commits API call can race).
	let githubCommit: string | undefined
	let downloadSource = source
	if (source.kind === 'github') {
		githubCommit = source.ref && fullCommitSha.test(source.ref) ? source.ref.toLowerCase() : undefined
		if (!githubCommit) githubCommit = await resolveGithubCommitSha(source, options)
		if (githubCommit) downloadSource = { ...source, ref: githubCommit }
	}

	const url = downloadSource.kind === 'github' ? githubTarballUrl(downloadSource) : downloadSource.url
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
	let commit: string | undefined
	if (source.kind === 'github') {
		commit = commitShaFromCodeloadUrl(downloaded.url) ?? githubCommit
	}
	return {
		...result,
		source: describePackageSource(source),
		fetchedFrom: downloaded.url,
		...(commit ? { commit } : {}),
	}
}

export async function previewPackageSource(
	source: PackageSource,
	options: { allowedHosts: Array<string>; fetch?: FetchLike | undefined },
): Promise<PackagePreview> {
	const fetched = await fetchPackageSource(source, options)
	return packagePreviewFromFetched(fetched)
}

/** Max characters of one package file (MCP `packagePreview` path, web explorer display). */
export const packageFileViewMaxChars = 200_000

export type PackageFileView = { path: string; bytes: number; content: string; truncated: boolean }

/** One file of a package (saved or previewed) for reading, truncated at packageFileViewMaxChars. */
export function packageFileView(files: PackageFiles, path: string): PackageFileView {
	if (!Object.hasOwn(files, path)) {
		throw new KodyError('package_file_not_found', `Package file "${path}" was not found.`, { status: 404 })
	}
	const content = files[path]!
	return {
		path,
		bytes: new TextEncoder().encode(content).byteLength,
		content: content.slice(0, packageFileViewMaxChars),
		truncated: content.length > packageFileViewMaxChars,
	}
}
