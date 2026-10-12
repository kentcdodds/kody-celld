import { appStatePattern } from './tokens.ts'

/** `mint` = the browser carries a valid app-origin state; `bounce` = send it to the app origin first to get one. */
export function decideAppsOpen(state: string): 'mint' | 'bounce' {
	return appStatePattern.test(state) ? 'mint' : 'bounce'
}
