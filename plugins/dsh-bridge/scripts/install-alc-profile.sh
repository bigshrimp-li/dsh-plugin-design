#!/usr/bin/env bash
#
# Install this bundle into the `alc` dsh profile.
#
# The bridge adds its own independent space. Native Harness sessions continue
# to use the built-in agent-loop and its model selector.
# This script creates the profile from the shipped `web` template on first run
# and links the working tree into it as a local bundle.
#
# It is idempotent: re-running re-links the same working tree and rewrites
# nothing else. It touches ONLY `$DSH_HOME/profiles/alc`; the user's other
# profiles (including `web`) are never read or written. It never reads or
# prints `$DSH_HOME/.credentials.yaml`, `$DSH_HOME/.env`, or any other secret.
#
# `DSH_HOME` is REQUIRED and must not be the user's own `~/.dsh`. This script
# exists to install into an isolated profile, and every run of it is a browser
# check whose whole point is that the run cannot touch the person's real
# configuration — so the directory is named rather than defaulted to. A script
# that quietly fell back to `~/.dsh` would make the isolation a property of the
# caller's memory instead of a property of this file, and the one time the
# memory slipped is the time it would matter.
#
# `--help` prints usage and exits without doing anything else; any other
# argument is a usage error, also without doing anything else. Both are checked
# before the harness is looked for and before any directory is created, so
# neither can install anything as a side effect of asking what the script does.
#
# Usage: DSH_HOME=<isolated dir> clients/dsh-bridge/scripts/install-alc-profile.sh [--help]
set -euo pipefail

PROFILE=alc
TEMPLATE=web

USAGE="usage: DSH_HOME=<isolated dir> $(basename "${BASH_SOURCE[0]}") [--help]"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat <<EOF
$USAGE

Installs this working tree as the '@super-agent/dsh-bridge' bundle into the
'$PROFILE' dsh profile under \$DSH_HOME, creating the profile from the
'$TEMPLATE' template on first run.

  DSH_HOME   required; the directory to install into. Must not be \$HOME/.dsh:
             this script is for an isolated profile, never the real one.
  --help     print this text and exit without installing anything.
EOF
      exit 0
      ;;
    *)
      echo "install-alc-profile: unrecognized argument \"$arg\"" >&2
      echo "$USAGE" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${DSH_HOME:-}" ]; then
  echo "install-alc-profile: DSH_HOME is required and was not set." >&2
  echo "install-alc-profile: refusing to default to \$HOME/.dsh — this script installs an isolated profile." >&2
  echo "$USAGE" >&2
  exit 2
fi
if [ "${DSH_HOME}" = "${DSH_HOME#/}" ]; then
  echo "install-alc-profile: DSH_HOME must be an absolute path; got \"$DSH_HOME\"" >&2
  exit 2
fi

DSH_HOME_DIR="$DSH_HOME"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

# The comparison is on resolved paths, because `~/.dsh` can be named in more
# than one way and only one of them is the string this script would write.
if [ -d "$DSH_HOME_DIR" ] && [ -d "$HOME/.dsh" ] &&
  [ "$(cd "$DSH_HOME_DIR" && pwd -P)" = "$(cd "$HOME/.dsh" && pwd -P)" ]; then
  echo "install-alc-profile: refusing to install into \$HOME/.dsh; name an isolated directory instead." >&2
  echo "$USAGE" >&2
  exit 2
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "install-alc-profile: 'dsh' is not on PATH" >&2
  exit 1
fi

# 1. Create the profile from the shipped web template when it does not exist.
#    `--dump-config` composes and exits, so this initializes the directory
#    without booting the app. An existing profile is left untouched.
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "install-alc-profile: creating profile '$PROFILE' from the '$TEMPLATE' template"
  dsh --profile "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >/dev/null
else
  echo "install-alc-profile: profile '$PROFILE' already exists"
fi

# 2. `dsh plugin` shells out to pnpm. Use a real pnpm when present; otherwise
#    borrow corepack's copy through a throwaway shim directory so this script
#    needs no global pnpm install.
SHIM_DIR=""
# The trap runs on the way out and its last command's status becomes the
# script's, so this must not end on a test that is false when there is nothing
# to clean up: `[ -n "$SHIM_DIR" ] && rm -rf "$SHIM_DIR"` returned 1 whenever
# pnpm was already on PATH, and the script reported failure after every
# assertion had passed.
cleanup() {
  if [ -n "$SHIM_DIR" ]; then
    rm -rf "$SHIM_DIR"
  fi
  return 0
}
trap cleanup EXIT
if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "install-alc-profile: neither pnpm nor corepack is available" >&2
    exit 1
  fi
  SHIM_DIR="$(mktemp -d)"
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' >"$SHIM_DIR/pnpm"
  chmod +x "$SHIM_DIR/pnpm"
  export PATH="$SHIM_DIR:$PATH"
  echo "install-alc-profile: using corepack's pnpm via a temporary shim"
fi

# 3. Link this working tree into the profile as a local bundle. `dsh plugin`
#    records it in `dsh.profile.bundles`, so its `cordis.patch.yml` composes.
echo "install-alc-profile: linking $BUNDLE_DIR into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$BUNDLE_DIR"

# 4. Verify the independent space is present and the native loop stays enabled.
COMPOSED="$(dsh --profile "$PROFILE" --dump-config)"
if printf '%s' "$COMPOSED" | grep -q -- "^- id: super-agent-bridge$"; then
  echo "install-alc-profile: bridge row present"
else
  echo "install-alc-profile: bridge row MISSING from the composed profile" >&2
  exit 1
fi
if ! printf '%s' "$COMPOSED" | grep -q -- "^- id: agent-loop$" ||
   printf '%s' "$COMPOSED" | awk '/^- id: agent-loop$/{p=1;next} /^- /{p=0} p{print}' | grep -q "disabled: true"; then
  echo "install-alc-profile: built-in agent-loop is missing or disabled" >&2
  exit 1
fi
echo "install-alc-profile: built-in agent-loop is enabled"

echo "install-alc-profile: done — run 'dsh --profile $PROFILE --no-open' to serve the bridge profile"
