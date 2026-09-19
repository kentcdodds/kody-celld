/**
 * The one browser bundle Vite emits (`vite.config.ts` pins the file name).
 * `clientEntry(clientEntryId('Name'), Component)` marks an island for
 * hydration; `remix/ui/server` splits the id into `href#exportName` and
 * `client/entry.tsx` resolves the export.
 */
export const CLIENT_ENTRY_HREF = '/build/client-entry.js'

export function clientEntryId(exportName: string) {
	return `${CLIENT_ENTRY_HREF}#${exportName}`
}
