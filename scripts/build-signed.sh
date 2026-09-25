#!/usr/bin/env bash
# Builds with the signing credentials from .env.
#
# Tauri reads these from the environment and `tauri build` does not load .env
# itself, so it is sourced here. Values are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

# Parsed line by line rather than sourced. A signing identity looks like
# "Developer ID Application: Name (TEAMID)" — the spaces and brackets make the
# shell choke on it unless it happens to be quoted, and failing on the most
# common value in the file with a bash syntax error is a poor welcome.
load_env() {
  local file=$1 line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac

    # An empty value must not be exported. Tauri treats a variable that is set
    # but blank as a request to use it, then fails on the empty string:
    #   The value '' is invalid for '--issuer <issuer>'
    [ -n "$val" ] || continue

    # Anything already in the environment wins, so NOTARIZE=0 ./build-signed.sh
    # is not undone by a blank line in the file.
    if [ -n "$(eval "printf '%s' \"\${$key-}\"")" ]; then
      continue
    fi

    export "$key=$val"
  done < "$file"
}

ENV_FILE=${ENV_FILE:-.env}
if [ -f "$ENV_FILE" ]; then
  load_env "$ENV_FILE"
  echo "Loaded $ENV_FILE"
else
  echo "No $ENV_FILE — building with an ad-hoc signature."
fi

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "No APPLE_SIGNING_IDENTITY: ad-hoc signed, so macOS will report an"
  echo "unidentified developer and the user must right-click -> Open."
else
  echo "Signing as: $APPLE_SIGNING_IDENTITY"

  # Tauri notarizes whenever a complete set of credentials is present, so the
  # only way to skip it is to withhold them.
  if [ "${NOTARIZE:-1}" = "0" ]; then
    echo "NOTARIZE=0: signing only."
    unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
    unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  else
    api_ok=0; pw_ok=0
    [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ] && api_ok=1
    [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && pw_ok=1

    if [ "$api_ok" = 1 ]; then
      if [ ! -f "${APPLE_API_KEY_PATH}" ]; then
        echo "APPLE_API_KEY_PATH does not point at a file: ${APPLE_API_KEY_PATH}" >&2
        echo "In Tauri this is the path to the .p8 and APPLE_API_KEY is the key id." >&2
        exit 1
      fi
      echo "Notarizing with the App Store Connect API key."
    elif [ "$pw_ok" = 1 ]; then
      echo "Notarizing with an Apple ID and app-specific password."
    else
      echo "Signing only: no complete set of notarization credentials, so"
      echo "macOS will still warn on first launch."
    fi
  fi
fi

npm run tauri build -- "$@"

# Tauri notarizes and staples the .app but leaves the .dmg alone, and the .dmg
# is what people download. Without its own ticket macOS has to ask Apple over
# the network, so an offline machine refuses to mount it.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ "${NOTARIZE:-1}" != "0" ]; then
  for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
    [ -f "$dmg" ] || continue
    if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      echo "Already stapled: $(basename "$dmg")"
      continue
    fi
    if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
      echo "Notarizing $(basename "$dmg")..."
      xcrun notarytool submit "$dmg" \
        --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
        --wait || { echo "notarization failed" >&2; exit 1; }
      xcrun stapler staple "$dmg"
    elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
      echo "Notarizing $(basename "$dmg")..."
      xcrun notarytool submit "$dmg" \
        --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
        --wait || { echo "notarization failed" >&2; exit 1; }
      xcrun stapler staple "$dmg"
    fi
  done
fi
