/**
 * client.js — OpenAI-compatible chat client. Zero dependencies, fetch-based.
 * Works both in the browser (via /api/llm proxy for CORS) and in Node.
 */

export class LLMError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

export class LLMClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.baseUrl  e.g. https://api.openai.com/v1 or http://127.0.0.1:20128/v1
   * @param {string} [cfg.apiKey]
   * @param {string} cfg.model
   * @param {string} [cfg.proxy]  optional proxy endpoint (browser uses '/api/llm')
   * @param {object} [cfg.params] default sampling parameters
   * @param {number} [cfg.timeoutMs]
   * @param {number} [cfg.retries]
   * @param {Record<string,string>} [cfg.headers]
   */
  constructor(cfg = {}) {
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = cfg.apiKey || '';
    this.model = cfg.model || '';
    this.proxy = cfg.proxy || null;
    this.params = cfg.params || {};
    this.timeoutMs = cfg.timeoutMs ?? 120000;
    this.retries = cfg.retries ?? 2;
    this.headers = cfg.headers || {};
    this.usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 };
  }

  withModel(model) {
    const c = new LLMClient({ ...this, baseUrl: this.baseUrl, model });
    c.usage = this.usage; // shared accumulator
    return c;
  }

  async listModels() {
    const { url, headers, body } = this.#prepare('/models', null);
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body || undefined });
    const text = await res.text();
    if (!res.ok) throw new LLMError(`Failed to list models (${res.status})`, { status: res.status, body: text });
    const data = JSON.parse(text);
    const arr = data.data || data.models || [];
    return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @param {object} [override] per-call parameter overrides
   * @returns {Promise<{text:string, reasoning:string, raw:object, usage:object, latencyMs:number, finishReason:string, model:string}>}
   */
  async chat(messages, override = {}) {
    const payload = {
      model: override.model || this.model,
      messages,
      ...this.params,
      ...stripUndefined(override),
    };
    delete payload.systemPrompt;
    if (payload.stream) delete payload.stream;

    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const { url, headers, body } = this.#prepare('/chat/completions', payload);
        const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
        const text = await res.text();
        clearTimeout(timer);
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          const err = new LLMError(`API error ${res.status}: ${truncate(text, 400)}`, { status: res.status, body: text });
          if (retryable && attempt < this.retries) { lastErr = err; await sleep(backoff(attempt)); continue; }
          this.usage.errors++;
          throw err;
        }
        let data;
        try { data = JSON.parse(text); } catch {
          this.usage.errors++;
          throw new LLMError(`Non-JSON response: ${truncate(text, 300)}`, { status: res.status, body: text });
        }
        const choice = data.choices?.[0] || {};
        const msg = choice.message || {};
        let out = msg.content ?? '';
        if (Array.isArray(out)) out = out.map((p) => p.text || p.content || '').join('');
        const reasoning = msg.reasoning_content || msg.reasoning || '';
        const u = data.usage || {};
        this.usage.requests++;
        this.usage.promptTokens += u.prompt_tokens || 0;
        this.usage.completionTokens += u.completion_tokens || 0;
        this.usage.totalTokens += u.total_tokens || 0;
        return {
          text: String(out),
          reasoning: String(reasoning || ''),
          raw: data,
          usage: {
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0,
            totalTokens: u.total_tokens || 0,
          },
          finishReason: choice.finish_reason || '',
          latencyMs: Date.now() - started,
          model: data.model || payload.model,
        };
      } catch (err) {
        clearTimeout(timer);
        const aborted = err.name === 'AbortError';
        const netErr = aborted || err instanceof TypeError;
        if (netErr && attempt < this.retries) {
          lastErr = aborted ? new LLMError(`Request timed out (${this.timeoutMs}ms)`, { cause: err }) : new LLMError(err.message, { cause: err });
          await sleep(backoff(attempt));
          continue;
        }
        this.usage.errors++;
        if (err instanceof LLMError) throw err;
        throw new LLMError(aborted ? `Request timed out (${this.timeoutMs}ms)` : `Network error: ${err.message}`, { cause: err });
      }
    }
    throw lastErr || new LLMError('Request failed');
  }

  #prepare(path, payload) {
    const headers = { 'content-type': 'application/json', ...this.headers };
    if (this.proxy) {
      return {
        url: this.proxy,
        headers,
        body: JSON.stringify({
          baseUrl: this.baseUrl,
          apiKey: this.apiKey || undefined,
          path,
          method: payload ? 'POST' : 'GET',
          headers: this.headers,
          payload: payload || undefined,
        }),
      };
    }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return { url: this.baseUrl + path, headers, body: payload ? JSON.stringify(payload) : null };
  }
}

function stripUndefined(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(8000, 500 * 2 ** n) + Math.random() * 250;
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/** For unit tests and dry runs: responds per scenario without real network. */
export class MockClient {
  /** @param {(messages:Array, turn:number, override:object)=>string|{text:string}} responder */
  constructor(responder, { latencyMs = 0 } = {}) {
    this.responder = responder;
    this.latencyMs = latencyMs;
    this.calls = [];
    this.model = 'mock';
    this.usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, errors: 0 };
  }
  withModel(model) { const c = new MockClient(this.responder, { latencyMs: this.latencyMs }); c.model = model; return c; }
  async chat(messages, override = {}) {
    this.calls.push({ messages, override });
    if (this.latencyMs) await sleep(this.latencyMs);
    const r = this.responder(messages, this.calls.length - 1, override);
    const text = typeof r === 'string' ? r : r?.text ?? '';
    this.usage.requests++;
    return {
      text, reasoning: '', raw: { mock: true }, finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: this.latencyMs, model: override.model || this.model,
    };
  }
}
