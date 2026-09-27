<!-- Locally Maintained -->
# NPM Dependency Pairing

[Back to Local Instructions Index](index.md)

## Vitest and Coverage Provider Must Stay Paired (MANDATORY)

`vitest` and `@vitest/coverage-v8` must always be installed or updated together, at versions each declares as peer-compatible with the other, whether the change is manual or a Dependabot PR.

`@vitest/coverage-v8` is a coverage provider plugin whose supported version range is tied to the `vitest` core version it plugs into; letting the two drift apart risks a coverage run failing outright or silently reporting incorrect results. The general "update required peer dependencies together" rule in [npm.instructions.md](../global/npm.instructions.md#fixed-package-versions) does not by itself catch this: `@vitest/coverage-v8` declares `vitest` as a *required* peer, but `vitest` declares `@vitest/coverage-v8` as only an *optional* peer, so a `vitest`-first bump would not be flagged by that rule alone. This file exists to close that gap in the direction the general rule misses.
