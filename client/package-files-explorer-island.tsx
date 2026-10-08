import { clientEntry } from 'remix/component'
import { PackageFilesExplorer } from '#client/package-files-explorer.tsx'
import { clientEntryId } from '#universal/client-entry.ts'

/**
 * kody-celld: kody hydrates the whole app; here the explorer is one island so
 * the tree filter, collapse and copy work while every file link stays a plain
 * document navigation (no client router — docs/web-ui.md).
 */
export const PackageFilesExplorerIsland = clientEntry(
	clientEntryId('PackageFilesExplorerIsland'),
	PackageFilesExplorer,
)
