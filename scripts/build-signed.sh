#!/usr/bin/env bash
# Builds with the signing credentials from .env.
#
# Tauri reads these from the environment, and `tauri build` does not load .env
# itself, so it is sourced here. Values are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  echo "Loaded .env"
else
  echo "No .env — building with an ad-hoc signature."
fi

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "Signing as: $APPLE_SIGNING_IDENTITY"
  if [ -z "${APPLE_API_KEY:-}" ] && [ -z "${APPLE_ID:-}" ]; then
    echo "No notarisation credentials: macOS will still warn on first launch."
  fi
else
  echo "No APPLE_SIGNING_IDENTITY: the build will be ad-hoc signed."
fi

npm run tauri build -- "$@"
