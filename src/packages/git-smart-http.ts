import { inflateSync } from 'node:zlib'
import { KodyError } from '../lib/errors.ts'
import type { PackageFiles } from './manifest.ts'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/**
 * Read-only Git smart-HTTP clone for public package repos (kody.codes
 * `@owner/pkg.git` and any allowlisted upload-pack host). Returns a UTF-8 file
 * map — no working tree, no credentials, no push.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const utf8Loose = new TextDecoder('utf-8')
const encoder = new TextEncoder()

const OBJ_COMMIT = 1
const OBJ_TREE = 2
const OBJ_BLOB = 3
const OBJ_TAG = 4
const OBJ_OFS_DELTA = 6
const OBJ_REF_DELTA = 7

type GitObject = { type: number; content: Uint8Array }

export type GitCloneLimits = {
	maxDownloadBytes: number
	maxFiles: number
	maxTotalBytes: number
	timeoutMs: number
	maxRedirects: number
}

const defaultLimits: GitCloneLimits = {
	maxDownloadBytes: 8 * 1024 * 1024,
	maxFiles: 400,
	maxTotalBytes: 24 * 1024 * 1024,
	timeoutMs: 20_000,
	maxRedirects: 3,
}

const flushPkt = encoder.encode('0000')
const skippedDirs = new Set(['node_modules'])

function pktLine(payload: string) {
	const body = encoder.encode(payload)
	const len = (body.byteLength + 4).toString(16).padStart(4, '0')
	const out = new Uint8Array(4 + body.byteLength)
	out.set(encoder.encode(len), 0)
	out.set(body, 4)
	return out
}

function concatBytes(parts: Array<Uint8Array>) {
	const total = parts.reduce((n, p) => n + p.byteLength, 0)
	const out = new Uint8Array(total)
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.byteLength
	}
	return out
}

function readPktLines(bytes: Uint8Array) {
	const lines: Array<Uint8Array> = []
	let offset = 0
	while (offset + 4 <= bytes.length) {
		const lenHex = utf8Loose.decode(bytes.subarray(offset, offset + 4))
		if (lenHex === '0000') {
			offset += 4
			lines.push(new Uint8Array(0))
			continue
		}
		const len = Number.parseInt(lenHex, 16)
		if (!Number.isFinite(len) || len < 4 || offset + len > bytes.length) {
			throw new KodyError('package_source_failed', 'Malformed git pkt-line response.', { status: 502 })
		}
		lines.push(bytes.subarray(offset + 4, offset + len))
		offset += len
	}
	return { lines, offset }
}

function lineText(line: Uint8Array) {
	let end = line.length
	if (end > 0 && line[end - 1] === 0x0a) end -= 1
	return utf8Loose.decode(line.subarray(0, end))
}

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
			throw new KodyError('invalid_package', `Git response is larger than ${maxBytes} bytes.`)
		}
		chunks.push(value)
	}
	return concatBytes(chunks)
}

export type AssertAllowed = (raw: string) => string

async function fetchGit(
	raw: string,
	init: RequestInit,
	assertAllowed: AssertAllowed,
	fetchImpl: FetchLike,
	limits: GitCloneLimits,
) {
	let current = assertAllowed(raw)
	for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
		const response = await fetchImpl(current, {
			...init,
			redirect: 'manual',
			signal: AbortSignal.timeout(limits.timeoutMs),
		})
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location')
			if (!location) {
				throw new KodyError('package_source_failed', `${current} redirected without a location.`, { status: 502 })
			}
			current = assertAllowed(new URL(location, current).toString())
			continue
		}
		if (!response.ok) {
			throw new KodyError(
				'package_source_failed',
				`${new URL(current).host} returned ${response.status} for git ${new URL(current).pathname}.`,
				{ status: response.status === 404 ? 404 : 502 },
			)
		}
		return { url: current, bytes: await readBody(response, limits.maxDownloadBytes) }
	}
	throw new KodyError('package_source_failed', 'Too many redirects.', { status: 502 })
}

export function normalizeGitUrl(gitUrl: string) {
	const url = new URL(gitUrl)
	url.hash = ''
	url.search = ''
	let path = url.pathname.replace(/\/+$/, '')
	if (!path.endsWith('.git')) path = `${path}.git`
	url.pathname = path
	return url.toString().replace(/\/+$/, '')
}

export type DiscoveredRefs = {
	head: string | null
	refs: Map<string, string>
	symrefs: Map<string, string>
	fetchedFrom: string
}

export async function discoverGitRefs(
	gitUrl: string,
	options: { assertAllowed: AssertAllowed; fetch?: FetchLike; limits?: Partial<GitCloneLimits> },
): Promise<DiscoveredRefs> {
	const limits = { ...defaultLimits, ...options.limits }
	const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
	const base = normalizeGitUrl(gitUrl)
	const { url, bytes } = await fetchGit(
		`${base}/info/refs?service=git-upload-pack`,
		{
			method: 'GET',
			headers: {
				'user-agent': 'kody-celld/0.1 (package-git-clone)',
				accept: 'application/x-git-upload-pack-advertisement',
			},
		},
		options.assertAllowed,
		fetchImpl,
		limits,
	)
	const { lines } = readPktLines(bytes)
	const refs = new Map<string, string>()
	const symrefs = new Map<string, string>()
	let head: string | null = null
	let sawService = false
	for (const line of lines) {
		if (line.length === 0) continue
		const text = lineText(line)
		if (text.startsWith('# service=')) {
			sawService = true
			continue
		}
		const nul = text.indexOf('\0')
		const main = nul >= 0 ? text.slice(0, nul) : text
		const caps = nul >= 0 ? text.slice(nul + 1) : ''
		const space = main.indexOf(' ')
		if (space < 0) continue
		const sha = main.slice(0, space).toLowerCase()
		const name = main.slice(space + 1)
		if (!/^[0-9a-f]{40}$/.test(sha)) continue
		refs.set(name, sha)
		if (name === 'HEAD') head = sha
		for (const cap of caps.split(' ')) {
			if (cap.startsWith('symref=HEAD:')) symrefs.set('HEAD', cap.slice('symref=HEAD:'.length))
		}
	}
	if (!sawService && refs.size === 0) {
		throw new KodyError(
			'package_source_failed',
			'Git smart-HTTP advertisement missing; is the .git upload-pack route live?',
			{ status: 502 },
		)
	}
	return { head, refs, symrefs, fetchedFrom: url }
}

export function resolveGitRef(discovery: DiscoveredRefs, ref: string | null) {
	if (ref === null || ref === '' || ref === 'HEAD') {
		if (discovery.head) return discovery.head
		const sym = discovery.symrefs.get('HEAD')
		if (sym) {
			const sha = discovery.refs.get(sym)
			if (sha) return sha
		}
		const fallback = discovery.refs.get('refs/heads/master') ?? discovery.refs.get('refs/heads/main')
		if (fallback) return fallback
		throw new KodyError('package_source_failed', 'Repository has no HEAD ref to clone.', { status: 502 })
	}
	if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase()
	for (const name of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]) {
		const sha = discovery.refs.get(name)
		if (sha) return sha
	}
	throw new KodyError('package_source_failed', `Ref "${ref}" was not advertised by the git remote.`, { status: 404 })
}

function demuxUploadPack(bytes: Uint8Array) {
	const packChunks: Array<Uint8Array> = []
	let offset = 0
	let sawBand = false
	while (offset + 4 <= bytes.length) {
		const lenHex = utf8Loose.decode(bytes.subarray(offset, offset + 4))
		if (lenHex === '0000') {
			offset += 4
			if (sawBand) break
			continue
		}
		const len = Number.parseInt(lenHex, 16)
		if (!Number.isFinite(len) || len < 4 || offset + len > bytes.length) break
		const payload = bytes.subarray(offset + 4, offset + len)
		offset += len
		if (payload.length === 0) continue
		const first = payload[0]!
		// Side-band: first byte is 1/2/3. ACK/NAK/shallow lines start with ASCII letters.
		if (first === 1 || first === 2 || first === 3) {
			sawBand = true
			const data = payload.subarray(1)
			if (first === 1) packChunks.push(data)
			else if (first === 3) {
				throw new KodyError('package_source_failed', utf8Loose.decode(data).trim() || 'Git remote error.', {
					status: 502,
				})
			}
			continue
		}
		const text = lineText(payload)
		if (text.startsWith('ERR ')) {
			throw new KodyError('package_source_failed', text.slice(4), { status: 502 })
		}
	}
	if (packChunks.length > 0) return concatBytes(packChunks)

	let packAt = -1
	for (let i = 0; i + 4 <= bytes.length; i += 1) {
		if (bytes[i] === 0x50 && bytes[i + 1] === 0x41 && bytes[i + 2] === 0x43 && bytes[i + 3] === 0x4b) {
			packAt = i
			break
		}
	}
	if (packAt < 0) {
		throw new KodyError('package_source_failed', 'Git upload-pack response had no packfile.', { status: 502 })
	}
	return bytes.subarray(packAt)
}

function inflateAt(bytes: Uint8Array, offset: number) {
	const result = inflateSync(bytes.subarray(offset), { info: true }) as unknown as {
		buffer: Buffer
		engine: { bytesWritten: number }
	}
	return {
		output: new Uint8Array(result.buffer.buffer, result.buffer.byteOffset, result.buffer.byteLength),
		bytesRead: result.engine.bytesWritten,
	}
}

function readVarInt(bytes: Uint8Array, offset: number) {
	let value = 0
	let shift = 0
	let at = offset
	for (;;) {
		if (at >= bytes.length) throw new KodyError('invalid_package', 'Truncated git pack.', { status: 502 })
		const c = bytes[at++]!
		value |= (c & 0x7f) << shift
		if ((c & 0x80) === 0) break
		shift += 7
	}
	return { value, offset: at }
}

function applyDelta(base: Uint8Array, delta: Uint8Array) {
	let offset = 0
	const sourceSize = readVarInt(delta, offset)
	offset = sourceSize.offset
	if (sourceSize.value !== base.byteLength) {
		throw new KodyError('invalid_package', 'Git delta source size mismatch.', { status: 502 })
	}
	const targetSize = readVarInt(delta, offset)
	offset = targetSize.offset
	const out = new Uint8Array(targetSize.value)
	let at = 0
	while (offset < delta.length) {
		const cmd = delta[offset++]!
		if (cmd === 0) throw new KodyError('invalid_package', 'Reserved git delta opcode.', { status: 502 })
		if (cmd & 0x80) {
			let copyOffset = 0
			let copySize = 0
			if (cmd & 0x01) copyOffset |= delta[offset++]!
			if (cmd & 0x02) copyOffset |= delta[offset++]! << 8
			if (cmd & 0x04) copyOffset |= delta[offset++]! << 16
			if (cmd & 0x08) copyOffset |= delta[offset++]! << 24
			if (cmd & 0x10) copySize |= delta[offset++]!
			if (cmd & 0x20) copySize |= delta[offset++]! << 8
			if (cmd & 0x40) copySize |= delta[offset++]! << 16
			if (copySize === 0) copySize = 0x10000
			if (copyOffset + copySize > base.byteLength || at + copySize > out.byteLength) {
				throw new KodyError('invalid_package', 'Git delta copy out of bounds.', { status: 502 })
			}
			out.set(base.subarray(copyOffset, copyOffset + copySize), at)
			at += copySize
		} else {
			const n = cmd
			if (offset + n > delta.length || at + n > out.byteLength) {
				throw new KodyError('invalid_package', 'Git delta insert out of bounds.', { status: 502 })
			}
			out.set(delta.subarray(offset, offset + n), at)
			offset += n
			at += n
		}
	}
	if (at !== out.byteLength) throw new KodyError('invalid_package', 'Git delta output size mismatch.', { status: 502 })
	return out
}

async function sha1Hex(content: Uint8Array, type: number) {
	const typeName =
		type === OBJ_COMMIT
			? 'commit'
			: type === OBJ_TREE
				? 'tree'
				: type === OBJ_BLOB
					? 'blob'
					: type === OBJ_TAG
						? 'tag'
						: null
	if (!typeName) throw new KodyError('invalid_package', `Unknown git object type ${type}.`, { status: 502 })
	const header = encoder.encode(`${typeName} ${content.byteLength}\0`)
	const body = new Uint8Array(header.byteLength + content.byteLength)
	body.set(header, 0)
	body.set(content, header.byteLength)
	const digest = await crypto.subtle.digest('SHA-1', body)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function unpackGitPack(pack: Uint8Array): Promise<Map<string, GitObject>> {
	if (pack.byteLength < 12 || utf8Loose.decode(pack.subarray(0, 4)) !== 'PACK') {
		throw new KodyError('invalid_package', 'Not a git packfile.', { status: 502 })
	}
	const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength)
	const version = view.getUint32(4)
	if (version !== 2 && version !== 3) {
		throw new KodyError('invalid_package', `Unsupported git pack version ${version}.`, { status: 502 })
	}
	const count = view.getUint32(8)
	const objectsByOrder: Array<GitObject> = []
	const starts: Array<number> = []
	const bySha = new Map<string, GitObject>()
	let offset = 12
	for (let n = 0; n < count; n += 1) {
		const start = offset
		let c = pack[offset++]!
		const type = (c >> 4) & 7
		let size = c & 0x0f
		let shift = 4
		while (c & 0x80) {
			c = pack[offset++]!
			size |= (c & 0x7f) << shift
			shift += 7
		}
		let base: GitObject | null = null
		if (type === OBJ_OFS_DELTA) {
			let byte = pack[offset++]!
			let baseOffset = byte & 0x7f
			while (byte & 0x80) {
				byte = pack[offset++]!
				baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f)
			}
			const baseStart = start - baseOffset
			const baseIndex = starts.indexOf(baseStart)
			base = baseIndex >= 0 ? (objectsByOrder[baseIndex] ?? null) : null
			if (!base) throw new KodyError('invalid_package', 'Git ofs-delta base missing.', { status: 502 })
		} else if (type === OBJ_REF_DELTA) {
			const sha = [...pack.subarray(offset, offset + 20)].map((b) => b.toString(16).padStart(2, '0')).join('')
			offset += 20
			base = bySha.get(sha) ?? null
			if (!base) throw new KodyError('invalid_package', `Git ref-delta base ${sha} missing.`, { status: 502 })
		}
		const inflated = inflateAt(pack, offset)
		offset += inflated.bytesRead
		let object: GitObject
		if (type === OBJ_OFS_DELTA || type === OBJ_REF_DELTA) {
			if (!base) throw new KodyError('invalid_package', 'Git delta without base.', { status: 502 })
			object = { type: base.type, content: applyDelta(base.content, inflated.output) }
		} else {
			if (inflated.output.byteLength !== size) {
				throw new KodyError('invalid_package', 'Git pack object size mismatch.', { status: 502 })
			}
			object = { type, content: inflated.output }
		}
		starts.push(start)
		objectsByOrder.push(object)
		bySha.set(await sha1Hex(object.content, object.type), object)
	}
	return bySha
}

function parseCommitTree(content: Uint8Array) {
	const text = utf8Loose.decode(content)
	const match = /^tree ([0-9a-f]{40})\n/.exec(text)
	if (!match) throw new KodyError('invalid_package', 'Git commit is missing a tree.', { status: 502 })
	return match[1]!
}

function parseTagObject(content: Uint8Array) {
	const text = utf8Loose.decode(content)
	const match = /^object ([0-9a-f]{40})\n/.exec(text)
	if (!match) throw new KodyError('invalid_package', 'Git tag is missing an object.', { status: 502 })
	return match[1]!
}

type TreeEntry = { mode: string; name: string; sha: string }

function parseTree(content: Uint8Array): Array<TreeEntry> {
	const entries: Array<TreeEntry> = []
	let offset = 0
	while (offset < content.length) {
		let space = offset
		while (space < content.length && content[space] !== 0x20) space += 1
		const mode = utf8Loose.decode(content.subarray(offset, space))
		let nul = space + 1
		while (nul < content.length && content[nul] !== 0) nul += 1
		const name = utf8Loose.decode(content.subarray(space + 1, nul))
		const shaBytes = content.subarray(nul + 1, nul + 21)
		if (shaBytes.byteLength !== 20) throw new KodyError('invalid_package', 'Truncated git tree.', { status: 502 })
		const sha = [...shaBytes].map((b) => b.toString(16).padStart(2, '0')).join('')
		entries.push({ mode, name, sha })
		offset = nul + 21
	}
	return entries
}

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

export function filesFromGitObjects(
	objects: Map<string, GitObject>,
	commitSha: string,
	subdir: string | null,
	limits: Pick<GitCloneLimits, 'maxFiles' | 'maxTotalBytes'> = defaultLimits,
) {
	let tip = objects.get(commitSha)
	if (!tip) throw new KodyError('invalid_package', `Git commit ${commitSha} missing from pack.`, { status: 502 })
	if (tip.type === OBJ_TAG) {
		const target = parseTagObject(tip.content)
		tip = objects.get(target)
		if (!tip) throw new KodyError('invalid_package', `Git tag target ${target} missing from pack.`, { status: 502 })
	}
	if (tip.type !== OBJ_COMMIT) {
		throw new KodyError('invalid_package', 'Resolved ref is not a commit.', { status: 502 })
	}
	let treeSha = parseCommitTree(tip.content)
	const prefix = normalizeSubdir(subdir)
	if (prefix) {
		for (const segment of prefix.split('/')) {
			const tree = objects.get(treeSha)
			if (!tree || tree.type !== OBJ_TREE) {
				throw new KodyError('invalid_package', `subdir "${prefix}" not found in the repository.`)
			}
			const entry = parseTree(tree.content).find((e) => e.name === segment && e.mode.startsWith('4'))
			if (!entry) throw new KodyError('invalid_package', `subdir "${prefix}" not found in the repository.`)
			treeSha = entry.sha
		}
	}

	const files: PackageFiles = {}
	const warnings: Array<string> = []
	const manifestDirs = new Set<string>()
	let totalBytes = 0
	let fileCount = 0

	const walk = (sha: string, dir: string) => {
		const tree = objects.get(sha)
		if (!tree || tree.type !== OBJ_TREE) {
			throw new KodyError('invalid_package', `Git tree ${sha} missing from pack.`, { status: 502 })
		}
		for (const entry of parseTree(tree.content)) {
			if (entry.name === '.git' || skippedDirs.has(entry.name)) continue
			const path = dir ? `${dir}/${entry.name}` : entry.name
			if (entry.mode.startsWith('4')) {
				walk(entry.sha, path)
				continue
			}
			// Regular files / executable / symlink — package files are text blobs only.
			if (!(entry.mode === '100644' || entry.mode === '100755' || entry.mode === '120000')) continue
			const blob = objects.get(entry.sha)
			if (!blob || blob.type !== OBJ_BLOB) {
				throw new KodyError('invalid_package', `Git blob ${entry.sha} missing from pack.`, { status: 502 })
			}
			if (entry.name === 'package.json') {
				const parent = dir
				manifestDirs.add(parent)
			}
			fileCount += 1
			if (fileCount > limits.maxFiles) {
				throw new KodyError('invalid_package', `Repository has more than ${limits.maxFiles} files.`)
			}
			totalBytes += blob.content.byteLength
			if (totalBytes > limits.maxTotalBytes) {
				throw new KodyError('invalid_package', `Repository contents exceed ${limits.maxTotalBytes} bytes.`)
			}
			try {
				files[path] = utf8.decode(blob.content)
			} catch {
				warnings.push(`Skipped ${path}: not UTF-8 text (packages hold text files only).`)
			}
		}
	}
	walk(treeSha, '')

	if (files['package.json'] === undefined) {
		const candidates = [...manifestDirs].filter((d) => d !== '').sort()
		const hint =
			candidates.length > 0
				? ` package.json was found in: ${candidates.slice(0, 8).join(', ')}. Pass one as subdir.`
				: prefix
					? ` Nothing under "${prefix}" in the repository.`
					: ''
		throw new KodyError('invalid_package', `No package.json at the package root.${hint}`)
	}
	return { files, warnings }
}

export async function cloneGitSmartHttp(
	gitUrl: string,
	options: {
		ref?: string | null
		subdir?: string | null
		assertAllowed: AssertAllowed
		fetch?: FetchLike
		limits?: Partial<GitCloneLimits>
	},
) {
	const limits = { ...defaultLimits, ...options.limits }
	const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
	const base = normalizeGitUrl(gitUrl)
	const discovery = await discoverGitRefs(base, {
		assertAllowed: options.assertAllowed,
		fetch: fetchImpl,
		limits,
	})
	const want = resolveGitRef(discovery, options.ref ?? null)
	const caps = 'multi_ack_detailed no-done side-band-64k ofs-delta agent=kody-celld/0.1'
	const body = concatBytes([pktLine(`want ${want} ${caps}\n`), pktLine('deepen 1\n'), flushPkt, pktLine('done\n')])
	const { url, bytes } = await fetchGit(
		`${base}/git-upload-pack`,
		{
			method: 'POST',
			headers: {
				'user-agent': 'kody-celld/0.1 (package-git-clone)',
				'content-type': 'application/x-git-upload-pack-request',
				accept: 'application/x-git-upload-pack-result',
			},
			body,
		},
		options.assertAllowed,
		fetchImpl,
		limits,
	)
	const pack = demuxUploadPack(bytes)
	const objects = await unpackGitPack(pack)
	const { files, warnings } = filesFromGitObjects(objects, want, options.subdir ?? null, limits)
	return { files, warnings, commit: want, fetchedFrom: url, gitUrl: base }
}
