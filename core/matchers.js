/**
 * matchers.js — condition evaluation engine.
 *
 * An edge's condition looks at the model's answer and decides "is this path
 * open?". One contract for every type: match(text, cond) -> { ok, captures, detail }
 *
 * Design note: `contains` alone is misleading on numeric tests ("14" contains
 * "4"). That is why `numeric` is a first-class type — it extracts numbers from
 * the answer and compares them as numbers — and `word` applies word boundaries.
 */

/** Strips hidden reasoning blocks such as <think>…</think>. */
export function stripThinking(text) {
  if (!text) return '';
  return text
    .replace(/<(think|thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi, ' ')
    // unterminated open block (truncated stream)
    .replace(/<(think|thinking|reasoning|scratchpad)>[\s\S]*$/i, ' ');
}

/** Drops markdown decoration and collapses whitespace. */
export function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalization pipeline. Which steps run is configured per flow / per node.
 * @param {string} text
 * @param {{thinking?:boolean, markdown?:boolean, lower?:boolean, trim?:boolean,
 *          punctuation?:boolean, whitespace?:boolean}} opts
 */
export function normalize(text, opts = {}) {
  let out = text == null ? '' : String(text);
  if (opts.thinking !== false) out = stripThinking(out);
  if (opts.markdown) out = stripMarkdown(out);
  if (opts.punctuation) out = out.replace(/[.,;:!?'"()\[\]{}…]/g, ' ');
  if (opts.whitespace !== false) out = out.replace(/\s+/g, ' ');
  if (opts.lower) out = out.toLowerCase();
  if (opts.trim !== false) out = out.trim();
  return out;
}

/** Pulls every number out of the text. Handles thousand separators and signs. */
export function extractNumbers(text) {
  if (!text) return [];
  const out = [];
  // 1.234,56 / 1,234.56 / -42 / 3.14 / 50%
  const re = /[-+]?\d[\d\s.,]*\d|[-+]?\d/g;
  for (const raw of text.match(re) || []) {
    const cleaned = cleanNumeric(raw);
    if (cleaned !== null) out.push(cleaned);
  }
  return out;
}

function cleanNumeric(raw) {
  let s = raw.replace(/\s/g, '');
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // whichever separator appears last is treated as the decimal point
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    // 1,234 -> thousands ; 3,5 -> decimal (decided by the grouping pattern)
    s = /^[-+]?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot) {
    if (/^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  s = s.replace(/[.,]+$/, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NUM_OPS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
};

/** Raw result of one condition type, before `negate` is applied. */
function evaluate(text, cond) {
  const type = cond.type || 'always';
  const value = cond.value == null ? '' : String(cond.value);

  switch (type) {
    case 'always':
      return { ok: true, detail: 'always' };

    case 'contains': {
      const hay = cond.caseSensitive ? text : text.toLowerCase();
      const needle = cond.caseSensitive ? value : value.toLowerCase();
      if (!needle) return { ok: false, detail: 'empty search text' };
      const at = hay.indexOf(needle);
      return { ok: at >= 0, detail: at >= 0 ? `"${value}" @${at}` : `"${value}" not found` };
    }

    case 'equals': {
      const a = cond.caseSensitive ? text.trim() : text.trim().toLowerCase();
      const b = cond.caseSensitive ? value.trim() : value.trim().toLowerCase();
      return { ok: a === b, detail: a === b ? 'exact match' : `"${a}" != "${b}"` };
    }

    case 'startsWith':
    case 'endsWith': {
      const a = cond.caseSensitive ? text.trim() : text.trim().toLowerCase();
      const b = cond.caseSensitive ? value.trim() : value.trim().toLowerCase();
      const ok = type === 'startsWith' ? a.startsWith(b) : a.endsWith(b);
      return { ok, detail: `${type}("${b}") = ${ok}` };
    }

    case 'word': {
      // word-boundary search: "4" does not match inside "14"
      if (!value) return { ok: false, detail: 'empty word' };
      const flags = cond.caseSensitive ? 'u' : 'iu';
      const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRe(value)}(?:$|[^\\p{L}\\p{N}_])`, flags);
      const ok = re.test(text);
      return { ok, detail: `word "${value}" = ${ok}` };
    }

    case 'anyOf':
    case 'allOf': {
      const items = (Array.isArray(cond.values) ? cond.values : value.split('\n'))
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (!items.length) return { ok: false, detail: 'empty list' };
      const hay = cond.caseSensitive ? text : text.toLowerCase();
      const hits = items.filter((it) => hay.includes(cond.caseSensitive ? it : it.toLowerCase()));
      const ok = type === 'anyOf' ? hits.length > 0 : hits.length === items.length;
      return { ok, detail: `${hits.length}/${items.length} matched [${hits.join(', ')}]` };
    }

    case 'regex': {
      let re;
      try {
        re = new RegExp(value, cond.flags || 'i');
      } catch (err) {
        return { ok: false, detail: `invalid regex: ${err.message}`, error: err.message };
      }
      const m = re.exec(text);
      if (!m) return { ok: false, detail: `/${value}/${cond.flags || 'i'} did not match` };
      const captures = {};
      m.forEach((g, i) => { if (i) captures[`$${i}`] = g; });
      if (m.groups) Object.assign(captures, m.groups);
      return { ok: true, captures, detail: `matched "${m[0]}"` };
    }

    case 'numeric': {
      const nums = extractNumbers(text);
      if (!nums.length) return { ok: false, detail: 'no number in answer' };
      // which: 'any' (default) | 'first' | 'last' | 'all'
      const which = cond.which || 'any';
      const pool = which === 'first' ? nums.slice(0, 1)
        : which === 'last' ? nums.slice(-1)
        : nums;
      const tol = Number(cond.tolerance) || 0;
      let test;
      if (cond.op === 'between') {
        const lo = Number(cond.min), hi = Number(cond.max);
        test = (n) => n >= lo - tol && n <= hi + tol;
      } else {
        const op = NUM_OPS[cond.op || 'eq'];
        const target = Number(cond.value);
        if (!op || !Number.isFinite(target)) return { ok: false, detail: 'invalid numeric condition' };
        test = (n) => (cond.op === 'eq' || !cond.op)
          ? Math.abs(n - target) <= tol
          : (cond.op === 'ne' ? Math.abs(n - target) > tol : op(n, target));
      }
      const matched = pool.filter(test);
      const ok = which === 'all' ? matched.length === pool.length && pool.length > 0 : matched.length > 0;
      return {
        ok,
        captures: ok ? { $num: String(matched[0] ?? pool[0]) } : undefined,
        detail: `numbers [${nums.join(', ')}] ${cond.op || 'eq'} ${cond.op === 'between' ? `${cond.min}..${cond.max}` : cond.value} -> ${ok}`,
      };
    }

    case 'length': {
      const len = text.trim().length;
      const min = cond.min == null ? -Infinity : Number(cond.min);
      const max = cond.max == null ? Infinity : Number(cond.max);
      const ok = len >= min && len <= max;
      return { ok, detail: `length ${len} in [${cond.min ?? '-'}, ${cond.max ?? '-'}] -> ${ok}` };
    }

    case 'json': {
      const parsed = tryParseJson(text);
      if (!parsed.ok) return { ok: false, detail: 'no valid JSON found' };
      if (!cond.path) return { ok: true, captures: { $json: JSON.stringify(parsed.value) }, detail: 'valid JSON' };
      const got = getPath(parsed.value, cond.path);
      if (got === undefined) return { ok: false, detail: `path missing: ${cond.path}` };
      if (cond.value === '' || cond.value == null) {
        return { ok: true, captures: { $json: String(got) }, detail: `${cond.path} = ${JSON.stringify(got)}` };
      }
      const ok = String(got).trim().toLowerCase() === String(cond.value).trim().toLowerCase();
      return { ok, captures: { $json: String(got) }, detail: `${cond.path} = ${JSON.stringify(got)} vs ${cond.value}` };
    }

    case 'expr': {
      // A user-authored JS expression: a deliberate feature, like a formula cell
      // in a spreadsheet. But the expression text lives inside the flow JSON, so
      // an imported flow file could ship code. The engine therefore never
      // reaches this branch without the `allowExpr` grant (see engine.js); the
      // UI asks for that grant explicitly when a flow is imported.
      if (cond.__denied) return { ok: false, detail: 'expr not permitted', error: 'expr_denied' };
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('text', 'numbers', 'vars', `"use strict"; return (${value});`);
        const ok = !!fn(text, extractNumbers(text), cond.vars || {});
        return { ok, detail: `expr -> ${ok}` };
      } catch (err) {
        return { ok: false, detail: `expr error: ${err.message}`, error: err.message };
      }
    }

    default:
      return { ok: false, detail: `unknown condition type: ${type}`, error: 'unknown_type' };
  }
}

function tryParseJson(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.unshift(fence[1].trim());
  const first = trimmed.search(/[[{]/);
  const lastO = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (first >= 0 && lastO > first) candidates.push(trimmed.slice(first, lastO + 1));
  for (const c of candidates) {
    try { return { ok: true, value: JSON.parse(c) }; } catch { /* try the next candidate */ }
  }
  return { ok: false };
}

function getPath(obj, path) {
  return String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * Evaluates a single condition, including `negate`.
 * @returns {{ok:boolean, captures?:Object, detail:string, error?:string}}
 */
export function match(text, cond = {}) {
  const res = evaluate(text == null ? '' : String(text), cond);
  if (cond.negate) {
    // a broken condition must never turn `true` just by being negated
    return { ...res, ok: !res.ok && !res.error, detail: `NOT(${res.detail})` };
  }
  return res;
}

/** Condition group: { all:[...] }, { any:[...] }, or a plain condition. */
export function matchGroup(text, cond = {}) {
  if (Array.isArray(cond.all)) {
    const parts = cond.all.map((c) => matchGroup(text, c));
    const ok = parts.length > 0 && parts.every((p) => p.ok);
    return { ok: cond.negate ? !ok : ok, detail: `ALL(${parts.map((p) => p.detail).join(' & ')})`, captures: mergeCaptures(parts) };
  }
  if (Array.isArray(cond.any)) {
    const parts = cond.any.map((c) => matchGroup(text, c));
    const ok = parts.some((p) => p.ok);
    return { ok: cond.negate ? !ok : ok, detail: `ANY(${parts.map((p) => p.detail).join(' | ')})`, captures: mergeCaptures(parts.filter((p) => p.ok)) };
  }
  return match(text, cond);
}

function mergeCaptures(parts) {
  const out = {};
  for (const p of parts) if (p.captures) Object.assign(out, p.captures);
  return Object.keys(out).length ? out : undefined;
}

/** Human-readable condition label (the edge caption in the UI). */
export function describeCondition(cond = {}) {
  if (Array.isArray(cond.all)) return cond.all.map(describeCondition).join(' AND ');
  if (Array.isArray(cond.any)) return cond.any.map(describeCondition).join(' OR ');
  const n = cond.negate ? 'not: ' : '';
  switch (cond.type) {
    case 'always': return 'always';
    case 'contains': return `${n}contains "${cond.value}"`;
    case 'word': return `${n}word "${cond.value}"`;
    case 'equals': return `${n}= "${cond.value}"`;
    case 'startsWith': return `${n}starts with "${cond.value}"`;
    case 'endsWith': return `${n}ends with "${cond.value}"`;
    case 'anyOf': return `${n}any of (${(cond.values || String(cond.value || '').split('\n')).length})`;
    case 'allOf': return `${n}all of (${(cond.values || String(cond.value || '').split('\n')).length})`;
    case 'regex': return `${n}/${cond.value}/${cond.flags || 'i'}`;
    case 'numeric':
      return cond.op === 'between'
        ? `${n}number in [${cond.min}, ${cond.max}]`
        : `${n}number ${({ eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }[cond.op || 'eq'])} ${cond.value}`;
    case 'length': return `${n}length ${cond.min ?? 0}–${cond.max ?? '∞'}`;
    case 'json': return `${n}json ${cond.path || ''}${cond.value ? ` = ${cond.value}` : ''}`;
    case 'expr': return `${n}expr`;
    default: return cond.type || '?';
  }
}

/** The `fields` list drives the UI: each type renders only what it uses. */
export const CONDITION_TYPES = [
  { id: 'contains', label: 'Contains', hint: 'The answer includes this text', fields: ['value', 'caseSensitive'] },
  { id: 'word', label: 'Whole word', hint: 'Word-boundary search: "4" will not match "14"', fields: ['value', 'caseSensitive'] },
  { id: 'equals', label: 'Equals', hint: 'The entire answer equals this', fields: ['value', 'caseSensitive'] },
  { id: 'regex', label: 'Regex', hint: 'Regular expression; capture groups become {{$1}} variables', fields: ['value', 'flags'] },
  { id: 'numeric', label: 'Numeric', hint: 'Extracts numbers from the answer and compares numerically', fields: ['op', 'value', 'min', 'max', 'tolerance', 'which'] },
  { id: 'anyOf', label: 'Any of', hint: 'One of the lines appears in the answer', fields: ['values', 'caseSensitive'] },
  { id: 'allOf', label: 'All of', hint: 'Every line appears in the answer', fields: ['values', 'caseSensitive'] },
  { id: 'startsWith', label: 'Starts with', hint: null, fields: ['value', 'caseSensitive'] },
  { id: 'endsWith', label: 'Ends with', hint: null, fields: ['value', 'caseSensitive'] },
  { id: 'length', label: 'Length', hint: 'Answer length within a character range', fields: ['min', 'max'] },
  { id: 'json', label: 'JSON path', hint: 'Parses the answer as JSON and reads a field: result.answer', fields: ['path', 'value'] },
  { id: 'expr', label: 'JS expression', hint: 'Free expression over text, numbers, vars', fields: ['value'] },
  { id: 'always', label: 'Always', hint: 'Unconditional transition — the default branch', fields: [] },
];

export const NUMERIC_OPS = [
  { id: 'eq', label: '=  equals' },
  { id: 'ne', label: '≠  not equal' },
  { id: 'gt', label: '>  greater than' },
  { id: 'gte', label: '≥  at least' },
  { id: 'lt', label: '<  less than' },
  { id: 'lte', label: '≤  at most' },
  { id: 'between', label: 'between min..max' },
];

export const NUMERIC_WHICH = [
  { id: 'any', label: 'any number in the answer' },
  { id: 'first', label: 'first number only' },
  { id: 'last', label: 'last number only' },
  { id: 'all', label: 'all numbers must match' },
];
