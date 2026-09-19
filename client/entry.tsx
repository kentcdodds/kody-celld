import { run } from 'remix/ui'
import { ConfirmSubmitButton } from '#client/confirm-submit-button.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { SiteHeader } from '#client/site-header.tsx'
import { Toaster } from '#client/toaster.tsx'

/**
 * Browser boot. Every `clientEntry()` island the server can render is
 * exported here under the name in its entry id (`/build/client-entry.js#Name`),
 * so hydration never fetches a second module. Kody's entry hydrates `AppRoot`
 * and starts a client router; kody-celld keeps full-document navigation and
 * hydrates islands only, so this file is the complete list of what runs in
 * the browser.
 */
const islands: Record<string, Function> = {
	ConfirmSubmitButton,
	CopyTextButton,
	SiteHeader,
	Toaster,
}

// `run()` also intercepts same-origin links and forms through the Navigation
// API and replays them as `fetch()` frame navigations. Every page here is a
// full document and several POSTs end in cross-origin redirects (OAuth consent
// back to the client's callback, connect flows to a provider), which fetch
// cannot follow under `connect-src 'self'`. Registering first keeps them native.
window.navigation?.addEventListener('navigate', (event) =>
	event.stopImmediatePropagation(),
)

run({
	loadModule(_moduleUrl, exportName) {
		const island = islands[exportName]
		if (!island) throw new Error(`Unknown client island: ${exportName}`)
		return island
	},
})
