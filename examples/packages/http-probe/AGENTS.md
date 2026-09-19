# Agent notes: @kody-smoke/http-probe

Default export: `probe({ url, secretName, header?, prefix? })`. A 403 with
`error: "secret_host_not_approved"` means an admin must approve the host with
`POST /admin/users/:id/secret-hosts { host }`.
`./provider`: `providerProbe({ url, provider, ref })` sends
`Authorization: Bearer {{secret/<provider>:<ref>}}` (needs a bound secret provider).
