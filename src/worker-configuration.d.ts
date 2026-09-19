import type * as MainModule from './index.ts'

declare global {
	namespace Cloudflare {
		interface GlobalProps {
			mainModule: typeof MainModule
			durableNamespaces: 'RegistryCell' | 'UserCell' | 'PackageStorageCell'
		}
	}
}
