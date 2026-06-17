# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Please ADD ALL Changes to the UNRELEASED SECTION and not a specific release
-->

## [Unreleased]
### Security
- Updated esbuild to 0.28.1 to fix path traversal vulnerability in local development server (GHSA-g7r4-m6w7-qqqr)
### Added
- Initial implementation: GitHub API proxy that blocks all git-write operations while passing through issues, PRs, and CI reads
- Docker support via Dockerfile, docker-compose, and distroless/nodejs20 runtime image running as nonroot
- Health endpoint (/health) for Docker HEALTHCHECK
- GitHub Actions workflow for Docker image build and publish
- Support for multiple credential pairs via credentials.json array, replacing single-pair env var approach
- Automated tests covering all startup paths, auth failure modes, and EACCES/EPERM permission errors
- Added .http test files for proxy-exposed endpoints and consumed GitHub APIs (api.github.com, uploads.github.com)
### Fixed
- Automatically populate headRepositoryId in createPullRequest GraphQL mutations when omitted, preventing PR creation failures when gh CLI uses a non-github.com GH_HOST
- Accept /api/v3/ prefix that gh CLI prepends for non-github.com hosts
- Graceful SIGTERM/SIGINT shutdown to prevent hang on docker compose stop
- Request logging added to console for all forwarded requests
- Rewrite /api/graphql to /graphql for GitHub Enterprise gh CLI compatibility
- Docker build fails when tests fail, preventing broken images from being published
- Resolved Vite CJS Node API deprecation warning in test output by upgrading vitest from 1.3.1 to 2.1.9 and renaming vitest.config.ts to vitest.config.mts to use native ESM module loading
### Changed
- Updated GitHub Actions to Node.js 24 compatible versions: actions/checkout@v6.0.3, docker/setup-buildx-action@v4.1.0, docker/build-push-action@v7.2.0
- Build uses esbuild to produce a single-file bundle with no node_modules in the runtime image
### Removed
### Deployment Changes
<!--
Releases that have at least been deployed to staging, BUT NOT necessarily released to live.  Changes should be moved from [Unreleased] into here as they are merged into the appropriate release branch
-->
## [0.0.0] - Project created