import {
	highlightMarkdownFences,
	highlightSnippets,
	type HighlightEnv,
} from '#app/highlight-code.ts'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import { isPackageFilesMediaKind } from '#universal/package-file-media.ts'
import {
	buildPackageFilesView,
	contentKindFromLanguage,
	languageFromFilePath,
	normalizePackageFilesPath,
	type PackageFilesView,
} from '#universal/package-files.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { createInProcessHighlightFetcher } from '../highlight/binding.ts'
import { packageFileViewMaxChars } from '../packages/install.ts'

/**
 * Server half of kody's files explorer (kody: packages/worker/src/app/package-files-data.ts).
 * kody loads files from D1/artifact repos and community listings; kody-celld hands in the
 * saved package's file map or a fetched preview source, then shares kody's `toLoaderData`.
 */

export function inProcessHighlightEnv(): HighlightEnv {
	return { HIGHLIGHT: createInProcessHighlightFetcher() }
}

/**
 * kody-celld: kody previews images, audio and video through its `/raw/` route. Packages here
 * hold UTF-8 text only and there is no raw route, so a file kody would show as media (a real
 * `.svg`, a text file named `.png`) is shown as text instead of hitting the explorer's media
 * branch, which requires a raw href.
 */
export function withoutMediaPreview(
	view: PackageFilesView,
	files: Record<string, string>,
): PackageFilesView {
	if (!view.contentPath || !isPackageFilesMediaKind(view.contentKind))
		return view
	const content = files[view.contentPath] ?? ''
	const language = languageFromFilePath(view.contentPath)
	return {
		...view,
		content,
		language,
		contentKind: contentKindFromLanguage(language),
	}
}

/**
 * kody-celld: the explorer island carries the file in its props and the Copy button
 * again, so very large files (lockfiles, bundles) are cut for display, as the previous
 * file viewer did. The header still shows the real size (`contentByteLength`). The
 * truncated notice is a separate loader field so Copy does not include it.
 */
export function withDisplayCap(view: PackageFilesView): PackageFilesView & {
	contentTruncated: boolean
} {
	if (!view.content || view.content.length <= packageFileViewMaxChars) {
		return { ...view, contentTruncated: false }
	}
	return {
		...view,
		content: view.content.slice(0, packageFileViewMaxChars),
		contentTruncated: true,
	}
}

// kody's toLoaderData, minus community / media / icon fields this project does not have.
async function toLoaderData(input: {
	env: HighlightEnv
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	view: PackageFilesView & { contentTruncated?: boolean }
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData> {
	const contentKind = input.view.contentKind
	const omitText =
		isPackageFilesMediaKind(contentKind) || contentKind === 'binary'
	const content = omitText ? null : input.view.content
	const language = omitText ? null : input.view.language
	const highlightOptions = { serverTiming: input.serverTiming }
	const contentFences =
		contentKind === 'markdown' && content
			? await highlightMarkdownFences(input.env, content, highlightOptions)
			: []
	const highlighted =
		contentKind === 'code' && content
			? ((
					await highlightSnippets(
						input.env,
						[{ code: content, lang: language ?? 'plaintext' }],
						highlightOptions,
					)
				)[0] ?? plainHighlightedCode(content, language))
			: content
				? plainHighlightedCode(content, language)
				: null
	return {
		ok: true,
		title: input.title,
		backHref: input.backHref,
		backLabel: input.backLabel,
		filesBasePath: input.filesBasePath,
		selectedPath: input.view.selectedPath,
		kind: input.view.kind,
		paths: input.view.paths,
		children: input.view.children,
		content,
		contentPath: input.view.contentPath,
		contentKind,
		language,
		contentByteLength: input.view.contentByteLength,
		contentTruncated: input.view.contentTruncated === true,
		mediaHref: null,
		contentFences,
		// kody-celld: a plain result is the content again; the explorer rebuilds it from `content`.
		contentHighlighted: highlighted?.plain ? null : highlighted,
		imageBaseHref: null,
	}
}

export async function loadPackageFilesData(input: {
	env: HighlightEnv
	files: Record<string, string>
	selectedPath: string
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	// kody-celld: route params arrive decoded, while kody's normalizer takes a
	// URL path and decodes it; re-encode each segment so it decodes exactly once
	// (`100%.txt` opens, `a%41.txt` stays itself). Traversal checks still apply.
	const selectedPath = normalizePackageFilesPath(
		input.selectedPath.split('/').map(encodeURIComponent).join('/'),
	)
	if (selectedPath === null) return null
	const view = buildPackageFilesView({ files: input.files, selectedPath })
	if (!view) return null
	return toLoaderData({
		...input,
		view: withDisplayCap(withoutMediaPreview(view, input.files)),
	})
}
