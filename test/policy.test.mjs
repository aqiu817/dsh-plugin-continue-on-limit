/**
 * Unit tests for the pure policy module.
 *
 * These run with a bare `node --test` against plain objects: no Cordis, no
 * harness, no plugin loader. That is the point of keeping every decision in
 * `policy.js` — the allow/deny surface is checkable without booting anything,
 * which is the only way a quiet plugin gets caught before it is installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTINUE_SOURCE_KIND,
  DEFAULTS,
  MAX_TOKENS,
  decide,
  isMaxTokens,
  newSessionState,
  recordSend,
  resetOnSettled,
} from '../lib/policy.js';

/** One `turn/end` reason for a truncated turn. */
const TRUNCATED = { kind: MAX_TOKENS };

/** Decide with defaults, letting the caller override the bits under test. */
function verdict(overrides = {}) {
  const base = {
    state: newSessionState(),
    reason: TRUNCATED,
    turn: 7,
    enabled: DEFAULTS.enabled,
    inboxBusy: false,
    now: 1_000,
    maxConsecutive: DEFAULTS.maxConsecutive,
    minIntervalMs: DEFAULTS.minIntervalMs,
    ...overrides,
  };
  return decide(base);
}

test('the default policy is the one the patch entry ships with', () => {
  assert.deepEqual(DEFAULTS, {
    enabled: true,
    continueText: '继续',
    maxConsecutive: 3,
    minIntervalMs: 1500,
  });
});

test('the continuation prompt claims its own identity, never human authority', () => {
  assert.equal(CONTINUE_SOURCE_KIND, 'cordis-host-runner');
  assert.notEqual(CONTINUE_SOURCE_KIND, 'user');
});

test('fresh session state starts with no history and no cooldown pressure', () => {
  assert.deepEqual(newSessionState(), {
    sent: 0,
    lastSentAt: 0,
    lastTurn: -1,
    pending: false,
  });
});

test('a queued-but-unsent continuation reserves the session', () => {
  // The send is deferred until the agent is idle, so `lastTurn` cannot cover
  // the window between scheduling and delivery. `pending` is that reservation.
  const state = { ...newSessionState(), pending: true };
  assert.deepEqual(verdict({ state }), { action: 'skip', why: 'send-pending' });
});

test('isMaxTokens matches only the truncation marker', () => {
  assert.equal(isMaxTokens(TRUNCATED), true);
  assert.equal(isMaxTokens({ kind: 'completed' }), false);
  assert.equal(isMaxTokens({ kind: 'aborted' }), false);
  assert.equal(isMaxTokens({ kind: 'error' }), false);
  assert.equal(isMaxTokens({ kind: 'blocked' }), false);
  assert.equal(isMaxTokens({ kind: 'interrupted' }), false);
  assert.equal(isMaxTokens({ kind: 'forked' }), false);
  assert.equal(isMaxTokens({}), false);
  assert.equal(isMaxTokens(null), false);
  assert.equal(isMaxTokens(undefined), false);
});

test('a fresh truncated turn is continued', () => {
  assert.deepEqual(verdict(), { action: 'send', why: 'continue' });
});

test('a truncation is continued even when the clock has not moved at all', () => {
  // lastSentAt starts at 0 and now is 0, so the cooldown gap is exactly the
  // full minIntervalMs, not negative. Guards against an off-by-one that would
  // swallow the first continuation of the process.
  const state = newSessionState();
  const result = verdict({ state, now: 0 });
  assert.equal(result.action, 'send');
});

test('every non-truncation reason is left alone', () => {
  for (const kind of ['completed', 'aborted', 'error', 'blocked', 'interrupted', 'forked']) {
    assert.deepEqual(
      verdict({ reason: { kind } }),
      { action: 'skip', why: 'reason-not-max-tokens' },
      `kind ${kind}`
    );
  }
});

test('a disabled plugin neither sends nor mutates the counter', () => {
  const state = newSessionState();
  const result = verdict({ state, enabled: false });
  assert.deepEqual(result, { action: 'skip', why: 'disabled' });
  assert.deepEqual(state, newSessionState());
});

test('queued human input beats the automatic continuation', () => {
  assert.deepEqual(
    verdict({ inboxBusy: true }),
    { action: 'skip', why: 'inbox-busy' }
  );
});

test('the same truncated turn is not continued twice', () => {
  const state = newSessionState();
  recordSend(state, 1_000, 7);
  assert.deepEqual(
    verdict({ state, now: 9_999_999 }),
    { action: 'skip', why: 'already-continued-turn' }
  );
});

test('the burst cap stops the chain and 0 means no cap', () => {
  const state = newSessionState();
  for (let i = 0; i < DEFAULTS.maxConsecutive; i += 1) {
    recordSend(state, 1_000 + i * 10_000, 7 + i);
  }
  assert.equal(state.sent, DEFAULTS.maxConsecutive);
  assert.deepEqual(
    verdict({ state, now: 9_999_999, turn: 200 }),
    { action: 'skip', why: 'cap-reached' }
  );

  const unlimited = verdict({ state, now: 9_999_999, turn: 200, maxConsecutive: 0 });
  assert.deepEqual(unlimited, { action: 'send', why: 'continue' });
});

test('the cap is reached before the next send, not after it', () => {
  const state = newSessionState();
  recordSend(state, 1_000, 7);
  recordSend(state, 2_000, 8);
  assert.deepEqual(
    verdict({ state, now: 3_000, turn: 9, maxConsecutive: 2 }),
    { action: 'skip', why: 'cap-reached' }
  );
});

test('the cooldown blocks an immediate second continuation and lifts later', () => {
  const state = newSessionState();
  recordSend(state, 1_000, 7);

  assert.deepEqual(
    verdict({ state, now: 1_000 + DEFAULTS.minIntervalMs - 1, turn: 8 }),
    { action: 'skip', why: 'cooldown' }
  );
  assert.deepEqual(
    verdict({ state, now: 1_000 + DEFAULTS.minIntervalMs, turn: 8 }),
    { action: 'send', why: 'continue' }
  );
});

test('a zero interval disables the cooldown entirely', () => {
  const state = newSessionState();
  recordSend(state, 500, 7);
  assert.deepEqual(
    verdict({ state, now: 500, turn: 8, minIntervalMs: 0 }),
    { action: 'send', why: 'continue' }
  );
});

test('the burst counter resets when a turn settles, the cooldown does not', () => {
  const state = newSessionState();
  recordSend(state, 1_000, 7);
  recordSend(state, 1_000 + DEFAULTS.minIntervalMs, 8);
  assert.equal(state.sent, 2);

  resetOnSettled(state);
  assert.equal(state.sent, 0);
  assert.equal(state.lastTurn, -1);
  // Still inside the gap from the second continuation: settling must not
  // grant an immediate free send.
  assert.deepEqual(
    verdict({ state, now: 1_000 + DEFAULTS.minIntervalMs + 1, turn: 9 }),
    { action: 'skip', why: 'cooldown' }
  );

  assert.deepEqual(
    verdict({ state, now: 1_000 + 2 * DEFAULTS.minIntervalMs, turn: 9 }),
    { action: 'send', why: 'continue' }
  );
});

test('decide never throws on a malformed reason', () => {
  assert.equal(verdict({ reason: {} }).action, 'skip');
  assert.equal(verdict({ reason: { kind: 42 } }).action, 'skip');
});
