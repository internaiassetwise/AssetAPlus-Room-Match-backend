// src/linebot/dispatchQueue.service.js — Per-user serialized, cross-user
// concurrent dispatch with a global concurrency cap. No external deps.
//
// Line can deliver many webhooks at once — a burst of different users, or
// Line's own retries for one user. We need all of:
//   1. ack Line instantly: the webhook route returns 200 BEFORE processing, so
//   2. process events asynchronously, but
//   3. never run two events for the SAME user at once — a user's chat history
//      is a read-modify-write, so concurrent turns would clobber and lose data;
//      same-user events must run one at a time, in arrival order, while
//   4. DIFFERENT users run concurrently, capped globally so a spike doesn't
//      exhaust the DB pool or hammer Gemini.
//
// This is a "per-key serial chain + counting semaphore". We deliberately do NOT
// use a Postgres row lock (the FOR UPDATE helper in chatSessions.repo): holding
// a row lock + a pool connection across the multi-second Gemini call would
// serialize per-user at the DB AND drain the pool — the opposite of the goal.
// The in-memory chain orders same-user turns without holding any DB resource
// during the LLM call.

import { config } from '../config.js'
import { logger } from '../logger.js'

const MAX_CONCURRENT = config.LINE_BOT_MAX_CONCURRENT

// key -> tail Promise of that key's chain. Same key runs strictly in order.
const tails = new Map()
let active = 0
const waiters = []   // resolve fns parked waiting for a concurrency slot

/** Take a global concurrency slot, parking if the cap is reached. */
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve() }
  return new Promise((resolve) => waiters.push(resolve))
}

/** Release a slot — hand it straight to a parked waiter if one exists. */
function release() {
  if (waiters.length) { waiters.shift()() }   // transfer the slot (active unchanged)
  else { active-- }
}

/**
 * Run `fn()` such that same-`key` calls execute one at a time in submission
 * order, different keys run concurrently, and at most MAX_CONCURRENT run at once.
 *
 * Never rejects: `fn` failures are logged and swallowed, so one bad event can't
 * poison the per-key chain (which would reject the NEXT message for that user)
 * or surface an unhandled rejection.
 *
 * @param {string} key        Serialize per key (e.g. lineUserId / groupId).
 * @param {() => (Promise|void)} fn  The work.
 * @param {string} [label]    For error logs.
 * @returns {Promise<void>}   Resolves once fn has run.
 */
export function enqueue(key, fn, label = 'dispatch') {
  const run = async () => {
    await acquire()
    try {
      await fn()
    } catch (err) {
      logger.error({ err, key, label }, 'dispatch job failed')
    } finally {
      release()
    }
  }
  // Chain on the previous job for this key (run whether it resolved OR rejected),
  // then swallow so the stored tail is always fulfilled and the chain can't break.
  const prev = tails.get(key) ?? Promise.resolve()
  const tail = prev.then(run, run).catch(() => {})
  tails.set(key, tail)
  tail.finally(() => { if (tails.get(key) === tail) tails.delete(key) })
  return tail
}

/** Snapshot for logs / health detail. */
export function stats() {
  return { maxConcurrent: MAX_CONCURRENT, active, pendingKeys: tails.size, parked: waiters.length }
}
