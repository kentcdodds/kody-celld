import { WorkerEntrypoint } from 'cloudflare:workers'
import type { CapabilityContext } from '../capabilities/define.ts'
import { runCapability } from '../capabilities/registry.ts'
import { packageStorageCellName, type StorageListOptions } from '../cells/package-storage-cell.ts'
import type { Env } from '../env.ts'
import { errorToJson, KodyError } from '../lib/errors.ts'

export type RuntimeProps = { userId: string; email: string; packageName: string | null }
type CallContext = { runId?: string; packageName?: string | null } | null

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * The `KODY` service binding inside every sandbox isolate. User identity comes
 * from `ctx.props` (set by the host when the isolate was loaded), so sandbox
 * code can never reach another user's cells. Storage cells are keyed by
 * (user, package); the package name comes from the stamped `packageStorage()`
 * call in the declaring module.
 */
export class RuntimeHost extends WorkerEntrypoint<Env, RuntimeProps> {
	private storage(packageName: unknown) {
		if (typeof packageName !== 'string' || !packageNamePattern.test(packageName)) {
			throw new KodyError('no_package_context', 'packageStorage() is only available inside saved package code.')
		}
		return this.env.PACKAGE_STORAGE.getByName(packageStorageCellName(this.ctx.props.userId, packageName))
	}

	private capabilityContext(call: CallContext): CapabilityContext {
		return {
			env: this.env,
			exports: this.ctx.exports,
			user: { id: this.ctx.props.userId, email: this.ctx.props.email },
			userCell: this.env.USER.getByName(this.ctx.props.userId),
			packageName: this.ctx.props.packageName,
			runId: call?.runId ?? null,
			baseUrl: this.env.KODY_PUBLIC_URL,
			fromRuntime: true,
		}
	}

	async capability(name: string, args: unknown, call: CallContext) {
		try {
			return await runCapability(name, args, this.capabilityContext(call))
		} catch (error) {
			// RPC serializes plain Errors only; keep the Kody error code in the message.
			const json = errorToJson(error)
			throw new Error(`${json.error}: ${json.message}`, { cause: error })
		}
	}

	async storageGet(packageName: string, key: string): Promise<unknown> {
		const text = await this.storage(packageName).get(key)
		return text === undefined ? undefined : (JSON.parse(text) as unknown)
	}

	async storageSet(packageName: string, key: string, value: unknown) {
		await this.storage(packageName).set(key, value === undefined ? undefined : JSON.stringify(value))
	}

	async storageDelete(packageName: string, key: string) {
		return this.storage(packageName).delete(key)
	}

	async storageList(packageName: string, options: StorageListOptions) {
		const page = await this.storage(packageName).list(options)
		return {
			cursor: page.cursor,
			items: page.items.map((item) => ({
				key: item.key,
				value: JSON.parse(item.valueJson) as unknown,
				updatedAt: item.updatedAt,
			})),
		}
	}

	async storageClear(packageName: string) {
		await this.storage(packageName).clear()
	}

	async storageSql(packageName: string, query: string, params: Array<unknown>) {
		const bound = params.map((value): SqlStorageValue => {
			if (value === null || value === undefined) return null
			if (typeof value === 'number' || typeof value === 'string') return value
			if (typeof value === 'boolean') return value ? 1 : 0
			if (value instanceof ArrayBuffer) return value
			return JSON.stringify(value)
		})
		return this.storage(packageName).sql(query, bound)
	}
}
