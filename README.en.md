# dsh-plugin-continue-on-limit

**Presses "continue" for you when the model is cut off by its output limit.**

[简体中文](./README.md) | **English**

A host-side DeepSeek Harness plugin. It watches `turn/end` for the `max-tokens`
finish reason and issues an ordinary next-turn follow-up through
`agent.followup()`, gated by a per-session burst cap, a minimum interval, and an
opt-out. No client half, no React slot, no dependency on any UI snapshot field.

[![npm](https://img.shields.io/npm/v/dsh-plugin-continue-on-limit)](https://www.npmjs.com/package/dsh-plugin-continue-on-limit)
![license](https://img.shields.io/badge/license-MIT-blue)
![tests](https://img.shields.io/badge/tests-61%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D22-informational)

---

## Table of contents

- [What it solves](#what-it-solves)
- [Install](#install)
- [Configuration](#configuration)
- [How it works](#how-it-works)
  - [1. Detection: host-side events only](#1-detection-host-side-events-only)
  - [2. When to send: why not from the callback](#2-when-to-send-why-not-from-the-callback)
  - [3. Message identity: why not user](#3-message-identity-why-not-user)
- [Safety design](#safety-design)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Relationship to native harness behaviour](#relationship-to-native-harness-behaviour)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## What it solves

dsh does **not** continue on its own. When a turn ends with `max-tokens`, the
harness parks the session and the UI shows "response truncated… send
'continue' to let the model keep going". That is deliberate — a person decides
whether more output is wanted.

If retyping those two words every time gets old, this plugin automates it.

The automatic continuation **never impersonates human input**. It enters the
transcript under the plugin's own identity and renders in the chat as a plugin
status update that names the notification which triggered the turn, so a chain
stays fully auditable.

## Install

The plugin is a standard dsh bundle, mounted through the profile's
`package.json`.

### From npm

Add the dependency to the profile's `package.json`
(`~/.dsh/profiles/<name>/package.json`) and list it in `bundles`:

```jsonc
{
  "dependencies": {
    "dsh-plugin-continue-on-limit": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-continue-on-limit"
      ]
    }
  }
}
```

Then install inside the profile directory and restart dsh:

```bash
pnpm install
```

`cordis.patch.yml` is picked up automatically through `dsh.bundle.patch`; you do
not need to hand-write the `- insert:` row.

### From source

Only needed if you intend to modify the plugin. Clone it and install its own
dependencies first:

```bash
git clone https://github.com/aqiu817/dsh-plugin-continue-on-limit.git
cd dsh-plugin-continue-on-limit
npm install --ignore-scripts
```

Use npm rather than pnpm: in some sandboxed environments pnpm cannot create
junctions and materialises the top-level `node_modules` as a real directory,
which leaves `@deepseek-ai/cosmokit` unreachable.

Then point the profile's dependency at the local path:

```jsonc
{
  "dependencies": {
    "dsh-plugin-continue-on-limit": "link:/absolute/path/to/dsh-plugin-continue-on-limit"
  }
}
```

Run `pnpm install` and restart dsh.

### Uninstall

Remove the dependency and the `bundles` entry, then run `pnpm install` again. No
state is left behind.

> This plugin is **not** a `required` bundle, so a failed composition writes no
> startup log. After installing, confirm that `continue-on-limit` appears on the
> Plugins page.

## Configuration

All fields are `.volatile()`: editing them on the Plugins page does **not**
reload the fiber, so `enabled: false` can stop a chain mid-flight.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch |
| `continueText` | string (1–200) | `继续` | The text that gets sent |
| `maxConsecutive` | integer (0–16) | `3` | Automatic continuations per truncation chain; `0` means no cap |
| `minIntervalMs` | integer (0–600000) | `1500` | Minimum gap between two continuations, as a loop backstop |

The defaults shipped in `cordis.patch.yml`:

```yaml
- insert:
    - id: continue-on-limit
      name: 'dsh-plugin-continue-on-limit'
      config:
        enabled: true
        continueText: '继续'
        maxConsecutive: 3
        minIntervalMs: 1500
```

## How it works

### 1. Detection: host-side events only

A single host-side source of truth, the same one
`@deepseek-ai/dsh-goal-round-driver` reads:

```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return;
  const agent = ctx.agents.get(session.id);
  if (agent === void 0 || agent.session !== session) return;
  if (event.data.reason.kind !== 'max-tokens') return;
  // ...
});
```

The `turn/end` payload is exactly `{ turn, reason }`, and `reason` is a
`TurnEndReason`, so the truncation marker is directly readable.

**Two routes deliberately not taken:**

- `agent/turn-stopping` — its payload is `{ agent, turn, signal }` with **no
  reason**, so it carries no truncation information and can only fire blindly.
- The client-side `SessionSnapshot` — its shape is a fixed 14 fields, and it has
  no `queue`, `pending` or `nodes` (the real field is called
  `pendingSubmissions`). Guessing field names that way throws a `TypeError` on
  every snapshot update; and even with optional chaining the candidate set stays
  empty, so the detection branch is never entered. The symptom is an install
  that starts fine and simply never fires.

### 2. When to send: why not from the callback

`turn/end` is broadcast from **inside** `Session.append`, and `append` holds its
reentrancy gate open for the duration of that broadcast:

```js
if (entry?.appending) throw new Error("session append cannot reenter while another append is being published");
// ...callbacks run synchronously...
finally { entry.appending = false; }   // reset only after the callbacks return
```

`Agent.followup()` itself appends — queueing a message writes an inbox splice —
so calling it **synchronously** from that callback always throws:

```text
Error: session append cannot reenter while another append is being published
    at Session.append        (dsh-session)
    at ReactLoopInbox.mutate (dsh-agent-loop)
    at ReactLoopInbox.splice
```

So the send is deferred until the agent is genuinely idle:

```js
state.pending = true;
void sendContinuation(...);   // calls followup() only after await agent.whenIdle()
```

**Why wait for idle rather than just deferring one microtask?** Because
`wakeDriver()` only starts a new driver when `phase.kind === 'idle'`:

```js
wakeDriver(wakeAfterAbort = false) {
  if (this.phase.kind !== "idle") { /* only maintenance / abort records wakeRequested */ return; }
  this.setPhase({ kind: "running", ... });   // actually opens the next turn
}
```

And the driver loop checks `if (!this.inbox.hasPending) return false` immediately
after appending `turn/end`. A message that lands after that check arrives once
the driver has already finished; `wakeDriver` then **does not** record
`wakeRequested` while the phase is `running`, so the message sits in the inbox
and nothing ever processes it. After `await agent.whenIdle()` the phase is
guaranteed to be `idle`, and only then does `followup()` actually open the next
turn.

`state.pending` covers that window: while the send is deferred, `lastTurn` has
not been written yet, so a second `turn/end` would schedule a duplicate.
`pending` is that reservation, cleared once the scheduled send settles.

### 3. Message identity: why not user

When its caller omits `source`, `Agent.followup()` stamps `{ kind: 'user' }`,
and the harness treats `user` as **human authority**. An automatic continuation
impersonating a person would make approval and ask-user flows believe someone is
actually present.

So this plugin sends `source.kind` as `cordis-host-runner` — the source kind the
harness reserves in `MessageSourceMap` for host-authored automation:

```ts
'cordis-host-runner': { kind: 'cordis-host-runner'; };
```

The chat renders it as a plugin trigger, keeping a chain fully auditable.

The message body is built locally rather than imported from
`@deepseek-ai/dsh-llm`: `createUserMessage()` is just
`createMessage({ ...input, role: 'user' })`, and `brandString()` is the identity
function at runtime (the documentation states that branded ids carry no tag, no
prototype and no registry), so a locally minted id is interchangeable. That
leaves the settings schema as the package's only dependency and lets the whole
suite run on bare `node --test` — no harness to boot, no snapshot to mock.

## Safety design

### The three gates

`maxConsecutive` is the primary gate. `3` is a deliberate default: enough to
finish a long answer, few enough that a model which keeps overflowing does not
bill until the context window fills. `0` is an explicit "no cap" and is a
dangerous option.

`minIntervalMs` is a runaway-loop backstop, not pacing — a real model reply
outlasts it by a wide margin.

### Implicit protections

- When the inbox already holds queued human input, **the human goes first**
  (skipped when `nextTurn` or `nextStep` is non-empty)
- The same turn is never continued twice; and while a send is queued
  (`pending`), nothing is scheduled again
- A non-`max-tokens` turn end is left alone and resets the burst counter
- A thrown `followup()` only writes a log line and never propagates into the
  `session/event` callback; the send itself is deferred until the agent is idle
  (see above)

### A mistyped number cannot silently disable a gate

`.volatile()` fields are written **straight into their reference cell** from the
Plugins page, bypassing the loader's `Config` validation. The schema therefore
only guards the initial composition; nothing polices runtime edits.

Without protection, typing `-1` into `maxConsecutive` on the settings page would
disable it: `if (maxConsecutive > 0 && ...)` in `decide()` short-circuits and the
cap **silently becomes unlimited**. `minIntervalMs: -1` defeats the cooldown the
same way.

So `readSettings()` type-checks and clamps every field (`LIMITS` and the schema
share one set of bounds):

| Input | Result |
|---|---|
| `maxConsecutive: -1` / `99` / `2.5` / `'lots'` | falls back to `3` |
| `maxConsecutive: 0` | kept as `0` (explicit "no cap" is a deliberate choice) |
| `minIntervalMs: -50` / `7000000` | falls back to `1500` |
| `continueText: 42` / `'   '` | falls back to `'继续'` |
| `continueText: 'x'.repeat(400)` | truncated to 200 |
| `continueText: '  trim me  '` | trimmed to `'trim me'` |
| `enabled: 'nope'` | falls back to `true` |

The point is that **a negative number falls back to the default, not to `0`**.
`0` means "turn this gate off", and a mistyped negative should not have that
power.

## Tests

```bash
npm test
# tests 61, pass 61, fail 0
```

61 cases across three layers:

| File | Cases | Coverage |
|---|---|---|
| `test/policy.test.mjs` | 17 | Pure decision logic fed plain objects, importing **no Cordis at all**: burst cap, cooldown, same-turn dedup, non-truncation reasons, disabled not mutating state |
| `test/index.test.mjs` | 28 | A mock ctx drives the real `apply()`, asserting the shape, frozenness, log path and error boundary of what reaches `agent.followup()`, session recycling, and the **reentrancy constraint** (the mock makes `followup` throw inside the dispatch window and asserts zero sends inside it and exactly one after idle) |
| `test/contract.test.mjs` | 16 | **Loading contract** — not behaviour, only "will installing this blow up?" |

`contract.test.mjs` asserts: the module graph resolves; `name` / `inject` /
`Config` / `apply` are all present with the right types; both
`validate(undefined)` and `validate({})` report no `issues`; the return value is
not a promise; `Config["~standard"]` exists; `main`, `dsh.bundle.patch` and
`files` in `package.json` all point at real files; every dependency directory is
genuinely readable; and an import + compose cycle repeated 25 times is stable.

> The `test` script passes `--test-isolation=none` because the DSH file sandbox
> forbids `child_process.spawn` while `node --test` spawns a child per test file
> by default. Plain `node --test` works in an ordinary environment.

## Known limitations

- **`max-tokens` only.** `aborted` / `error` / `blocked` / `interrupted` /
  `forked` are all left alone. Either the model stopped itself or a person
  stopped it, and "continue" cannot rescue those.
- **The counter is in-memory.** A process restart clears it, so a chain that
  spans a restart is treated as a new chain.
- **429s and exhausted quota are out of scope.** Different problem domain.
- **It does not judge whether the model actually finished.** It just presses the
  key for you. If the model loops into repetition, `maxConsecutive` bounds the
  number of rounds, but confirming that still means reading the transcript.
- **Subagents are not distinguished.** `ctx.agents.get()` returns an agent for
  subagent sessions too, so their truncations are continued as well and share the
  same burst cap. To manage only the main session, lower `maxConsecutive` or set
  `enabled: false`.

## Relationship to native harness behaviour

`@deepseek-ai/dsh-goal-round-driver` disarms on a `max-tokens` `turn/end`: under
goal semantics, a truncated turn did not deliver, so it should not automatically
advance.

This plugin changes no existing behaviour; it only adds a follow-up. The two
operate at different levels — the goal driver decides *whether to open the next
turn*, while this plugin handles *this turn not being finished*. They coexist.

## Troubleshooting

**Nothing happens after installing.** This is not a `required` bundle, so a
failed composition writes no startup log. First confirm `continue-on-limit`
appears on the Plugins page, then look for lines beginning with
`continue-on-limit:` in `ctx.logger`.

**The turn truncated but was not continued.** Check in order: is `enabled`
`true`; has `maxConsecutive` been reached (a warning is logged when it is); is
there queued human input in the inbox (which yields to the human).

**dsh crashes on startup right after installing, with an error during
`import`.** There is one real trap here: **npm's `node_modules` contents and the
npm cache hold references to each other, and deleting the cache turns the
installed packages into broken reparse points** — the directory still exists,
`stat` reports `size=0`, and `readdir` fails with `ENOENT`. The plugin itself is
completely intact, but dsh crashes during `import` at startup.

So: once installed, **do not delete the npm cache**. To clean up, delete
`node_modules` and run `npm install` again. After installing, run `npm test`
once — `contract.test.mjs` checks every dependency directory and its
`package.json` for genuine readability and repeats the import 25 times to
confirm stability.

**A zero-dependency build.** Delete the `Config` export: for a plugin with no
`Config` the loader short-circuits with `if (!e.Config) return n`. The cost is
losing the settings page and live toggling.

## Development

```bash
npm install --ignore-scripts
npm test
```

Layout:

```text
lib/policy.js     pure decision logic, zero framework dependencies — when to send
lib/index.js      wiring — read the event, find the agent, send the message
cordis.patch.yml  composition declaration
```

The decision logic is peeled into the framework-free `policy.js` so that the
"when should this send" path can be verified with bare node — no harness to
boot, no snapshot to mock. That is the layer most likely to be wrong and the
hardest to observe from an integration environment.

## License

[MIT](./LICENSE) © 2026 Rina
