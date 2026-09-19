# @kody-smoke/http-probe

Calls `url` with `Authorization: Bearer {{secret:<secretName>}}`. Used by the
secrets smoke to prove that:

1. an unapproved host is denied before any bytes leave the runtime, and
2. once the host is approved, the gateway injects the value and the code never
   observes it.
