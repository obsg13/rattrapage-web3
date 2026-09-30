'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../src/prng');
const T = require('../src/telemetry');
const { classifyReport, isSuspicious } = require('../src/classify');

test('retrouve la cause des rapports generes par spikeReport', () => {
  const rng = createRng(3);
  const c = T.makeClient(rng);
  const s = T.makeServer(rng, { createdAt: Date.now() });
  for (const cause of ['network', 'hidden', 'shader', 'overlay', 'world', 'generic']) {
    const { report } = T.spikeReport(rng, c, s, { cause, build: 'beta-test', now: Date.now() });
    assert.equal(classifyReport(report), cause);
  }
});

test('network passe avant shader (ordre des regles)', () => {
  const report = { reason: 'network', graphics: { firstCapture: true } };
  assert.equal(classifyReport(report), 'network');
});

test('un rapport incomplet donne generic sans planter', () => {
  assert.equal(classifyReport({}), 'generic');
  assert.equal(classifyReport(undefined), 'generic');
});

test('isSuspicious detecte les rapports impossibles', () => {
  assert.equal(isSuspicious({ fps: 200, frameMs: 20, work: { totalMs: 10 } }), true);
  assert.equal(isSuspicious({ fps: 60, frameMs: 5, work: { totalMs: 30 } }), true);
  assert.equal(isSuspicious({ fps: 60, frameMs: 20, work: { totalMs: 15 } }), false);
  assert.equal(isSuspicious({}), false);
});
