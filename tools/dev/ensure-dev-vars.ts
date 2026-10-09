// Ensures `.dev.vars` exists for local `celld dev` / smoke. Copies the committed
// `.dev.vars.example` when missing so loopback smoke defaults never need to live
// in wrangler.jsonc (which single-node Docker would inherit). When the file
// already exists (copy-on-missing), still merge the loopback package-source
// hosts smoke needs — older checkouts otherwise refuse `127.0.0.1` fixtures.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageSourceHostsKey = 'KODY_PACKAGE_SOURCE_HOSTS'
/** Exact private hosts the local package-fixture smoke must be able to fetch. */
export const localPackageSourceHosts = ['127.0.0.1', 'localhost'] as const

function readEnvAssignment(contents: string, key: string): { index: number; value: string } | null {
	const lines = contents.split(/\r?\n/)
	const index = lines.findIndex((line) => {
		const trimmed = line.trim()
		return trimmed.startsWith(`${key}=`) && !trimmed.startsWith('#')
	})
	if (index < 0) return null
	const line = lines[index]!
	return { index, value: line.slice(line.indexOf('=') + 1) }
}

/** Merge loopback package-source hosts into a `.dev.vars` body; null if unchanged. */
export function mergeLocalPackageSourceHosts(contents: string, exampleContents: string): string | null {
	const existing = readEnvAssignment(contents, packageSourceHostsKey)
	if (!existing) {
		const fromExample = readEnvAssignment(exampleContents, packageSourceHostsKey)
		const addition = fromExample
			? `${packageSourceHostsKey}=${fromExample.value}`
			: `${packageSourceHostsKey}=${localPackageSourceHosts.join(',')}`
		const next =
			contents.endsWith('\n') || contents.length === 0 ? `${contents}${addition}\n` : `${contents}\n${addition}\n`
		return next
	}
	const hosts = existing.value
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
	const missing = localPackageSourceHosts.filter((host) => !hosts.includes(host))
	if (missing.length === 0) return null
	const lines = contents.split(/\r?\n/)
	lines[existing.index] = `${packageSourceHostsKey}=${[...hosts, ...missing].join(',')}`
	return lines.join('\n')
}

export function ensureDevVars(options: { targetPath: string; examplePath: string }): {
	wrote: boolean
	mergedHosts: boolean
} {
	let wrote = false
	let mergedHosts = false
	if (!existsSync(options.examplePath)) {
		throw new Error(`missing ${options.examplePath}; cannot seed .dev.vars`)
	}
	if (!existsSync(options.targetPath)) {
		copyFileSync(options.examplePath, options.targetPath)
		wrote = true
	}
	const exampleContents = readFileSync(options.examplePath, 'utf8')
	const before = readFileSync(options.targetPath, 'utf8')
	const after = mergeLocalPackageSourceHosts(before, exampleContents)
	if (after !== null && after !== before) {
		writeFileSync(options.targetPath, after)
		mergedHosts = true
	}
	return { wrote, mergedHosts }
}

const thisFile = fileURLToPath(import.meta.url)
const invokedAsMain =
	process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(thisFile).href

if (invokedAsMain) {
	const root = path.resolve(path.dirname(thisFile), '../..')
	try {
		const result = ensureDevVars({
			targetPath: path.join(root, '.dev.vars'),
			examplePath: path.join(root, '.dev.vars.example'),
		})
		if (result.wrote) {
			console.error('[kody-celld] wrote .dev.vars from .dev.vars.example (loopback smoke defaults)')
		} else if (result.mergedHosts) {
			console.error(
				`[kody-celld] added ${localPackageSourceHosts.join(', ')} to ${packageSourceHostsKey} in .dev.vars (local package smoke)`,
			)
		}
	} catch (error) {
		console.error(`[kody-celld] ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
