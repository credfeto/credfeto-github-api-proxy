<!-- Locally Maintained -->
# NPM Dependency Pairing

[Back to Local Instructions Index](index.md)

## Vitest and Coverage Provider Must Stay Paired (MANDATORY)

`vitest` and `@vitest/coverage-v8` must always be installed or updated together, at compatible versions. This applies to any install or update of either package, whether performed manually or via a Dependabot PR; do not bump one without also bumping the other to a version compatible with it in the same change.

This holds because `@vitest/coverage-v8` is a coverage provider plugin whose supported version range is tied to the `vitest` core version it plugs into; letting the two drift apart risks a coverage run failing outright or silently reporting incorrect results.
