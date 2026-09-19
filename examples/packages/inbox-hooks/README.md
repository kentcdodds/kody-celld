# @kody-smoke/inbox-hooks

Example package that declares three inbound webhooks (`github`, `stripe`,
`plain`) and one email subscription (`email.message.received`). Each delivery
or email is appended to a table in `packageStorage()`; the default export
reports what arrived.

Used by `smoke/webhooks.mjs` and `smoke/email.mjs`.
