# LLM Edge Bench

> **Interactive Branching Graph Workbench for LLM Decision & Failure-Recovery Evals.**

Most LLM benchmarks test single-turn isolation: *Ask Question → Get Answer → Grade 0/1*.  
They cannot measure **how models recover from errors**, whether they can self-correct when guided down a fallback path, or whether they can maintain coherence across non-linear state graphs.

**LLM Edge Bench** lets you design evaluation flows as interactive directed graphs:
- **Questions are nodes**, **answers are edges**.
- Edges branch on rich conditions: exact match, word boundary, numeric comparisons (`= 4`, `> 10`, `between 5..10`), regular expressions with capture groups, JSON path validation, character length, or custom JS expressions.
- **Cycles are first-class**: asking *"2+2 = ?"* until the model answers `4` is an explicit loop with a configurable attempt budget.
- **Failures branch to remediation**: when a model fails, route it to an *"Explain your calculation"* branch, inject hints, or restart the ladder.

---

## Highlights

- **Zero External Dependencies**: Pure modern ESM (Node.js 18+) + vanilla DOM/SVG frontend. No build steps, no webpack, no React runtime, completely offline-capable.
- **Interactive DAG Canvas**: Drag-and-drop nodes, draw edges port-to-port, pan & zoom with mouse wheel, auto-layout algorithms.
- **Live Visual Execution**: During a run, nodes pulse in real time as prompts fire; taken branches glow green; step-by-step model outputs and evaluation reasons stream into the console drawer.
- **Full Engine Control from UI**:
  - **Memory Policy**: `conversation` (carries full branch history down the path), `window` (sliding N turns), or `isolated` (clean slate on every node).
  - **Failed Attempt Memory**: `keep` (model sees previous wrong answer), `drop` (wrong attempts wiped from prompt context on retry), or `summary` (collapsed into a short note).
  - **Trial Counter**: Toggleable `[Attempt 2/5]` injected into prompt prefix, suffix, or system message so models see retry progression.
  - **Cache Buster**: Optional nonce injection (`user` parameter or system note) preventing reverse proxies (e.g. Omniroute) from returning cached identical responses during retry loops.
  - **Budgets**: Per-node attempt limits, global step budget, and execution timeout.
  - **Regex Variable Forwarding**: Named capture groups (`(?<val>\d+)`) or `$1` are automatically interpolated into downstream node prompts as `{{val}}` or `{{$1}}`.
- **Batch Comparative Benchmarking**: Run any flow across N models × M repetitions with concurrent execution and get a side-by-side pass-rate, retry count, and average score table.
- **OpenAI-Compatible**: Works with Ollama, Omniroute, vLLM, OpenAI, Groq, Anthropic proxies, OpenRouter, or any `/v1/chat/completions` provider.

---

## Quick Start

```bash
# 1. Clone / enter directory
cd ~/Desktop/PROJELER/Python/AI/llm_edge_bench

# 2. Run unit tests (54 passing tests, zero dependencies)
node test/engine.test.js

# 3. Start workbench server
node server.js --port 8787 --base-url http://127.0.0.1:20128/v1
```

Open **`http://127.0.0.1:8787/`** in your browser.

If you are using Omniroute or a local endpoint with authentication, you can pass the key directly to the server so it is never exposed to the browser:
```bash
node server.js --port 8787 --base-url http://127.0.0.1:20128/v1 --key "$YOUR_API_KEY"
```

---

## Built-in Templates

Click **`Templates ▾`** in the top bar to load:

1. **Arithmetic Ladder**: 2+2 → 4 → 16+16 → 32. If 2+2 is wrong, branches into *"Explain Reason"*. If no edge matches, loops until 4 is answered or attempts exhaust.
2. **Strict JSON Adherence**: Requires raw JSON output; validates via JSON path (`age = 29`). If malformed, routes to a format correction node.
3. **Self-Correction & Hinting**: Asks the classic two-coin riddle. If wrong, routes to a hint branch to test whether the model updates its reasoning.
4. **Multi-turn State Tracker**: Model generates a 4-digit code, regex captures it into `{{$code}}`, and the subsequent question tests whether the model recalls its own state.

---

## Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `P` | Add Prompt node at screen center |
| `E` | Add Outcome / Terminal node |
| `F` | Fit graph to view |
| `C` | Toggle execution console drawer |
| `Del` / `Backspace` | Delete selected node or branch |

---

## Architecture

```
llm_edge_bench/
├── core/
│   ├── matchers.js       # 13 condition evaluators (numeric, word, regex, JSON, expr...)
│   ├── engine.js         # Directed graph execution engine, retry loops, budget caps
│   └── client.js         # Zero-dep fetch-based OpenAI chat client & MockClient
├── test/
│   └── engine.test.js    # 54 automated assertions covering edge cases, loops & memory
├── web/
│   ├── index.html        # Clean semantic dark-mode shell
│   ├── css/app.css       # High-density, theme-consistent styles
│   └── js/
│       ├── app.js        # UI orchestrator, storage, batch modal, hotkeys
│       ├── graph.js      # Interactive SVG/DOM canvas, pan, zoom, bezier routing
│       ├── inspector.js  # Node, edge & flow property editors
│       ├── console-view.js # Step-by-step live feed, live metrics & path chips
│       └── templates.js  # Pre-built benchmark flows
└── server.js             # Static file server + CORS / secret-keeping LLM proxy
```

---

## License

MIT. Authored by Cahit Karahan.
