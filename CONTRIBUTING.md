# Contributing to aisdk-posthog

Thanks for helping out. This is a community-maintained package, not an official PostHog SDK.

## Setup

Requirements: Node >= 22.12 and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
```

## Layout

```
src/        library sources (entry points: src/index.ts, src/ai.ts)
test/       vitest suites
examples/   runnable examples (not published)
dist/       build output (git-ignored)
```

## Everyday commands

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm format        # prettier --write
pnpm test          # vitest run
pnpm build         # tsup -> dist (ESM + CJS + types)
```

CI runs typecheck, lint, format check, tests and build on Node 22 and 24.

## Pull requests

- Branch from `main`; keep PRs focused.
- Add or update tests for behavior changes.
- Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `chore:`, `docs:`; `!` for breaking changes).
- Add an entry to `CHANGELOG.md` under an "Unreleased" heading for user-visible changes.
- The public API is the `aisdk-posthog` and `aisdk-posthog/ai` entry points; changing either is a semver-relevant change.

## Releasing (maintainers)

1. Update `version` in `package.json` and move the changelog entries under that version.
2. Merge to `main`, then push a tag `vX.Y.Z`.
3. The `Release` workflow verifies the tag matches `package.json`, runs the checks and publishes to npm with provenance.

## Reporting security issues

See [SECURITY.md](./SECURITY.md). Do not open public issues for vulnerabilities.
