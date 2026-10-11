## Intent

<!-- Overarching goal of this change: what it is for, not how it works. -->

**Door:** `two-way` | `one-way`
<!--
`two-way`: cheap to reverse. Ship and change if wrong.
`one-way`: expensive to undo (stored shapes, public contracts, deleted user data). Spend the review here. Escalate product or security one-way doors to Kent.
-->

**Cleanup:** `none` | `needed` | `done`
<!--
`none`: no leftover old lane.
`needed`: migration left something to delete later. Fill What to delete below.
`done`: leftovers already removed in this PR.
-->

**What to delete:** <!-- only when Cleanup is `needed` -->

## Why

<!-- State the need. How does hosted Kody do this today? Cite the hosted file or say it is new in both. -->

**Hosted Kody:** <!-- path in kentcdodds/kody, or "n/a (celld runtime only)", or "lands in hosted first / same change" -->

## Summary

<!-- What changed. Short bullets are fine. Keep the PR under about 800 changed lines; split larger work. -->

## New dependency, abstraction, or `KODY_` variable

<!-- "None" or justify each. Prefer hosted's approach. See Earn every dependency. -->

## Referenced issues and PRs

<!--
Use Fixes / Closes / Resolves #1234 only when this PR fully fixes the issue.
Related work: Related to #1234. Never write "does not close #N".
-->

## Testing

<!-- What you ran: validate, focused tests, smoke summary line when you ran smoke. -->
