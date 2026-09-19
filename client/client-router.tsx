import { type Handle } from 'remix/ui'

/**
 * Compatibility surface for upstream components that hook into kody's
 * client-side router (`packages/worker/client/client-router.tsx`). kody-celld
 * navigates with full documents, so these are inert: no `navigate` events are
 * ever dispatched and every anchor click is left to the browser. Keeping the
 * same exports lets `SiteHeader`, `RecordTable` and the account nav port
 * verbatim.
 */
export const routerEvents = new EventTarget()

export function listenToRouterNavigation(
	_handle: Pick<Handle, 'signal' | 'update'>,
	_listener: () => void,
) {}

export function shouldRouterHandleClick(
	_event: MouseEvent,
	_anchor: HTMLAnchorElement,
) {
	return false
}
