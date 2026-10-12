/**
 * Wiring tests for the plugin entry point.
 *
 * These drive `apply()` with a mock Cordis context and a controllable clock,
 * then assert on what reaches `agent.followup()`. The decision logic itself is
 * covered in `policy.test.mjs`; here the question is only "does the handler
 * read the real event, find the right agent, and send the right message?" —
 * which is exactly the surface a mock-free unit test cannot see.
 *
 * One harness detail matters more than the rest: `emit()` holds the session's
 * append guard open for the whole synchronous dispatch, because that is the
 * real constraint the host imposes. A `turn/end` is published from inside
 * `Session.append`, and any `followup()` from that callback appends the inbox
 * splice and is rejected as a reentrant append. So the plugin defers the send
 * until the agent reaches idle, and every test drains that deferral.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import z from '@deepseek-ai/schemastery';

import {
  Config,
  CONTINUE_SOURCE_KIND,
  DEFAULTS,
  apply,
  buildContinueMessage,
  inject,
  name,
  readSettings,
} from '../lib/index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One session: an id is all this plugin ever looks at. */
function makeSession(id) {
  return { id };
}

/** One agent: inbox queues plus a recorder for sent follow-ups. */
function makeAgent(id, session) {
  const inbox = { nextTurn: [], nextStep: [] };
  const sent = [];
  /** Resolvers parked on `whenIdle()`, so a test can hold the agent busy. */
  const idleWaiters = [];
  let holdIdle = false;

  const agent = {
    id,
    session,
    inbox,
    status: 'idle',
    sent,
    /**
     * Mirrors the session's append guard. While the `turn/end` append that
     * published the event is open, a `followup()` from inside that callback
     * would append the inbox splice and be rejected as a reentrant append.
     */
    publishing: false,
    whenIdle() {
      if (!holdIdle) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    /** Model a live driver: `whenIdle()` parks until `releaseIdle()`. */
    holdIdle() {
      holdIdle = true;
    },
    releaseIdle() {
      holdIdle = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    },
    followup(message) {
      if (agent.publishing) {
        throw new Error('session append cannot reenter while another append is being published');
      }
      sent.push(message);
    },
  };

  return agent;
}

/**
 * A mock plugin context: captures event subscriptions, serves agents by id,
 * and records log lines.
 */
function makeCtx(agents = new Map()) {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    agents: { get: (id) => agents.get(id) },
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
    },
  };
  return { ctx, handlers, logs };
}

/** A `turn/end` event for one turn and one finish reason. */
function turnEnd(turn, kind) {
  return {
    type: 'turn/end',
    seq: turn * 10,
    time: turn * 1000,
    data: { turn, reason: { kind } },
  };
}

/** Drain the microtask queue, so a deferred continuation has landed. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Apply once with a controllable clock, then feed one event. */
function harness({ agents, config, start = 1_000_000 } = {}) {
  let clock = start;
  const { ctx, handlers, logs } = makeCtx(agents);
  const agentList = [...(agents?.values() ?? [])];
  apply(ctx, config, { now: () => clock });
  return {
    ctx,
    handlers,
    logs,
    agentList,
    /**
     * Publish one event with the append guard held open across the whole
     * synchronous dispatch, then drain the deferred send. A continuation
     * queued from inside the callback — the bug this file guards — throws.
     */
    async emit(session, event) {
      const agent = agents?.get(session.id);
      if (agent !== void 0) agent.publishing = true;
      try {
        handlers.get('session/event')(session, event);
      } finally {
        if (agent !== void 0) agent.publishing = false;
      }
      await flush();
    },
    advance(ms) {
      clock += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test('the manifest declares the agents service and nothing else', () => {
  assert.equal(name, 'continue-on-limit');
  assert.deepEqual(inject, ['agents']);
});

test('the settings surface is fully volatile, so the Plugins page edits it live', () => {
  const form = volatileForm(Config);
  assert.notEqual(form, undefined);
  assert.deepEqual(Object.keys(form.dict).sort(), [
    'continueText',
    'enabled',
    'maxConsecutive',
    'minIntervalMs',
  ]);
  for (const field of ['enabled', 'continueText', 'maxConsecutive', 'minIntervalMs']) {
    assert.equal(
      Config.dict[field].meta.volatile,
      true,
      `${field} must be .volatile() or the settings page silently omits it`
    );
  }
});

test('an entry row with no config at all still resolves', () => {
  for (const input of [undefined, {}]) {
    const result = Config['~standard'].validate(input);
    assert.equal(
      result.issues,
      void 0,
      `validate(${input === void 0 ? 'undefined' : '{}'}) must not report issues`
    );
  }
  // `.volatile()` fields resolve to reference cells rather than plain values,
  // so compare after unwrapping.
  assert.deepEqual(readSettings(Config['~standard'].validate(undefined).value), DEFAULTS);
  assert.deepEqual(readSettings(Config['~standard'].validate({}).value), DEFAULTS);
});

test('the config schema rejects a bad cap instead of silently obeying it', () => {
  for (const bad of [-1, 17, 2.5]) {
    const result = Config['~standard'].validate({ maxConsecutive: bad });
    assert.notEqual(
      result.issues,
      void 0,
      `maxConsecutive: ${bad} must be rejected`
    );
  }
  const zero = Config['~standard'].validate({ maxConsecutive: 0 });
  assert.equal(zero.issues, void 0, '0 is a documented "no cap" value');
});

test('readSettings falls back to defaults field by field', () => {
  assert.deepEqual(readSettings(undefined), DEFAULTS);
  assert.deepEqual(readSettings({}), DEFAULTS);
  assert.deepEqual(readSettings({ maxConsecutive: 2 }), {
    ...DEFAULTS,
    maxConsecutive: 2,
  });
});

test('readSettings unwraps a volatile reference cell', () => {
  let stored = 5;
  const cell = Object.freeze({ get: () => stored });
  assert.deepEqual(readSettings({ maxConsecutive: cell }), {
    ...DEFAULTS,
    maxConsecutive: 5,
  });
  stored = 1;
  assert.equal(readSettings({ maxConsecutive: cell }).maxConsecutive, 1);
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

test('apply subscribes to the session event feed and to session disposal', () => {
  const { handlers } = harness();
  assert.deepEqual([...handlers.keys()], ['session/disposed', 'session/event']);
});

test('the continuation is queued after the dispatch window, never inside it', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  // `emit` holds `publishing` open for the whole synchronous dispatch, which is
  // exactly the window where `Agent.followup()` would append the inbox splice
  // and be rejected as a reentrant append. A synchronous send throws here.
  const pending = emit(session, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 0, 'nothing may be sent while the append is open');

  await pending;
  assert.equal(agentList[0].sent.length, 1, 'the continuation lands once the agent is idle');
});

test('disposing a session drops its state, so a same-id chain starts fresh', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const agents = new Map([['session-1', agent]]);
  const { handlers, emit, advance, agentList } = harness({
    agents,
    config: { maxConsecutive: 1 },
  });

  await emit(session, turnEnd(1, 'max-tokens'));
  advance(10_000);
  await emit(session, turnEnd(2, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 1, 'the cap was applied');

  handlers.get('session/disposed')(session);

  // A new session and a new agent carrying the same id is a fresh chain.
  const revived = makeSession('session-1');
  const replacement = makeAgent('session-1', revived);
  agents.set('session-1', replacement);
  advance(10_000);
  await emit(revived, turnEnd(5, 'max-tokens'));

  assert.equal(replacement.sent.length, 1, 'the burst counter restarted from zero');
  assert.equal(agentList[0].sent.length, 1, 'the old agent kept only its one continuation');
});

test('a truncated turn is continued with a plugin-owned user message', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(3, 'max-tokens'));

  assert.equal(agentList[0].sent.length, 1);
  const message = agentList[0].sent[0];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: DEFAULTS.continueText }]);
  assert.deepEqual(message.source, { kind: CONTINUE_SOURCE_KIND });
  assert.equal(typeof message.id, 'string');
  assert.equal(message.id.length, 36);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content), true);
  assert.equal(Object.isFrozen(message.source), true);
});

test('the continuation is a next-turn followup and nothing else is invoked', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  // The mock has no steer, no inject, no send: any unexpected call would throw
  // straight out of the continuation, so reaching this assertion is the check.
  const { emit } = harness({ agents: new Map([['session-1', agent]]) });
  await emit(session, turnEnd(3, 'max-tokens'));
  assert.equal(agent.sent.length, 1);
});

test('a non-truncation turn end sends nothing and resets the burst counter', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, advance, agentList, logs } = harness({
    agents: new Map([['session-1', agent]]),
    config: { maxConsecutive: 2 },
  });

  await emit(session, turnEnd(1, 'max-tokens'));
  advance(10_000);
  await emit(session, turnEnd(2, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 2);

  await emit(session, turnEnd(3, 'completed'));
  assert.equal(agentList[0].sent.length, 2, 'a completed turn is left alone');
  assert.equal(logs.some((entry) => entry[0] === 'info' && String(entry[1][0]).includes('settled')), true);

  // The counter reset, so a fresh chain may run again.
  advance(10_000);
  await emit(session, turnEnd(4, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 3);
});

test('every other finish reason is ignored', async () => {
  for (const kind of ['aborted', 'error', 'blocked', 'interrupted', 'forked']) {
    const session = makeSession('session-1');
    const agent = makeAgent('session-1', session);
    const { emit, agentList } = harness({ agents: new Map([['session-1', agent]]) });
    await emit(session, turnEnd(1, kind));
    assert.equal(agentList[0].sent.length, 0, `kind ${kind}`);
  }
});

test('events for a session with no live agent are ignored', async () => {
  const session = makeSession('ghost');
  const { emit } = harness();
  await emit(session, turnEnd(1, 'max-tokens'));
});

test('an agent whose session no longer matches is ignored', async () => {
  const live = makeSession('session-1');
  const stale = makeSession('session-2');
  const agent = makeAgent('session-1', live);
  const { emit, agentList } = harness({ agents: new Map([['session-2', agent]]) });
  await emit(stale, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 0);
});

test('the burst cap stops the chain and says so once', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, advance, agentList, logs } = harness({
    agents: new Map([['session-1', agent]]),
    config: { maxConsecutive: 2 },
  });

  await emit(session, turnEnd(1, 'max-tokens'));
  advance(10_000);
  await emit(session, turnEnd(2, 'max-tokens'));
  advance(10_000);
  await emit(session, turnEnd(3, 'max-tokens'));

  assert.equal(agentList[0].sent.length, 2);
  const warnings = logs.filter((entry) => entry[0] === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][1][0]), /burst cap/);
});

test('a repeated turn end for the same turn sends only once', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, advance, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(5, 'max-tokens'));
  await emit(session, turnEnd(5, 'max-tokens'));
  advance(10_000);
  await emit(session, turnEnd(5, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 1);
});

test('a turn end arriving while a continuation is still queued does not queue a second', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  agent.holdIdle();
  const { emit, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(5, 'max-tokens'));
  await emit(session, turnEnd(5, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 0, 'both events landed while the agent was busy');

  agent.releaseIdle();
  await flush();
  assert.equal(agentList[0].sent.length, 1, 'only the reserved continuation went out');
});

test('the cooldown suppresses a continuation that lands too soon', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, advance, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 1);

  advance(DEFAULTS.minIntervalMs - 1);
  await emit(session, turnEnd(2, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 1, 'still inside the gap');

  advance(1);
  await emit(session, turnEnd(2, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 2, 'the gap has elapsed');
});

test('queued human input wins over the automatic continuation', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  agent.inbox.nextTurn.push({ id: 'human-1', role: 'user', content: [], source: { kind: 'user' } });
  const { emit, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 0);
});

test('a next-step message in the inbox also wins', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  agent.inbox.nextStep.push({ id: 'steer-1', role: 'user', content: [], source: { kind: 'user' } });
  const { emit, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 0);
});

test('a disabled plugin sends nothing', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, agentList } = harness({
    agents: new Map([['session-1', agent]]),
    config: { enabled: false },
  });

  await emit(session, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 0);
});

test('a volatile cell is re-read on every turn end, not captured at startup', async () => {
  let enabled = true;
  const cell = Object.freeze({ get: () => enabled });
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, advance, agentList } = harness({
    agents: new Map([['session-1', agent]]),
    config: { enabled: cell },
  });

  await emit(session, turnEnd(1, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 1);

  enabled = false;
  advance(10_000);
  await emit(session, turnEnd(2, 'max-tokens'));
  assert.equal(agentList[0].sent.length, 1, 'flipping the cell off stops the chain');
});

test('the configured continueText is what gets sent', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, agentList } = harness({
    agents: new Map([['session-1', agent]]),
    config: { continueText: 'Keep going.' },
  });

  await emit(session, turnEnd(1, 'max-tokens'));
  assert.deepEqual(agentList[0].sent[0].content, [{ type: 'text', text: 'Keep going.' }]);
});

test('each continuation gets its own id, with no stray fields', () => {
  const messageA = buildContinueMessage(DEFAULTS.continueText);
  const messageB = buildContinueMessage(DEFAULTS.continueText);
  assert.notEqual(messageA.id, messageB.id);
  // MessageBase is exactly { id, content, source } plus role on a user message.
  assert.deepEqual(Object.keys(messageA).sort(), ['content', 'id', 'role', 'source']);
});

test('a failing followup is logged and never propagates', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  agent.followup = () => {
    throw new Error('session closed');
  };
  const { emit, logs } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, turnEnd(1, 'max-tokens'));
  const errors = logs.filter((entry) => entry[0] === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0][1][0].message, /session closed/);
});

test('a turn end with a missing reason is ignored rather than thrown on', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, logs, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, { type: 'turn/end', seq: 1, time: 1, data: { turn: 1 } });
  assert.equal(agentList[0].sent.length, 0);
  assert.deepEqual(logs, []);
});

test('events that are not turn ends are ignored', async () => {
  const session = makeSession('session-1');
  const agent = makeAgent('session-1', session);
  const { emit, logs, agentList } = harness({ agents: new Map([['session-1', agent]]) });

  await emit(session, { type: 'step/end', seq: 1, time: 1, data: {} });
  await emit(session, { type: 'tool/call', seq: 2, time: 2, data: {} });
  await emit(session, { type: 'assistant/message', seq: 3, time: 3, data: {} });
  assert.equal(agentList[0].sent.length, 0);
  assert.deepEqual(logs, []);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The host's volatile projection (schemastery), reproduced here because the
 * installed copy is whatever version the profile pins. `describe()` skips a
 * namespace entirely when this returns undefined — which is how a schema with
 * no volatile field makes a settings page invisible.
 */
function volatileForm(schema) {
  if (schema.meta.volatile) return schema;
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child);
        return field === undefined ? [] : [[key, field]];
      })
    );
    return Object.keys(dict).length === 0 ? undefined : z.object(dict);
  }
  return undefined;
}
