// kody-celld: community asset hrefs are not ported (no /assets/ route); README images stay links.
import {
	joinPackageFilesPath,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'

export const packageReadmeImageMaxBytes = 2 * 1024 * 1024

const packageReadmeImageExtensions = [
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'svg',
] as const

const packageReadmeImageExtensionSet = new Set<string>(
	packageReadmeImageExtensions,
)

function extensionOfPath(path: string) {
	const name = path.split('/').pop() ?? ''
	const separator = name.lastIndexOf('.')
	if (separator <= 0 || separator === name.length - 1) return ''
	return name.slice(separator + 1).toLowerCase()
}

/** True when the repo-relative path is a README-servable image file. */
export function isPackageReadmeImagePath(path: string) {
	return packageReadmeImageExtensionSet.has(extensionOfPath(path))
}

/**
 * Directory that owns a file path (`docs/README.md` → `docs`). Empty for a
 * root file so `./poster.png` stays at the package root.
 */
export function directoryOfPackageFilePath(path: string | null | undefined) {
	if (!path) return ''
	const lastSlash = path.lastIndexOf('/')
	return lastSlash === -1 ? '' : path.slice(0, lastSlash)
}

/**
 * Resolve a markdown image href against a package file directory.
 * Only in-repo relative paths with an allowlisted image extension pass.
 * Protocols, `//`, query/hash, and `..` traversal fail closed.
 */
export function resolvePackageReadmeImagePath(
	href: string,
	fromDirectory = '',
): string | null {
	const trimmed = href.trim()
	if (!trimmed) return null
	if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(trimmed)) return null
	if (trimmed.startsWith('//')) return null
	if (trimmed.includes('?') || trimmed.includes('#')) return null
	const combined = trimmed.startsWith('/')
		? trimmed
		: fromDirectory
			? `${fromDirectory}/${trimmed}`
			: trimmed
	const normalized = normalizePackageFilesPath(combined)
	if (!normalized || !isPackageReadmeImagePath(normalized)) return null
	return normalized
}

export function joinPackageReadmeImageHref(
	imageBaseHref: string,
	relativePath: string,
) {
	return joinPackageFilesPath(imageBaseHref, relativePath)
}
