import { mcpClientMetadataDocument, mcpOAuthUrls } from '../mcp-client/oauth.ts'

/** The public OAuth client metadata document Kody presents to MCP authorization servers. */
export function clientMetadataResponse(publicUrl: string) {
	const document = mcpClientMetadataDocument(mcpOAuthUrls(publicUrl))
	if (!document) return Response.json({ error: 'not_found' }, { status: 404 })
	return Response.json(document, {
		headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
	})
}
