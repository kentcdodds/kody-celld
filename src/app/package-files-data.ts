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

// kody's toLoaderData, minus community / media / icon fields this project does not have.
async function toLoaderData(input: {
	env: HighlightEnv
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	view: PackageFilesView
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
	const contentHighlighted =
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
		mediaHref: null,
		contentFences,
		contentHighlighted,
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
	const selectedPath = normalizePackageFilesPath(input.selectedPath)
	if (selectedPath === null) return null
	const view = buildPackageFilesView({ files: input.files, selectedPath })
	if (!view) return null
	return toLoaderData({
		...input,
		view: withoutMediaPreview(view, input.files),
	})
}
