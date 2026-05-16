<!--
Thanks for contributing!

Title format: use a Conventional Commit prefix.
  feat: ...        — new feature, minor bump
  fix: ...         — bug fix, patch bump
  feat!: ...       — breaking change (pre-1.0: still minor)
  docs: / test: / chore: / refactor: / perf: — see CONTRIBUTING.md
-->

## What

<!-- One-line summary of the change. -->

## Why

<!-- Link to issue (#nnn) or describe the problem. -->

## How

<!-- Brief description of the approach. Call out anything non-obvious. -->

## Test plan

<!-- Tick each that applies. -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (unit suite stays at ≥204 tests, all green)
- [ ] If a provider adapter changed: I ran the relevant integration test
      locally and pasted output below
- [ ] If a public API changed: I updated the README / TypeDoc / examples
- [ ] No new runtime dependencies

<!-- Paste relevant integration test output here if applicable. -->

## Breaking changes

<!-- If any, list them. Pre-1.0 we still ship breaking changes as minor
     bumps, but call them out so users updating across minors know. -->

None.
