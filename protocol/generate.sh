#!/usr/bin/env bash
# Regenerate TS and pydantic types from messages.schema.json.
set -euo pipefail
cd "$(dirname "$0")"

npx --yes json-schema-to-typescript@15.0.4 \
  --input messages.schema.json \
  --output gen/ts/messages.ts \
  --bannerComment "/* Generated from protocol/messages.schema.json by protocol/generate.sh. Do not edit. */" \
  --unreachableDefinitions

PY_CODEGEN="${PY_CODEGEN:-uv run datamodel-codegen}"
$PY_CODEGEN \
  --input messages.schema.json \
  --input-file-type jsonschema \
  --output gen/py/messages.py \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 \
  --use-title-as-name \
  --enum-field-as-literal all \
  --use-annotated \
  --field-constraints \
  --disable-timestamp \
  --custom-file-header "# Generated from protocol/messages.schema.json by protocol/generate.sh. Do not edit."
