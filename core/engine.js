/**
 * engine.js — graph execution engine for branching LLM benchmarks.
 *
 * The model receives a node's prompt and answers. Outgoing edges are tested
 * in order; the first matching edge dictates the next node. If no edge
 * matches, the node's fallback behavior triggers (default: ask again).
 *
 * Cycles are first-class: asking until correct IS a loop. To bound execution,
 * three separate budgets protect the run:
 *   - per-node attempt budget (maxAttempts)
 *   - total steps budget (maxSteps)
 *   - wall-clock time budget (maxMs)
 */

import { matchGroup, normalize, describeCondition } from './matchers.js';

export const NODE_TYPES = ['prompt', 'end'];

/** Default empty flow. Every setting is driven by the UI. */
export function createFlow(partial = {}) {
  return {
    version: 2,
    id: partial.id || uid('flow'),
    name: partial.name || 'New Flow',
    description: partial.description || '',
    startId: partial.startId || null,
    nodes: partial.nodes || {},
    settings: {
      systemPrompt: '',
      // --- context carry policy -----------------------------------------
      // 'conversation' : full conversation carried down the branch
      // 'window'       : last historyTurns turns carried
      // 'isolated'     : clean slate on every prompt
      memory: 'conversation',
      historyTurns: 4,
      // How failed attempts at the same node are treated in context:
      // 'keep'   : model sees its own previous wrong answers
      // 'drop'   : only the latest attempt remains (failed retries wiped)
      // 'summary': wrong answers collapsed into a short system/user note
      retryMemory: 'keep',
      retryMemoryNote: 'Your previous answer was not accepted.',
      // --- trial counter ------------------------------------------------
      trialCounter: {
        enabled: false,
        template: '[Attempt {{attempt}}/{{budget}}]',
        position: 'prefix',  // 'prefix' | 'suffix' | 'system'
        skipFirst: true,     // don't show on attempt 1
      },
      // --- cache buster -------------------------------------------------
      // Gateways (e.g. Omniroute) cache identical request bodies. That locks
      // "ask until correct" loops onto the cached answer. This injects a nonce.
      cacheBuster: { enabled: true, mode: 'user' }, // 'user' | 'system' | 'seed' | 'off'
      // --- budgets ------------------------------------------------------
      maxSteps: 40,
      maxMs: 10 * 60 * 1000,
      defaultMaxAttempts: 5,
      // --- normalization ------------------------------------------------
      normalize: { thinking: true, markdown: false, lower: true, punctuation: false, trim: true, whitespace: true },
      params: { temperature: 0.2 },
      ...(partial.settings || {}),
    },
    ...stripKeys(partial, ['id', 'name', 'description', 'startId', 'nodes', 'settings']),
  };
}

export function createNode(partial = {}) {
  return {
    id: partial.id || uid('n'),
    type: partial.type || 'prompt',
    title: partial.title || '',
    prompt: partial.prompt ?? '',
    // Node-level overrides (null = inherit from flow)
    systemPrompt: partial.systemPrompt ?? null,
    params: partial.params || null,
    maxAttempts: partial.maxAttempts ?? null,
    memory: partial.memory ?? null,              // 'conversation'|'window'|'isolated'|null
    historyTurns: partial.historyTurns ?? null,
    retryMemory: partial.retryMemory ?? null,    // 'keep'|'drop'|'summary'|null
    trialCounter: partial.trialCounter ?? null,
    // Reset conversation history upon entering this node (start fresh branch)
    resetContextOnEnter: partial.resetContextOnEnter ?? false,
    // Fallback behavior when NO edge matches:
    // 'retry' (ask again) | 'stop' (end run) | 'goto' (jump to target)
    fallback: partial.fallback || 'retry',
    fallbackTarget: partial.fallbackTarget || null,
    // When the attempt budget is exhausted:
    // 'stop' | 'goto'
    onExhausted: partial.onExhausted || 'stop',
    onExhaustedTarget: partial.onExhaustedTarget || null,
    score: partial.score ?? 0,
    tags: partial.tags || [],
    outcome: partial.outcome || null, // 'pass' | 'fail' | null (for end nodes)
    edges: (partial.edges || []).map(createEdge),
    ui: partial.ui || { x: 0, y: 0 },
  };
}

export function createEdge(partial = {}) {
  return {
    id: partial.id || uid('e'),
    label: partial.label || '',
    to: partial.to || null,
    condition: partial.condition || { type: 'contains', value: '' },
    score: partial.score ?? 0,
    inject: partial.inject || '',              // optional guidance prepended to the next prompt
    resetAttempts: partial.resetAttempts ?? true,
    resetContext: partial.resetContext ?? false, // wipe history when taking this edge
    ...stripKeys(partial, ['id', 'label', 'to', 'condition', 'score', 'inject', 'resetAttempts', 'resetContext']),
  };
}

const uidCounters = {};
function uid(prefix) {
  uidCounters[prefix] = (uidCounters[prefix] || 0) + 1;
  return `${prefix}_${Date.now().toString(36)}${uidCounters[prefix].toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
function stripKeys(o, keys) {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/** Fills {{variable}} placeholders from vars dictionary. */
export function interpolate(template, vars) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, key) => {
    const v = vars[key];
    return v === undefined || v === null ? full : String(v);
  });
}

/** Pre-flight flow validation. */
export function validateFlow(flow) {
  const errors = [];
  const warnings = [];
  const ids = Object.keys(flow.nodes || {});
  if (!ids.length) errors.push('Flow contains no nodes.');
  if (!flow.startId) errors.push('No start node selected.');
  else if (!flow.nodes[flow.startId]) errors.push(`Start node does not exist: ${flow.startId}`);

  for (const id of ids) {
    const n = flow.nodes[id];
    if (n.type === 'end') continue;
    if (!String(n.prompt || '').trim()) warnings.push(`Node "${nodeLabel(n)}" has an empty prompt.`);
    const seen = new Set();
    for (const e of n.edges || []) {
      if (!e.to) errors.push(`Node "${nodeLabel(n)}" has an edge with no target.`);
      else if (!flow.nodes[e.to]) errors.push(`Node "${nodeLabel(n)}" points to a non-existent node: ${e.to}`);
      if (e.condition?.type === 'regex') {
        try { new RegExp(e.condition.value, e.condition.flags || 'i'); }
        catch (err) { errors.push(`Node "${nodeLabel(n)}" has an invalid regex: ${err.message}`); }
      }
      const sig = JSON.stringify(e.condition);
      if (seen.has(sig)) warnings.push(`Node "${nodeLabel(n)}" has duplicate conditions.`);
      seen.add(sig);
    }
    const alwaysAt = (n.edges || []).findIndex((e) => e.condition?.type === 'always' && !e.condition.negate);
    if (alwaysAt >= 0 && alwaysAt < (n.edges.length - 1)) {
      warnings.push(`Node "${nodeLabel(n)}": "always" edge is not last — ${n.edges.length - alwaysAt - 1} edge(s) below it will never be evaluated.`);
    }
    if (n.fallback === 'goto' && !flow.nodes[n.fallbackTarget || '']) {
      errors.push(`Node "${nodeLabel(n)}" fallback goto target does not exist.`);
    }
    if (n.onExhausted === 'goto' && !flow.nodes[n.onExhaustedTarget || '']) {
      errors.push(`Node "${nodeLabel(n)}" exhausted goto target does not exist.`);
    }
  }

  if (flow.startId && flow.nodes[flow.startId]) {
    const reach = reachable(flow);
    for (const id of ids) if (!reach.has(id)) warnings.push(`Node "${nodeLabel(flow.nodes[id])}" is unreachable.`);
  }

  const hasExpr = ids.some((id) => (flow.nodes[id].edges || []).some((e) => containsExpr(e.condition)));
  return { ok: errors.length === 0, errors, warnings, hasExpr };
}

export function containsExpr(cond) {
  if (!cond) return false;
  if (cond.type === 'expr') return true;
  for (const k of ['all', 'any']) if (Array.isArray(cond[k]) && cond[k].some(containsExpr)) return true;
  return false;
}

export function reachable(flow) {
  const seen = new Set();
  const stack = [flow.startId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !flow.nodes[id]) continue;
    seen.add(id);
    const n = flow.nodes[id];
    for (const e of n.edges || []) if (e.to) stack.push(e.to);
    if (n.fallbackTarget) stack.push(n.fallbackTarget);
    if (n.onExhaustedTarget) stack.push(n.onExhaustedTarget);
  }
  return seen;
}

export function nodeLabel(n) {
  if (!n) return '?';
  return n.title || (n.prompt ? String(n.prompt).slice(0, 40).replace(/\s+/g, ' ') : n.id);
}

/** Applies the retryMemory policy to the history array for the current node. */
export function applyRetryMemory(history, currentNodeId, mode, note) {
  if (!history.length || mode === 'keep') return history;
  if (mode === 'drop') {
    // Drop all turns that belong to the current node except nothing
    // (the current question is about to be asked cleanly)
    return history.filter((m) => m.__nodeId !== currentNodeId);
  }
  if (mode === 'summary') {
    const base = history.filter((m) => m.__nodeId !== currentNodeId);
    const retryCount = history.filter((m) => m.__nodeId === currentNodeId && m.role === 'assistant').length;
    if (retryCount > 0) {
      base.push({
        role: 'system',
        content: `${note || 'Previous attempt was not accepted.'} (${retryCount} failed attempt${retryCount > 1 ? 's' : ''})`,
      });
    }
    return base;
  }
  return history;
}

/**
 * Execute a single run of a flow against a client.
 * @param {object} flow
 * @param {{chat:Function}} client
 * @param {object} [opts]
 * @param {(ev:object)=>void} [opts.onEvent]
 * @param {()=>boolean} [opts.shouldStop]
 * @param {boolean} [opts.allowExpr]
 * @param {Record<string,string>} [opts.vars]
 * @param {number} [opts.seedIndex]
 */
export async function runFlow(flow, client, opts = {}) {
  const s = flow.settings || {};
  const emit = (ev) => { try { opts.onEvent?.({ ...ev, t: Date.now() }); } catch { /* ignore listener err */ } };
  const startedAt = Date.now();
  const maxSteps = opts.maxSteps ?? s.maxSteps ?? 40;
  const maxMs = opts.maxMs ?? s.maxMs ?? 600000;
  const normOpts = { ...(s.normalize || {}), ...(opts.normalize || {}) };

  const run = {
    id: uid('run'),
    flowId: flow.id,
    flowName: flow.name,
    model: opts.modelLabel || client.model || '',
    repeatIndex: opts.seedIndex ?? 0,
    startedAt,
    finishedAt: null,
    steps: [],
    status: 'running',
    stopReason: null,
    score: 0,
    outcome: null,
    visits: {},
    pathNodeIds: [],
    usage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    error: null,
  };

  const vars = { ...(opts.vars || {}) };
  /** @type {Array<{role:string,content:string,__nodeId?:string,__attempt?:number}>} */
  let history = [];
  const attempts = Object.create(null); // nodeId -> attempts at this node
  let currentId = flow.startId;
  let pendingInject = '';
  let resetNext = false;

  emit({ type: 'run:start', runId: run.id, flowId: flow.id, model: run.model, repeatIndex: run.repeatIndex });

  try {
    while (true) {
      if (opts.shouldStop?.()) { run.status = 'stopped'; run.stopReason = 'stopped by user'; break; }
      if (!currentId) { run.status = 'done'; run.stopReason = 'end of path (no target)'; break; }
      const node = flow.nodes[currentId];
      if (!node) { run.status = 'error'; run.stopReason = `node not found: ${currentId}`; break; }

      run.visits[currentId] = (run.visits[currentId] || 0) + 1;
      run.pathNodeIds.push(currentId);

      if (node.type === 'end') {
        run.score += Number(node.score) || 0;
        run.outcome = node.outcome || 'end';
        run.steps.push({
          index: run.steps.length, nodeId: node.id, nodeTitle: nodeLabel(node), type: 'end',
          outcome: run.outcome, score: Number(node.score) || 0, note: node.prompt || '',
        });
        emit({ type: 'node:end', runId: run.id, nodeId: node.id, outcome: run.outcome, score: Number(node.score) || 0 });
        run.status = 'done';
        run.stopReason = `reached end node: ${nodeLabel(node)}`;
        break;
      }

      if (run.steps.length >= maxSteps) { run.status = 'stopped'; run.stopReason = `step budget reached (${maxSteps})`; break; }
      if (Date.now() - startedAt > maxMs) { run.status = 'stopped'; run.stopReason = `time budget reached (${Math.round(maxMs / 1000)}s)`; break; }

      attempts[currentId] = (attempts[currentId] || 0) + 1;
      const attempt = attempts[currentId];
      const budget = node.maxAttempts ?? s.defaultMaxAttempts ?? 5;

      // context reset requests
      if (resetNext || (node.resetContextOnEnter && attempt === 1)) {
        history = [];
        resetNext = false;
      }

      const memory = opts.memory || node.memory || s.memory || 'conversation';
      const retryMemory = node.retryMemory || s.retryMemory || 'keep';
      const historyTurns = node.historyTurns ?? s.historyTurns ?? 0;
      const trialCfg = { ...(s.trialCounter || {}), ...(node.trialCounter || {}) };

      // build prompt with live variables
      const liveVars = {
        ...vars,
        attempt: String(attempt),
        budget: String(budget),
        remaining: String(Math.max(0, budget - attempt)),
        step: String(run.steps.length + 1),
        node: nodeLabel(node),
      };
      const promptText = interpolate(node.prompt, liveVars);

      let trialText = '';
      if (trialCfg.enabled && !(trialCfg.skipFirst && attempt === 1)) {
        trialText = interpolate(trialCfg.template || '[Attempt {{attempt}}/{{budget}}]', liveVars);
      }

      let userContent = promptText;
      if (pendingInject) userContent = `${pendingInject}\n\n${userContent}`.trim();
      if (trialText && trialCfg.position !== 'system') {
        userContent = trialCfg.position === 'suffix' ? `${userContent}\n\n${trialText}` : `${trialText}\n${userContent}`;
      }
      pendingInject = '';

      let sysText = interpolate(node.systemPrompt ?? s.systemPrompt ?? '', liveVars);
      if (trialText && trialCfg.position === 'system') sysText = `${sysText}\n${trialText}`.trim();

      // build message list based on memory policy
      let carried = memory === 'isolated' ? [] : applyRetryMemory(history, node.id, retryMemory, s.retryMemoryNote);
      if (memory === 'window' && historyTurns > 0) carried = carried.slice(-historyTurns * 2);

      const messages = [];
      if (sysText.trim()) messages.push({ role: 'system', content: sysText });
      messages.push(...carried.map(({ role, content }) => ({ role, content })));
      messages.push({ role: 'user', content: userContent });

      const params = { ...(s.params || {}), ...(node.params || {}), ...(opts.params || {}) };

      // cache buster: prevents gateways from returning cached responses on retry
      const cb = { ...(s.cacheBuster || {}), ...(opts.cacheBuster || {}) };
      if (cb.enabled && cb.mode !== 'off' && attempt > 1) {
        const nonce = `${run.id}-${node.id}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
        if (cb.mode === 'seed') params.seed = Math.floor(Math.random() * 2 ** 31);
        else if (cb.mode === 'system') messages.unshift({ role: 'system', content: `# session: ${nonce}` });
        else params.user = nonce; // default: OpenAI 'user' parameter, does not pollute prompt
      }

      emit({ type: 'step:prompt', runId: run.id, nodeId: node.id, attempt, prompt: userContent, step: run.steps.length, messageCount: messages.length });

      // call model
      let resp;
      try {
        resp = await client.chat(messages, params);
      } catch (err) {
        const step = {
          index: run.steps.length, nodeId: node.id, nodeTitle: nodeLabel(node), type: 'error',
          attempt, prompt: userContent, answer: '', error: err.message, latencyMs: 0,
        };
        run.steps.push(step);
        emit({ type: 'step:error', runId: run.id, nodeId: node.id, error: err.message, step: step.index });
        run.status = 'error';
        run.stopReason = `model error: ${err.message}`;
        run.error = err.message;
        break;
      }

      run.usage.requests++;
      run.usage.promptTokens += resp.usage?.promptTokens || 0;
      run.usage.completionTokens += resp.usage?.completionTokens || 0;
      run.usage.totalTokens += resp.usage?.totalTokens || 0;

      const rawAnswer = resp.text || '';
      const normAnswer = normalize(rawAnswer, normOpts);

      if (memory !== 'isolated') {
        history.push(
          { role: 'user', content: userContent, __nodeId: node.id, __attempt: attempt },
          { role: 'assistant', content: rawAnswer, __nodeId: node.id, __attempt: attempt }
        );
      }

      // test outgoing edges in order
      let taken = null;
      const tried = [];
      for (const edge of node.edges || []) {
        const cond = prepCondition(edge.condition, opts.allowExpr);
        const res = matchGroup(normAnswer, cond);
        tried.push({ edgeId: edge.id, label: edge.label || describeCondition(edge.condition), ok: res.ok, detail: res.detail });
        if (res.ok) { taken = { edge, res }; break; }
      }

      const step = {
        index: run.steps.length,
        nodeId: node.id,
        nodeTitle: nodeLabel(node),
        type: 'prompt',
        attempt,
        prompt: userContent,
        answer: rawAnswer,
        normalized: normAnswer,
        reasoning: resp.reasoning || '',
        latencyMs: resp.latencyMs || 0,
        usage: resp.usage,
        finishReason: resp.finishReason,
        evaluations: tried,
        matchedEdgeId: taken?.edge.id || null,
        matchedLabel: taken ? (taken.edge.label || describeCondition(taken.edge.condition)) : null,
        matchDetail: taken?.res.detail || null,
        score: 0,
        nextNodeId: null,
        action: null,
      };

      if (taken) {
        const { edge, res } = taken;
        if (res.captures) Object.assign(vars, res.captures);
        step.score = (Number(node.score) || 0) + (Number(edge.score) || 0);
        run.score += step.score;
        step.nextNodeId = edge.to;
        step.action = 'edge';
        if (edge.resetAttempts !== false) attempts[currentId] = 0;
        if (edge.resetContext) resetNext = true;
        if (edge.inject) pendingInject = interpolate(edge.inject, { ...vars, attempt: String(attempt) });
        run.steps.push(step);
        emit({ type: 'step:done', runId: run.id, step, edgeId: edge.id, nextNodeId: edge.to });
        currentId = edge.to;
        continue;
      }

      // no edge matched
      if (attempt >= budget) {
        step.action = `exhausted:${node.onExhausted}`;
        step.nextNodeId = node.onExhausted === 'goto' ? node.onExhaustedTarget : null;
        run.steps.push(step);
        emit({ type: 'step:done', runId: run.id, step, exhausted: true });
        emit({ type: 'node:exhausted', runId: run.id, nodeId: node.id, attempts: attempt, budget });
        if (node.onExhausted === 'goto' && node.onExhaustedTarget) {
          attempts[currentId] = 0;
          currentId = node.onExhaustedTarget;
          continue;
        }
        run.status = 'done';
        run.outcome = run.outcome || 'exhausted';
        run.stopReason = `node "${nodeLabel(node)}" exhausted ${budget} attempt(s)`;
        break;
      }

      if (node.fallback === 'stop') {
        step.action = 'fallback:stop';
        run.steps.push(step);
        emit({ type: 'step:done', runId: run.id, step });
        run.status = 'done';
        run.outcome = run.outcome || 'nomatch';
        run.stopReason = `node "${nodeLabel(node)}": no edge matched, stopped`;
        break;
      }
      if (node.fallback === 'goto' && node.fallbackTarget) {
        step.action = 'fallback:goto';
        step.nextNodeId = node.fallbackTarget;
        run.steps.push(step);
        emit({ type: 'step:done', runId: run.id, step, nextNodeId: node.fallbackTarget });
        attempts[currentId] = 0;
        currentId = node.fallbackTarget;
        continue;
      }
      // default: ask again
      step.action = 'fallback:retry';
      step.nextNodeId = node.id;
      run.steps.push(step);
      emit({ type: 'step:done', runId: run.id, step, retry: true, nextNodeId: node.id });
      // currentId remains unchanged
    }
  } catch (err) {
    run.status = 'error';
    run.stopReason = `engine error: ${err.message}`;
    run.error = err.stack || err.message;
  }

  run.finishedAt = Date.now();
  run.durationMs = run.finishedAt - startedAt;
  run.vars = vars;
  emit({ type: 'run:end', runId: run.id, status: run.status, score: run.score, outcome: run.outcome, stopReason: run.stopReason, durationMs: run.durationMs });
  return run;
}

function prepCondition(cond, allowExpr) {
  if (allowExpr || !containsExpr(cond)) return cond;
  const walk = (c) => {
    if (!c) return c;
    if (c.type === 'expr') return { ...c, __denied: true };
    const out = { ...c };
    for (const k of ['all', 'any']) if (Array.isArray(c[k])) out[k] = c[k].map(walk);
    return out;
  };
  return walk(cond);
}

/**
 * Runs a flow across N repeats x M model targets.
 * @param {object} flow
 * @param {Array<{label:string, client:object}>} targets
 */
export async function runBatch(flow, targets, opts = {}) {
  const repeats = Math.max(1, opts.repeats || 1);
  const concurrency = Math.max(1, opts.concurrency || 1);
  const jobs = [];
  for (const t of targets) for (let i = 0; i < repeats; i++) jobs.push({ target: t, index: i });

  const results = new Array(jobs.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      if (opts.shouldStop?.()) return;
      const myIndex = cursor++;
      const job = jobs[myIndex];
      results[myIndex] = await runFlow(flow, job.target.client, {
        ...opts,
        modelLabel: job.target.label,
        seedIndex: job.index,
      });
      opts.onRunComplete?.(results[myIndex]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results.filter(Boolean);
}

/** Computes summary statistics from a run collection. */
export function summarize(runs) {
  const byModel = {};
  for (const r of runs) {
    const key = r.model || '(no model)';
    const m = byModel[key] ||= {
      model: key, runs: 0, score: 0, scores: [], outcomes: {}, steps: 0,
      requests: 0, tokens: 0, durationMs: 0, errors: 0, nodeVisits: {}, firstTryWins: 0, retries: 0,
    };
    m.runs++;
    m.score += r.score || 0;
    m.scores.push(r.score || 0);
    m.outcomes[r.outcome || r.status] = (m.outcomes[r.outcome || r.status] || 0) + 1;
    m.steps += r.steps?.length || 0;
    m.requests += r.usage?.requests || 0;
    m.tokens += r.usage?.totalTokens || 0;
    m.durationMs += r.durationMs || 0;
    if (r.status === 'error') m.errors++;
    for (const [id, c] of Object.entries(r.visits || {})) m.nodeVisits[id] = (m.nodeVisits[id] || 0) + c;
    const retried = (r.steps || []).filter((s) => s.action === 'fallback:retry').length;
    m.retries += retried;
    if (retried === 0 && r.outcome === 'pass') m.firstTryWins++;
  }
  for (const m of Object.values(byModel)) {
    m.avgScore = m.runs ? m.score / m.runs : 0;
    m.avgSteps = m.runs ? m.steps / m.runs : 0;
    m.avgDurationMs = m.runs ? m.durationMs / m.runs : 0;
    m.passRate = m.runs ? (m.outcomes.pass || 0) / m.runs : 0;
    m.stdDev = stdDev(m.scores);
  }
  return {
    total: runs.length,
    byModel: Object.values(byModel).sort((a, b) => b.avgScore - a.avgScore),
  };
}

function stdDev(xs) {
  if (xs.length < 2) return 0;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
}
