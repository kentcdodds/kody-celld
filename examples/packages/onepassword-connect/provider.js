import { secretHeaders } from 'kody:runtime'

// Sealed provider entry. Kody calls this with { providerId, ref, config,
// doorSecretName }; the return value goes to the gateway only (never stored).
//
// ref grammar: vaults/<vaultId>/items/<itemIdOrTitle>/fields/<fieldIdOrLabel>
// Default field: "credential", then "password".
const refPattern = /^vaults\/([^/]+)\/items\/([^/]+)(?:\/fields\/([^/]+))?$/

export default async function secretProvider({ ref, config, doorSecretName }) {
	const match = refPattern.exec(ref)
	if (!match) {
		throw new Error(`1password ref must look like vaults/<vault>/items/<item>[/fields/<field>], got "${ref}"`)
	}
	const [, vault, item, field] = match
	const baseUrl = (config.baseUrl ?? '').replace(/\/$/, '')
	if (!baseUrl) throw new Error('config.baseUrl (your 1Password Connect server URL) is required')

	const headers = secretHeaders.bearer(doorSecretName)
	let itemId = item
	if (!/^[a-z0-9]{26}$/.test(item)) {
		const search = await fetch(
			`${baseUrl}/v1/vaults/${encodeURIComponent(vault)}/items?filter=${encodeURIComponent(`title eq "${item}"`)}`,
			{ headers },
		)
		if (!search.ok) throw new Error(`1Password Connect item search failed: ${search.status}`)
		const matches = await search.json()
		if (matches.length !== 1) throw new Error(`expected exactly one item titled "${item}", found ${matches.length}`)
		itemId = matches[0].id
	}
	const response = await fetch(
		`${baseUrl}/v1/vaults/${encodeURIComponent(vault)}/items/${encodeURIComponent(itemId)}`,
		{
			headers,
		},
	)
	if (!response.ok) throw new Error(`1Password Connect item fetch failed: ${response.status}`)
	const data = await response.json()
	const wanted = field ?? 'credential'
	const found =
		data.fields?.find((f) => f.id === wanted || f.label === wanted || f.purpose?.toLowerCase() === wanted) ??
		(field ? undefined : data.fields?.find((f) => f.purpose === 'PASSWORD'))
	if (!found || typeof found.value !== 'string') throw new Error(`field "${wanted}" not found on item`)
	return {
		value: found.value,
		hosts: (data.urls ?? []).map((u) => u.href),
		canonicalRef: `vaults/${data.vault?.id ?? vault}/items/${data.id}/fields/${found.id}`,
	}
}
