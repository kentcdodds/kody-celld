# Agent notes: @kody-smoke/smoke-vault

- `./secretProvider` is sealed: Kody refuses to run it via `packageRun`.
- Bind with `secretProviderBind({ providerId: 'smokevault', packageName: '@kody-smoke/smoke-vault', doorSecretName, config: { baseUrl } })`.
