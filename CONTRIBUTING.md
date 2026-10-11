# Contributing

This repository is Fair Source ([FSL-1.1-ALv2](./LICENSE)). Outside pull
requests need a signed inbound Contributor License Agreement. You keep
copyright; the CLA is the license grant that keeps kody-celld a single-licensor
tree.

- [Inbound contributions](./docs/contributing/inbound-contributions.md): who
  signs, how to sign, and maintainer steps
- [Individual CLA](./docs/legal/individual-cla.md)
- [Entity CLA](./docs/legal/entity-cla.md)
- [0018: Inbound CLA](./docs/contributing/decisions/0018-inbound-cla.md)

## Contributor bar

kody-celld is a faithful self-host of
[hosted Kody](https://github.com/kentcdodds/kody). Before opening a PR:

1. State the **need** and how hosted Kody does it (cite the hosted file).
2. Justify any **new dependency**, abstraction, or `KODY_` variable
   ([Earn every dependency](./docs/principles/earn-every-dependency.md)).
3. Keep the PR under about **800 changed lines**; split larger work.
4. Add **no second way** of doing an existing thing; delete the old lane or
   file a removal issue.
5. Add **no test-only code in production**
   ([No invasive test-only code](./docs/principles/no-invasive-test-only-code.md)).

Use the [pull request template](./.github/pull_request_template.md). Stewards
and review agents follow
[docs/contributing/review-checklist.md](./docs/contributing/review-checklist.md).

## Setup and maps

- [Contributing index](./docs/contributing/index.md)
- [Engineering principles](./docs/principles/index.md)
- [Getting started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Agent guide](./AGENTS.md)
