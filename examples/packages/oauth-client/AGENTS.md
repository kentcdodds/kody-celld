# Agent notes: @kody-smoke/oauth-client

- `packageRun({ packageName: '@kody-smoke/oauth-client', exportName: './call', params: { integration, url } })`.
- A 403 `integration_host_not_allowed` means the URL host is not in the
  integration's `allowedHosts`; `integration_locked` means the integration's
  usage is package-limited and this package is not listed.
