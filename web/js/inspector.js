/**
 * inspector.js — right-side property inspector for nodes, edges, and flow settings.
 * Fully drives all flexible engine behaviors: memory policies, trial counters,
 * fallbacks, and multi-condition rules.
 */

import { CONDITION_TYPES, NUMERIC_OPS, NUMERIC_WHICH } from '../../core/matchers.js';
import { createEdge, nodeLabel } from '../../core/engine.js';

export class InspectorView {
  /**
   * @param {HTMLElement} container
   * @param {HTMLElement} titleEl
   * @param {HTMLElement} footerEl
   * @param {()=>void} onFlowMutated
   * @param {(targetId:string)=>void} onFocusNode
   */
  constructor(container, titleEl, footerEl, onFlowMutated, onFocusNode) {
    this.container = container;
    this.titleEl = titleEl;
    this.footerEl = footerEl;
    this.onFlowMutated = onFlowMutated;
    this.onFocusNode = onFocusNode;
    this.flow = null;
    this.currentNodeId = null;
    this.currentEdge = null; // { edgeId, fromNodeId }
  }

  setFlow(flow) {
    this.flow = flow;
  }

  showEmpty() {
    this.currentNodeId = null;
    this.currentEdge = null;
    this.titleEl.textContent = 'Flow Overview';
    if (this.footerEl) {
      this.footerEl.style.display = 'none';
      this.footerEl.innerHTML = '';
    }

    if (!this.flow) {
      this.container.innerHTML = '<div class="inspector-empty">No flow loaded.</div>';
      return;
    }

    const n = Object.keys(this.flow.nodes || {}).length;
    let e = 0;
    for (const node of Object.values(this.flow.nodes || {})) e += (node.edges || []).length;
    const startNode = this.flow.nodes[this.flow.startId];

    this.container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:14px;">
        <div class="panel-section">
          <div class="section-title">Graph Summary</div>
          <div class="metric-grid" style="margin-top:6px;">
            <div class="metric"><div class="metric-val">${n}</div><div class="metric-lbl">Nodes</div></div>
            <div class="metric"><div class="metric-val">${e}</div><div class="metric-lbl">Branches</div></div>
          </div>
        </div>

        <div class="panel-section">
          <div class="section-title">Start Node</div>
          <div style="font-weight:600; font-size:12px; color:var(--color-primary); padding:6px 0;">
            ${startNode ? escapeHtml(nodeLabel(startNode)) : '<span style="color:var(--color-danger);">None selected</span>'}
          </div>
        </div>

        <div class="panel-section">
          <div class="section-title">Engine Defaults</div>
          <div style="display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--text-muted); font-family:var(--font-mono);">
            <div>Memory: <strong>${this.flow.settings?.memory || 'conversation'}</strong></div>
            <div>Retry Memory: <strong>${this.flow.settings?.retryMemory || 'keep'}</strong></div>
            <div>Max Attempts: <strong>${this.flow.settings?.defaultMaxAttempts ?? 5}</strong></div>
            <div>Trial Counter: <strong>${this.flow.settings?.trialCounter?.enabled ? 'enabled' : 'off'}</strong></div>
            <div>Cache Buster: <strong>${this.flow.settings?.cacheBuster?.enabled ? 'enabled' : 'off'}</strong></div>
          </div>
        </div>

        <div class="panel-section" style="margin-top:auto;">
          <div class="section-title">Shortcuts</div>
          <div style="display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--text-dim);">
            <div><kbd style="background:var(--bg-elevated); padding:1px 4px; border-radius:3px;">P</kbd> Add prompt node</div>
            <div><kbd style="background:var(--bg-elevated); padding:1px 4px; border-radius:3px;">E</kbd> Add outcome node</div>
            <div><kbd style="background:var(--bg-elevated); padding:1px 4px; border-radius:3px;">F</kbd> Fit view to screen</div>
            <div><kbd style="background:var(--bg-elevated); padding:1px 4px; border-radius:3px;">C</kbd> Toggle console</div>
            <div><kbd style="background:var(--bg-elevated); padding:1px 4px; border-radius:3px;">Del</kbd> Delete selected</div>
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // Node Inspector
  // =========================================================================
  showNode(nodeId) {
    this.currentNodeId = nodeId;
    this.currentEdge = null;
    const node = this.flow?.nodes?.[nodeId];
    if (!node) return this.showEmpty();

    const isStart = this.flow.startId === node.id;
    const isEnd = node.type === 'end';
    const isCode = node.type === 'code';

    this.titleEl.textContent = `${isEnd ? 'Outcome Node' : isCode ? 'Code Node' : 'Prompt Node'}: ${nodeLabel(node)}`;

    const allNodeOptions = Object.values(this.flow.nodes)
      .map((n) => `<option value="${n.id}">${escapeHtml(nodeLabel(n))}</option>`)
      .join('');

    this.container.innerHTML = `
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="nodeTitle" value="${escapeAttr(node.title || '')}" placeholder="Short descriptive label" />
      </div>

      ${isCode ? `
      <!-- Code Script Input -->
      <div class="form-group">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <label>JavaScript Script</label>
          <button class="btn btn-xs btn-outline" id="btnTestCode" type="button">▶ Test Run</button>
        </div>
        <textarea id="nodeCode" class="code-textarea" rows="10" spellcheck="false" placeholder="// Access vars, history, lastAnswer&#10;return 'OK';">${escapeHtml(node.code || '')}</textarea>
        <div class="form-hint">Available: <code>vars</code>, <code>history</code>, <code>lastAnswer</code>. Mutate vars or return value.</div>
        <div id="codeTestResult" class="code-test-result" style="display:none"></div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Score Points</label>
          <input type="number" id="nodeScore" value="${node.score ?? 0}" step="1" />
        </div>
        <div class="form-group">
          <label>Timeout (ms)</label>
          <input type="number" id="nodeTimeoutMs" value="${node.timeoutMs ?? 5000}" step="500" min="500" max="60000" />
        </div>
        <div class="form-group">
          <label>Max Attempts</label>
          <input type="number" id="nodeMaxAttempts" value="${node.maxAttempts ?? ''}" placeholder="1" min="1" max="50" />
        </div>
      </div>
      ` : `
      <div class="form-group">
        <label>${isEnd ? 'Outcome Note' : 'Prompt Template'}</label>
        <textarea id="nodePrompt" rows="${isEnd ? 3 : 5}" placeholder="Supports {{variable}}, {{attempt}}, {{budget}}">${escapeHtml(node.prompt || '')}</textarea>
        <div class="form-hint">${isEnd ? 'Text saved with the benchmark run summary.' : 'Variables from regex captures or previous steps can be injected: {{step}}, {{attempt}}, {{$1}}.'}</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Score Points</label>
          <input type="number" id="nodeScore" value="${node.score ?? 0}" step="1" />
        </div>
        ${isEnd ? `
        <div class="form-group">
          <label>Verdict</label>
          <select id="nodeOutcome">
            <option value="pass" ${node.outcome === 'pass' ? 'selected' : ''}>PASS</option>
            <option value="fail" ${node.outcome === 'fail' ? 'selected' : ''}>FAIL</option>
            <option value="neutral" ${node.outcome === 'neutral' ? 'selected' : ''}>NEUTRAL</option>
          </select>
        </div>
        ` : `
        <div class="form-group">
          <label>Max Attempts</label>
          <input type="number" id="nodeMaxAttempts" value="${node.maxAttempts ?? ''}" placeholder="Flow default" min="1" max="50" />
        </div>
        `}
      </div>
      `}

      ${!isEnd && !isCode ? `
      <!-- Context & Memory Policy -->
      <div class="form-group">
        <label>Conversation Memory</label>
        <select id="nodeMemory">
          <option value="" ${node.memory == null ? 'selected' : ''}>(inherit from flow)</option>
          <option value="conversation" ${node.memory === 'conversation' ? 'selected' : ''}>Full branch history</option>
          <option value="window" ${node.memory === 'window' ? 'selected' : ''}>Sliding window</option>
          <option value="isolated" ${node.memory === 'isolated' ? 'selected' : ''}>Isolated (clean slate)</option>
        </select>
        <div class="form-hint">Controls whether previous turns down this branch are visible.</div>
      </div>

      <div class="form-group">
        <label>Failed Attempt Memory</label>
        <select id="nodeRetryMemory">
          <option value="" ${node.retryMemory == null ? 'selected' : ''}>(inherit from flow)</option>
          <option value="keep" ${node.retryMemory === 'keep' ? 'selected' : ''}>Keep (model sees previous wrong answer)</option>
          <option value="drop" ${node.retryMemory === 'drop' ? 'selected' : ''}>Drop (previous attempts wiped on retry)</option>
          <option value="summary" ${node.retryMemory === 'summary' ? 'selected' : ''}>Summary note only</option>
        </select>
      </div>

      <div class="form-group">
        <label class="toggle-label">
          <input type="checkbox" id="nodeResetContext" ${node.resetContextOnEnter ? 'checked' : ''} />
          <span>Reset conversation context upon entering this node</span>
        </label>
      </div>
      ` : ''}

      <!-- Fallback Behaviors -->
      ${!isEnd ? `
      <div class="form-group">
        <label>When No Edge Matches</label>
        <select id="nodeFallback">
          <option value="retry" ${node.fallback === 'retry' ? 'selected' : ''}>Ask again (default retry loop)</option>
          <option value="stop" ${node.fallback === 'stop' ? 'selected' : ''}>Stop flow execution</option>
          <option value="goto" ${node.fallback === 'goto' ? 'selected' : ''}>Jump to another node</option>
        </select>
      </div>

      <div class="form-group" id="fallbackTargetGroup" style="display:${node.fallback === 'goto' ? 'flex' : 'none'}">
        <label>Fallback Target Node</label>
        <select id="nodeFallbackTarget">
          <option value="">-- select node --</option>
          ${allNodeOptions}
        </select>
      </div>

      <div class="form-group">
        <label>When Attempt Budget Exhausted</label>
        <select id="nodeOnExhausted">
          <option value="stop" ${node.onExhausted === 'stop' ? 'selected' : ''}>Stop flow</option>
          <option value="goto" ${node.onExhausted === 'goto' ? 'selected' : ''}>Jump to alternative node</option>
        </select>
      </div>

      <div class="form-group" id="onExhaustedTargetGroup" style="display:${node.onExhausted === 'goto' ? 'flex' : 'none'}">
        <label>Exhausted Target Node</label>
        <select id="nodeOnExhaustedTarget">
          <option value="">-- select node --</option>
          ${allNodeOptions}
        </select>
      </div>

      <!-- Outgoing Edges list -->
      <div class="form-group">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <label>Outgoing Branches (${(node.edges || []).length})</label>
          <button class="btn btn-xs btn-outline" id="btnAddBranch">+ Add Branch</button>
        </div>
        <div class="edges-list" id="nodeEdgesList"></div>
      </div>
      ` : ''}
    `;

    // Render footer action bar in dedicated bottom container
    if (this.footerEl) {
      this.footerEl.style.display = 'block';
      this.footerEl.innerHTML = `
        <div class="form-actions">
          <div class="actions-left">
            ${!isStart ? `<button class="btn btn-sm btn-outline" id="btnMakeStart">★ Make Start</button>` : '<span style="font-size:11px; color:var(--color-primary); font-weight:700; padding:0 4px;">★ Start Node</span>'}
            ${!isEnd ? `<button class="btn btn-sm btn-outline" id="btnResetNodeDefaults" title="Clear node overrides and inherit flow defaults">Reset Overrides</button>` : ''}
          </div>
          <div class="actions-right">
            <button class="btn btn-sm btn-danger" id="btnDeleteNode">Delete Node</button>
          </div>
        </div>
      `;

      const resetNodeBtn = this.footerEl.querySelector('#btnResetNodeDefaults');
      if (resetNodeBtn) {
        resetNodeBtn.addEventListener('click', () => {
          node.memory = null;
          node.retryMemory = null;
          node.maxAttempts = null;
          node.fallback = 'retry';
          node.fallbackTarget = null;
          node.onExhausted = 'stop';
          node.onExhaustedTarget = null;
          node.resetContextOnEnter = false;
          this.onFlowMutated();
          this.showNode(node.id);
        });
      }

      const startBtn = this.footerEl.querySelector('#btnMakeStart');
      if (startBtn) {
        startBtn.addEventListener('click', () => {
          this.flow.startId = node.id;
          this.onFlowMutated();
          this.showNode(node.id);
        });
      }

      this.footerEl.querySelector('#btnDeleteNode')?.addEventListener('click', () => {
        if (!confirm(`Delete node "${nodeLabel(node)}"?`)) return;
        delete this.flow.nodes[node.id];
        for (const n of Object.values(this.flow.nodes)) {
          n.edges = (n.edges || []).filter((e) => e.to !== node.id);
          if (n.fallbackTarget === node.id) n.fallbackTarget = null;
          if (n.onExhaustedTarget === node.id) n.onExhaustedTarget = null;
        }
        if (this.flow.startId === node.id) {
          this.flow.startId = Object.keys(this.flow.nodes)[0] || null;
        }
        this.onFlowMutated();
        this.showEmpty();
      });
    }

    // Bind inputs
    const titleInput = this.container.querySelector('#nodeTitle');
    titleInput.addEventListener('input', () => { node.title = titleInput.value; this.onFlowMutated(); });

    const promptInput = this.container.querySelector('#nodePrompt');
    if (promptInput) {
      promptInput.addEventListener('input', () => { node.prompt = promptInput.value; this.onFlowMutated(); });
    }

    const codeInput = this.container.querySelector('#nodeCode');
    if (codeInput) {
      codeInput.addEventListener('input', () => { node.code = codeInput.value; this.onFlowMutated(); });
    }

    const timeoutInput = this.container.querySelector('#nodeTimeoutMs');
    if (timeoutInput) {
      timeoutInput.addEventListener('input', () => { node.timeoutMs = Number(timeoutInput.value) || 5000; this.onFlowMutated(); });
    }

    const btnTestCode = this.container.querySelector('#btnTestCode');
    const codeResultEl = this.container.querySelector('#codeTestResult');
    if (btnTestCode && codeResultEl) {
      btnTestCode.addEventListener('click', () => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('context', 'vars', 'history', 'lastAnswer', `
            "use strict";
            const { input, step, node } = context;
            ${node.code}
          `);
          const testVars = { sampleVar: 'testValue', attempt: 1 };
          const ctx = { input: 'Sample test input', vars: testVars, history: [], lastAnswer: 'Sample test input', node };
          const res = fn(ctx, testVars, [], 'Sample test input');
          const str = typeof res === 'object' && res !== null ? JSON.stringify(res, null, 2) : String(res ?? '');
          codeResultEl.style.display = 'block';
          codeResultEl.className = 'code-test-result ok';
          codeResultEl.textContent = `✓ Returned: ${str}`;
        } catch (err) {
          codeResultEl.style.display = 'block';
          codeResultEl.className = 'code-test-result err';
          codeResultEl.textContent = `✕ Syntax / Runtime Error: ${err.message}`;
        }
      });
    }

    const scoreInput = this.container.querySelector('#nodeScore');
    scoreInput.addEventListener('input', () => { node.score = Number(scoreInput.value) || 0; this.onFlowMutated(); });

    if (isEnd) {
      const outcomeSelect = this.container.querySelector('#nodeOutcome');
      outcomeSelect?.addEventListener('change', () => { node.outcome = outcomeSelect.value; this.onFlowMutated(); });
    } else {
      const maxAttInput = this.container.querySelector('#nodeMaxAttempts');
      maxAttInput?.addEventListener('input', () => {
        node.maxAttempts = maxAttInput.value ? Number(maxAttInput.value) : null;
        this.onFlowMutated();
      });

      const memSelect = this.container.querySelector('#nodeMemory');
      memSelect?.addEventListener('change', () => { node.memory = memSelect.value || null; this.onFlowMutated(); });

      const retryMemSelect = this.container.querySelector('#nodeRetryMemory');
      retryMemSelect?.addEventListener('change', () => { node.retryMemory = retryMemSelect.value || null; this.onFlowMutated(); });

      const resetCheck = this.container.querySelector('#nodeResetContext');
      resetCheck?.addEventListener('change', () => { node.resetContextOnEnter = resetCheck.checked; this.onFlowMutated(); });

      const fallbackSelect = this.container.querySelector('#nodeFallback');
      const fallbackTargetGroup = this.container.querySelector('#fallbackTargetGroup');
      const fallbackTargetSelect = this.container.querySelector('#nodeFallbackTarget');
      if (node.fallbackTarget && fallbackTargetSelect) fallbackTargetSelect.value = node.fallbackTarget;

      fallbackSelect?.addEventListener('change', () => {
        node.fallback = fallbackSelect.value;
        if (fallbackTargetGroup) fallbackTargetGroup.style.display = node.fallback === 'goto' ? 'flex' : 'none';
        this.onFlowMutated();
      });
      fallbackTargetSelect?.addEventListener('change', () => {
        node.fallbackTarget = fallbackTargetSelect.value || null;
        this.onFlowMutated();
      });

      const exhSelect = this.container.querySelector('#nodeOnExhausted');
      const exhTargetGroup = this.container.querySelector('#onExhaustedTargetGroup');
      const exhTargetSelect = this.container.querySelector('#nodeOnExhaustedTarget');
      if (node.onExhaustedTarget && exhTargetSelect) exhTargetSelect.value = node.onExhaustedTarget;

      exhSelect?.addEventListener('change', () => {
        node.onExhausted = exhSelect.value;
        if (exhTargetGroup) exhTargetGroup.style.display = node.onExhausted === 'goto' ? 'flex' : 'none';
        this.onFlowMutated();
      });
      exhTargetSelect?.addEventListener('change', () => {
        node.onExhaustedTarget = exhTargetSelect.value || null;
        this.onFlowMutated();
      });

      this.container.querySelector('#btnAddBranch')?.addEventListener('click', () => {
        const otherNodes = Object.keys(this.flow.nodes).filter((id) => id !== node.id);
        const to = otherNodes[0] || null;
        const e = createEdge({ to, label: 'new branch', condition: { type: 'contains', value: '' } });
        node.edges = node.edges || [];
        node.edges.push(e);
        this.onFlowMutated();
        this.showNode(node.id);
      });

      this.#renderNodeEdgesList(node);
    }
  }

  #renderNodeEdgesList(node) {
    const listEl = this.container.querySelector('#nodeEdgesList');
    if (!listEl) return;
    listEl.innerHTML = '';

    (node.edges || []).forEach((edge, idx) => {
      const targetNode = this.flow.nodes[edge.to];
      const card = document.createElement('div');
      card.className = 'edge-item-card';
      card.innerHTML = `
        <div class="edge-item-header">
          <span class="edge-item-target">-> ${escapeHtml(nodeLabel(targetNode) || '(no target)')}</span>
          <div style="display:flex; gap:4px;">
            <button class="btn btn-xs btn-ghost btn-edit-edge" title="Edit branch condition">✎</button>
            <button class="btn btn-xs btn-ghost btn-del-edge" title="Delete branch">✕</button>
          </div>
        </div>
        <div style="font-size:11px; color:var(--text-dim);">${escapeHtml(edge.label || edge.condition?.type || 'always')}</div>
      `;
      card.querySelector('.btn-edit-edge').addEventListener('click', () => this.showEdge(edge.id, node.id));
      card.querySelector('.btn-del-edge').addEventListener('click', () => {
        node.edges.splice(idx, 1);
        this.onFlowMutated();
        this.showNode(node.id);
      });
      listEl.appendChild(card);
    });
  }

  // =========================================================================
  // Edge Inspector
  // =========================================================================
  showEdge(edgeId, fromNodeId) {
    this.currentEdge = { edgeId, fromNodeId };
    this.currentNodeId = null;

    const fromNode = this.flow?.nodes?.[fromNodeId];
    const edge = fromNode?.edges?.find((e) => e.id === edgeId);
    if (!edge) return this.showEmpty();

    this.titleEl.textContent = `Branch: ${edge.label || 'Condition'}`;

    const allNodeOptions = Object.values(this.flow.nodes)
      .map((n) => `<option value="${n.id}" ${n.id === edge.to ? 'selected' : ''}>${escapeHtml(nodeLabel(n))}</option>`)
      .join('');

    const condTypes = CONDITION_TYPES.map((ct) =>
      `<option value="${ct.id}" ${edge.condition?.type === ct.id ? 'selected' : ''}>${ct.label}</option>`
    ).join('');

    this.container.innerHTML = `
      <div class="form-group">
        <label>Target Node</label>
        <select id="edgeTarget">${allNodeOptions}</select>
      </div>

      <div class="form-group">
        <label>Branch Label</label>
        <input type="text" id="edgeLabel" value="${escapeAttr(edge.label || '')}" placeholder="Short caption on edge" />
      </div>

      <div class="form-group">
        <label>Condition Type</label>
        <select id="condType">${condTypes}</select>
        <div class="form-hint" id="condHint"></div>
      </div>

      <div id="condDynamicFields"></div>

      <div class="form-group">
        <label class="toggle-label">
          <input type="checkbox" id="condNegate" ${edge.condition?.negate ? 'checked' : ''} />
          <span>Invert condition (NOT / negate)</span>
        </label>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Score Points</label>
          <input type="number" id="edgeScore" value="${edge.score ?? 0}" step="1" />
        </div>
      </div>

      <div class="form-group">
        <label>Prompt Injection on Traversal</label>
        <textarea id="edgeInject" rows="2" placeholder="Text prepended to next prompt...">${escapeHtml(edge.inject || '')}</textarea>
        <div class="form-hint">E.g. "You were wrong because...", prepended only when this path is taken.</div>
      </div>

      <div class="form-group">
        <label class="toggle-label">
          <input type="checkbox" id="edgeResetAttempts" ${edge.resetAttempts !== false ? 'checked' : ''} />
          <span>Reset attempt counter of current node when entering target</span>
        </label>
      </div>

      <div class="form-group">
        <label class="toggle-label">
          <input type="checkbox" id="edgeResetContext" ${edge.resetContext ? 'checked' : ''} />
          <span>Wipe conversation history when taking this branch</span>
        </label>
      </div>
    `;

    // Render edge action footer
    if (this.footerEl) {
      this.footerEl.style.display = 'block';
      this.footerEl.innerHTML = `
        <div class="form-actions">
          <div class="actions-left">
            <button class="btn btn-sm btn-outline" id="btnBackToNode">← Back to Node</button>
          </div>
          <div class="actions-right">
            <button class="btn btn-sm btn-danger" id="btnDeleteEdge">Delete Branch</button>
          </div>
        </div>
      `;

      this.footerEl.querySelector('#btnBackToNode')?.addEventListener('click', () => this.showNode(fromNodeId));

      this.footerEl.querySelector('#btnDeleteEdge')?.addEventListener('click', () => {
        fromNode.edges = fromNode.edges.filter((e) => e.id !== edgeId);
        this.onFlowMutated();
        this.showNode(fromNodeId);
      });
    }

    // Bindings
    const targetSelect = this.container.querySelector('#edgeTarget');
    targetSelect.addEventListener('change', () => { edge.to = targetSelect.value; this.onFlowMutated(); });

    const labelInput = this.container.querySelector('#edgeLabel');
    labelInput.addEventListener('input', () => { edge.label = labelInput.value; this.onFlowMutated(); });

    const condTypeSelect = this.container.querySelector('#condType');
    condTypeSelect.addEventListener('change', () => {
      edge.condition = edge.condition || {};
      edge.condition.type = condTypeSelect.value;
      this.#renderCondDynamicFields(edge);
      this.onFlowMutated();
    });

    const negateCheck = this.container.querySelector('#condNegate');
    negateCheck.addEventListener('change', () => { edge.condition.negate = negateCheck.checked; this.onFlowMutated(); });

    const scoreInput = this.container.querySelector('#edgeScore');
    scoreInput.addEventListener('input', () => { edge.score = Number(scoreInput.value) || 0; this.onFlowMutated(); });

    const injectArea = this.container.querySelector('#edgeInject');
    injectArea.addEventListener('input', () => { edge.inject = injectArea.value; this.onFlowMutated(); });

    const resetAttemptsCheck = this.container.querySelector('#edgeResetAttempts');
    resetAttemptsCheck.addEventListener('change', () => { edge.resetAttempts = resetAttemptsCheck.checked; this.onFlowMutated(); });

    const resetContextCheck = this.container.querySelector('#edgeResetContext');
    resetContextCheck.addEventListener('change', () => { edge.resetContext = resetContextCheck.checked; this.onFlowMutated(); });

    this.#renderCondDynamicFields(edge);
  }

  #renderCondDynamicFields(edge) {
    const type = edge.condition?.type || 'always';
    const c = edge.condition;
    const meta = CONDITION_TYPES.find((ct) => ct.id === type);
    const container = this.container.querySelector('#condDynamicFields');
    const hintEl = this.container.querySelector('#condHint');
    if (hintEl) hintEl.textContent = meta?.hint || '';
    if (!container) return;

    let html = '';

    if (['contains', 'word', 'equals', 'startsWith', 'endsWith', 'regex'].includes(type)) {
      html += `
        <div class="form-group">
          <label>${type === 'regex' ? 'Regex Pattern' : 'Match String'}</label>
          <input type="text" id="cValue" value="${escapeAttr(c.value || '')}" placeholder="${type === 'regex' ? 'e.g. \\\\b(apple|banana)\\\\b' : 'target text'}" />
        </div>
      `;
      if (type === 'regex') {
        html += `
          <div class="form-group">
            <label>Regex Flags</label>
            <input type="text" id="cFlags" value="${escapeAttr(c.flags || 'i')}" placeholder="i, m, s" />
          </div>
        `;
      } else {
        html += `
          <div class="form-group">
            <label class="toggle-label">
              <input type="checkbox" id="cCase" ${c.caseSensitive ? 'checked' : ''} />
              <span>Case-sensitive</span>
            </label>
          </div>
        `;
      }
    } else if (type === 'numeric') {
      const ops = NUMERIC_OPS.map((o) => `<option value="${o.id}" ${c.op === o.id ? 'selected' : ''}>${o.label}</option>`).join('');
      const which = NUMERIC_WHICH.map((w) => `<option value="${w.id}" ${(c.which || 'any') === w.id ? 'selected' : ''}>${w.label}</option>`).join('');
      html += `
        <div class="form-group">
          <label>Comparison</label>
          <select id="cNumOp">${ops}</select>
        </div>
        <div class="form-row" id="numBetweenRow" style="display:${c.op === 'between' ? 'flex' : 'none'}">
          <div class="form-group">
            <label>Min</label>
            <input type="number" id="cNumMin" value="${c.min ?? 0}" step="any" />
          </div>
          <div class="form-group">
            <label>Max</label>
            <input type="number" id="cNumMax" value="${c.max ?? 10}" step="any" />
          </div>
        </div>
        <div class="form-group" id="numValRow" style="display:${c.op === 'between' ? 'none' : 'flex'}">
          <label>Target Value</label>
          <input type="number" id="cValue" value="${c.value ?? 0}" step="any" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Tolerance (+/-)</label>
            <input type="number" id="cNumTol" value="${c.tolerance ?? 0}" step="any" placeholder="0" />
          </div>
          <div class="form-group">
            <label>Apply To</label>
            <select id="cNumWhich">${which}</select>
          </div>
        </div>
      `;
    } else if (['anyOf', 'allOf'].includes(type)) {
      const lines = Array.isArray(c.values) ? c.values.join('\n') : (c.value || '');
      html += `
        <div class="form-group">
          <label>Match Items (one per line)</label>
          <textarea id="cValuesArea" rows="4">${escapeHtml(lines)}</textarea>
        </div>
        <div class="form-group">
          <label class="toggle-label">
            <input type="checkbox" id="cCase" ${c.caseSensitive ? 'checked' : ''} />
            <span>Case-sensitive</span>
          </label>
        </div>
      `;
    } else if (type === 'length') {
      html += `
        <div class="form-row">
          <div class="form-group">
            <label>Min Characters</label>
            <input type="number" id="cLenMin" value="${c.min ?? ''}" placeholder="0" />
          </div>
          <div class="form-group">
            <label>Max Characters</label>
            <input type="number" id="cLenMax" value="${c.max ?? ''}" placeholder="unbounded" />
          </div>
        </div>
      `;
    } else if (type === 'json') {
      html += `
        <div class="form-group">
          <label>JSON Path</label>
          <input type="text" id="cJsonPath" value="${escapeAttr(c.path || '')}" placeholder="e.g. data.items[0].id" />
        </div>
        <div class="form-group">
          <label>Expected Value (optional)</label>
          <input type="text" id="cValue" value="${escapeAttr(c.value ?? '')}" placeholder="Leave empty to just check presence" />
        </div>
      `;
    } else if (type === 'expr') {
      html += `
        <div class="form-group">
          <label>JavaScript Expression</label>
          <textarea id="cValue" rows="3" placeholder="numbers[0] === 42 && vars.foo === 'bar'">${escapeHtml(c.value || '')}</textarea>
          <div class="form-hint">Available: <code>text</code>, <code>numbers</code> (array), <code>vars</code> (captured variables).</div>
        </div>
      `;
    }

    container.innerHTML = html;

    // Hook dynamic inputs
    const valInput = container.querySelector('#cValue');
    if (valInput) valInput.addEventListener('input', () => { c.value = valInput.value; this.onFlowMutated(); });

    const flagsInput = container.querySelector('#cFlags');
    if (flagsInput) flagsInput.addEventListener('input', () => { c.flags = flagsInput.value; this.onFlowMutated(); });

    // Live regex syntax validation
    if (type === 'regex' && valInput) {
      const validateRegex = () => {
        const val = valInput.value.trim();
        const fl = flagsInput ? flagsInput.value.trim() : 'i';
        let hint = container.querySelector('#regexErrorHint');
        if (!hint) {
          hint = document.createElement('div');
          hint.id = 'regexErrorHint';
          hint.className = 'form-hint';
          hint.style.marginTop = '4px';
          valInput.parentNode.appendChild(hint);
        }
        if (!val) {
          hint.textContent = '';
          valInput.style.borderColor = '';
          return;
        }
        try {
          new RegExp(val, fl);
          hint.textContent = '✓ Valid regular expression';
          hint.style.color = 'var(--color-success)';
          valInput.style.borderColor = 'var(--color-success)';
        } catch (err) {
          hint.textContent = `✗ ${err.message}`;
          hint.style.color = 'var(--color-danger)';
          valInput.style.borderColor = 'var(--color-danger)';
        }
      };
      valInput.addEventListener('input', validateRegex);
      if (flagsInput) flagsInput.addEventListener('input', validateRegex);
      validateRegex();
    }

    const caseCheck = container.querySelector('#cCase');
    if (caseCheck) caseCheck.addEventListener('change', () => { c.caseSensitive = caseCheck.checked; this.onFlowMutated(); });

    const numOp = container.querySelector('#cNumOp');
    if (numOp) {
      numOp.addEventListener('change', () => {
        c.op = numOp.value;
        const between = c.op === 'between';
        container.querySelector('#numBetweenRow').style.display = between ? 'flex' : 'none';
        container.querySelector('#numValRow').style.display = between ? 'none' : 'flex';
        this.onFlowMutated();
      });
    }

    const numMin = container.querySelector('#cNumMin');
    if (numMin) numMin.addEventListener('input', () => { c.min = Number(numMin.value); this.onFlowMutated(); });
    const numMax = container.querySelector('#cNumMax');
    if (numMax) numMax.addEventListener('input', () => { c.max = Number(numMax.value); this.onFlowMutated(); });
    const numTol = container.querySelector('#cNumTol');
    if (numTol) numTol.addEventListener('input', () => { c.tolerance = Number(numTol.value); this.onFlowMutated(); });
    const numWhich = container.querySelector('#cNumWhich');
    if (numWhich) numWhich.addEventListener('change', () => { c.which = numWhich.value; this.onFlowMutated(); });

    const valuesArea = container.querySelector('#cValuesArea');
    if (valuesArea) valuesArea.addEventListener('input', () => {
      c.values = valuesArea.value.split('\n').map((s) => s.trim()).filter(Boolean);
      this.onFlowMutated();
    });

    const lenMin = container.querySelector('#cLenMin');
    if (lenMin) lenMin.addEventListener('input', () => { c.min = lenMin.value ? Number(lenMin.value) : null; this.onFlowMutated(); });
    const lenMax = container.querySelector('#cLenMax');
    if (lenMax) lenMax.addEventListener('input', () => { c.max = lenMax.value ? Number(lenMax.value) : null; this.onFlowMutated(); });

    const jsonPath = container.querySelector('#cJsonPath');
    if (jsonPath) jsonPath.addEventListener('input', () => { c.path = jsonPath.value; this.onFlowMutated(); });
  }

  // =========================================================================
  // Flow-wide Settings Modal View
  // =========================================================================
  renderFlowSettingsModal() {
    const s = this.flow?.settings || {};
    const norm = s.normalize || {};
    const tc = s.trialCounter || {};
    const cb = s.cacheBuster || {};

    return `
      <div class="modal-header">
        <h3>Flow Settings & Engine Policies</h3>
        <button class="btn btn-xs btn-ghost" id="modalClose">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Global System Prompt</label>
          <textarea id="setSysPrompt" rows="3" placeholder="Applies to all nodes unless overridden">${escapeHtml(s.systemPrompt || '')}</textarea>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Default Context Memory</label>
            <select id="setMemory">
              <option value="conversation" ${s.memory === 'conversation' ? 'selected' : ''}>Conversation (full branch history)</option>
              <option value="window" ${s.memory === 'window' ? 'selected' : ''}>Sliding Window</option>
              <option value="isolated" ${s.memory === 'isolated' ? 'selected' : ''}>Isolated (clean per question)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Window Turns</label>
            <input type="number" id="setTurns" value="${s.historyTurns ?? 4}" min="1" max="50" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Failed Attempt Memory Policy</label>
            <select id="setRetryMemory">
              <option value="keep" ${s.retryMemory === 'keep' ? 'selected' : ''}>Keep (model sees its failed answers)</option>
              <option value="drop" ${s.retryMemory === 'drop' ? 'selected' : ''}>Drop (failed attempts wiped on retry)</option>
              <option value="summary" ${s.retryMemory === 'summary' ? 'selected' : ''}>Summary note only</option>
            </select>
          </div>
          <div class="form-group">
            <label>Default Max Attempts</label>
            <input type="number" id="setDefaultAttempts" value="${s.defaultMaxAttempts ?? 5}" min="1" max="50" />
          </div>
        </div>

        <div class="form-sep" style="height:1px; background:var(--border);"></div>

        <!-- Trial Counter -->
        <div class="form-group">
          <label class="toggle-label">
            <input type="checkbox" id="setTrialEnabled" ${tc.enabled ? 'checked' : ''} />
            <strong>Show Trial Counter to Model (e.g. [Attempt 2/5])</strong>
          </label>
        </div>
        <div class="form-row" id="trialDetailsRow" style="display:${tc.enabled ? 'flex' : 'none'}">
          <div class="form-group" style="flex:2;">
            <label>Counter Template</label>
            <input type="text" id="setTrialTemplate" value="${escapeAttr(tc.template || '[Attempt {{attempt}}/{{budget}}]')}" />
          </div>
          <div class="form-group">
            <label>Position</label>
            <select id="setTrialPos">
              <option value="prefix" ${tc.position === 'prefix' ? 'selected' : ''}>Prefix (above prompt)</option>
              <option value="suffix" ${tc.position === 'suffix' ? 'selected' : ''}>Suffix (below prompt)</option>
              <option value="system" ${tc.position === 'system' ? 'selected' : ''}>Inside system prompt</option>
            </select>
          </div>
        </div>

        <!-- Cache Buster -->
        <div class="form-group">
          <label class="toggle-label">
            <input type="checkbox" id="setCacheBuster" ${cb.enabled ? 'checked' : ''} />
            <strong>Gateway Cache Buster (prevents frozen retry loops)</strong>
          </label>
          <div class="form-hint">Injects a per-attempt nonce into the request so reverse proxies (e.g. Omniroute) do not return the identical cached answer.</div>
        </div>

        <div class="form-sep" style="height:1px; background:var(--border);"></div>

        <!-- Normalization -->
        <label style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-dim);">Answer Normalization</label>
        <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:6px;">
          <label class="toggle-label"><input type="checkbox" id="normThinking" ${norm.thinking ? 'checked' : ''} /> <span>Strip &lt;think&gt; tags</span></label>
          <label class="toggle-label"><input type="checkbox" id="normLower" ${norm.lower ? 'checked' : ''} /> <span>Case-insensitive</span></label>
          <label class="toggle-label"><input type="checkbox" id="normMarkdown" ${norm.markdown ? 'checked' : ''} /> <span>Strip markdown formatting</span></label>
          <label class="toggle-label"><input type="checkbox" id="normTrim" ${norm.trim ? 'checked' : ''} /> <span>Trim whitespace</span></label>
        </div>

        <div class="form-sep" style="height:1px; background:var(--border);"></div>

        <!-- Budgets -->
        <div class="form-row">
          <div class="form-group">
            <label>Max Total Steps</label>
            <input type="number" id="setMaxSteps" value="${s.maxSteps ?? 40}" min="1" max="200" />
          </div>
          <div class="form-group">
            <label>Sampling Temperature</label>
            <input type="number" id="setTemp" value="${s.params?.temperature ?? 0.2}" step="0.1" min="0" max="2" />
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="btnResetSettingsDefaults" style="margin-right:auto;" title="Restore benchmark recommended default values">Reset to Defaults</button>
        <button class="btn btn-primary" id="btnSaveFlowSettings">Save Settings</button>
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}
