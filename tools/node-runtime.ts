import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function isExecutedDirectly(importMetaUrl: string) {
	const entryPoint = process.argv[1]
	if (!entryPoint) {
		return false
	}

	return pathToFileURL(path.resolve(entryPoint)).href === importMetaUrl
}
