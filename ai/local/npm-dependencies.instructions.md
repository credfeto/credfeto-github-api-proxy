<!-- Locally Maintained -->
# NPM Dependency Pairing

[Back to Local Instructions Index](index.md)

## Vitest and Coverage Provider Must Stay Paired (MANDATORY)

`vitest` and `@vitest/coverage-v8` must always be installed or updated together, at compatible versions, whether the change is manual or a Dependabot PR.

`@vitest/coverage-v8` is a coverage provider plugin whose supported version range is tied to the `vitest` core version it plugs into; letting the two drift apart risks a coverage run failing outright or silently reporting incorrect results. This is a stronger, explicit statement of the general peer-dependency rule in [npm.instructions.md](../global/npm.instructions.md#fixed-package-versions) for this specific, repo-relevant pair.
