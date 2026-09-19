import { type AppSession } from './app-session.ts'
import { type AppLoaderData, type PageFlash } from './loader-data.ts'

/**
 * Everything the document body needs. Declared in `universal/` so the Worker
 * can type `renderPage` against it without pulling browser-only component
 * code into its typecheck (see `src/app/ssr-stubs/app-root.ts`).
 */
export type AppRootProps = {
	pathname: string
	session: AppSession | null
	version: string
	flash: PageFlash | null
	data: AppLoaderData
}
