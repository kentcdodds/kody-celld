# Match hosted first

kody-celld is a faithful self-host of
[hosted Kody](https://github.com/kentcdodds/kody), not a separate product.
Copy hosted Kody's behaviour, contracts, and code before inventing a celld-only
shape. Capability names, arguments, placeholder grammar, package manifests, and
UI patterns should match hosted unless there is a written reason they cannot.

## Rules

- Before adding or changing a surface, open the hosted file that owns it and
  mirror that design. Cite the hosted path in the PR.
- Contract changes (MCP shapes, placeholders, manifests, schedules) land in
  hosted Kody first, or in the same change set on both sides with Kent's say.
- celld-only code is limited to runtime and infrastructure adapters (celld
  Worker Loader quirks, S3 durability, generic SMTP / OpenAI-compatible / S3 /
  CDP providers). Feature work is not an excuse for a second design.
- Any intentional divergence needs:
  1. a written reason in the PR, and
  2. a note under "Intentional divergences" in
     [docs/decision-standalone-vs-adapters.md](../decision-standalone-vs-adapters.md).

## Related

- [Earn every dependency](./earn-every-dependency.md)
- [Generic platform](./generic-platform.md)
- [Cleanup](./cleanup.md)
