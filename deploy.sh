#!/usr/bin/env bash
# Deploy xqueue to Cloudflare.
# The API token is kept OUT of the repo, in ~/.config/xqueue/cloudflare.env
# (chmod 600). You can reuse the same Cloudflare token as your other projects —
# just copy it in, since everything is on the lukasgenis@outlook.com account.
set -euo pipefail

ENV_FILE="${HOME}/.config/xqueue/cloudflare.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found." >&2
  echo "  create it with: mkdir -p ~/.config/xqueue && printf 'CLOUDFLARE_API_TOKEN=YOUR_TOKEN\\n' > \"$ENV_FILE\" && chmod 600 \"$ENV_FILE\"" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/homebrew/bin:$PATH"
exec npx wrangler deploy "$@"
