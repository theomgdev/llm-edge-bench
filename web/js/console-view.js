/**
 * console-view.js — bottom drawer live execution monitor.
 * Displays step-by-step model interactions, evaluated branch conditions,
 * captured regex variables, and real-time benchmark tokens/latency/cost.
 */

export class ConsoleView {
  /**
   * @param {object} els
   * @param {HTMLElement} els.drawer
   * @param {HTMLElement} els.feed
   * @param {HTMLElement} els.statusText
   * @param {HTMLElement} els.stats
   * @param {HTMLElement} els.pulseDot
   * @param {HTMLElement} els.pathChips
   * @param {HTMLElement} els.varsPre
   * @param {HTMLElement} els.metRequests
   * @param {HTMLElement} els.metTokens
   * @param {HTMLElement} els.metScore
   * @param {HTMLElement} els.metDuration
   */
  constructor(els) {
    this.els = els;
    this.activeRunId = null;
    this.steps = [];
    this.path = [];
    this.vars = {};
    this.startTime = null;
    this.timer = null;
  }

  startRun(runId, model, flowName) {
    this.activeRunId = runId;
    this.steps = [];
    this.path = [];
    this.vars = {};
    this.startTime = Date.now();

    this.els.pulseDot.className = 'pulse-dot running';
    this.els.statusText.textContent = `Running: ${flowName} (${model})`;
    this.els.feed.innerHTML = '';
    this.els.pathChips.innerHTML = '';
    this.els.varsPre.textContent = '{}';
    this.els.metRequests.textContent = '0';
    this.els.metTokens.textContent = '0';
    this.els.metScore.textContent = '0';
    this.els.metDuration.textContent = '0s';

    this.#startTimer();
    this.expand();
  }

  endRun(run) {
    this.#stopTimer();
    this.els.pulseDot.className = 'pulse-dot';
    const duration = ((run.durationMs || 0) / 1000).toFixed(1);
    this.els.statusText.textContent = `Finished: ${run.status.toUpperCase()} (${run.stopReason || 'completed'}) in ${duration}s`;
    this.els.metDuration.textContent = `${duration}s`;
    this.els.metScore.textContent = String(run.score ?? 0);
    this.els.metTokens.textContent = String(run.usage?.totalTokens ?? 0);
    this.els.metRequests.textContent = String(run.usage?.requests ?? 0);

    const summaryCard = document.createElement('div');
    summaryCard.className = `step-card ${run.outcome === 'pass' ? 'success' : run.status === 'error' ? 'error' : 'retry'}`;
    summaryCard.innerHTML = `
      <div class="step-card-header">
        <span class="step-node-name">RUN COMPLETED: ${escapeHtml((run.outcome || run.status).toUpperCase())}</span>
        <span class="step-attempt">${duration}s | Score: ${run.score ?? 0}</span>
      </div>
      <div style="font-size:12px; color:var(--text-main); padding-top:4px;">
        ${escapeHtml(run.stopReason || 'End of path reached.')}
      </div>
    `;
    this.els.feed.appendChild(summaryCard);
    this.els.feed.scrollTop = this.els.feed.scrollHeight;
  }

  addStep(step) {
    this.steps.push(step);

    // Update path
    if (step.nodeTitle) {
      this.path.push(step.nodeTitle);
      this.#renderPath();
    }

    // Update metrics
    this.els.metRequests.textContent = String(this.steps.length);
    const totalTokens = this.steps.reduce((acc, s) => acc + (s.usage?.totalTokens || 0), 0);
    this.els.metTokens.textContent = String(totalTokens);
    const score = this.steps.reduce((acc, s) => acc + (s.score || 0), 0);
    this.els.metScore.textContent = String(score);

    // Card
    const card = document.createElement('div');
    const isRetry = step.action === 'fallback:retry';
    const isError = step.type === 'error';
    const isSuccess = step.action === 'edge';
    card.className = `step-card ${isError ? 'error' : isRetry ? 'retry' : isSuccess ? 'success' : ''}`;

    const evalsHtml = (step.evaluations || [])
      .map((ev) => `<span class="eval-tag ${ev.ok ? 'hit' : ''}" title="${escapeAttr(ev.detail)}">${ev.ok ? '✓' : '✗'} ${escapeHtml(ev.label)}</span>`)
      .join(' ');

    card.innerHTML = `
      <div class="step-card-header">
        <div>
          <span class="step-node-name">${escapeHtml(step.nodeTitle || step.nodeId)}</span>
          <span class="step-attempt">attempt ${step.attempt || 1}</span>
        </div>
        <div style="color:var(--text-dim); font-size:10px;">
          ${step.latencyMs ? `${step.latencyMs}ms` : ''}
          ${step.score ? ` | <strong style="color:var(--color-primary);">${step.score > 0 ? `+${step.score}` : step.score} pts</strong>` : ''}
        </div>
      </div>

      <div class="step-prompt">${escapeHtml(step.prompt || '')}</div>

      ${step.answer ? `<div class="step-answer"><strong>Model:</strong> ${escapeHtml(step.answer)}</div>` : ''}
      ${step.error ? `<div class="step-answer" style="color:var(--color-danger);"><strong>Error:</strong> ${escapeHtml(step.error)}</div>` : ''}

      ${step.reasoning ? `<div class="step-reasoning"><strong>Thinking:</strong> ${escapeHtml(step.reasoning)}</div>` : ''}

      ${evalsHtml ? `<div class="step-evals">${evalsHtml}</div>` : ''}

      <div style="font-size:11px; color:var(--text-dim); margin-top:2px;">
        ${step.action === 'edge' ? `<span style="color:var(--color-success);">-> Took branch: <strong>${escapeHtml(step.matchedLabel || '')}</strong></span>` : ''}
        ${step.action === 'fallback:retry' ? `<span style="color:var(--color-warning);">⟲ No branch matched; retrying node</span>` : ''}
        ${step.action?.startsWith('exhausted') ? `<span style="color:var(--color-danger);">✕ Attempt budget exhausted</span>` : ''}
      </div>
    `;

    this.els.feed.appendChild(card);
    this.els.feed.scrollTop = this.els.feed.scrollHeight;
  }

  updateVars(vars) {
    this.vars = { ...vars };
    this.els.varsPre.textContent = JSON.stringify(this.vars, null, 2);
  }

  clear() {
    this.steps = [];
    this.path = [];
    this.vars = {};
    this.els.feed.innerHTML = '<div class="feed-empty">Console cleared.</div>';
    this.els.pathChips.innerHTML = '<span class="chip-empty">—</span>';
    this.els.varsPre.textContent = '{}';
    this.els.statusText.textContent = 'Idle';
    this.els.metRequests.textContent = '0';
    this.els.metTokens.textContent = '0';
    this.els.metScore.textContent = '0';
    this.els.metDuration.textContent = '0s';
  }

  toggle() {
    this.els.drawer.classList.toggle('collapsed');
  }

  expand() {
    this.els.drawer.classList.remove('collapsed');
  }

  #renderPath() {
    if (!this.path.length) {
      this.els.pathChips.innerHTML = '<span class="chip-empty">—</span>';
      return;
    }
    const html = this.path
      .map((name, i) => `<span class="path-chip">${escapeHtml(name)}</span>${i < this.path.length - 1 ? '<span class="path-sep">→</span>' : ''}`)
      .join('');
    this.els.pathChips.innerHTML = html;
  }

  #startTimer() {
    this.#stopTimer();
    this.timer = setInterval(() => {
      if (!this.startTime) return;
      const s = ((Date.now() - this.startTime) / 1000).toFixed(1);
      this.els.metDuration.textContent = `${s}s`;
    }, 200);
  }

  #stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
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
