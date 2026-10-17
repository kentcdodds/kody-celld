#!/usr/bin/env node
/**
 * Single-node Docker helpers shared by docker/entrypoint.sh.
 *
 * Production `single` mode must not keep `celld.dev` as the long-running
 * process: that wrapper gives the child a fixed 30s announce deadline
 * (denoland/celld crates/celld/dev.rs), which fails once the local store has
 * enough uncompacted LTX state (kentcdodds/kody-celld#89).
 *
 * `celld.dev` is still the only public way to write a deployment into the
 * local object store (`.celld/dev/objects.sqlite3`). This module drives that
 * deploy step, stops the supervisor as soon as `deploy/current.json` is
 * written (last step of celld's deploy::write), then the entrypoint execs the
 * same node argv `celld.dev` would spawn for its child: no announce deadline,
 * and LTX compaction runs.
 *
 * CELLD_NODE matches celld: `dev-` + first 12 hex chars of SHA-256 of the
 * realpath of the project directory (parent of the Wrangler config).
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { realpathSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const DEPLOY_POINTER = 'deploy/current.json'
const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000

export function resolveProjectDir(project) {
	const root = realpathSync(project)
	for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
		const config = join(root, name)
		if (existsSync(config)) {
			return dirname(realpathSync(config))
		}
	}
	throw new Error(`no Wrangler config (wrangler.jsonc|json|toml) under ${root}; celld single deploy needs one`)
}

export function celldDevNodeId(projectDir) {
	const digest = createHash('sha256').update(Buffer.from(projectDir)).digest('hex')
	return `dev-${digest.slice(0, 12)}`
}

export function objectsDbPath(stateDir) {
	return join(stateDir, 'objects.sqlite3')
}

export function readDeployPointerEtag(databasePath) {
	if (!existsSync(databasePath)) return null
	const db = new DatabaseSync(databasePath, { readOnly: true })
	try {
		const row = db.prepare('SELECT etag FROM objects WHERE key = ?').get(DEPLOY_POINTER)
		return row == null ? null : Number(row.etag)
	} finally {
		db.close()
	}
}

function parseArgs(argv) {
	const out = {
		command: argv[0] ?? '',
		project: '/app',
		state: '',
		port: '8080',
		host: '127.0.0.1',
		celldFlags: [],
	}
	const rest = argv.slice(1)
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		if (arg === '--') {
			out.celldFlags = rest.slice(i + 1)
			break
		}
		if (arg === '--project') {
			out.project = rest[++i] ?? ''
			continue
		}
		if (arg === '--state') {
			out.state = rest[++i] ?? ''
			continue
		}
		if (arg === '--port') {
			out.port = rest[++i] ?? ''
			continue
		}
		if (arg === '--host') {
			out.host = rest[++i] ?? ''
			continue
		}
		throw new Error(`unknown argument: ${arg}`)
	}
	return out
}

function printNodeEnv({ projectDir, stateDir }) {
	const database = objectsDbPath(stateDir)
	const runtime = join(stateDir, 'runtime')
	const nodeId = celldDevNodeId(projectDir)
	// One line the entrypoint can eval. Values are path-safe (no spaces from us).
	process.stdout.write(
		[
			`CELLD_INTERNAL_DEV_STORE=${shellQuote(database)}`,
			`CELLD_WATCH=${shellQuote(runtime)}`,
			`CELLD_NODE=${shellQuote(nodeId)}`,
		].join(' ') + '\n',
	)
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function stopProcess(child) {
	if (child.exitCode != null || child.signalCode != null) return
	try {
		child.kill('SIGTERM')
	} catch {
		return
	}
	const deadline = Date.now() + 40_000
	while (Date.now() < deadline) {
		if (child.exitCode != null || child.signalCode != null) return
		await delay(100)
	}
	try {
		child.kill('SIGKILL')
	} catch {
		/* already gone */
	}
	await delay(200)
}

async function deployLocal(options) {
	const projectDir = resolveProjectDir(options.project)
	const stateDir = realpathSync(
		(() => {
			mkdirSync(options.state, { recursive: true })
			mkdirSync(join(options.state, 'runtime'), { recursive: true })
			return options.state
		})(),
	)
	const database = objectsDbPath(stateDir)
	const priorEtag = readDeployPointerEtag(database)
	const timeoutMs = Number(process.env.KODY_SINGLE_DEPLOY_TIMEOUT_MS || DEFAULT_DEPLOY_TIMEOUT_MS)
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
		throw new Error(`KODY_SINGLE_DEPLOY_TIMEOUT_MS must be >= 1000 (got ${timeoutMs})`)
	}

	const logPath = join(stateDir, '.last-deploy.log')
	const logFd = openSync(logPath, 'w')
	const args = [
		'dev',
		projectDir,
		'--host',
		options.host,
		'--port',
		String(options.port),
		'--no-watch',
		...options.celldFlags,
	]
	// Match celld.dev's child scrub so a leftover fleet env cannot divert this
	// temporary supervisor onto a cloud bucket mid-deploy.
	const env = { ...process.env }
	for (const name of [
		'AWS_DEFAULT_REGION',
		'AWS_REGION',
		'CELLD_ADDR',
		'CELLD_ADVERTISE',
		'CELLD_BUCKET',
		'CELLD_CLOUD',
		'CELLD_INTERNAL_ADDR',
		'CELLD_INTERNAL_DEV_STORE',
		'CELLD_TEST_BUCKET',
		'CELLD_TRUST_FORWARDED_HEADERS',
		'CELLD_UNSAFE_PUBLIC_ADVERTISE',
		'S3_ENDPOINT',
	]) {
		delete env[name]
	}

	process.stderr.write(`[kody-celld] single deploy: writing Worker into ${database} via celld.dev (log: ${logPath})\n`)

	const child = spawn('celld', args, {
		env,
		stdio: ['ignore', logFd, logFd],
	})
	closeSync(logFd)

	let childError = null
	child.on('error', (error) => {
		childError = error
	})

	const success = () => ({
		projectDir,
		stateDir,
		nodeId: celldDevNodeId(projectDir),
		database,
	})

	const deadline = Date.now() + timeoutMs
	try {
		while (Date.now() < deadline) {
			if (childError) {
				throw new Error(`failed to start celld.dev: ${childError.message}`)
			}
			const etag = readDeployPointerEtag(database)
			if (etag != null && etag !== priorEtag) {
				process.stderr.write(
					`[kody-celld] single deploy: ${DEPLOY_POINTER} updated (etag ${priorEtag ?? 'none'} -> ${etag}); stopping celld.dev supervisor\n`,
				)
				await stopProcess(child)
				return success()
			}
			if (child.exitCode != null || child.signalCode != null) {
				const code = child.exitCode
				const signal = child.signalCode
				// Announce timeout means deploy_project already finished; treat as
				// success when the pointer moved. If it did not, surface the log.
				const etagAfter = readDeployPointerEtag(database)
				if (etagAfter != null && etagAfter !== priorEtag) {
					return success()
				}
				throw new Error(
					`celld.dev exited before updating ${DEPLOY_POINTER}` +
						(code != null ? ` (exit ${code})` : '') +
						(signal != null ? ` (signal ${signal})` : '') +
						`; see ${logPath}`,
				)
			}
			await delay(200)
		}
		const etag = readDeployPointerEtag(database)
		if (etag != null && etag !== priorEtag) {
			await stopProcess(child)
			return success()
		}
		throw new Error(`timed out after ${timeoutMs}ms waiting for ${DEPLOY_POINTER} to update; see ${logPath}`)
	} finally {
		await stopProcess(child)
	}
}

async function main(argv) {
	const options = parseArgs(argv)
	switch (options.command) {
		case 'node-env': {
			if (!options.state) throw new Error('--state is required')
			const projectDir = resolveProjectDir(options.project)
			mkdirSync(join(options.state, 'runtime'), { recursive: true })
			printNodeEnv({ projectDir, stateDir: realpathSync(options.state) })
			return
		}
		case 'node-id': {
			process.stdout.write(celldDevNodeId(resolveProjectDir(options.project)) + '\n')
			return
		}
		case 'deploy': {
			if (!options.state) throw new Error('--state is required')
			if (!options.port) throw new Error('--port is required')
			await deployLocal(options)
			return
		}
		default:
			throw new Error(
				`usage: single-local.mjs deploy|node-env|node-id --project DIR --state DIR [--port N] [--host IP] [-- celld.dev flags]`,
			)
	}
}

const isMain =
	Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`[kody-celld] ${error?.stack || error}\n`)
		process.exit(1)
	})
}
