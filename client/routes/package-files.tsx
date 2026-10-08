import { type Handle } from 'remix/component'
import { PackageFilesExplorerIsland } from '#client/package-files-explorer-island.tsx'
import { type AppLoaderData } from '#universal/loader-data.ts'

type Data = Extract<AppLoaderData, { page: 'accountPackageFiles' }>

/**
 * `/account/packages/:name/files/*` — kody's files explorer over a saved
 * package (kody: client/routes/package-files.tsx). The data arrives with the
 * server render instead of through kody's client-router loader.
 */
export function PackageFiles(handle: Handle<{ data: Data; pathname: string }>) {
	return () => <PackageFilesExplorerIsland data={handle.props.data.files} />
}
