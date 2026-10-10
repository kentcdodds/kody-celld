# Engineering principles

Short, durable rules for how we build kody-celld. Each page is one principle.
Load only the page the task needs.

kody-celld is a faithful self-host of
[hosted Kody](https://github.com/kentcdodds/kody). Shared principle pages are
copied from that repo and kept in sync by the sync lock (see
`shared-from-kody.json`). Do not hand-edit them — change them upstream, then
resync.

## Shared (synced from kody)

| Principle                                                                   | When to open it                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Generic platform](./generic-platform.md)                                   | Adding a vendor branch, a framework mount, or a provider-named type                                       |
| [Normalized source of truth](./normalized-source-of-truth.md)               | Adding a cache, index, or second store for a fact that already has a record                               |
| [Delete what is off the common path](./delete-off-the-common-path.md)       | Keeping a shim, flag, field, or doc for a path the product does not take                                  |
| [Cleanup](./cleanup.md)                                                     | A migration left the old lane beside the new one, or leftovers still name the old way                     |
| [Fail loudly at the right layer](./fail-loudly.md)                          | An error could be swallowed so a partial result continues                                                 |
| [Fix the root bottleneck](./fix-the-root-bottleneck.md)                     | Masking slowness with timeouts, fallbacks, or a quieter path                                              |
| [Two-way and one-way doors](./two-way-doors.md)                             | Deciding how much review a change needs                                                                   |
| [Examples over prose](./examples-over-prose.md)                             | Writing docs, skills, or a multi-step procedure                                                           |
| [Keep agent context lean](./lean-agent-context.md)                          | Editing `AGENTS.md`, agent skills, or deciding where guidance belongs                                     |
| [No invasive test-only code in production](./no-invasive-test-only-code.md) | Adding test seams, `*ForTests` exports, `NODE_ENV`/`VITEST` branches, or fixtures that would live in prod |
| [Test the workflow](./test-the-workflow.md)                                 | Adding or reshaping tests                                                                                 |

Related maps that live only in hosted Kody (open them there):
[contributing index](https://github.com/kentcdodds/kody/blob/main/docs/contributing/index.md),
[decision records](https://github.com/kentcdodds/kody/blob/main/docs/contributing/decisions/index.md),
[harness engineering](https://github.com/kentcdodds/kody/blob/main/docs/contributing/harness-engineering.md).

## kody-celld only

| Principle                                   | When to open it                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Match hosted first](./match-hosted-first.md) | Adding a capability, contract, UI surface, or behaviour that hosted Kody already has (or will) |
| [Earn every dependency](./earn-every-dependency.md) | Adding a dependency, abstraction, config knob, or `KODY_` variable                     |

## Epic Web principles

Do not copy these into the repo. Read them at the source when a change touches
coupling, consistency, merge size, or privilege:

[Epic Programming Principles](https://www.epicweb.dev/principles) — AHA, Do as
little as possible, Avoid tight coupling, Colocation, Keep it consistent, Don't
sync state, Least privilege, Small merge requests, and more.

## Related maps (this repo)

- [Contributing](../contributing/index.md)
- [Security invariants](../contributing/security-invariants.md)
- [celld compatibility](../contributing/celld-compat.md)
- [Architecture decision](../decision-standalone-vs-adapters.md)
