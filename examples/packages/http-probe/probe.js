/**
 * Sends a request whose Authorization header is a Kody secret placeholder.
 * The placeholder is replaced by the FetchGateway only when the destination
 * host has been approved by an account admin; this code never sees the value.
 */
export default async function probe({ url, secretName, header = 'authorization', prefix = 'Bearer ' }) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { [header]: `${prefix}{{secret:${secretName}}}`, 'content-type': 'application/json' },
		body: JSON.stringify({ note: 'body placeholders work too: {{secret:' + secretName + '}}' }),
	})
	const text = await response.text()
	let body
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: response.status, body }
}
