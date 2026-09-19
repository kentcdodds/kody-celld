import type { PackageStorageCell } from './cells/package-storage-cell.ts'
import type { RegistryCell } from './cells/registry-cell.ts'
import type { UserCell } from './cells/user-cell.ts'

export type Env = {
	LOADER: WorkerLoader
	REGISTRY: DurableObjectNamespace<RegistryCell>
	USER: DurableObjectNamespace<UserCell>
	PACKAGE_STORAGE: DurableObjectNamespace<PackageStorageCell>
	KODY_ADMIN_TOKEN: string
	KODY_MASTER_KEY: string
	/** Comma-separated retired master keys still allowed to decrypt until `POST /admin/secrets/rekey` re-seals everything. */
	KODY_MASTER_KEY_PREVIOUS?: string
	KODY_PUBLIC_URL: string
	KODY_ALLOW_INSECURE_SECRET_HOSTS?: string
}

export const KODY_CELLD_VERSION = '0.1.0'
