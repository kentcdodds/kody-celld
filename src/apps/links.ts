import { appUrl, readAppConfig } from './app-url.ts'

export function packageAppLinks(
	env: { KODY_APP_BASE_URL?: string | undefined; KODY_PUBLIC_URL: string },
	userId: string,
	packageName: string,
):
	| { url: string; openUrl: string }
	| { error: 'apps_disabled' | 'app_origin_misconfigured' | 'app_origin_unmappable'; message: string } {
	const apps = readAppConfig(env)
	if (!apps) return { error: 'apps_disabled', message: 'Package apps are off on this server (set KODY_APP_BASE_URL).' }
	if (!apps.ok) return { error: 'app_origin_misconfigured', message: apps.error }
	const url = appUrl(apps.config, userId, packageName)
	if (!url)
		return { error: 'app_origin_unmappable', message: 'This account id cannot be used as a package-app subdomain.' }
	const publicUrl = env.KODY_PUBLIC_URL.replace(/\/$/, '')
	return { url: `${url}/`, openUrl: `${publicUrl}/apps/open?package=${encodeURIComponent(packageName)}` }
}
