// Install smoke: install a package straight from GitHub (tarball via
// codeload.github.com), run it, update it from its recorded source, and prove
// the source-host policy refuses disallowed / private hosts and that package
// code cannot install packages. Set SMOKE_OFFLINE=1 to skip the GitHub part.
import { assert, log } from './lib.mjs'

// The example package lives in this repository; `main` is the stable ref.
const source = 'github:kentcdodds/kody-celld/examples/packages/http-probe#main'

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
		notListed.isError && /KODY_PACKAGE_SOURCE_HOSTS/.test(JSON.stringify(notListed.payload)),
		'hosts outside KODY_PACKAGE_SOURCE_HOSTS must be refused',
		notListed.payload,
	)
	const badSpec = await mcp.callDirectRaw('packageInstall', { source: 'github:owner' })
	assert(
		badSpec.isError && /github:owner\/repo/.test(JSON.stringify(badSpec.payload)),
		'bad github: spec',
		badSpec.payload,
	)
	log('policy', 'link-local, unlisted host and malformed spec refused')

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

	if (process.env.SMOKE_OFFLINE === '1') {
		log('skip', 'SMOKE_OFFLINE=1 (no route to GitHub)')
		return
	}

	// Ad hoc runs act as the user and may install.
	const installed = await mcp.call('packageInstall', { source })
	assert(installed.name === '@kody-smoke/http-probe', 'installed the wrong package', installed)
	assert(installed.source === source, 'source should be recorded verbatim', installed)
	assert(/codeload\.github\.com/.test(installed.fetchedFrom), 'GitHub sources download via codeload', installed)
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
	assert(updated.source === source && updated.previousVersion === installed.version, 'update kept provenance', updated)
	log('packageUpdate', { version: updated.version, previousVersion: updated.previousVersion })
}
