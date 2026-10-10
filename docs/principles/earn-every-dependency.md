# Earn every dependency

No new dependency, abstraction, or config knob without a stated need that
hosted Kody's approach cannot meet. Prefer deletion over addition.

## Rules

- **Dependencies.** State the need, the size, and whether hosted Kody uses the
  same package at the same version. If hosted does not use it, say why celld
  must. Prefer matching hosted's choice over a celld-only library.
- **Abstractions.** No new interface, helper module, or wrapper with a single
  caller. Extract only when a second real caller exists, or when hosted already
  has the same seam.
- **Config knobs.** A new `KODY_` variable must not be derivable from, or
  foldable into, an existing one. Prefer one allowlist / one adapter URL over
  per-feature copies.
- **Deletion first.** Before adding a lane, ask what the change deletes. A PR
  that only adds is unfinished when an old path still works beside it.

## Related

- [Match hosted first](./match-hosted-first.md)
- [Generic platform](./generic-platform.md)
- [Delete what is off the common path](./delete-off-the-common-path.md)
- [Cleanup](./cleanup.md)
