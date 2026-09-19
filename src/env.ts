import type { AiEnv } from './ai/config.ts'
import type { BlobEnv } from './blobs/config.ts'
import type { BrowserEnv } from './browser/config.ts'
import type { MemoryCell } from './cells/memory-cell.ts'
import type { PackageStorageCell } from './cells/package-storage-cell.ts'
import type { RegistryCell } from './cells/registry-cell.ts'
import type { UserCell } from './cells/user-cell.ts'
import type { EmailEnv } from './email/config.ts'
import type { LimitEnv } from './lib/limits.ts'

export type Env = LimitEnv &
	AiEnv &
	BlobEnv &
	BrowserEnv &
	EmailEnv & {
		LOADER: WorkerLoader
		REGISTRY: DurableObjectNamespace<RegistryCell>
		USER: DurableObjectNamespace<UserCell>
		MEMORY: DurableObjectNamespace<MemoryCell>
		PACKAGE_STORAGE: DurableObjectNamespace<PackageStorageCell>
		/** R2-compatible bucket binding: `r2/<bucket_name>/` in the fleet bucket. Optional when KODY_BLOB_PROVIDER=s3. */
		BLOBS?: R2Bucket
		KODY_ADMIN_TOKEN: string
		KODY_MASTER_KEY: string
		/** Comma-separated retired master keys still allowed to decrypt until `POST /admin/secrets/rekey` re-seals everything. */
		KODY_MASTER_KEY_PREVIOUS?: string
		KODY_PUBLIC_URL: string
		KODY_ALLOW_INSECURE_SECRET_HOSTS?: string
		/** How long a resolved {{secret/provider:ref}} value stays in the gateway's in-memory cache (default 300). */
		KODY_SECRET_PROVIDER_CACHE_SECONDS?: string
		/** Wall-clock budget for one sealed provider run (default 20000). */
		KODY_SECRET_PROVIDER_TIMEOUT_MS?: string
	}

export const KODY_CELLD_VERSION = '0.1.0'
