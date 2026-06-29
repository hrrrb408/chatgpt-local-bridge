#!/bin/bash
# Print the current chatgpt-local-bridge public tunnel URL (from the cloudflared launchd log).
# Run this after a machine reboot to get the new URL, then paste it into ChatGPT's connector.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$DIR/logs/cloudflared.log" 2>/dev/null | tail -1)
if [ -z "$URL" ]; then
  echo "(no tunnel URL found — is the cloudflared service running? check $DIR/logs/cloudflared.log)" >&2
  exit 1
fi
echo "$URL/mcp"
