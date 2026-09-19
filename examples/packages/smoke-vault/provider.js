import { secretHeaders } from 'kody:runtime'

// Sealed provider entry: Kody calls it with { providerId, ref, config, doorSecretName }
// and hands the returned value to the fetch gateway only. The door token reaches the
// vault via the ordinary {{secret:...}} placeholder, so this code never sees it either.
export default async function secretProvider({ ref, config, doorSecretName }) {
	const baseUrl = String(config.baseUrl ?? '').replace(/\/$/, '')
	if (!baseUrl) throw new Error('config.baseUrl is required')
	const response = await fetch(`${baseUrl}/v1/items/${encodeURIComponent(ref)}`, {
		headers: secretHeaders.bearer(doorSecretName),
	})
	if (response.status === 404) throw new Error(`vault has no item "${ref}"`)
	if (!response.ok) throw new Error(`vault responded ${response.status}`)
	const item = await response.json()
	return { value: item.value, hosts: item.hosts ?? [], canonicalRef: item.id }
}
