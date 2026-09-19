/**
 * The signed-in identity the shell renders (header corner, footer links).
 * Plain data so it can cross from the server handlers into components; the
 * cookie-backed `WebSession` in `src/web/session.ts` stays server-only.
 */
export type AppSession = {
	displayName: string
	email: string
	avatarUrl: string | null
	/** Operator console cookie present alongside the user session. */
	isAdmin: boolean
}
