// Install smoke: policy refusals, package-code forbidden, then preview/install/
// update from a hermetic local JSON file-map (smoke/package-fixture-server.mjs).
// Does not fetch this repo's live github: tarball — main's file count can exceed
// the product 400-file archive ceiling and flake independently of install logic.
import { assert, log } from './lib.mjs'
import { gitPackageName, startPackageFixtureServer } from './package-fixture-server.mjs'

export async function smokeInstall({ mcp }) {
	// Policy checks need no network at all.
	const refused = await mcp.callDirectRaw('packageInstall', { source: 'https://169.254.169.254/latest/pkg.tgz' })
	assert(
		refused.isError && /private host/.test(JSON.stringify(refused.payload)),
		'link-local sources must be refused before any fetch',
		refused.payload,
	)
	const notListed = await mcp.callDirectRaw('packageInstall', { source: 'https://example.com/pkg.tgz' })
	assert(
		notListed.isError && /KODY_PRIVATE_HOSTS/.test(JSON.stringify(notListed.payload)),
		'hosts outside KODY_PRIVATE_HOSTS must be refused',
		notListed.payload,
	)
	const badSpec = await mcp.callDirectRaw('packageInstall', { source: 'github:owner' })
	assert(
		badSpec.isError && /github:owner\/repo/.test(JSON.stringify(badSpec.payload)),
		'bad github: spec',
		badSpec.payload,
	)
	log('policy', 'link-local, unlisted host and malformed spec refused')

	const fixture = await startPackageFixtureServer()
	try {
		const source = fixture.flatUrl

		// Package code must never install packages: save a tiny package that tries.
		await mcp.call('packageSave', {
			files: {
				'package.json': JSON.stringify({
					name: '@kody-smoke/installer',
					version: '1.0.0',
					description: 'Tries to install a package from inside package code.',
					exports: './main.js',
				}),
				'README.md': '# @kody-smoke/installer',
				'AGENTS.md': 'Run the default export; it must fail with forbidden.',
				'main.js': `import { kody } from 'kody:runtime'
export default async function main() { return await kody.packageInstall({ source: ${JSON.stringify(source)} }) }`,
			},
			source: 'smoke/install.mjs',
		})
		const fromPackage = await mcp.callDirect('packageRun', { name: '@kody-smoke/installer' })
		assert(
			!fromPackage.ok && /Package code may not install/.test(fromPackage.error?.message ?? ''),
			'package code must not be able to install packages',
			fromPackage,
		)
		log('package code refused', fromPackage.error.message)

		// Packages saved from local files have nothing to update from.
		const local = await mcp.callDirectRaw('packageUpdate', { name: '@kody-smoke/installer' })
		assert(
			local.isError && /not a remote source/.test(JSON.stringify(local.payload)),
			'local packages cannot update',
			local.payload,
		)
		log('local package update refused')

		// packagePreview can read one file so the code is reviewable before install.
		const preview = await mcp.call('packagePreview', { source, path: 'probe.js' })
		assert(
			preview.file?.path === 'probe.js' &&
				preview.file.content.includes('{{secret:') &&
				preview.file.truncated === false,
			'packagePreview returns the requested file content',
			preview.file,
		)
		const missingFile = await mcp.callDirectRaw('packagePreview', { source, path: 'nope.js' })
		assert(
			missingFile.isError && /was not found/.test(JSON.stringify(missingFile.payload)),
			'packagePreview refuses paths outside the package',
			missingFile.payload,
		)
		log('packagePreview', { files: preview.fileCount, file: preview.file.path, bytes: preview.file.bytes })

		// Ad hoc runs act as the user and may install.
		const installed = await mcp.call('packageInstall', { source })
		assert(installed.name === '@kody-smoke/http-probe', 'installed the wrong package', installed)
		assert(installed.source === source, 'source should be recorded verbatim', installed)
		assert(
			installed.fetchedFrom === source || installed.fetchedFrom.startsWith(source),
			'fixture URL should be the fetch target',
			installed.fetchedFrom,
		)
		log('packageInstall', {
			name: installed.name,
			version: installed.version,
			files: installed.files,
			fetchedFrom: installed.fetchedFrom,
			warnings: installed.warnings,
		})

		const listed = (await mcp.call('packageList')).packages.find((pkg) => pkg.name === '@kody-smoke/http-probe')
		assert(listed && listed.source === source, 'installed package should carry its source in packageList', listed)

		// packageUpdate re-fetches from the recorded source and keeps provenance.
		const updated = await mcp.call('packageUpdate', { name: '@kody-smoke/http-probe' })
		assert(
			updated.source === source && updated.previousVersion === installed.version,
			'update kept provenance',
			updated,
		)
		log('packageUpdate', { version: updated.version, previousVersion: updated.previousVersion })

		// Same fixture over `.git` smart HTTP (exercises pack inflate on celld).
		const gitPreview = await mcp.call('packagePreview', { source: fixture.gitUrl, path: 'probe.js' })
		assert(
			gitPreview.name === gitPackageName &&
				gitPreview.commit === fixture.gitCommit &&
				gitPreview.file?.path === 'probe.js' &&
				gitPreview.file.content.includes('{{secret:'),
			'git packagePreview returns the requested file and commit',
			gitPreview,
		)
		const gitInstalled = await mcp.call('packageInstall', { source: fixture.gitUrl })
		assert(gitInstalled.name === gitPackageName, 'git install wrong package', gitInstalled)
		assert(gitInstalled.commit === fixture.gitCommit, 'git install commit', gitInstalled)
		assert(
			String(gitInstalled.fetchedFrom).endsWith('/git-upload-pack'),
			'git install should fetch via upload-pack',
			gitInstalled.fetchedFrom,
		)
		log('git packageInstall', {
			name: gitInstalled.name,
			commit: gitInstalled.commit,
			fetchedFrom: gitInstalled.fetchedFrom,
		})
		const gitUpdated = await mcp.call('packageUpdate', { name: gitPackageName })
		assert(
			gitUpdated.source === fixture.gitUrl && gitUpdated.commit === fixture.gitCommit,
			'git update kept provenance',
			gitUpdated,
		)
		log('git packageUpdate', { commit: gitUpdated.commit })
	} finally {
		await fixture.close()
	}
}
