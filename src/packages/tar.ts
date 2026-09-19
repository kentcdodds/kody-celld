import { KodyError } from '../lib/errors.ts'

export type TarEntry = { path: string; bytes: Uint8Array }

export type TarLimits = {
	maxFiles: number
	maxTotalBytes: number
}

const BLOCK = 512
const decoder = new TextDecoder()

function cString(bytes: Uint8Array, start: number, length: number) {
	let end = start
	const stop = start + length
	while (end < stop && bytes[end] !== 0) end += 1
	return decoder.decode(bytes.subarray(start, end))
}

function octal(bytes: Uint8Array, start: number, length: number) {
	const text = cString(bytes, start, length).trim()
	if (text === '') return 0
	const value = parseInt(text, 8)
	if (!Number.isFinite(value) || value < 0) throw new KodyError('invalid_package', 'Malformed tar header.')
	return value
}

function isZeroBlock(bytes: Uint8Array, offset: number) {
	for (let i = offset; i < offset + BLOCK; i += 1) if (bytes[i] !== 0) return false
	return true
}

/** Parses `key=value` records from a pax extended header. */
function paxRecords(bytes: Uint8Array) {
	const records: Record<string, string> = {}
	let offset = 0
	while (offset < bytes.length) {
		let space = offset
		while (space < bytes.length && bytes[space] !== 0x20) space += 1
		const length = Number(decoder.decode(bytes.subarray(offset, space)))
		if (!Number.isFinite(length) || length <= 0) break
		const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1))
		const eq = record.indexOf('=')
		if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1)
		offset += length
	}
	return records
}

/**
 * Minimal ustar/pax/GNU tar reader: returns regular files only (directories,
 * links and device nodes are skipped). Enough for GitHub/npm tarballs, without
 * a dependency that would need bundling into the Worker.
 */
export function readTar(archive: Uint8Array, limits: TarLimits): Array<TarEntry> {
	const entries: Array<TarEntry> = []
	let offset = 0
	let totalBytes = 0
	let pendingLongName: string | null = null
	let pendingPax: Record<string, string> | null = null
	while (offset + BLOCK <= archive.length) {
		if (isZeroBlock(archive, offset)) break
		const header = archive.subarray(offset, offset + BLOCK)
		const size = octal(header, 124, 12)
		const typeflag = String.fromCharCode(header[156] ?? 0)
		const dataStart = offset + BLOCK
		const dataEnd = dataStart + size
		if (dataEnd > archive.length) throw new KodyError('invalid_package', 'Truncated tar archive.')
		const data = archive.subarray(dataStart, dataEnd)
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

		if (typeflag === 'L') {
			pendingLongName = cString(data, 0, data.length)
			continue
		}
		if (typeflag === 'x') {
			pendingPax = paxRecords(data)
			continue
		}
		if (typeflag === 'g') continue

		let path = pendingLongName ?? pendingPax?.path ?? cString(header, 0, 100)
		if (pendingLongName === null && pendingPax?.path === undefined) {
			const magic = cString(header, 257, 6)
			const prefix = magic.startsWith('ustar') ? cString(header, 345, 155) : ''
			if (prefix) path = `${prefix}/${path}`
		}
		pendingLongName = null
		pendingPax = null

		if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') continue
		if (entries.length >= limits.maxFiles) {
			throw new KodyError('invalid_package', `Archive has more than ${limits.maxFiles} files.`)
		}
		totalBytes += size
		if (totalBytes > limits.maxTotalBytes) {
			throw new KodyError('invalid_package', `Archive contents exceed ${limits.maxTotalBytes} bytes.`)
		}
		entries.push({ path, bytes: data })
	}
	return entries
}

export async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
	const reader = stream.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxBytes) {
			await reader.cancel()
			throw new KodyError('invalid_package', `Archive expands beyond ${maxBytes} bytes.`)
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

export function isGzip(bytes: Uint8Array) {
	return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}
