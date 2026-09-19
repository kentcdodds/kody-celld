import { createAuthenticatedFetch } from 'kody:runtime'

// Calls `url` as the connected integration. The gateway swaps the
// {{integration-token:<name>}} placeholder for the live access token (refreshing
// it first when expired) — provided the URL's host is on the integration's
// allowedHosts and this package is permitted by the integration's usage grant.
export default async function call({ integration, url, method = 'GET' }) {
	const authedFetch = createAuthenticatedFetch(integration)
	const response = await authedFetch(url, { method })
	const text = await response.text()
	let body
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: response.status, body }
}
