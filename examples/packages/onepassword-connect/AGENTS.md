# Agent notes: @kody-examples/onepassword-connect

- `./secretProvider` is invoked by Kody only (sealed run). Never call it from
  `packageRun`; it would return the secret into run history.
- Default export `status({ baseUrl })` hits `/heartbeat` without credentials.
- Refs by title/label resolve to a `canonicalRef` with ids; grant that.
