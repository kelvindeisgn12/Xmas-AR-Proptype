#!/bin/zsh

set -e

SCRIPT_DIR="${0:A:h}"
RUNTIME_ROOT="/Users/kelvinyip/.cache/codex-runtimes/codex-primary-runtime/dependencies"

export PATH="$RUNTIME_ROOT/node/bin:$RUNTIME_ROOT/bin/override:$RUNTIME_ROOT/bin/fallback:$PATH"

cd "$SCRIPT_DIR"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  pnpm install
fi

echo "Starting the local preview at http://localhost:5173"
echo "Keep this window open while you edit. Press Control-C to stop."
pnpm dev
