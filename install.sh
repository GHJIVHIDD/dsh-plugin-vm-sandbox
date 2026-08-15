#!/usr/bin/env sh
# Install @deepseek-ai/dsh-plugin-vm-sandbox into a local DeepSeek Harness web profile.
#
# Usage:
#   ./install.sh                 # installs into ~/.dsh/profiles/web
#   DSH_HOME=/custom/dsh ./install.sh
#   DSH_PROFILE=headless ./install.sh
#
# This script does not require pnpm: it copies the plugin into the profile's
# node_modules and appends the required patch entry to cordis.patch.yml.
set -eu

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_NAME="@deepseek-ai/dsh-plugin-vm-sandbox"
PLUGIN_ID="ui-vm-sandbox"
SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/dsh-plugin-vm-sandbox"
DEST_DIR="$PROFILE_DIR/node_modules/@deepseek-ai/dsh-plugin-vm-sandbox"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "error: profile directory not found: $PROFILE_DIR" >&2
  echo "Make sure DeepSeek Harness is installed and the '$PROFILE' profile has been initialized." >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR/node_modules/@deepseek-ai"
if command -v node >/dev/null 2>&1; then
  (cd "$SRC_DIR" && node ./scripts/prepare.mjs)
else
  echo "warning: node not found; skip prepare (lib/ should already exist)" >&2
fi
rm -rf "$DEST_DIR"
cp -R "$SRC_DIR" "$DEST_DIR"
echo "installed plugin files -> $DEST_DIR"

PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH_FILE" ]; then
  cp "$SRC_DIR/cordis.patch.yml" "$PATCH_FILE"
  echo "created $PATCH_FILE"
elif grep -q '^[[:space:]]*\[\][[:space:]]*$' "$PATCH_FILE"; then
  cp "$SRC_DIR/cordis.patch.yml" "$PATCH_FILE"
  echo "replaced empty patch list with $PLUGIN_ID"
elif ! grep -q "$PLUGIN_ID" "$PATCH_FILE"; then
  printf '\n# VM sandbox (installed by share script)\n' >> "$PATCH_FILE"
  cat "$SRC_DIR/cordis.patch.yml" >> "$PATCH_FILE"
  echo "appended $PLUGIN_ID to $PATCH_FILE"
else
  echo "$PLUGIN_ID already present in $PATCH_FILE"
fi

echo
echo "Done. Restart/refresh your dsh web profile:"
echo "  dsh --profile $PROFILE"
