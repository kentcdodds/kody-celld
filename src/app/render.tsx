import { renderToStream } from 'remix/ui/server'
import { AppRoot } from '#client/app-root.tsx'
import { type AppSession } from '#universal/app-session.ts'
import { CLIENT_ENTRY_HREF } from '#universal/client-entry.ts'
import { type AppLoaderData, type PageFlash } from '#universal/loader-data.ts'
import { KODY_CELLD_VERSION } from '../env.ts'
import { firstPartySecurityHeaders } from './security-headers.ts'
import { SsrDocument } from './ssr-document.tsx'
import { openDocumentStream } from './ssr-document-stream.ts'

export type RenderPageOptions = {
	title: string
	pathname: string
	data: AppLoaderData
	session?: AppSession | null
	flash?: PageFlash | null
	status?: number
	headers?: HeadersInit
}

/**
 * Maps a `clientEntry` id (`/build/client-entry.js#Name`) onto the one Vite
 * bundle. Mirrors `resolveOriginClientEntry` in kody's
 * `packages/worker/src/app/ssr-render.tsx`: every island exported from the
 * entry hydrates from that file; any other module URL is imported as-is.
 */
export function resolveClientEntry(entryId: string) {
	const [moduleUrl = '', rawExportName] = entryId.split('#')
	const exportName = rawExportName?.trim() || 'AppRoot'
	if (
		moduleUrl &&
		moduleUrl !== CLIENT_ENTRY_HREF &&
		moduleUrl.startsWith('/')
	) {
		return { href: moduleUrl, exportName, preloads: [] }
	}
	return { href: CLIENT_ENTRY_HREF, exportName, preloads: [] }
}

/**
 * Renders a full HTML document for a browser route: `SsrDocument` →
 * `AppRoot` (site or auth chrome, decided by the loader-data variant) → the
 * route component, streamed with `remix/ui/server` and the first-party
 * security headers (`packages/worker/src/app/ssr-render.tsx` upstream).
 * Text is escaped by the renderer; there is no raw-HTML escape hatch, so the
 * only way a string reaches the document is as text or an attribute value.
 */
export async function renderPage(
	options: RenderPageOptions,
): Promise<Response> {
	const stream = renderToStream(
		<SsrDocument title={`${options.title} · Kody`} robots="noindex">
			<AppRoot
				pathname={options.pathname}
				session={options.session ?? null}
				version={KODY_CELLD_VERSION}
				flash={options.flash ?? null}
				data={options.data}
			/>
		</SsrDocument>,
		{
			resolveClientEntry,
			onError(error) {
				console.error('SSR render error:', error)
			},
		},
	)
	return new Response(await openDocumentStream(stream), {
		status: options.status ?? 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			...firstPartySecurityHeaders,
			...Object.fromEntries(new Headers(options.headers ?? {}).entries()),
		},
	})
}
