# Publishing

This package is published to npm as **`@encorp.ai/llm-open-proxy`** using
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) — no
long-lived `NPM_TOKEN` is stored anywhere. GitHub Actions exchanges its
short-lived OIDC token directly with npm for a one-shot publish.

## One-time setup

You only do this once, before the first release.

### 1. Make sure the npm org exists

Org name: `encorp.ai`. URL: <https://www.npmjs.com/org/encorp.ai>.

If it doesn't exist yet, create it under your npm account
(Profile → Add Organization → free tier is fine for public packages).

### 2. Configure Trusted Publisher on npmjs.com

Trusted Publisher must be added *before* the first publish — npm refuses
to auto-create the package via OIDC unless a publisher claim is already
on file for the scope.

1. Go to **<https://www.npmjs.com/package/@encorp.ai/llm-open-proxy/access>**
   (yes, even though the package doesn't exist yet — npm lets you
   pre-register a trusted publisher under the scope).

   Or: org page → **Packages** → **Add Package** → choose
   "GitHub Actions" as publishing method.

2. Fill in:

   | Field                | Value                       |
   | -------------------- | --------------------------- |
   | Organization or user | `encorp-io`                 |
   | Repository           | `llm-open-proxy`            |
   | Workflow filename    | `release.yml`               |
   | Environment name     | *(leave blank)*             |

3. Save. The publisher claim now exists; npm will accept OIDC tokens
   that match this exact `(repo, workflow)` tuple.

### 3. (Optional) Add a GitHub Environment for extra gating

If you want a manual approval gate before every publish (recommended
for production packages), create a GitHub Environment named `npm` with
required reviewers, then:

- Add `environment: npm` under the `publish` job in `release.yml`.
- Re-enter "npm" as the **Environment name** on the npm Trusted Publisher
  config.

We skip this by default for a smoother first release.

## Cutting a release — automated via release-please

Day-to-day you **never bump versions by hand**. The flow is:

1. **Commit with [Conventional Commits](https://www.conventionalcommits.org/)**
   prefixes on `main` (or in PRs that merge to `main`):

   | Prefix              | Bump  | Example                                         |
   | ------------------- | ----- | ----------------------------------------------- |
   | `fix:`              | patch | `fix: clamp Anthropic temperature at 1.0`       |
   | `feat:`             | minor | `feat: support tool_choice=any for Anthropic`   |
   | `feat!:` / `BREAKING CHANGE:` | major | `feat!: rename convertChatRequest → translate` |
   | `perf:` `refactor:` `docs:` `deps:` | no bump, but lands in CHANGELOG |        |
   | `chore:` `test:` `ci:` `build:` `style:` | hidden | (no bump, no CHANGELOG entry) |     |

   Scope is optional: `feat(google): add safety_settings passthrough`.

2. **`release-please.yml`** sees the new commits and opens (or updates) a
   PR titled **"chore(main): release X.Y.Z"** that:
   - Bumps `package.json` version
   - Prepends a CHANGELOG.md entry grouped by section
   - Updates `.release-please-manifest.json`

3. **Merge the Release PR** when you're ready to ship. release-please then:
   - Creates a git tag `vX.Y.Z` on the merge commit
   - Creates a GitHub Release with the CHANGELOG entry as release notes

4. **`release.yml`** fires on the Release published event and:
   - Re-runs typecheck + tests + build
   - Verifies the tag matches package.json version
   - Runs `npm publish --provenance --access public` (auth via Trusted Publishing OIDC)

After it succeeds, the package page on npmjs.com shows a green
**"Published with provenance"** badge linking back to the exact GitHub
Actions run that built it.

### One-time GitHub setting

release-please opens PRs from `GITHUB_TOKEN`. Some orgs disable that by
default — if the workflow run fails with `GitHub Actions is not permitted
to create or approve pull requests`, go to:

**Repo → Settings → Actions → General → Workflow permissions** →
✅ "Allow GitHub Actions to create and approve pull requests".

### Manual escape hatch

If you ever need to ship without going through release-please (e.g. an
emergency patch on an older line), you can still trigger `release.yml`
directly via `workflow_dispatch` after creating a tag + Release by hand:

```bash
npm version patch          # bumps package.json + creates tag + commit
git push --follow-tags
gh release create v0.1.2 --generate-notes
```

But for normal work, just use conventional commits and merge the Release PR.

## Verifying the first publish

```bash
npm view @encorp.ai/llm-open-proxy
npm view @encorp.ai/llm-open-proxy --json | jq '.dist."npm-signature", .dist.attestations'
```

Or browse to <https://www.npmjs.com/package/@encorp.ai/llm-open-proxy> and
look for the provenance section under "Published with".

## If something goes wrong

- **`npm error 403 Forbidden — You do not have permission to publish "@encorp.ai/llm-open-proxy"`**
  → Trusted Publisher claim doesn't exist yet, or the repo/workflow
  filename doesn't match. Re-check step 2 above.

- **`npm error code E404 — Not found`** during a first publish over OIDC
  → Same root cause. Trusted Publishing pre-creates the package, but only
  when the publisher claim is on file.

- **`npm error need auth`** → You're on an old npm. The workflow upgrades
  npm to latest before publishing; if you removed that step, restore it
  (Trusted Publishing requires npm ≥ 11.5.1).

- **Provenance badge missing** but publish succeeded
  → `id-token: write` permission missing from the workflow, or
  `--provenance` flag dropped from the `npm publish` invocation.
