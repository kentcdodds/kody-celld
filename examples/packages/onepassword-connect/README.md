# @kody-examples/onepassword-connect

A `kody.secretProvider` package for a self-hosted
[1Password Connect](https://developer.1password.com/docs/connect/) server.

```text
{{secret/1password:vaults/<vaultId>/items/<itemIdOrTitle>/fields/<fieldIdOrLabel>}}
```

Setup (from an MCP session):

1. `packageSave` this directory.
2. `secretSave({ name: 'op-connect-token', value: '<connect token>' })` — the
   "door" secret. Have an admin approve your Connect host for secret injection
   so the provider itself can reach it.
3. `secretProviderBind({ providerId: '1password', packageName: '@kody-examples/onepassword-connect', doorSecretName: 'op-connect-token', config: { baseUrl: 'https://connect.example.com' } })`.

The item's website URLs become the hosts the resolved value may be sent to;
`canonicalRef` pins grants to the item/field ids even when you reference by
title or label.
