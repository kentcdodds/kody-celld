# @kody-smoke/oauth-client

Shows how a package uses a connected OAuth integration without ever holding a
token:

- `./call({ integration, url })` uses `createAuthenticatedFetch(integration)`;
  the gateway injects the token at the network boundary.
- Subscribes to `integration.auth.succeeded` / `integration.auth.failed` and
  files the (metadata-only) events in `packageStorage()`; the default export
  lists them.
