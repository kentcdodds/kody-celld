import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { Code, Muted, PreBlock } from './form-controls.tsx'

type Data = Extract<AppLoaderData, { page: 'accountPackageFiles' }>

export function PackageFiles(handle: Handle<{ data: Data; pathname: string }>) {
	return () => {
		const { data, pathname } = handle.props
		const packageHref = routes.accountPackageDetail.href({ name: data.name })

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title={`${data.name} files`}
					description={`Files in ${data.name} v${data.version}.`}
					currentHref={pathname}
					actions={<a href={packageHref}>Back to package</a>}
				/>
				<AccountManagementPanel title="Package files">
					{data.files.length > 0 ? (
						<ul
							mix={css({
								margin: 0,
								paddingLeft: '1.2rem',
								display: 'grid',
								gap: spacing.xs,
								color: colors.text,
							})}
						>
							{data.files.map((file) => (
								<li key={file.path}>
									<a
										href={routes.accountPackageFiles.href({
											name: data.name,
											relativePath: file.path,
										})}
										aria-current={
											data.selected?.path === file.path ? 'page' : undefined
										}
									>
										<Code>{file.path}</Code>
									</a>
									<Muted small> {file.bytes} bytes</Muted>
								</li>
							))}
						</ul>
					) : (
						<p>No files in this package.</p>
					)}
				</AccountManagementPanel>
				{data.selected ? (
					<AccountManagementPanel title={data.selected.path}>
						<PreBlock>{data.selected.content}</PreBlock>
						{data.selected.truncated ? (
							<p>File content is truncated at 200,000 characters.</p>
						) : null}
					</AccountManagementPanel>
				) : (
					<AccountManagementPanel ariaLabel="Selected file">
						<p>Select a file to view its contents.</p>
					</AccountManagementPanel>
				)}
			</AccountManagementShell>
		)
	}
}
