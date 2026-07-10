#!/bin/bash
# scripts/sign-line-webhook.sh — Phase 1 positive test helper.
#
# Computes a valid X-Line-Signature over a synthetic event body, posts it to
# the local webhook, and dumps the row that landed in line_webhook_log.

set -euo pipefail

cd "$(dirname "$0")/.."

SECRET="$(grep '^LINE_CHANNEL_SECRET=' .env | cut -d= -f2-)"
BODY='{"events":[{"type":"message","source":{"userId":"Utest123"},"replyToken":"r1","message":{"type":"text","text":"hi"}}]}'

SIG="$(SECRET="$SECRET" BODY="$BODY" node -e '
  const c = require("crypto")
  process.stdout.write(c.createHmac("sha256", process.env.SECRET).update(process.env.BODY).digest("base64"))
')"

echo "Computed sig: $SIG"
echo "--- POST ---"
curl -i -s -X POST http://localhost:4000/api/line/webhook \
  -H "Content-Type: application/json" \
  -H "X-Line-Signature: $SIG" \
  -d "$BODY"
echo
echo
echo "--- line_webhook_log (latest 3) ---"
PGPASSWORD=postgres psql -U postgres -h localhost -d room_match -A -F '|' -c \
  "SELECT id, line_user_id, reply_token, event_type, created_at FROM line_webhook_log ORDER BY id DESC LIMIT 3;"
