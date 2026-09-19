# Agent notes: @kody-smoke/inbox-hooks

- Default export returns `{ deliveries, emails }` counters and the last few rows.
- `webhookUrlMint({ packageName: '@kody-smoke/inbox-hooks', webhookName: 'github' | 'stripe' | 'plain' })` mints URLs.
- `github` and `stripe` need `secretSave` for `githubWebhookSecret` / `stripeWebhookSecret` first.
