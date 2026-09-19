# @kody-smoke/smoke-vault

Minimal `kody.secretProvider` package used by `smoke/secret-providers.mjs`. The
mock vault returns `{ id, value, hosts }` for `GET /v1/items/:ref` with the door
token as a bearer; the provider passes that through as
`{ value, hosts, canonicalRef }`. Kody caches the value in memory only and
injects it into requests bound for one of `hosts`.
