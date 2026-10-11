# Steward review checklist

Review agents and humans use this bar for contributor and agent PRs. Open the
[principles index](../principles/index.md) for the full rule; this list is the
gate.

## Checklist

- [ ] States the need and how [hosted Kody](https://github.com/kentcdodds/kody)
      does it (cite the hosted file), or why celld must differ
- [ ] Capability names and arguments match hosted when the surface exists there
- [ ] Any new dependency has a stated need and size; hosted uses it at the same
      version, or there is a reason it cannot
- [ ] Any new `KODY_` variable cannot be derived from, or folded into, an
      existing one
- [ ] Adds no second way to do something that already exists; the old way is
      deleted in the same PR or has a removal issue
- [ ] No new abstraction with a single caller
- [ ] No test-only parameters, exports, env branches, or helper files in `src/`
- [ ] Tests are flat, one workflow each, with an oracle the production code
      does not share ([Test the workflow](../principles/test-the-workflow.md))
- [ ] Under about **800** changed lines, or split as agreed up front
- [ ] States what it deletes (`Cleanup` on the PR template)
- [ ] Security-model, contract, or product choices go to Kent as one-way doors
- [ ] Verbatim synced files were not hand-edited (run `npm run sync:kody:check`)

## Related

- [PR template](../../.github/pull_request_template.md)
- [Match hosted first](../principles/match-hosted-first.md)
- [Earn every dependency](../principles/earn-every-dependency.md)
- [Shared-from-kody sync lock](./shared-from-kody.md)
