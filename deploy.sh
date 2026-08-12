#!/usr/bin/env bash
# Optional deploy helper for xqueue.
#
# Most people should just run:  npx wrangler deploy
# (or push to main if Cloudflare Git integration is connected.)
#
# This script only exists if you keep a Cloudflare API token in a local file
# instead of using `wrangler login` interactively.
#
# Token file (chmod 600), never commit it:
#   ~/.config/xqueue/cloudflare.env
#   CLOUDFLARE_API_TOKEN=...
set -euo pipefail

ENV_FILE="${HOME}/.config/xqueue/cloudflare.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found." >&2
  echo "  create it with:" >&2
  echo "    mkdir -p ~/.config/xqueue" >&2
  echo "    printf 'CLOUDFLARE_API_TOKEN=YOUR_TOKEN\\n' > \"$ENV_FILE\"" >&2
  echo "    chmod 600 \"$ENV_FILE\"" >&2
  echo "" >&2
  echo "  or skip this script and run: npx wrangler login && npx wrangler deploy" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:$PATH"
exec npx wrangler deploy "$@"
