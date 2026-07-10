#!/bin/bash
# scripts/test-gemini.sh — Quick smoke test for the Gemini API key + model.
# Reads KEY + MODEL from .env, calls generateContent, prints status + body.
# Does NOT echo any prefix of the key.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=$(grep '^GOOGLE_GEMINI_API_KEY=' .env | cut -d= -f2-)
MODEL=$(grep '^GOOGLE_GEMINI_REPHRASE_MODEL=' .env | cut -d= -f2-)
curl -s -o /tmp/gemini-test.json -w "HTTP %{http_code}\n" \
  -X POST "https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: ${KEY}" \
  -d '{
    "contents":[{
      "role":"user",
      "parts":[{"text":"You are a helpful Thai-speaking assistant. Reply briefly.\n\n---\n\nhello"}]
    }],
    "generationConfig":{"maxOutputTokens":64}
  }'
echo "--- response body ---"
python3 -m json.tool < /tmp/gemini-test.json 2>&1 | head -40