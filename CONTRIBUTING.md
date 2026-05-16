# Contributing

Thanks for considering a contribution. This is a small, focused library
with a strong opinion about scope, so a quick read of this doc will save
you a round-trip during review.

## Scope — what belongs here

This package translates between OpenAI's Chat Completions wire format
and the native wire formats of other LLM providers. That's it. In scope:

- Adding a new provider that maps cleanly onto canonical (OpenAI) shape
- Fixing wire-format translation bugs (request reshape, response
  unshape, SSE event translation)
- Surfacing previously-dropped fields (e.g. Anthropic thinking blocks)
  through canonical shape
- Improving warnings, error messages, type definitions
- Adding integration tests that catch real translation regressions

Out of scope:

- Retry strategies beyond classifying which status codes are retryable
  (`isRetryableUpstreamStatus`) — that belongs in the consumer's
  transport layer
- Rate-limit handling, cost tracking, request logging — same
- Building a hosted gateway or HTTP server — see `examples/04-express-proxy`
  for the smallest possible reference, but the gateway itself is not
  this package's product
- Anything that pulls in a runtime dependency — the zero-runtime-deps
  promise is load-bearing. Test-only deps go through review separately.

If you're unsure, open an issue describing the change before writing
code. We'd rather discuss scope upfront than ask you to revert
something late.

## Development setup

Requires Node 22 or later (24 recommended — that's what CI publishes
with).

```bash
git clone https://github.com/encorp-io/llm-open-proxy
cd llm-open-proxy
npm install
npm run typecheck     # tsc --noEmit
npm test              # 200+ unit tests, must stay green
```

To run integration tests against real upstream APIs (opt-in, requires
API keys, costs <$0.01 per full run):

```bash
cp .env.example .env
# edit .env, set whichever provider keys you have
npm run test:integration
```

See `tests/integration/README.md` for the coverage matrix and per-test
cost notes.

## Commit messages — Conventional Commits

Releases are fully automated by [release-please](https://github.com/googleapis/release-please).
It reads commit messages on `main` and opens a Release PR with the
version bump and CHANGELOG entry it inferred. To make sure your commit
ends up in the right CHANGELOG section, use [Conventional Commit](https://www.conventionalcommits.org/)
prefixes:

| Prefix                          | Bump   | Used for                          |
| ------------------------------- | ------ | --------------------------------- |
| `fix:`                          | patch  | Bug fix                           |
| `feat:`                         | minor  | New feature, backwards-compatible |
| `feat!:` or `BREAKING CHANGE:`  | major  | Breaking change                   |
| `perf:`                         | none   | Perf improvement, no bump         |
| `refactor:`                     | none   | Internal cleanup                  |
| `docs:`                         | none   | Docs-only change                  |
| `test:` `chore:` `ci:` `build:` | none   | Hidden from CHANGELOG             |

Scope is optional but encouraged for narrow changes:

```
feat(anthropic): support tool_choice=any
fix(streaming): accumulate tool_call args across SSE chunks
docs(readme): clarify retry semantics
```

Pre-1.0 (currently `0.x.y`) we keep `feat!:` at a minor bump rather than
major — see `release-please-config.json` (`bump-minor-pre-major: true`).
Once we cut 1.0.0, breaking changes get a major bump as usual.

## PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (unit suite stays green)
- [ ] If you touched a provider adapter, you ran the relevant
      integration test for that provider locally
- [ ] If you added a public API surface, you added a TypeScript example
      to a docstring or `examples/`
- [ ] Conventional commit prefix on every commit (squash/rebase your
      WIP commits before opening PR if needed)
- [ ] No new runtime dependencies in `dependencies` (dev deps need a
      separate justification)

CI runs the unit suite + typecheck + build on every PR. Integration
tests are not run in CI (they cost money) — running them locally before
opening a PR for adapter changes is the contributor's responsibility.

## What happens after merge

1. release-please sees your conventional-commit message and either
   updates its open "Release PR" or opens a new one with the bumped
   version + CHANGELOG entry.
2. A maintainer merges the Release PR when ready to ship.
3. release-please tags + creates a GitHub Release.
4. `release.yml` publishes to npm via Trusted Publishing OIDC, with
   a Sigstore provenance attestation linking the published tarball
   back to the exact GitHub Actions run that built it.

No npm token is stored anywhere; the publish identity is the workflow
itself.

## Questions

Open an issue or start a draft PR. We respond on weekdays, usually
within a day or two.
