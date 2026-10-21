/**
 * app.js — main application entrypoint and orchestrator.
 * Wires GraphView, InspectorView, ConsoleView, LLMClient, and storage.
 */

import { LLMClient } from '../core/client.js';
import { runFlow, runBatch, validateFlow, createFlow, createNode, createEdge, summarize } from '../core/engine.js';
import { GraphView } from './graph.js';
import { InspectorView } from './inspector.js';
import { ConsoleView } from './console-view.js';
import { getTemplates } from './templates.js';
import {
  listSavedFlows,
  getSavedFlow,
  saveFlow,
  deleteSavedFlow,
  duplicateSavedFlow,
  getCurrentSavedFlow,
  initStorageWithTemplates,
} from './flow-storage.js';

class App {
  constructor() {
    this.flow = null;
    this.dirty = false;
    this.activeRunController = null;

    this.templates = getTemplates();

    // DOM Elements
    this.flowNameInput = document.getElementById('flowNameInput');
    this.flowDirtyDot = document.getElementById('flowDirtyDot');
    this.apiBaseUrl = document.getElementById('apiBaseUrl');
    this.apiKey = document.getElementById('apiKey');
    this.modelInput = document.getElementById('modelInput');
    this.modelsDataList = document.getElementById('modelsDataList');

    this.btnRun = document.getElementById('btnRun');
    this.btnStop = document.getElementById('btnStop');

    this.modalBackdrop = document.getElementById('modalBackdrop');
    this.modalCard = document.getElementById('modalCard');

    // Initialize sub-views
    this.console = new ConsoleView({
      drawer: document.getElementById('consoleDrawer'),
      feed: document.getElementById('consoleFeed'),
      statusText: document.getElementById('runStatusText'),
      stats: document.getElementById('consoleStats'),
      pulseDot: document.getElementById('runPulseDot'),
      pathChips: document.getElementById('pathChips'),
      varsPre: document.getElementById('varsPre'),
      metRequests: document.getElementById('metRequests'),
      metTokens: document.getElementById('metTokens'),
      metScore: document.getElementById('metScore'),
      metDuration: document.getElementById('metDuration'),
    });

    this.inspector = new InspectorView(
      document.getElementById('inspectorBody'),
      document.getElementById('inspectorTitle'),
      document.getElementById('inspectorFooter'),
      () => this.onFlowMutated(),
      (id) => this.graph.selectNode(id)
    );

    this.graph = new GraphView({
      container: document.getElementById('canvasContainer'),
      svg: document.getElementById('canvasSvg'),
      edgesLayer: document.getElementById('edgesLayer'),
      nodesLayer: document.getElementById('nodesLayer'),
      draftEdge: document.getElementById('draftEdge'),
      emptyHint: document.getElementById('emptyHint'),
      hudZoom: document.getElementById('hudZoom'),
      hudNodeCount: document.getElementById('hudNodeCount'),
      hudEdgeCount: document.getElementById('hudEdgeCount'),
      onSelectNode: (id) => {
        this.openInspector();
        this.inspector.showNode(id);
      },
      onSelectEdge: (eid, fromId) => {
        this.openInspector();
        this.inspector.showEdge(eid, fromId);
      },
      onClearSelection: () => {
        this.inspector.showEmpty();
      },
      onCreateEdge: (fromId, toId) => this.createEdge(fromId, toId),
      onFlowMutated: () => this.onFlowMutated(),
    });

    this.#initEvents();
    this.#initConsoleResize();
    this.#loadInitialFlow();
    this.#checkServerConfig();
  }

  duplicateSelectedNode() {
    if (!this.graph.selectedNodeId) return;
    const orig = this.flow.nodes[this.graph.selectedNodeId];
    if (!orig) return;

    const newId = `node_${Date.now().toString(36)}`;
    const copy = JSON.parse(JSON.stringify(orig));
    copy.id = newId;
    copy.title = `${orig.title || 'Node'} (copy)`;
    copy.ui = {
      x: (orig.ui?.x ?? 100) + 40,
      y: (orig.ui?.y ?? 100) + 40,
    };
    // Re-generate edge IDs to avoid duplicate IDs
    copy.edges = (copy.edges || []).map((e) => ({
      ...e,
      id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    }));

    this.flow.nodes[newId] = copy;
    this.onFlowMutated();
    this.graph.selectNode(newId);
  }

  #initConsoleResize() {
    const drawer = document.getElementById('consoleDrawer');
    const handle = document.getElementById('consoleHandle');
    let isResizing = false;
    let startY = 0;
    let startH = 0;

    handle.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('button')) return;
      isResizing = true;
      startY = e.clientY;
      startH = drawer.offsetHeight;
      drawer.style.transition = 'none'; // remove transition during drag
      document.body.style.cursor = 'ns-resize';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const dy = startY - e.clientY;
      const maxH = window.innerHeight * 0.82;
      const minH = 42;
      const newH = Math.max(minH, Math.min(maxH, startH + dy));
      drawer.style.height = `${newH}px`;
      drawer.classList.toggle('collapsed', newH <= 50);
    });

    window.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      drawer.style.transition = '';
      document.body.style.cursor = '';
    });
  }

  openInspector() {
    document.getElementById('inspector').classList.remove('collapsed');
  }

  toggleInspector() {
    document.getElementById('inspector').classList.toggle('collapsed');
  }

  // =========================================================================
  // Initialization & Flow Loading
  // =========================================================================
  #loadInitialFlow() {
    initStorageWithTemplates(this.templates);
    const saved = getCurrentSavedFlow();
    if (saved) {
      try {
        this.setFlow(saved, false);
        return;
      } catch { /* fallback to template */ }
    }
    // Default to Arithmetic Ladder
    const fallbackTpl = this.templates.find((t) => t.id === 'tpl_arithmetic') || this.templates[0];
    this.setFlow(fallbackTpl, false);
  }

  setFlow(flow, markDirty = true) {
    this.flow = flow;
    this.flowNameInput.value = flow.name || 'Untitled Flow';
    this.graph.setFlow(flow);
    this.inspector.setFlow(flow);
    this.inspector.showEmpty();
    this.setDirty(markDirty);
    setTimeout(() => this.graph.fitView(), 50);
  }

  onFlowMutated() {
    this.graph.render();
    this.setDirty(true);
  }

  setDirty(dirty) {
    this.dirty = dirty;
    this.flowDirtyDot.classList.toggle('dirty', dirty);
    const statusText = document.getElementById('saveStatusText');
    if (this.flow) {
      saveFlow(this.flow, true);
      if (statusText) {
        statusText.textContent = dirty ? 'Saving...' : 'Saved';
        setTimeout(() => {
          if (statusText) statusText.textContent = 'Saved';
          this.flowDirtyDot.classList.remove('dirty');
        }, 300);
      }
    }
  }

  async #checkServerConfig() {
    this.hasProxyServer = false;
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        this.hasProxyServer = true;
        const data = await res.json();
        if (data.serverBaseUrl && !this.apiBaseUrl.value) this.apiBaseUrl.value = data.serverBaseUrl;
      }
    } catch {
      this.hasProxyServer = false;
    }
  }

  // =========================================================================
  // Flow Actions
  // =========================================================================
  addNode(type = 'prompt') {
    const id = `node_${Date.now().toString(36)}`;
    const rect = document.getElementById('canvasContainer').getBoundingClientRect();
    const center = this.graph.clientToGraph(rect.left + rect.width / 2, rect.top + rect.height / 2);

    const isEnd = type === 'end';
    const isCode = type === 'code';
    const node = createNode({
      id,
      type,
      title: isEnd ? 'Outcome' : isCode ? 'Code Script' : 'New Question',
      prompt: isEnd ? 'Terminal outcome note.' : isCode ? '' : 'Ask a question here...',
      code: isCode ? '// JavaScript script with access to vars, history, lastAnswer\n// Return a string or mutate vars\nreturn "VALID";' : undefined,
      outcome: isEnd ? 'pass' : null,
      maxAttempts: isEnd ? null : isCode ? 1 : 3,
      ui: { x: Math.round(center.x - 130), y: Math.round(center.y - 50) },
    });

    this.flow.nodes[id] = node;
    if (!this.flow.startId) this.flow.startId = id;
    this.onFlowMutated();
    this.graph.selectNode(id);
  }

  createEdge(fromId, toId) {
    const from = this.flow.nodes[fromId];
    if (!from) return;
    from.edges = from.edges || [];
    // prevent exact duplicate
    if (from.edges.some((e) => e.to === toId)) return;

    const edge = createEdge({
      to: toId,
      label: 'branch',
      condition: { type: 'contains', value: '' },
    });
    from.edges.push(edge);
    this.onFlowMutated();
    this.graph.selectEdge(edge.id, fromId);
  }

  // =========================================================================
  // Benchmark Execution
  // =========================================================================
  async runCurrentFlow() {
    if (!this.flow) return;

    // Pre-flight validation
    const v = validateFlow(this.flow);
    if (!v.ok) {
      alert(`Cannot run flow:\n- ${v.errors.join('\n- ')}`);
      return;
    }
    if (v.hasExpr && !this.flow.settings?.allowExpr) {
      const ok = confirm('This flow contains custom JavaScript expressions (expr conditions). Allow them to execute?');
      if (!ok) return;
    }

    const baseUrl = this.apiBaseUrl.value.trim();
    const apiKey = this.apiKey.value.trim();
    const model = this.modelInput.value.trim();

    if (!baseUrl) { alert('Please enter an OpenAI-compatible API base URL.'); return; }
    if (!model) { alert('Please enter a model name (e.g. agy/gemini-3.1-flash-lite).'); return; }

    const client = new LLMClient({
      baseUrl,
      apiKey,
      model,
      proxy: this.hasProxyServer ? '/api/llm' : null,
      timeoutMs: 120000,
    });

    let stopped = false;
    this.activeRunController = { stop: () => { stopped = true; } };

    this.btnRun.style.display = 'none';
    this.btnStop.style.display = 'inline-flex';

    this.console.startRun('run', model, this.flow.name);

    try {
      const run = await runFlow(this.flow, client, {
        allowExpr: true,
        shouldStop: () => stopped,
        onEvent: (ev) => {
          if (ev.type === 'step:prompt') {
            this.graph.setActiveRunState(ev.nodeId, null);
          } else if (ev.type === 'step:done') {
            this.console.addStep(ev.step);
            this.graph.setActiveRunState(ev.step.nodeId, ev.edgeId || null);
          } else if (ev.type === 'node:end') {
            this.graph.setActiveRunState(ev.nodeId, null);
          }
        },
      });

      this.console.updateVars(run.vars || {});
      this.console.endRun(run);
    } catch (err) {
      alert(`Run failed: ${err.message}`);
    } finally {
      this.btnRun.style.display = 'inline-flex';
      this.btnStop.style.display = 'none';
      this.activeRunController = null;
      setTimeout(() => this.graph.setActiveRunState(null, null), 1000);
    }
  }

  stopCurrentRun() {
    this.activeRunController?.stop();
  }

  // =========================================================================
  // Batch Benchmark Modal
  // =========================================================================
  showBatchModal() {
    this.modalBackdrop.style.display = 'grid';
    this.modalCard.innerHTML = `
      <div class="modal-header">
        <h3>Batch Benchmark Runner</h3>
        <button class="btn btn-xs btn-ghost" id="batchClose">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Models to Compare (one per line)</label>
          <textarea id="batchModels" rows="4" placeholder="agy/gemini-3.1-flash-lite\ngemini/gemini-3.1-flash-lite">${escapeHtml(this.modelInput.value)}</textarea>
          <div class="form-hint">Each model will be evaluated over N identical repetitions against this flow.</div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Repeats per Model</label>
            <input type="number" id="batchRepeats" value="3" min="1" max="20" />
          </div>
          <div class="form-group">
            <label>Concurrency</label>
            <input type="number" id="batchConcurrency" value="2" min="1" max="10" />
          </div>
        </div>

        <div id="batchProgress" style="display:none; flex-direction:column; gap:8px;">
          <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:700;">
            <span id="batchStatus">Running...</span>
            <span id="batchCount">0 / 0</span>
          </div>
          <div style="height:6px; background:var(--bg-elevated); border-radius:3px; overflow:hidden;">
            <div id="batchBar" style="height:100%; width:0%; background:var(--color-primary); transition:width 0.2s;"></div>
          </div>
        </div>

        <div id="batchResults" style="display:none; max-height:260px; overflow-y:auto;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="btnStartBatch">Start Batch Evaluation</button>
      </div>
    `;

    this.modalCard.querySelector('#batchClose').addEventListener('click', () => {
      this.modalBackdrop.style.display = 'none';
    });

    this.modalCard.querySelector('#btnStartBatch').addEventListener('click', async () => {
      const models = this.modalCard.querySelector('#batchModels').value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!models.length) return alert('Enter at least one model.');

      const repeats = Number(this.modalCard.querySelector('#batchRepeats').value) || 1;
      const concurrency = Number(this.modalCard.querySelector('#batchConcurrency').value) || 1;

      const progressEl = this.modalCard.querySelector('#batchProgress');
      const resultsEl = this.modalCard.querySelector('#batchResults');
      const barEl = this.modalCard.querySelector('#batchBar');
      const statusEl = this.modalCard.querySelector('#batchStatus');
      const countEl = this.modalCard.querySelector('#batchCount');
      const startBtn = this.modalCard.querySelector('#btnStartBatch');

      progressEl.style.display = 'flex';
      resultsEl.style.display = 'none';
      startBtn.disabled = true;

      const baseUrl = this.apiBaseUrl.value.trim();
      const apiKey = this.apiKey.value.trim();

      const targets = models.map((m) => ({
        label: m,
        client: new LLMClient({ baseUrl, apiKey, model: m, proxy: this.hasProxyServer ? '/api/llm' : null }),
      }));

      const total = targets.length * repeats;
      let completed = 0;

      const runs = await runBatch(this.flow, targets, {
        repeats,
        concurrency,
        allowExpr: true,
        onRunComplete: (r) => {
          completed++;
          barEl.style.width = `${(completed / total) * 100}%`;
          countEl.textContent = `${completed} / ${total}`;
          statusEl.textContent = `Completed ${r.model} (Score: ${r.score})`;
        },
      });

      const summary = summarize(runs);
      startBtn.disabled = false;
      statusEl.textContent = 'Batch complete!';

      // Render comparative table
      let tableHtml = `
        <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:left;">
          <thead>
            <tr style="border-bottom:1px solid var(--border); color:var(--text-dim);">
              <th style="padding:6px;">Model</th>
              <th style="padding:6px;">Runs</th>
              <th style="padding:6px;">Pass Rate</th>
              <th style="padding:6px;">Avg Score</th>
              <th style="padding:6px;">Retries</th>
              <th style="padding:6px;">Avg Duration</th>
            </tr>
          </thead>
          <tbody>
      `;
      for (const m of summary.byModel) {
        tableHtml += `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:6px; font-weight:700; color:var(--text-main);">${escapeHtml(m.model)}</td>
            <td style="padding:6px;">${m.runs}</td>
            <td style="padding:6px; color:${m.passRate > 0.8 ? 'var(--color-success)' : 'var(--text-muted)'}; font-weight:700;">${Math.round(m.passRate * 100)}%</td>
            <td style="padding:6px; font-weight:700; color:var(--color-primary);">${m.avgScore.toFixed(1)}</td>
            <td style="padding:6px;">${m.retries}</td>
            <td style="padding:6px;">${(m.avgDurationMs / 1000).toFixed(1)}s</td>
          </tr>
        `;
      }
      tableHtml += '</tbody></table>';

      resultsEl.innerHTML = tableHtml;
      resultsEl.style.display = 'block';
    });
  }

  // =========================================================================
  // Event Bindings
  // =========================================================================
  #initEvents() {
    // Flow title rename
    this.flowNameInput.addEventListener('input', () => {
      if (this.flow) {
        this.flow.name = this.flowNameInput.value;
        this.setDirty(true);
      }
    });

    // Toolbar actions
    document.getElementById('toolAddPrompt')?.addEventListener('click', () => this.addNode('prompt'));
    document.getElementById('toolAddCode')?.addEventListener('click', () => this.addNode('code'));
    document.getElementById('toolAddEnd')?.addEventListener('click', () => this.addNode('end'));
    document.getElementById('toolAutoLayout')?.addEventListener('click', () => this.graph.autoLayout());
    document.getElementById('toolFitView')?.addEventListener('click', () => this.graph.fitView());
    document.getElementById('toolValidate')?.addEventListener('click', () => {
      const v = validateFlow(this.flow);
      if (v.ok && !v.warnings.length) {
        alert('Flow audit passed with zero errors or warnings!');
      } else {
        const msg = [
          v.errors.length ? 'ERRORS:\n- ' + v.errors.join('\n- ') : '',
          v.warnings.length ? 'WARNINGS:\n- ' + v.warnings.join('\n- ') : '',
        ].filter(Boolean).join('\n\n');
        alert(msg);
      }
    });
    document.getElementById('toolToggleConsole')?.addEventListener('click', () => this.console.toggle());

    // Top actions
    this.btnRun?.addEventListener('click', () => this.runCurrentFlow());
    this.btnStop?.addEventListener('click', () => this.stopCurrentRun());
    document.getElementById('btnBatchModal')?.addEventListener('click', () => this.showBatchModal());

    // Flow Settings Modal
    document.getElementById('btnFlowSettings')?.addEventListener('click', () => this.openFlowSettingsModal());
    document.getElementById('btnMenuFlowSettings')?.addEventListener('click', () => {
      document.getElementById('flowActionsMenu')?.classList.remove('open');
      this.openFlowSettingsModal();
    });

    // My Flows Button & Menu Item
    document.getElementById('btnMyFlows')?.addEventListener('click', () => this.openMyFlowsModal());
    document.getElementById('btnMenuMyFlows')?.addEventListener('click', () => {
      document.getElementById('flowActionsMenu')?.classList.remove('open');
      this.openMyFlowsModal();
    });

    // New Blank Flow
    document.getElementById('btnNewFlow')?.addEventListener('click', () => {
      document.getElementById('flowActionsMenu')?.classList.remove('open');
      if (this.dirty && !confirm('Discard unsaved changes and create new flow?')) return;
      this.newFlow();
    });

    // Duplicate Flow
    document.getElementById('btnDuplicateFlow')?.addEventListener('click', () => {
      document.getElementById('flowActionsMenu')?.classList.remove('open');
      if (!this.flow) return;
      const clone = duplicateSavedFlow(this.flow);
      this.setFlow(clone);
    });

    // Flow Actions Dropdown
    const flowActionsBtn = document.getElementById('btnFlowActions');
    const flowActionsMenu = document.getElementById('flowActionsMenu');
    if (flowActionsBtn && flowActionsMenu) {
      flowActionsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('templatesMenu')?.classList.remove('open');
        flowActionsMenu.classList.toggle('open');
      });
    }

    // Templates Dropdown
    const tplBtn = document.getElementById('btnTemplates');
    const tplMenu = document.getElementById('templatesMenu');
    tplBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('flowActionsMenu')?.classList.remove('open');
      tplMenu.classList.toggle('open');
      if (tplMenu.classList.contains('open')) {
        tplMenu.innerHTML = this.templates.map((tpl, i) => `
          <button class="dropdown-item" data-tpl-idx="${i}">
            <span class="item-title">${escapeHtml(tpl.name)}</span>
            <span class="item-desc">${escapeHtml(tpl.description || '')}</span>
          </button>
        `).join('');
        tplMenu.querySelectorAll('.dropdown-item').forEach((btn) => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.tplIdx);
            tplMenu.classList.remove('open');
            if (this.dirty && !confirm('Discard unsaved changes and load template?')) return;
            const clone = JSON.parse(JSON.stringify(this.templates[idx]));
            saveFlow(clone, true);
            this.setFlow(clone);
          });
        });
      }
    });
    window.addEventListener('click', () => {
      tplMenu.classList.remove('open');
      document.getElementById('flowActionsMenu')?.classList.remove('open');
    });

    // Export Flow
    document.getElementById('btnExport').addEventListener('click', () => {
      this.exportFlow(this.flow);
    });

    // Import Flow
    const fileInput = document.getElementById('importFileInput');
    document.getElementById('btnImport').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed.nodes) throw new Error('File does not look like a valid flow JSON.');
        saveFlow(parsed, true);
        this.setFlow(parsed);
      } catch (err) {
        alert(`Failed to import flow: ${err.message}`);
      } finally {
        fileInput.value = '';
      }
    });

    // Inspector controls
    document.getElementById('inspectorClose').addEventListener('click', () => {
      if (this.graph.selectedNodeId || this.graph.selectedEdge) {
        // Deselect node/edge and return to Flow Overview
        this.graph.clearSelection();
      } else {
        // Already in Flow Overview: close/collapse the panel
        document.getElementById('inspector').classList.add('collapsed');
      }
    });

    const toggleInspectorBtn = document.getElementById('toolToggleInspector');
    if (toggleInspectorBtn) {
      toggleInspectorBtn.addEventListener('click', () => this.toggleInspector());
    }

    // API key show/hide toggle
    const toggleApiKeyBtn = document.getElementById('btnToggleApiKey');
    if (toggleApiKeyBtn) {
      toggleApiKeyBtn.addEventListener('click', () => {
        const isPass = this.apiKey.type === 'password';
        this.apiKey.type = isPass ? 'text' : 'password';
        toggleApiKeyBtn.style.color = isPass ? 'var(--color-primary)' : 'var(--text-dim)';
      });
    }

    // HUD Zoom controls
    document.getElementById('btnZoomIn')?.addEventListener('click', () => {
      this.graph.scale = Math.min(2.5, this.graph.scale * 1.15);
      this.graph.render();
    });
    document.getElementById('btnZoomOut')?.addEventListener('click', () => {
      this.graph.scale = Math.max(0.2, this.graph.scale * 0.85);
      this.graph.render();
    });
    document.getElementById('hudZoom')?.addEventListener('click', () => {
      this.graph.scale = 1.0;
      this.graph.render();
    });

    // Console controls
    document.getElementById('btnToggleDrawer').addEventListener('click', () => this.console.toggle());
    document.getElementById('consoleHandle').addEventListener('dblclick', () => this.console.toggle());
    document.getElementById('btnClearConsole').addEventListener('click', () => this.console.clear());

    // Fetch models button
    document.getElementById('btnFetchModels').addEventListener('click', async () => {
      const baseUrl = this.apiBaseUrl.value.trim();
      const apiKey = this.apiKey.value.trim();
      if (!baseUrl) return alert('Enter base URL first.');
      const client = new LLMClient({ baseUrl, apiKey, proxy: this.hasProxyServer ? '/api/llm' : null });
      try {
        const models = await client.listModels();
        this.modelsDataList.innerHTML = models.map((m) => `<option value="${escapeAttr(m)}">`).join('');
        alert(`Discovered ${models.length} model(s) from endpoint.`);
      } catch (err) {
        alert(`Failed to fetch models: ${err.message}`);
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Don't intercept when typing in inputs/textareas
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Duplicate: Ctrl+D or Cmd+D
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        this.duplicateSelectedNode();
        return;
      }

      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this.addNode('prompt'); }
      else if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.addNode('code'); }
      else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); this.addNode('end'); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); this.graph.fitView(); }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); this.console.toggle(); }
      else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); this.toggleInspector(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.graph.selectedNodeId) {
          const nid = this.graph.selectedNodeId;
          delete this.flow.nodes[nid];
          for (const n of Object.values(this.flow.nodes)) {
            n.edges = (n.edges || []).filter((e) => e.to !== nid);
          }
          this.onFlowMutated();
          this.graph.clearSelection();
        } else if (this.graph.selectedEdge) {
          const { edgeId, fromNodeId } = this.graph.selectedEdge;
          const fn = this.flow.nodes[fromNodeId];
          if (fn) {
            fn.edges = fn.edges.filter((e) => e.id !== edgeId);
            this.onFlowMutated();
            this.graph.clearSelection();
          }
        }
      }
    });
  }

  newFlow() {
    const blank = createFlow({ name: 'Untitled Flow' });
    const q = createNode({ id: 'start_q', title: 'First Question', prompt: 'Hello, what is 2+2?', maxAttempts: 3 });
    blank.nodes[q.id] = q;
    blank.startId = q.id;
    saveFlow(blank, true);
    this.setFlow(blank);
  }

  exportFlow(flow = this.flow) {
    if (!flow) return;
    const json = JSON.stringify(flow, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(flow.name || 'flow').replace(/[^\w-]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  closeModal() {
    this.modalBackdrop.style.display = 'none';
    this.modalCard.innerHTML = '';
    this.modalCard.className = 'modal-card';
  }

  openFlowSettingsModal() {
    this.modalBackdrop.style.display = 'grid';
    this.modalCard.className = 'modal-card';
    this.modalCard.innerHTML = this.inspector.renderFlowSettingsModal();

    const modalClose = this.modalCard.querySelector('#modalClose');
    modalClose?.addEventListener('click', () => { this.closeModal(); });

    const trialCheck = this.modalCard.querySelector('#setTrialEnabled');
    const trialRow = this.modalCard.querySelector('#trialDetailsRow');
    trialCheck?.addEventListener('change', () => { trialRow.style.display = trialCheck.checked ? 'flex' : 'none'; });

    // Reset to canonical benchmark defaults
    const resetBtn = this.modalCard.querySelector('#btnResetSettingsDefaults');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const fresh = createFlow().settings;
        this.modalCard.querySelector('#setSysPrompt').value = fresh.systemPrompt || '';
        this.modalCard.querySelector('#setMemory').value = fresh.memory || 'conversation';
        this.modalCard.querySelector('#setTurns').value = fresh.historyTurns ?? 4;
        this.modalCard.querySelector('#setRetryMemory').value = fresh.retryMemory || 'keep';
        this.modalCard.querySelector('#setDefaultAttempts').value = fresh.defaultMaxAttempts ?? 5;

        trialCheck.checked = true; // recommended default
        trialRow.style.display = 'flex';
        this.modalCard.querySelector('#setTrialTemplate').value = '[Attempt {{attempt}}/{{budget}}]';
        this.modalCard.querySelector('#setTrialPos').value = 'prefix';

        this.modalCard.querySelector('#setCacheBuster').checked = true;

        this.modalCard.querySelector('#normThinking').checked = true;
        this.modalCard.querySelector('#normLower').checked = true;
        this.modalCard.querySelector('#normMarkdown').checked = false;
        this.modalCard.querySelector('#normTrim').checked = true;

        this.modalCard.querySelector('#setMaxSteps').value = fresh.maxSteps ?? 40;
        this.modalCard.querySelector('#setTemp').value = fresh.params?.temperature ?? 0.2;

        resetBtn.textContent = '✓ Defaults Restored!';
        setTimeout(() => { if (resetBtn) resetBtn.textContent = 'Reset to Defaults'; }, 1500);
      });
    }

    this.modalCard.querySelector('#btnSaveFlowSettings')?.addEventListener('click', () => {
      const s = this.flow.settings = this.flow.settings || {};
      s.systemPrompt = this.modalCard.querySelector('#setSysPrompt').value;
      s.memory = this.modalCard.querySelector('#setMemory').value;
      s.historyTurns = Number(this.modalCard.querySelector('#setTurns').value);
      s.retryMemory = this.modalCard.querySelector('#setRetryMemory').value;
      s.defaultMaxAttempts = Number(this.modalCard.querySelector('#setDefaultAttempts').value);

      s.trialCounter = {
        enabled: trialCheck.checked,
        template: this.modalCard.querySelector('#setTrialTemplate').value,
        position: this.modalCard.querySelector('#setTrialPos').value,
        skipFirst: true,
      };

      s.cacheBuster = {
        enabled: this.modalCard.querySelector('#setCacheBuster').checked,
        mode: 'user',
      };

      s.normalize = {
        thinking: this.modalCard.querySelector('#normThinking').checked,
        lower: this.modalCard.querySelector('#normLower').checked,
        markdown: this.modalCard.querySelector('#normMarkdown').checked,
        trim: this.modalCard.querySelector('#normTrim').checked,
        whitespace: true,
      };

      s.maxSteps = Number(this.modalCard.querySelector('#setMaxSteps').value);
      s.params = s.params || {};
      s.params.temperature = Number(this.modalCard.querySelector('#setTemp').value);

      this.onFlowMutated();
      this.closeModal();
    });
  }

  openMyFlowsModal() {
    this.modalCard.className = 'modal-card modal-card-lg';
    this.modalCard.innerHTML = `
      <div class="modal-header">
        <div>
          <h3>📂 Saved Flows Library</h3>
          <p style="font-size:11.5px; color:var(--text-dim); margin-top:2px;">All flows are autosaved in browser storage. Switch, duplicate, rename, or export anytime.</p>
        </div>
        <button class="btn btn-xs btn-ghost" id="modalClose">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="text" class="input flow-lib-search" id="flowSearchInput" placeholder="Search saved flows..." />
          <button class="btn btn-sm btn-outline" id="btnLibNewBlank" style="white-space:nowrap;">+ New Flow</button>
          <button class="btn btn-sm btn-outline" id="btnLibImport" style="white-space:nowrap;">📥 Import JSON</button>
        </div>
        <div id="flowListContainer"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-sm btn-outline" id="modalCloseFooter">Close</button>
      </div>
    `;

    this.modalBackdrop.style.display = 'grid';

    const renderList = (filter = '') => {
      const allFlows = listSavedFlows();
      const flows = allFlows.filter((f) => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return f.name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q);
      });

      const container = this.modalCard.querySelector('#flowListContainer');
      if (!container) return;

      if (flows.length === 0) {
        container.innerHTML = `<div class="inspector-empty" style="padding: 24px; text-align: center;">No saved flows found matching "${escapeHtml(filter)}".</div>`;
        return;
      }

      container.innerHTML = `
        <div class="flow-lib-grid">
          ${flows.map((f) => {
            const isActive = this.flow && this.flow.id === f.id;
            const dateStr = new Date(f.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + new Date(f.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            return `
              <div class="flow-lib-card ${isActive ? 'active-flow' : ''}" data-flow-id="${escapeHtml(f.id)}">
                <div class="flow-lib-header">
                  <div class="flow-lib-title">
                    <span>${escapeHtml(f.name)}</span>
                    ${isActive ? '<span class="flow-lib-badge badge-active">● Active</span>' : ''}
                  </div>
                  <span class="flow-lib-meta">${escapeHtml(dateStr)}</span>
                </div>
                <div class="flow-lib-desc">${escapeHtml(f.description || 'No description.')}</div>
                <div class="flow-lib-header" style="margin-top:2px;">
                  <div class="flow-lib-meta">
                    <span><strong>${f.nodeCount}</strong> nodes</span>
                    <span>•</span>
                    <span><strong>${f.edgeCount}</strong> branches</span>
                    ${f.startId ? `<span>•</span><span>Start: <code>${escapeHtml(f.startId)}</code></span>` : ''}
                  </div>
                  <div class="flow-lib-actions">
                    ${!isActive ? `<button class="btn btn-xs btn-primary btn-open-flow" data-id="${escapeHtml(f.id)}">Open Flow</button>` : '<button class="btn btn-xs btn-outline" disabled>Currently Open</button>'}
                    <button class="btn btn-xs btn-outline btn-dup-flow" data-id="${escapeHtml(f.id)}" title="Duplicate this flow">Duplicate</button>
                    <button class="btn btn-xs btn-outline btn-rename-flow" data-id="${escapeHtml(f.id)}" title="Rename this flow">Rename</button>
                    <button class="btn btn-xs btn-outline btn-export-flow" data-id="${escapeHtml(f.id)}" title="Export JSON">Export</button>
                    ${allFlows.length > 1 ? `<button class="btn btn-xs btn-danger btn-del-flow" data-id="${escapeHtml(f.id)}" title="Delete from storage">Delete</button>` : ''}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      // Bind actions
      container.querySelectorAll('.btn-open-flow').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const target = getSavedFlow(id);
          if (target) {
            this.setFlow(target);
            this.closeModal();
          }
        });
      });

      container.querySelectorAll('.btn-dup-flow').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const target = getSavedFlow(id);
          if (target) {
            duplicateSavedFlow(target);
            renderList(filter);
          }
        });
      });

      container.querySelectorAll('.btn-rename-flow').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const target = getSavedFlow(id);
          if (!target) return;
          const newName = prompt('New flow name:', target.name || '');
          if (newName && newName.trim()) {
            target.name = newName.trim();
            saveFlow(target, this.flow?.id === id);
            if (this.flow?.id === id) {
              this.flowNameInput.value = target.name;
            }
            renderList(filter);
          }
        });
      });

      container.querySelectorAll('.btn-export-flow').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const target = getSavedFlow(id);
          if (target) this.exportFlow(target);
        });
      });

      container.querySelectorAll('.btn-del-flow').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const target = getSavedFlow(id);
          if (!target) return;
          if (!confirm(`Delete flow "${target.name || 'Untitled'}" from browser storage?`)) return;
          deleteSavedFlow(id);
          if (this.flow?.id === id) {
            const remaining = listSavedFlows();
            if (remaining.length > 0) {
              this.setFlow(remaining[0].flow);
            } else {
              this.newFlow();
            }
          }
          renderList(filter);
        });
      });
    };

    renderList('');

    const searchInput = this.modalCard.querySelector('#flowSearchInput');
    searchInput?.focus();
    searchInput?.addEventListener('input', (e) => {
      renderList(e.target.value.trim());
    });

    this.modalCard.querySelector('#modalClose')?.addEventListener('click', () => this.closeModal());
    this.modalCard.querySelector('#modalCloseFooter')?.addEventListener('click', () => this.closeModal());
    this.modalCard.querySelector('#btnLibNewBlank')?.addEventListener('click', () => {
      this.closeModal();
      this.newFlow();
    });
    this.modalCard.querySelector('#btnLibImport')?.addEventListener('click', () => {
      this.closeModal();
      document.getElementById('importFileInput')?.click();
    });
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

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
