/**
 * Auto-continue a DeepSeek Harness turn that the model ended by exhausting its
 * output budget.
 *
 * When a turn stops because the response hit the model's output cap the harness
 * parks the session and waits for a human to type "继续". This plugin is that
 * "继续", issued by the host instead of by a person: it sends an ordinary
 * next-turn follow-up so the model resumes from the same partial answer.
 *
 * Detection is host-side only. It listens to the `session/event` feed and acts
 * on `turn/end { reason: { kind: 'max-tokens' } }`, which is the harness's own
 * truncation marker — the same one `dsh-goal-round-driver` disarms on. There is
 * no client half, so nothing depends on the shape of a UI snapshot and nothing
 * can throw into a React slot.
 *
 * Safety is three separate gates, in order: a burst cap per session, a minimum
 * gap between continuations, and an opt-out. Each continuation still appears in
 * the transcript as a plugin-triggered turn, so a chain is always auditable.
 *
 * @module dsh-plugin-continue-on-limit
 */

import { randomUUID } from 'node:crypto';

import z from '@deepseek-ai/schemastery';

import {
  CONTINUE_SOURCE_KIND,
  DEFAULTS,
  decide,
  newSessionState,
  recordSend,
  resetOnSettled,
} from './policy.js';

export { CONTINUE_SOURCE_KIND, DEFAULTS } from './policy.js';

/** Composition entry name; the id the profile patch row resolves to. */
export const name = 'continue-on-limit';

/**
 * `agents` is the one service this plugin waits for; without it there are no
 * live sessions to continue. Nothing else is injected — `ctx.on`, `ctx.logger`
 * and the `session/event` feed are core context, and the message this plugin
 * sends is built locally rather than imported from `@deepseek-ai/dsh-llm`.
 *
 * The message is built here because `createUserMessage()` is only
 * `createMessage({ ...input, role: 'user' })`, and `brandString()` is a
 * runtime identity: the harness documents that branded ids carry no tag or
 * prototype, so a locally minted id is interchangeable. Building it keeps the
 * whole package testable with a bare `node --test`, and leaves the one
 * dependency (the settings schema) as the only import a reader has to trust.
 */
export const inject = ['agents'];

/**
 * Field bounds. These are the same numbers the `Config` schema enforces, but
 * the schema only guards the initial composition — a `.volatile()` field is
 * written straight into its reference cell by the settings page, with no
 * re-validation. So every read has to defend for itself, or a typo such as
 * `maxConsecutive: -1` would pass through and silently turn the burst cap
 * `off`, because `decide()` treats a non-positive cap as unlimited.
 *
 * Exported so the tests and the schema can be checked against one source.
 */
export const LIMITS = Object.freeze({
  maxConsecutive: Object.freeze({ min: 0, max: 16 }),
  minIntervalMs: Object.freeze({ min: 0, max: 600_000 }),
  continueText: Object.freeze({ min: 1, max: 200 }),
});

/**
 * Editable surface. Every field is `.volatile()` so a change on the Plugins
 * page mutates the reference cell in place instead of reloading this fiber —
 * which is what makes "stop auto-continuing" take effect mid-chain.
 *
 * The top-level `.default({})` matters: the loader validates an entry's
 * composed config against this schema and throws on issues, so an entry row
 * that omits `config:` entirely must still resolve to a valid object.
 */
export const Config = z
  .object({
    /** Switch the plugin off without uninstalling it. */
    enabled: z
      .boolean()
      .default(DEFAULTS.enabled)
      .description('send an automatic follow-up when a turn is cut off by the output limit')
      .volatile(),
    /** The prompt text sent to continue. Kept short and language-neutral. */
    continueText: z
      .string()
      .min(LIMITS.continueText.min)
      .max(LIMITS.continueText.max)
      .default(DEFAULTS.continueText)
      .description('prompt text sent to continue a truncated answer')
      .volatile(),
    /**
     * Automatic follow-ups allowed per truncation chain. `0` means no cap,
     * which is unsafe: a model that keeps overflowing will bill until the
     * context window fills. Kept bounded so an accidental edit cannot go
     * uncapped.
     */
    maxConsecutive: z
      .number()
      .step(1)
      .min(LIMITS.maxConsecutive.min)
      .max(LIMITS.maxConsecutive.max)
      .default(DEFAULTS.maxConsecutive)
      .description('automatic follow-ups per truncation chain; 0 disables the cap')
      .volatile(),
    /**
     * Minimum gap between two continuations for one session. This is a loop
     * backstop, not pacing — a model reply outlasts it. `0` disables it.
     */
    minIntervalMs: z
      .number()
      .step(1)
      .min(LIMITS.minIntervalMs.min)
      .max(LIMITS.minIntervalMs.max)
      .default(DEFAULTS.minIntervalMs)
      .description('minimum milliseconds between two automatic continuations')
      .volatile(),
  })
  .default({});

/**
 * Unwrap a volatile reference cell, if the value is one.
 *
 * A `.volatile()` field reaches `apply()` as a frozen `{ get }` cell rather
 * than as a plain value, so every read has to go through `get()` to observe a
 * setting change without a reload. Ordinary fields pass through untouched,
 * which is why every read site can go through here unconditionally. The test
 * seam hands a plain object, which lands on the same branch.
 *
 * @param {unknown} value - a resolved config field value.
 * @returns {unknown} the plain value behind a volatile cell, else the value.
 */
function plain(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function'
    ? value.get()
    : value;
}

/** Coerce an optional integer field onto a closed range, else fall back. */
function within(value, fallback, bounds) {
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : fallback;
}

/**
 * Read the current settings, tolerating a missing, partial, or badly typed
 * entry config.
 *
 * `apply()` runs once per composition; the volatile cells keep working because
 * they are read fresh on every `turn/end`, not captured at startup.
 *
 * Every field is coerced or clamped rather than only defaulted, so a wrong
 * value can never disable a safety gate. `0` remains legal for both numbers:
 * it means "no cap" and "no minimum gap", which are deliberate opt-outs a
 * person can choose — a negative number is not one of them.
 *
 * @param {Record<string, unknown> | undefined} config - the composed entry config.
 * @returns {{enabled: boolean, continueText: string, maxConsecutive: number, minIntervalMs: number}}
 */
export function readSettings(config) {
  const source = config ?? {};
  const rawContinueText = plain(source.continueText);
  return {
    enabled: typeof plain(source.enabled) === 'boolean'
      ? plain(source.enabled)
      : DEFAULTS.enabled,
    continueText: typeof rawContinueText === 'string' && rawContinueText.trim() !== ''
      ? rawContinueText.trim().slice(0, LIMITS.continueText.max)
      : DEFAULTS.continueText,
    maxConsecutive: within(
      plain(source.maxConsecutive),
      DEFAULTS.maxConsecutive,
      LIMITS.maxConsecutive,
    ),
    minIntervalMs: within(
      plain(source.minIntervalMs),
      DEFAULTS.minIntervalMs,
      LIMITS.minIntervalMs,
    ),
  };
}

/**
 * One user-role message whose only content is the continuation prompt.
 *
 * Mirrors `createUserMessage()` exactly: a fresh id, `role: 'user'`, one text
 * block, and a deep freeze before publication. `source` is this plugin's own
 * identity rather than `'user'` — see {@link CONTINUE_SOURCE_KIND}.
 *
 * @param {string} text - the prompt to send.
 * @returns {readonly {id: string, role: 'user', content: readonly [], source: {kind: string}}}
 */
export function buildContinueMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: CONTINUE_SOURCE_KIND },
  });
}

/** Freeze a freshly built message tree in place. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/**
 * Whether the agent already has input queued, in which case letting the human's
 * words run beats injecting our own.
 *
 * @param {{inbox?: {nextTurn?: readonly unknown[], nextStep?: readonly unknown[]}}} agent
 * @returns {boolean}
 */
function inboxBusy(agent) {
  const inbox = agent?.inbox;
  return inbox?.nextTurn?.length > 0 || inbox?.nextStep?.length > 0;
}

/**
 * Plugin entry point — synchronous Cordis `apply()`.
 *
 * @param {object} ctx - the plugin context.
 * @param {Record<string, unknown> | undefined} config - composed entry config.
 * @param {object} [hooks] - test seam.
 * @param {() => number} [hooks.now] - clock override; defaults to `Date.now`.
 */
export function apply(ctx, config, hooks = {}) {
  const now = typeof hooks.now === 'function' ? hooks.now : () => Date.now();
  /** @type {Map<string, {sent: number, lastSentAt: number, lastTurn: number, pending: boolean}>} */
  const states = new Map();

  /** State for a session, created lazily on first truncation. */
  function stateFor(sessionId) {
    let state = states.get(sessionId);
    if (state === void 0) {
      state = newSessionState();
      states.set(sessionId, state);
    }
    return state;
  }

  ctx.on('session/disposed', (session) => {
    states.delete(session.id);
  });

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;

    const agent = ctx.agents.get(session.id);
    if (agent === void 0 || agent.session !== session) return;

    const data = event.data ?? {};
    const turn = typeof data.turn === 'number' ? data.turn : -1;
    const reason = data.reason;

    if (reason === void 0 || reason.kind !== 'max-tokens') {
      const state = states.get(session.id);
      if (state !== void 0 && state.sent > 0) {
        const sent = state.sent;
        resetOnSettled(state);
        ctx.logger.info(
          'continue-on-limit: session "%s" settled after %d auto-continue(s)',
          session.id,
          sent
        );
      }
      return;
    }

    const settings = readSettings(config);
    const state = stateFor(session.id);
    const verdict = decide({
      state,
      reason,
      turn,
      enabled: settings.enabled,
      inboxBusy: inboxBusy(agent),
      now: now(),
      maxConsecutive: settings.maxConsecutive,
      minIntervalMs: settings.minIntervalMs,
    });

    if (verdict.action !== 'send') {
      if (verdict.why === 'cap-reached') {
        ctx.logger.warn(
          'continue-on-limit: session "%s" hit the burst cap of %d; a person must send "%s" to keep going',
          session.id,
          settings.maxConsecutive,
          settings.continueText
        );
      }
      return;
    }

    // The `turn/end` append that published this event is still open, and
    // `Session.append` rejects a reentrant append — which is exactly what
    // `Agent.followup()` performs, because queueing a message appends the
    // inbox splice. So the send waits for the driver to finish and the agent to
    // reach idle; only from idle does `followup()` open the next turn instead
    // of latching a wake that nothing will replay.
    state.pending = true;
    void sendContinuation({
      agent,
      session,
      state,
      turn,
      text: settings.continueText,
      clock: now,
      logger: ctx.logger,
    });
  });
}

/**
 * Queue the continuation once the agent is idle.
 *
 * Never rejects: a continuation that cannot be queued must not take down the
 * session feed. The turn stays truncated and the harness's own "send 继续"
 * hint remains in the UI, which is the correct fallback.
 *
 * `whenIdle()` resolves after the current driver settles, and `kick()` sets the
 * phase back to `idle` before that promise resolves — so by the time
 * `followup()` runs the agent is genuinely idle and the wake starts a new
 * driver rather than being dropped.
 *
 * @param {object} options
 * @param {{whenIdle: () => Promise<void>, followup: (message: object) => void}} options.agent
 * @param {{id: string}} options.session
 * @param {{sent: number, lastSentAt: number, lastTurn: number, pending: boolean}} options.state
 * @param {number} options.turn - the turn that was truncated.
 * @param {string} options.text - the continuation prompt.
 * @param {() => number} options.clock - the clock reading, in milliseconds.
 * @param {{info: Function, error: Function}} options.logger
 * @returns {Promise<void>}
 */
async function sendContinuation({ agent, session, state, turn, text, clock, logger }) {
  try {
    await agent.whenIdle();
    agent.followup(buildContinueMessage(text));
    recordSend(state, clock(), turn);
    logger.info(
      'continue-on-limit: sent continuation #%d for session "%s" turn %d',
      state.sent,
      session.id,
      turn
    );
  } catch (error) {
    logger.error(error);
  } finally {
    state.pending = false;
  }
}
