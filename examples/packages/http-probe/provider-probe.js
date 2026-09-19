/**
 * Like probe(), but with a provider-backed placeholder: `{{secret/<provider>:<ref>}}`.
 * The bound provider package resolves the ref in a sealed run and the gateway
 * injects the value; this code never sees it.
 */
export default async function providerProbe({ url, provider, ref, header = 'authorization', prefix = 'Bearer ' }) {
	const response = await fetch(url, { headers: { [header]: `${prefix}{{secret/${provider}:${ref}}}` } })
	const text = await response.text()
	let body
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: response.status, body }
}
