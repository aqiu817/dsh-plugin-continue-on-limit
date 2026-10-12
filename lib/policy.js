/**
 * Auto-continue policy for a turn the model ended by exhausting its output
 * budget.
 *
 * This module is deliberately free of any Cordis or harness import: every
 * allow/deny rule lives here so the whole decision surface can be exercised
 * with `node --test` against a plain object, with no harness to boot and no
 * mock of the runtime to reason about. `lib/index.js` owns the wiring only.
 *
 * @module dsh-plugin-continue-on-limit/policy
 */

/**
 * Producer identity a plugin-authored continuation prompt claims.
 *
 * Never `'user'`: `Agent.followup()` stamps `{ kind: 'user' }` when its caller
 * omits a source, and the harness treats that kind as human authority. An
 * automatic producer must carry its own identity so the turn is auditable and
 * so approval and question flows keep waiting on a person instead of us.
 * `'cordis-host-runner'` is the source kind the harness reserves for
 * host-authored automation, and the chat renders it as a plugin trigger.
 */
export const CONTINUE_SOURCE_KIND = 'cordis-host-runner';

/** The finish-reason `kind` that marks an output-budget truncation. */
export const MAX_TOKENS = 'max-tokens';

/**
 * Defaults for an ordinary interactive session.
 *
 * `maxConsecutive: 3` bounds one truncation chain to three automatic
 * follow-ups before a human must say something; `minIntervalMs: 1500` is a
 * backstop against a tight loop, not a pacing feature — a real model reply
 * takes longer than this regardless.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  continueText: '继续',
  maxConsecutive: 3,
  minIntervalMs: 1500,
});

/**
 * Fresh per-session policy state.
 *
 * `sent` counts automatic continuations issued since the chain last settled,
 * and `lastSentAt` is the clock reading of the most recent continuation ever
 * sent for this session — it survives a settle, so the minimum gap still
 * applies to a new chain started seconds after an old one finished.
 *
 * `lastSentAt: 0` is the "never sent" sentinel and must stay 0 rather than
 * some negative value: `Date.now()` is always positive, so `lastSentAt > 0`
 * is exactly "has sent at least once", and the cooldown cannot be measured
 * against the Unix epoch — which would place the process's first continuation
 * inside the gap and swallow it. `lastTurn` is a third, independent guard: it
 * rejects a duplicate `turn/end` for a turn we already answered.
 *
 * `pending` covers the window `lastTurn` cannot. A continuation cannot be
 * queued from inside the `turn/end` callback — that append is still open, and
 * `Agent.followup()` appends the inbox splice, which the session rejects as a
 * reentrant append — so the send is scheduled to run once the agent reaches
 * idle. Between the schedule and the send `lastTurn` is still unset, so a
 * second `turn/end` for the same truncation would schedule a second
 * continuation. `pending` is that reservation, cleared when the scheduled
 * send settles either way.
 *
 * @returns {{sent: number, lastSentAt: number, lastTurn: number, pending: boolean}}
 */
export function newSessionState() {
  return { sent: 0, lastSentAt: 0, lastTurn: -1, pending: false };
}

/**
 * Whether a turn-end reason marks an output-budget truncation.
 *
 * Every other reason — `completed`, `aborted`, `error`, `blocked`,
 * `interrupted`, `forked` — means the model chose to stop or was stopped, and
 * none of them is something a bare "继续" can recover.
 *
 * @param {{kind?: unknown}} reason - one `TurnEndReason`.
 * @returns {boolean}
 */
export function isMaxTokens(reason) {
  return reason != null && reason.kind === MAX_TOKENS;
}

/**
 * Decide whether to auto-continue one truncated turn.
 *
 * Checks run in order and the first miss wins, so each skip reason is the most
 * specific one that applied. Capability and intent checks come before the
 * accounting ones, so a disabled plugin never mutates a session's counter.
 *
 * @param {object} options
 * @param {{sent: number, lastSentAt: number, lastTurn: number, pending: boolean}} options.state
 * @param {{kind?: unknown}} options.reason - the `turn/end` reason.
 * @param {number} options.turn - the turn number the reason belongs to.
 * @param {boolean} options.enabled - whether the plugin is switched on.
 * @param {boolean} options.inboxBusy - whether the agent already has queued input.
 * @param {number} options.now - the clock reading, in milliseconds.
 * @param {number} options.maxConsecutive - burst cap; `0` means no cap.
 * @param {number} options.minIntervalMs - minimum gap between two continuations.
 * @returns {{action: 'send'|'skip', why: string}}
 */
export function decide(options) {
  const { state, reason, turn, enabled, inboxBusy, now } = options;
  const { maxConsecutive, minIntervalMs } = options;

  if (!isMaxTokens(reason)) return { action: 'skip', why: 'reason-not-max-tokens' };
  if (!enabled) return { action: 'skip', why: 'disabled' };
  if (inboxBusy) return { action: 'skip', why: 'inbox-busy' };
  if (state.pending) return { action: 'skip', why: 'send-pending' };
  if (state.sent > 0 && state.lastTurn === turn) {
    return { action: 'skip', why: 'already-continued-turn' };
  }
  if (maxConsecutive > 0 && state.sent + 1 > maxConsecutive) {
    return { action: 'skip', why: 'cap-reached' };
  }
  if (state.lastSentAt > 0 && now - state.lastSentAt < minIntervalMs) {
    return { action: 'skip', why: 'cooldown' };
  }

  return { action: 'send', why: 'continue' };
}

/**
 * Record that a continuation was sent for this turn.
 *
 * @param {{sent: number, lastSentAt: number, lastTurn: number}} state
 * @param {number} now - the clock reading, in milliseconds.
 * @param {number} turn - the turn that was truncated.
 */
export function recordSend(state, now, turn) {
  state.sent += 1;
  state.lastSentAt = now;
  state.lastTurn = turn;
}

/**
 * Settle a chain: a turn ended without truncation, so the burst counter resets.
 *
 * The cooldown stamp is left alone on purpose — a chain that settles and a new
 * one that starts seconds later should still respect the minimum gap.
 *
 * @param {{sent: number, lastSentAt: number, lastTurn: number}} state
 */
export function resetOnSettled(state) {
  state.sent = 0;
  state.lastTurn = -1;
}
