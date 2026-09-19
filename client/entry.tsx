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

run({
	loadModule(_moduleUrl, exportName) {
		const island = islands[exportName]
		if (!island) throw new Error(`Unknown client island: ${exportName}`)
		return island
	},
})
