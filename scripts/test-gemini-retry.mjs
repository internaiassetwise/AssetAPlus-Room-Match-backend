// scripts/test-gemini-retry.mjs — Verify geminiFetch retries transient statuses
// and returns immediately on non-retryable ones. Spins up local HTTP servers
// (no network) so it's deterministic.
//   node --env-file=.env scripts/test-gemini-retry.mjs
import http from 'node:http'
import { geminiFetch } from '../src/services/gemini.service.js'

function server(status) {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => { res.statusCode = status; res.end('nope') })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}
const port = (s) => s.address().port

async function case_(status, label) {
  const s = await server(status)
  const t0 = Date.now()
  const r = await geminiFetch(`http://127.0.0.1:${port(s)}`, '{"x":1}', `test-${status}`)
  const ms = Date.now() - t0
  console.log(`${label}: status=${r.status} ok=${r.ok} elapsed=${ms}ms`)
  s.close()
  return ms
}

// 503 → retryable: should back off 3 times (~3.5s) then return the 503 response.
const ms503 = await case_(503, '503 (retryable  )')
// 429 → retryable too.
await case_(429, '429 (retryable  )')
// 400 → non-retryable: should return immediately (< 200ms).
const ms400 = await case_(400, '400 (non-retryable)')
// 200 → success immediately.
await case_(200, '200 (success     )')

console.log('\nASSERT:')
console.log(' 503 retried (elapsed > 3000ms):', ms503 > 3000)
console.log(' 400 immediate (elapsed < 300ms):', ms400 < 300)
