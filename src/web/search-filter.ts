export function matchesSearchQuery(query: string, searchableValues: ReadonlyArray<string | null | undefined>) {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return true

	const haystack = searchableValues
		.filter((value): value is string => typeof value === 'string')
		.join(' ')
		.toLowerCase()

	return tokens.every((token) => haystack.includes(token))
}
