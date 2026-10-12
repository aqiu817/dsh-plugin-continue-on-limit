/**
 * Load-contract test.
 *
 * The other two suites prove the plugin *behaves* correctly. This one proves it
 * *loads*: that the module graph resolves from this package's own real path,
 * that every export the Cordis loader expects is present and correctly typed,
 * and that the loader's exact config-validation step does not throw.
 *
 * The last point is the one that matters for "did this break the whole of dsh":
 * the loader runs
 *
 *     function jc(e, n) {
 *       if (!e.Config) return n;
 *       const o = e.Config["~standard"].validate(n);
 *       if ("then" in o) throw new TypeError("Async config validation is not supported");
 *       if (o.issues) throw new kc(o.issues);
 *       return o.value;
 *     }
 *
 * and an `issues` on a composed entry propagates up as a load failure. So the
 * contract here is: `issues` is falsy, and the result is not a promise, for
 * every entry config shape this plugin is realisticly installed with.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

/**
 * The loader's `jc()` reproduced verbatim, minus the framework error type.
 * Returns the composed value, or throws exactly as the loader would.
 */
function loaderCompose(manifest, entryConfig) {
  if (!manifest.Config) return entryConfig;
  const o = manifest.Config['~standard'].validate(entryConfig);
  if ('then' in o) {
    throw new TypeError('Async config validation is not supported');
  }
  if (o.issues) {
    throw new TypeError(`config issues: ${JSON.stringify(o.issues)}`);
  }
  return o.value;
}

const mod = await import('../lib/index.js');

test('the module graph loads from this package at all', () => {
  assert.equal(typeof mod, 'object');
  assert.notEqual(mod, null);
});

test('the loader finds every export it reads', () => {
  assert.equal(typeof mod.name, 'string');
  assert.equal(mod.name, 'continue-on-limit');
  assert.deepEqual(mod.inject, ['agents']);
  // A schemastery schema is callable, and the loader reads the standard-schema
  // adapter off it as a property.
  assert.equal(typeof mod.Config, 'function');
  assert.equal(typeof mod.Config['~standard'], 'object');
  assert.equal(typeof mod.apply, 'function');
});

test('there is no client half, so no client bundle gets created', () => {
  assert.equal(mod.dsh, void 0);
  assert.equal(mod.client, void 0);
});

test('Config is a standard-schema, and validation is synchronous', () => {
  const schema = mod.Config['~standard'];
  assert.equal(typeof schema, 'object');
  assert.equal(typeof schema.validate, 'function');
  const result = schema.validate(undefined);
  assert.equal('then' in result, false, 'the loader rejects a promise here');
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
});

test('the loader composes an entry that omits config entirely', () => {
  const value = loaderCompose(mod, undefined);
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
});

test('the loader composes an entry with an empty config', () => {
  const value = loaderCompose(mod, {});
  assert.equal(typeof value, 'object');
});

test('the loader composes the config this patch row actually ships', () => {
  // Mirrors cordis.patch.yml, key for key.
  const value = loaderCompose(mod, {
    enabled: true,
    continueText: '继续',
    maxConsecutive: 3,
    minIntervalMs: 1500,
  });
  assert.equal(typeof value, 'object');
});

test('LIMITS and the schema bounds are one and the same', () => {
  const limits = mod.LIMITS;
  assert.equal(limits.maxConsecutive.min, 0);
  assert.equal(limits.maxConsecutive.max, 16);
  assert.equal(limits.minIntervalMs.min, 0);
  assert.equal(limits.minIntervalMs.max, 600_000);
  assert.equal(limits.continueText.min, 1);
  assert.equal(limits.continueText.max, 200);
  // Frozen, so a caller cannot widen a range out from under the clampers.
  assert.equal(Object.isFrozen(limits), true);
  assert.equal(Object.isFrozen(limits.maxConsecutive), true);
});

test('readSettings refuses to hand a safety gate a nonsense value', () => {
  // A negative cap is the dangerous one: decide() treats non-positive as
  // "no cap". It must come back as the default, never as the negative.
  assert.equal(
    mod.readSettings({ maxConsecutive: -1 }).maxConsecutive,
    mod.DEFAULTS.maxConsecutive
  );
  assert.equal(
    mod.readSettings({ minIntervalMs: -50 }).minIntervalMs,
    mod.DEFAULTS.minIntervalMs
  );

  // Out of range on the high side, and a non-integer, both fall back.
  assert.equal(
    mod.readSettings({ maxConsecutive: 99 }).maxConsecutive,
    mod.DEFAULTS.maxConsecutive
  );
  assert.equal(mod.readSettings({ maxConsecutive: 2.5 }).maxConsecutive, mod.DEFAULTS.maxConsecutive);
  assert.equal(
    mod.readSettings({ minIntervalMs: 7_000_000 }).minIntervalMs,
    mod.DEFAULTS.minIntervalMs
  );

  // The wrong type entirely.
  assert.equal(
    mod.readSettings({ maxConsecutive: 'lots' }).maxConsecutive,
    mod.DEFAULTS.maxConsecutive
  );
  assert.equal(mod.readSettings({ enabled: 'nope' }).enabled, mod.DEFAULTS.enabled);
  assert.equal(mod.readSettings({ continueText: 42 }).continueText, mod.DEFAULTS.continueText);
  assert.equal(
    mod.readSettings({ continueText: '   ' }).continueText,
    mod.DEFAULTS.continueText
  );

  // Zero is a deliberate opt-out, not a mistake: it stays zero.
  assert.equal(mod.readSettings({ maxConsecutive: 0 }).maxConsecutive, 0);
  assert.equal(mod.readSettings({ minIntervalMs: 0 }).minIntervalMs, 0);
});

test('readSettings honours a valid value and clamps a long prompt', () => {
  assert.deepEqual(
    mod.readSettings({ enabled: false, maxConsecutive: 7, minIntervalMs: 9000, continueText: 'keep going' }),
    { enabled: false, continueText: 'keep going', maxConsecutive: 7, minIntervalMs: 9000 }
  );
  assert.equal(
    mod.readSettings({ continueText: 'x'.repeat(400) }).continueText.length,
    mod.LIMITS.continueText.max
  );
  assert.equal(mod.readSettings({ continueText: '  trim me  ' }).continueText, 'trim me');
});

test('a volatile cell is unwrapped before it is clamped', () => {
  const cell = { get: () => -1 };
  assert.equal(
    mod.readSettings({ maxConsecutive: cell }).maxConsecutive,
    mod.DEFAULTS.maxConsecutive
  );
  assert.equal(mod.readSettings({ maxConsecutive: { get: () => 5 } }).maxConsecutive, 5);
  // A cell whose getter throws is not ours to swallow: it belongs to the host.
  assert.throws(() => mod.readSettings({ maxConsecutive: { get: () => { throw new Error('boom'); } } }));
});

test('readSettings survives a config that is not an object at all', () => {
  for (const config of [null, 0, '', 'string', true, []]) {
    assert.deepEqual(mod.readSettings(config), {
      enabled: mod.DEFAULTS.enabled,
      continueText: mod.DEFAULTS.continueText,
      maxConsecutive: mod.DEFAULTS.maxConsecutive,
      minIntervalMs: mod.DEFAULTS.minIntervalMs,
    });
  }
});

test('the package manifest points at files that exist', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.main, 'string');
  assert.equal(existsSync(resolve(pkgRoot, pkg.main)), true);

  assert.equal(typeof pkg.dsh, 'object');
  assert.equal(pkg.dsh.client, void 0, 'host only');
  assert.equal(typeof pkg.dsh.bundle.patch, 'string');
  assert.equal(existsSync(resolve(pkgRoot, pkg.dsh.bundle.patch)), true);

  for (const file of pkg.files ?? []) {
    assert.equal(existsSync(resolve(pkgRoot, file)), true, `package.json lists a missing ${file}`);
  }
  assert.equal(pkg.scripts.test, 'node --test --test-isolation=none "test/**/*.test.mjs"');
});

test('every dependency named in package.json resolves and actually reads', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const target = resolve(pkgRoot, 'node_modules', ...dep.split('/'));
    // statSync alone is not enough: a broken reparse point stats fine with
    // size 0 while readdir and readFileSync both fail with ENOENT. Reading the
    // file is what the loader actually does, so that is what gets checked.
    const raw = readFileSync(resolve(target, 'package.json'), 'utf8');
    assert.equal(raw.length > 0, true, `${dep}/package.json is empty`);
    const depPkg = JSON.parse(raw);
    assert.equal(typeof depPkg.name, 'string', `${dep} has no name`);
    assert.equal(depPkg.name, dep, `${dep} resolves to ${depPkg.name}`);
  }
});

test('the import and validate cycle is stable across repeated runs', async () => {
  // Guards against a transient filesystem read returning nothing. The whole
  // package graph is re-read on each iteration, which is what actually happens
  // when the host imports this plugin at startup.
  for (let i = 0; i < 25; i += 1) {
    const fresh = await import(`../lib/index.js?load=${i}`);
    const value = loaderCompose(fresh, undefined);
    assert.equal(typeof value, 'object', `iteration ${i}`);
  }
});

test('apply() returns without throwing on a minimal context', () => {
  const ctx = {
    agents: { get: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      assert.equal(typeof event, 'string');
      assert.equal(typeof handler, 'function');
    },
  };
  assert.doesNotThrow(() => mod.apply(ctx, undefined));
});
