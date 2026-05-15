#!/usr/bin/env bash
# Local docs build — produces a self-contained _site/ directory you can
# preview with any static server, e.g.:
#   npx http-server _site -p 8080
#
# CI builds the same artifact via .github/workflows/docs.yml.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Validating OpenAPI spec…"
npx --yes @redocly/cli@latest lint docs/openapi.yaml

echo "→ Generating TypeDoc…"
npx typedoc

echo "→ Assembling _site/ …"
rm -rf _site
mkdir -p _site
cp docs/index.html _site/index.html
cp docs/openapi.html _site/openapi.html
cp docs/openapi.yaml _site/openapi.yaml
cp -r docs/typedoc _site/typedoc

echo
echo "✔ Docs ready in _site/"
echo "  Preview:  npx --yes http-server _site -p 8080 -o"
