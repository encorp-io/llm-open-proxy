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

## Cutting a release

```bash
# 1. Bump version in package.json (semver). Examples:
npm version patch    # 0.1.0 → 0.1.1
npm version minor    # 0.1.0 → 0.2.0
npm version major    # 0.1.0 → 1.0.0
# This creates a commit + tag `v<version>`.

# 2. Push commit + tag
git push --follow-tags

# 3. Create a GitHub Release pointing at that tag
gh release create v0.1.1 --generate-notes
# Or do it via the GitHub UI: Releases → Draft a new release.
```

When the release is **published** (not draft), `.github/workflows/release.yml`
fires:

1. Re-runs typecheck + tests + build
2. Verifies `package.json.version` matches the tag
3. Runs `npm publish --provenance --access public`

The publish step authenticates via OIDC; no token is read from secrets.
After it succeeds, the package page on npmjs.com shows a green
**"Published with provenance"** badge linking back to the exact GitHub
Actions run that built it.

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
