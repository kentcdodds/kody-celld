import type { UserRecord } from '../cells/registry-cell.ts'
import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { buildModuleGraph, type ModuleGraph } from '../execute/module-graph.ts'
import { npmConfigFromEnv } from '../execute/npm-config.ts'
import { randomId } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { limitsFromEnv } from '../lib/limits.ts'
import { isAssetPath, serveAppAsset } from './assets.ts'
import { buildAppRequest, sanitizeAppResponse } from './forward.ts'
import type { AppTarget } from './origin.ts'
import { appErrorPage, appNotFoundPage } from './pages.ts'
import { recordAppFailure } from './run-report.ts'
import { appIsolateName, appIsolateNameForGraph, stampsMatch } from './serve-name.ts'

export { appIsolateName }

// Warm requests skip the graph build. An entry is reused only while every saved
// package it pulled in still has the `updated_at` it was built from.
type GraphEntry = { graph: Promise<ModuleGraph>; stamps: Promise<Record<string, string>> }
const graphCache = new Map<string, GraphEntry>()
const graphCacheLimit = 32

async function cachedGraph(
	name: string,
	userCell: ReturnType<typeof getUserCell>,
	build: () => Promise<ModuleGraph>,
): Promise<ModuleGraph> {
	const hit = graphCache.get(name)
	if (hit) {
		try {
			const built = await hit.stamps
			const now = await userCell.packageStamps(Object.keys(built))
			if (stampsMatch(built, now) && graphCache.get(name) === hit) {
				// Re-insert so eviction drops the least recently used entry.
				graphCache.delete(name)
				graphCache.set(name, hit)
				return await hit.graph
			}
		} catch {
			// A failed build or stamp read falls through to a fresh build.
		}
		if (graphCache.get(name) === hit) graphCache.delete(name)
	}
	const graph = build()
	const entry: GraphEntry = {
		graph,
		stamps: graph.then((built) => userCell.packageStamps(built.packages)),
	}
	graphCache.set(name, entry)
	const drop = () => {
		if (graphCache.get(name) === entry) graphCache.delete(name)
	}
	entry.graph.catch(drop)
	entry.stamps.catch(drop)
	while (graphCache.size > graphCacheLimit) {
		const oldest = graphCache.keys().next().value
		if (oldest === undefined) break
		graphCache.delete(oldest)
	}
	return graph
}

function errorShape(error: unknown) {
	const kody = KodyError.fromUnknown(error)
	if (kody) return { name: kody.code, message: kody.message }
	if (error instanceof Error) return { name: error.name, message: error.message }
	return { name: 'Error', message: String(error) }
}

export async function serveApp(input: {
	request: Request
	env: Env
	exports: ExecutionContext['exports']
	target: AppTarget
	user: UserRecord
}): Promise<Response> {
	const { env, target, user } = input
	const publicUrl = env.KODY_PUBLIC_URL.replace(/\/$/, '')
	const userCell = getUserCell(env, user.id)
	const pkg = await userCell.packageGet(target.packageName)
	const app = pkg?.manifest.app
	if (!pkg || !app) return appNotFoundPage()
	if (isAssetPath(target.restPath)) {
		return serveAppAsset({ request: input.request, restPath: target.restPath, files: pkg.files, assetsDir: app.assets })
	}
	const hostedUrl = `${target.origin}${target.mountPath}`
	const graphKey = await appIsolateName({
		userId: user.id,
		packageName: pkg.name,
		updatedAt: pkg.updatedAt,
		hostedUrl,
	})

	let graph: ModuleGraph
	try {
		graph = await cachedGraph(graphKey, userCell, () => {
			const npm = npmConfigFromEnv(env)
			return buildModuleGraph({
				entry: { kind: 'package', packageName: pkg.name, entryPath: app.entry },
				userCell,
				allowNpm: npm.enabled,
				npm: { config: npm, cache: env.NPM_CACHE.get(env.NPM_CACHE.idFromName('npm-cache')) },
				wrapper: 'app',
			})
		})
	} catch (error) {
		const shape = errorShape(error)
		await recordAppFailure(env, { userId: user.id, packageName: pkg.name, error: shape })
		return appErrorPage(500, `The app could not be built: ${shape.message}`, publicUrl)
	}

	const isolateName = await appIsolateNameForGraph({ userId: user.id, hostedUrl, modules: graph.modules })
	const props = { userId: user.id, email: user.email, packageName: pkg.name }
	const worker = env.LOADER.get(isolateName, () => ({
		compatibilityDate: '2026-01-01',
		compatibilityFlags: ['nodejs_compat'],
		mainModule: graph.mainModule,
		modules: graph.modules,
		env: { KODY: input.exports.RuntimeHost({ props }) },
		globalOutbound: input.exports.FetchGateway({ props }),
	}))
	// The isolate only ever sees this rebuilt request, never the browser's raw one.
	const appRequest = buildAppRequest(input.request, {
		origin: target.origin,
		restPath: target.restPath,
		context: {
			runId: randomId('app'),
			packageContext: {
				packageName: pkg.name,
				version: pkg.version,
				hostedUrl,
				appBasePath: target.mountPath,
				assetBasePath: `${target.mountPath}/_assets`,
			},
		},
	})

	const timeoutMs = limitsFromEnv(env).executeTimeoutMs
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs)
	})
	try {
		const response = await Promise.race([worker.getEntrypoint().fetch(appRequest), timeout])
		if (response === 'timeout') {
			await recordAppFailure(env, {
				userId: user.id,
				packageName: pkg.name,
				error: { name: 'app_timeout', message: `The app did not respond within ${timeoutMs / 1000}s.` },
			})
			return appErrorPage(504, `The app did not respond within ${timeoutMs / 1000}s.`, publicUrl)
		}
		return sanitizeAppResponse(response)
	} catch (error) {
		await recordAppFailure(env, { userId: user.id, packageName: pkg.name, error: errorShape(error) })
		return appErrorPage(500, 'The app crashed.', publicUrl)
	} finally {
		clearTimeout(timer)
	}
}
