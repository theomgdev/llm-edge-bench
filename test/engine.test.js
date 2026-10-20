/**
 * engine.test.js — unit test suite. Zero dependencies: `node test/engine.test.js`
 */
import assert from 'node:assert/strict';
import { match, matchGroup, extractNumbers, normalize, describeCondition } from '../core/matchers.js';
import { createFlow, createNode, createEdge, runFlow, validateFlow, summarize, interpolate, runBatch, applyRetryMemory } from '../core/engine.js';
import { MockClient } from '../core/client.js';

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(`  ok   ${name}`); }
  catch (err) { fail++; results.push(`  FAIL ${name}\n       ${err.message}`); }
}
async function ta(name, fn) {
  try { await fn(); pass++; results.push(`  ok   ${name}`); }
  catch (err) { fail++; results.push(`  FAIL ${name}\n       ${err.message}`); }
}

// ---------------------------------------------------------------- matchers
t('contains basic', () => assert.equal(match('answer is 4', { type: 'contains', value: '4' }).ok, true));
t('contains case-insensitive', () => assert.equal(match('FOUR', { type: 'contains', value: 'four' }).ok, true));
t('contains case-sensitive', () => assert.equal(match('FOUR', { type: 'contains', value: 'four', caseSensitive: true }).ok, false));
t('negate works', () => assert.equal(match('5', { type: 'contains', value: '4', negate: true }).ok, true));

t('word boundary: 4 != 14', () => {
  assert.equal(match('result is 14', { type: 'word', value: '4' }).ok, false);
  assert.equal(match('result is 4', { type: 'word', value: '4' }).ok, true);
  assert.equal(match('result is 4.', { type: 'word', value: '4' }).ok, true);
});
t('contains false-positive baseline', () => assert.equal(match('result is 14', { type: 'contains', value: '4' }).ok, true));

t('numeric eq', () => assert.equal(match('answer: 4', { type: 'numeric', op: 'eq', value: 4 }).ok, true));
t('numeric 14 != 4', () => assert.equal(match('answer: 14', { type: 'numeric', op: 'eq', value: 4 }).ok, false));
t('numeric last', () => assert.equal(match('2+2 was 4, now 5', { type: 'numeric', op: 'eq', value: 5, which: 'last' }).ok, true));
t('numeric tolerance', () => assert.equal(match('about 3.14', { type: 'numeric', op: 'eq', value: 3.1, tolerance: 0.05 }).ok, true));
t('numeric between', () => assert.equal(match('score 7', { type: 'numeric', op: 'between', min: 5, max: 10 }).ok, true));
t('numeric gt', () => assert.equal(match('32', { type: 'numeric', op: 'gt', value: 30 }).ok, true));
t('numeric no number', () => assert.equal(match('i do not know', { type: 'numeric', op: 'eq', value: 4 }).ok, false));

t('extractNumbers formats', () => {
  assert.deepEqual(extractNumbers('1,234.56 and -42 and 3.14'), [1234.56, -42, 3.14]);
  assert.deepEqual(extractNumbers('price is 1.000 USD'), [1000]);
});

t('regex capture', () => {
  const r = match('answer: 42 units', { type: 'regex', value: 'answer:\\s*(\\d+)' });
  assert.equal(r.ok, true);
  assert.equal(r.captures.$1, '42');
});
t('regex named group', () => {
  const r = match('x=9', { type: 'regex', value: 'x=(?<val>\\d+)' });
  assert.equal(r.captures.val, '9');
});
t('broken regex returns error without throwing', () => {
  const r = match('abc', { type: 'regex', value: '([' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
t('broken regex with negate does not turn true', () => {
  assert.equal(match('abc', { type: 'regex', value: '([', negate: true }).ok, false);
});

t('anyOf / allOf', () => {
  assert.equal(match('maybe yes', { type: 'anyOf', values: ['yes', 'no'] }).ok, true);
  assert.equal(match('yes and no', { type: 'allOf', values: ['yes', 'no'] }).ok, true);
  assert.equal(match('only yes', { type: 'allOf', values: ['yes', 'no'] }).ok, false);
});

t('length', () => {
  assert.equal(match('short', { type: 'length', max: 10 }).ok, true);
  assert.equal(match('x'.repeat(50), { type: 'length', max: 10 }).ok, false);
});

t('json path + fence', () => {
  const r = match('```json\n{"result":{"answer":"4"}}\n```', { type: 'json', path: 'result.answer', value: '4' });
  assert.equal(r.ok, true);
});
t('json embedded in prose', () => {
  const r = match('Here is my JSON: {"a":[1,2]} done', { type: 'json', path: 'a[1]' });
  assert.equal(r.ok, true);
  assert.equal(r.captures.$json, '2');
});

t('expr allowed', () => assert.equal(match('12', { type: 'expr', value: 'numbers[0] % 2 === 0' }).ok, true));
t('expr denied flag rejects execution', () => {
  const r = match('12', { type: 'expr', value: 'true', __denied: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'expr_denied');
});

t('thinking blocks stripped', () => {
  assert.equal(normalize('<think>answer must be 7</think> 4', { lower: true }), '4');
});
t('unterminated thinking block', () => {
  assert.equal(normalize('<think>still thinking 7', {}).trim(), '');
});
t('normalize: thinking wrong answer does not trigger wrong edge', () => {
  const txt = normalize('<think>first I thought 5</think>The answer is 4', { lower: true });
  assert.equal(match(txt, { type: 'numeric', op: 'eq', value: 4 }).ok, true);
  assert.equal(match(txt, { type: 'numeric', op: 'eq', value: 5 }).ok, false);
});

t('group all/any', () => {
  const cond = { all: [{ type: 'contains', value: '4' }, { type: 'numeric', op: 'lt', value: 10 }] };
  assert.equal(matchGroup('4', cond).ok, true);
  const cond2 = { any: [{ type: 'contains', value: 'zzz' }, { type: 'word', value: 'four' }] };
  assert.equal(matchGroup('four', cond2).ok, true);
});

t('describeCondition is readable', () => {
  assert.equal(describeCondition({ type: 'numeric', op: 'eq', value: 4 }), 'number = 4');
  assert.ok(describeCondition({ all: [{ type: 'contains', value: 'a' }, { type: 'contains', value: 'b' }] }).includes('AND'));
});

t('interpolate', () => {
  assert.equal(interpolate('attempt {{attempt}} of {{budget}}', { attempt: '2', budget: '5' }), 'attempt 2 of 5');
  assert.equal(interpolate('{{missing}}', {}), '{{missing}}');
});

// ---------------------------------------------------------------- flow setup helper
function mathFlow() {
  const n1 = createNode({ id: 'q1', title: '2+2', prompt: 'What is 2+2? Output just the number.', maxAttempts: 4 });
  const n2 = createNode({ id: 'q2', title: '16+16', prompt: 'What is 16+16?', maxAttempts: 3 });
  const nWhy = createNode({ id: 'why', title: 'Explain', prompt: 'Why did you give that answer? Explain step by step.', maxAttempts: 2 });
  const okEnd = createNode({ id: 'win', type: 'end', title: 'Passed', outcome: 'pass', score: 10 });
  const badEnd = createNode({ id: 'lose', type: 'end', title: 'Failed', outcome: 'fail', score: 0 });

  n1.edges = [
    createEdge({ id: 'e-ok', label: 'correct', to: 'q2', condition: { type: 'numeric', op: 'eq', value: 4 }, score: 5 }),
    createEdge({ id: 'e-bad', label: 'wrong', to: 'why', condition: { type: 'numeric', op: 'ne', value: 4 }, score: -2 }),
  ];
  n2.edges = [createEdge({ to: 'win', condition: { type: 'numeric', op: 'eq', value: 32 }, score: 5 })];
  nWhy.edges = [createEdge({ to: 'lose', condition: { type: 'always' } })];

  return createFlow({
    id: 'f-math', name: 'Arithmetic Flow', startId: 'q1',
    nodes: { q1: n1, q2: n2, why: nWhy, win: okEnd, lose: badEnd },
    settings: { memory: 'isolated', maxSteps: 20, defaultMaxAttempts: 4, normalize: { thinking: true, lower: true } },
  });
}

await ta('happy path: 4 -> 32 -> pass', async () => {
  const client = new MockClient((msgs) => (msgs.at(-1).content.includes('16+16') ? '32' : '4'));
  const run = await runFlow(mathFlow(), client);
  assert.equal(run.outcome, 'pass');
  assert.equal(run.score, 20); // 5 + 5 + 10
  assert.deepEqual(run.pathNodeIds, ['q1', 'q2', 'win']);
});

await ta('wrong answer routes to explain branch', async () => {
  const client = new MockClient((msgs) => (msgs.at(-1).content.includes('Why') ? 'because math' : '5'));
  const run = await runFlow(mathFlow(), client);
  assert.equal(run.outcome, 'fail');
  assert.ok(run.pathNodeIds.includes('why'));
  assert.equal(run.score, -2);
});

await ta('no edge matched -> ask again, then correct', async () => {
  const flow = mathFlow();
  flow.nodes.q1.edges = [createEdge({ to: 'q2', condition: { type: 'numeric', op: 'eq', value: 4 }, score: 5 })];
  let turn = 0;
  const client = new MockClient((msgs) => {
    if (msgs.at(-1).content.includes('16+16')) return '32';
    turn++;
    return turn < 3 ? 'i do not know' : '4';
  });
  const run = await runFlow(flow, client);
  assert.equal(run.outcome, 'pass');
  const retries = run.steps.filter((s) => s.action === 'fallback:retry').length;
  assert.equal(retries, 2);
  assert.equal(run.visits.q1, 3);
});

await ta('attempts exhausted stops run without infinite loop', async () => {
  const flow = mathFlow();
  flow.nodes.q1.edges = [createEdge({ to: 'q2', condition: { type: 'numeric', op: 'eq', value: 4 } })];
  const client = new MockClient(() => 'never correct');
  const run = await runFlow(flow, client);
  assert.equal(run.outcome, 'exhausted');
  assert.equal(run.visits.q1, 4);
  assert.match(run.stopReason, /exhausted/);
});

await ta('attempts exhausted with goto routes to alternative node', async () => {
  const flow = mathFlow();
  flow.nodes.q1.edges = [createEdge({ to: 'q2', condition: { type: 'numeric', op: 'eq', value: 4 } })];
  flow.nodes.q1.maxAttempts = 2;
  flow.nodes.q1.onExhausted = 'goto';
  flow.nodes.q1.onExhaustedTarget = 'lose';
  const client = new MockClient(() => 'wrong');
  const run = await runFlow(flow, client);
  assert.equal(run.outcome, 'fail');
  assert.equal(run.visits.q1, 2);
});

await ta('fallback: stop halts immediately on nomatch', async () => {
  const flow = mathFlow();
  flow.nodes.q1.edges = [createEdge({ to: 'q2', condition: { type: 'numeric', op: 'eq', value: 4 } })];
  flow.nodes.q1.fallback = 'stop';
  const run = await runFlow(flow, new MockClient(() => 'nope'));
  assert.equal(run.outcome, 'nomatch');
  assert.equal(run.visits.q1, 1);
});

await ta('backward edge (jump back to an earlier node)', async () => {
  const flow = mathFlow();
  flow.nodes.q2.edges.push(createEdge({ to: 'q1', label: 'restart', condition: { type: 'always' } }));
  let n = 0;
  const client = new MockClient((msgs) => {
    const isQ2 = msgs.at(-1).content.includes('16+16');
    if (!isQ2) return '4';
    n++;
    return n < 2 ? '33' : '32';
  });
  const run = await runFlow(flow, client);
  assert.equal(run.outcome, 'pass');
  assert.equal(run.visits.q1, 2);
  assert.ok(run.pathNodeIds.join('>').includes('q2>q1>q2'));
});

await ta('step budget caps execution', async () => {
  const a = createNode({ id: 'a', prompt: 'A?', edges: [createEdge({ to: 'b', condition: { type: 'always' } })] });
  const b = createNode({ id: 'b', prompt: 'B?', edges: [createEdge({ to: 'a', condition: { type: 'always' } })] });
  const flow = createFlow({ startId: 'a', nodes: { a, b }, settings: { maxSteps: 7, memory: 'isolated' } });
  const run = await runFlow(flow, new MockClient(() => 'x'));
  assert.equal(run.status, 'stopped');
  assert.equal(run.steps.length, 7);
  assert.match(run.stopReason, /step budget/);
});

await ta('regex captures interpolate into subsequent prompts', async () => {
  const q1 = createNode({
    id: 'q1', prompt: 'Pick a number.',
    edges: [createEdge({ to: 'q2', condition: { type: 'regex', value: '(\\d+)' } })],
  });
  const q2 = createNode({ id: 'q2', prompt: 'Was your number {{$1}}? Reply YES if so.',
    edges: [createEdge({ to: 'end', condition: { type: 'contains', value: 'yes' } })] });
  const end = createNode({ id: 'end', type: 'end', outcome: 'pass', score: 1 });
  const flow = createFlow({ startId: 'q1', nodes: { q1, q2, end }, settings: { memory: 'isolated' } });
  const seen = [];
  const client = new MockClient((msgs) => { seen.push(msgs.at(-1).content); return seen.length === 1 ? '77' : 'yes'; });
  const run = await runFlow(flow, client);
  assert.equal(run.outcome, 'pass');
  assert.ok(seen[1].includes('77'), `capture was not interpolated: ${seen[1]}`);
});

await ta('edge inject prepends text to next prompt', async () => {
  const q1 = createNode({ id: 'q1', prompt: 'Q1?',
    edges: [createEdge({ to: 'q2', condition: { type: 'always' }, inject: 'Be more specific.' })] });
  const q2 = createNode({ id: 'q2', prompt: 'Q2?', edges: [createEdge({ to: 'e', condition: { type: 'always' } })] });
  const e = createNode({ id: 'e', type: 'end', outcome: 'pass' });
  const flow = createFlow({ startId: 'q1', nodes: { q1, q2, e }, settings: { memory: 'isolated' } });
  const seen = [];
  await runFlow(flow, new MockClient((m) => { seen.push(m.at(-1).content); return 'ok'; }));
  assert.ok(seen[1].startsWith('Be more specific.'), seen[1]);
});

// ---------------------------------------------------------------- new flexibility features
await ta('trial counter is visible to model on retry', async () => {
  const flow = mathFlow();
  flow.settings.trialCounter = { enabled: true, template: '[Attempt {{attempt}}/{{budget}}]', position: 'prefix', skipFirst: true };
  flow.nodes.q1.edges = [createEdge({ to: 'win', condition: { type: 'numeric', op: 'eq', value: 4 } })];
  const seen = [];
  let turn = 0;
  const client = new MockClient((msgs) => {
    seen.push(msgs.at(-1).content);
    turn++;
    return turn === 1 ? 'wrong' : '4';
  });
  const run = await runFlow(flow, client);
  assert.equal(run.outcome, 'pass');
  assert.ok(!seen[0].includes('[Attempt'), 'first attempt should not have counter');
  assert.ok(seen[1].includes('[Attempt 2/4]'), `counter missing on attempt 2: ${seen[1]}`);
});

await ta('trial counter works in suffix position', async () => {
  const flow = mathFlow();
  flow.settings.trialCounter = { enabled: true, template: 'TRY={{attempt}}', position: 'suffix', skipFirst: false };
  flow.nodes.q1.edges = [createEdge({ to: 'win', condition: { type: 'always' } })];
  const seen = [];
  await runFlow(flow, new MockClient((msgs) => { seen.push(msgs.at(-1).content); return 'ok'; }));
  assert.ok(seen[0].endsWith('TRY=1'), seen[0]);
});

await ta('retryMemory: drop removes previous failed attempts of current node', async () => {
  const history = [
    { role: 'user', content: 'prior question', __nodeId: 'prior' },
    { role: 'assistant', content: 'prior answer', __nodeId: 'prior' },
    { role: 'user', content: 'bad try 1', __nodeId: 'current' },
    { role: 'assistant', content: 'wrong 1', __nodeId: 'current' },
  ];
  const kept = applyRetryMemory(history, 'current', 'keep');
  assert.equal(kept.length, 4);
  const dropped = applyRetryMemory(history, 'current', 'drop');
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0].content, 'prior question');
});

await ta('retryMemory: summary replaces failed attempts with a note', async () => {
  const history = [
    { role: 'user', content: 'prior question', __nodeId: 'prior' },
    { role: 'assistant', content: 'prior answer', __nodeId: 'prior' },
    { role: 'user', content: 'bad try 1', __nodeId: 'current' },
    { role: 'assistant', content: 'wrong 1', __nodeId: 'current' },
  ];
  const summarized = applyRetryMemory(history, 'current', 'summary', 'Not accepted');
  assert.equal(summarized.length, 3);
  assert.equal(summarized[2].role, 'system');
  assert.ok(summarized[2].content.includes('Not accepted'));
  assert.ok(summarized[2].content.includes('1 failed attempt'));
});

await ta('resetContextOnEnter wipes history when entering node', async () => {
  const flow = mathFlow();
  flow.settings.memory = 'conversation';
  flow.nodes.q2.resetContextOnEnter = true;
  const lens = [];
  const client = new MockClient((msgs) => {
    lens.push(msgs.length);
    return msgs.at(-1).content.includes('16+16') ? '32' : '4';
  });
  await runFlow(flow, client);
  // q1 has 1 message (user). q2 resets, so it sees 1 message (user) instead of 3
  assert.deepEqual(lens, [1, 1]);
});

await ta('edge.resetContext wipes history on branch traversal', async () => {
  const flow = mathFlow();
  flow.settings.memory = 'conversation';
  flow.nodes.q1.edges[0].resetContext = true; // correct branch resets context
  const lens = [];
  const client = new MockClient((msgs) => {
    lens.push(msgs.length);
    return msgs.at(-1).content.includes('16+16') ? '32' : '4';
  });
  await runFlow(flow, client);
  assert.deepEqual(lens, [1, 1]);
});

await ta('cacheBuster passes user nonce on attempt > 1', async () => {
  const flow = mathFlow();
  flow.settings.cacheBuster = { enabled: true, mode: 'user' };
  flow.nodes.q1.edges = [createEdge({ to: 'win', condition: { type: 'numeric', op: 'eq', value: 4 } })];
  const overrides = [];
  let turn = 0;
  const client = new MockClient((msgs, t, over) => {
    overrides.push(over);
    turn++;
    return turn === 1 ? 'wrong' : '4';
  });
  await runFlow(flow, client);
  assert.equal(overrides[0].user, undefined, 'attempt 1 should not have user nonce');
  assert.ok(overrides[1].user?.startsWith('run_'), `attempt 2 must have nonce: ${overrides[1].user}`);
});

await ta('cacheBuster toggleable: off mode does not set nonce', async () => {
  const flow = mathFlow();
  flow.settings.cacheBuster = { enabled: false };
  flow.nodes.q1.edges = [createEdge({ to: 'win', condition: { type: 'numeric', op: 'eq', value: 4 } })];
  const overrides = [];
  let turn = 0;
  const client = new MockClient((msgs, t, over) => { overrides.push(over); turn++; return turn === 1 ? 'wrong' : '4'; });
  await runFlow(flow, client);
  assert.equal(overrides[1].user, undefined);
});

// ---------------------------------------------------------------- validation
t('validate: edge with no target is error', () => {
  const q = createNode({ id: 'q', prompt: 'a', edges: [createEdge({ to: null, condition: { type: 'contains', value: 'x' } })] });
  const v = validateFlow(createFlow({ startId: 'q', nodes: { q } }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('no target')));
});
t('validate: always edge in the middle warns', () => {
  const e2 = createNode({ id: 'e2', type: 'end' });
  const q = createNode({ id: 'q', prompt: 'a', edges: [
    createEdge({ to: 'e2', condition: { type: 'always' } }),
    createEdge({ to: 'e2', condition: { type: 'contains', value: 'z' } }),
  ] });
  const v = validateFlow(createFlow({ startId: 'q', nodes: { q, e2 } }));
  assert.ok(v.warnings.some((w) => w.includes('never be evaluated')));
});
t('validate: unreachable node warns', () => {
  const q = createNode({ id: 'q', prompt: 'a', edges: [] });
  const orphan = createNode({ id: 'orphan', prompt: 'b' });
  const v = validateFlow(createFlow({ startId: 'q', nodes: { q, orphan } }));
  assert.ok(v.warnings.some((w) => w.includes('unreachable')));
});
t('validate: broken regex caught', () => {
  const e2 = createNode({ id: 'e2', type: 'end' });
  const q = createNode({ id: 'q', prompt: 'a', edges: [createEdge({ to: 'e2', condition: { type: 'regex', value: '([' } })] });
  const v = validateFlow(createFlow({ startId: 'q', nodes: { q, e2 } }));
  assert.equal(v.ok, false);
});
t('validate: clean flow has no errors', () => {
  const v = validateFlow(mathFlow());
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.warnings, []);
});

// ---------------------------------------------------------------- batch run
await ta('runBatch: 2 models x 3 repeats', async () => {
  const good = { label: 'good-model', client: new MockClient((m) => (m.at(-1).content.includes('16+16') ? '32' : '4')) };
  const bad = { label: 'bad-model', client: new MockClient(() => 'i do not know') };
  const runs = await runBatch(mathFlow(), [good, bad], { repeats: 3, concurrency: 2 });
  assert.equal(runs.length, 6);
  const s = summarize(runs);
  assert.equal(s.total, 6);
  assert.equal(s.byModel.length, 2);
  assert.equal(s.byModel[0].model, 'good-model');
  assert.equal(s.byModel[0].passRate, 1);
  assert.equal(s.byModel[0].avgScore, 20);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
