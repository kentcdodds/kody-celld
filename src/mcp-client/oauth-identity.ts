/**
 * Pending MCP OAuth attempts are bound to the `mcp_servers` row id and OAuth
 * client id they started with (#50, #55 / #57). One predicate is used at
 * callback start and again immediately before persisting the grant so those
 * two moments cannot drift apart.
 */
export function oauthAttemptIdentityMatches(input: {
	pendingServerId: string | null | undefined
	pendingClientId: string | null | undefined
	serverId: string | null | undefined
	clientId: string | null | undefined
}): boolean {
	return Boolean(
		input.pendingServerId &&
		input.serverId === input.pendingServerId &&
		input.pendingClientId &&
		input.clientId === input.pendingClientId,
	)
}
