/**
 * templates.js — built-in benchmark graph templates.
 * Demonstrates retry loops, branching on error, regex captures, and context control.
 */

import { createFlow, createNode, createEdge } from '../../core/engine.js';

export function getTemplates() {
  return [
    createArithmeticLadder(),
    createFormatAdherence(),
    createSelfCorrectionHinting(),
    createStateMemoryTracker(),
  ];
}

/**
 * 1. Arithmetic Ladder
 * The classic progression: 2+2 -> 4 -> 16+16 -> 32.
 * If 2+2 is wrong, branches into "Explain your reasoning" path.
 * If no edge matches, loops until 4 is returned.
 */
function createArithmeticLadder() {
  const q1 = createNode({
    id: 'q1',
    title: '2 + 2',
    prompt: 'What is 2 + 2? Output only the final number.',
    maxAttempts: 4,
    score: 0,
    ui: { x: 60, y: 160 },
  });

  const q2 = createNode({
    id: 'q2',
    title: '16 + 16',
    prompt: 'Correct! Now what is 16 + 16? Output only the number.',
    maxAttempts: 3,
    score: 0,
    ui: { x: 500, y: 70 },
  });

  const why = createNode({
    id: 'why',
    title: 'Explain Reason',
    prompt: 'You gave an unexpected answer. Explain your calculation step by step.',
    maxAttempts: 2,
    score: 0,
    ui: { x: 500, y: 290 },
  });

  const pass = createNode({
    id: 'pass',
    type: 'end',
    title: 'Mastered',
    outcome: 'pass',
    score: 20,
    prompt: 'Solved both math problems correctly.',
    ui: { x: 920, y: 70 },
  });

  const fail = createNode({
    id: 'fail',
    type: 'end',
    title: 'Failed',
    outcome: 'fail',
    score: -5,
    prompt: 'Failed arithmetic baseline.',
    ui: { x: 920, y: 290 },
  });

  q1.edges = [
    createEdge({
      label: '= 4 (correct)',
      to: 'q2',
      condition: { type: 'numeric', op: 'eq', value: 4 },
      score: 5,
    }),
    createEdge({
      label: '!= 4 (wrong)',
      to: 'why',
      condition: { type: 'numeric', op: 'ne', value: 4 },
      score: -2,
    }),
  ];

  q2.edges = [
    createEdge({
      label: '= 32 (correct)',
      to: 'pass',
      condition: { type: 'numeric', op: 'eq', value: 32 },
      score: 15,
    }),
    createEdge({
      label: 'wrong -> back to q1',
      to: 'q1',
      condition: { type: 'always' },
      score: -3,
      inject: 'You missed 16+16. Let us restart with the basics.',
    }),
  ];

  why.edges = [
    createEdge({
      label: 'explanation received',
      to: 'fail',
      condition: { type: 'always' },
    }),
  ];

  return createFlow({
    id: 'tpl_arithmetic',
    name: 'Arithmetic Ladder',
    description: 'Branching math test: 2+2 -> 16+16 on pass, explanation branch on failure, retry loop on non-match.',
    startId: 'q1',
    nodes: { q1, q2, why, pass, fail },
    settings: {
      memory: 'conversation',
      trialCounter: { enabled: true, template: '[Attempt {{attempt}}/{{budget}}]', position: 'prefix', skipFirst: true },
      cacheBuster: { enabled: true, mode: 'user' },
      defaultMaxAttempts: 4,
    },
  });
}

/**
 * 2. Strict Format Adherence Challenge
 * Tests whether the model follows strict JSON schema output.
 * If JSON parsing fails, regex tries to recover; if that fails, loops with a format warning.
 */
function createFormatAdherence() {
  const qJson = createNode({
    id: 'json_node',
    title: 'JSON Extraction',
    prompt: 'Extract the user details into valid JSON: "Alice is a 29-year-old software engineer living in Ankara." Output ONLY a JSON object with keys: name (string), age (number), city (string). No markdown, no prose.',
    maxAttempts: 3,
    ui: { x: 80, y: 160 },
  });

  const verified = createNode({
    id: 'verified',
    type: 'end',
    title: 'Valid Schema',
    outcome: 'pass',
    score: 25,
    ui: { x: 500, y: 80 },
  });

  const malformed = createNode({
    id: 'malformed',
    title: 'Format Correction',
    prompt: 'Your previous response was not valid JSON. You MUST output ONLY valid JSON matching {"name":"Alice","age":29,"city":"Ankara"}. Fix it now.',
    maxAttempts: 2,
    ui: { x: 500, y: 260 },
  });

  const failedEnd = createNode({
    id: 'failed_end',
    type: 'end',
    title: 'Format Failed',
    outcome: 'fail',
    score: 0,
    ui: { x: 840, y: 260 },
  });

  qJson.edges = [
    createEdge({
      label: 'valid JSON & age=29',
      to: 'verified',
      condition: {
        all: [
          { type: 'json', path: 'name', value: 'Alice' },
          { type: 'json', path: 'age', value: '29' },
        ],
      },
      score: 25,
    }),
    createEdge({
      label: 'fallback to correction',
      to: 'malformed',
      condition: { type: 'always' },
    }),
  ];

  malformed.edges = [
    createEdge({
      label: 'corrected JSON',
      to: 'verified',
      condition: { type: 'json', path: 'age', value: '29' },
      score: 10,
    }),
    createEdge({
      label: 'still invalid',
      to: 'failed_end',
      condition: { type: 'always' },
    }),
  ];

  return createFlow({
    id: 'tpl_format',
    name: 'Strict JSON Adherence',
    description: 'Tests if model produces valid JSON without markdown wrapping. Routes to recovery prompt if malformed.',
    startId: 'json_node',
    nodes: { json_node: qJson, verified, malformed, failed_end: failedEnd },
    settings: {
      memory: 'conversation',
      normalize: { thinking: true, markdown: false, lower: false },
    },
  });
}

/**
 * 3. Self-Correction & Progressive Hinting
 * Asks a riddle. If wrong, injects a hint and retries.
 * Tests if the model can use newly provided context to adjust its belief.
 */
function createSelfCorrectionHinting() {
  const riddle = createNode({
    id: 'riddle',
    title: 'The Coin Riddle',
    prompt: 'I have two coins that add up to 30 cents, and one of them is not a nickel. What are the two coins?',
    maxAttempts: 3,
    ui: { x: 80, y: 160 },
  });

  const passSol = createNode({
    id: 'pass_sol',
    type: 'end',
    title: 'Solved',
    outcome: 'pass',
    score: 30,
    ui: { x: 500, y: 100 },
  });

  const hintBranch = createNode({
    id: 'hint_branch',
    title: 'With Hint',
    prompt: 'Hint: ONE of them is not a nickel, but the OTHER ONE can be! What are the two coins?',
    maxAttempts: 2,
    ui: { x: 500, y: 260 },
  });

  const failRiddle = createNode({
    id: 'fail_riddle',
    type: 'end',
    title: 'Unsolved',
    outcome: 'fail',
    score: 0,
    ui: { x: 820, y: 260 },
  });

  riddle.edges = [
    createEdge({
      label: 'quarter & nickel',
      to: 'pass_sol',
      condition: {
        all: [
          { type: 'contains', value: 'quarter' },
          { type: 'contains', value: 'nickel' },
        ],
      },
      score: 30,
    }),
    createEdge({
      label: 'missed -> give hint',
      to: 'hint_branch',
      condition: { type: 'always' },
    }),
  ];

  hintBranch.edges = [
    createEdge({
      label: 'solved with hint',
      to: 'pass_sol',
      condition: {
        all: [
          { type: 'contains', value: 'quarter' },
          { type: 'contains', value: 'nickel' },
        ],
      },
      score: 15,
    }),
    createEdge({
      label: 'still wrong',
      to: 'fail_riddle',
      condition: { type: 'always' },
    }),
  ];

  return createFlow({
    id: 'tpl_hinting',
    name: 'Self-Correction & Hinting',
    description: 'Tests if model corrects itself when given an explicit hint on its second try.',
    startId: 'riddle',
    nodes: { riddle, pass_sol: passSol, hint_branch: hintBranch, fail_riddle: failRiddle },
    settings: { memory: 'conversation' },
  });
}

/**
 * 4. Multi-Turn State Memory Tracker
 * Model generates an arbitrary variable, regex captures it into {{$1}},
 * and the next question checks whether the model recalls its own state.
 */
function createStateMemoryTracker() {
  const qPick = createNode({
    id: 'pick',
    title: 'Pick Code',
    prompt: 'Generate a secret 4-digit numeric code. Output only the 4 digits.',
    maxAttempts: 2,
    ui: { x: 80, y: 160 },
  });

  const qRecall = createNode({
    id: 'recall',
    title: 'Recall Code',
    prompt: 'A moment ago you picked code {{$code}}. Reverse those 4 digits now.',
    maxAttempts: 2,
    ui: { x: 460, y: 160 },
  });

  const doneEnd = createNode({
    id: 'done',
    type: 'end',
    title: 'Tracker Complete',
    outcome: 'pass',
    score: 20,
    ui: { x: 800, y: 160 },
  });

  qPick.edges = [
    createEdge({
      label: 'captured 4 digits',
      to: 'recall',
      condition: { type: 'regex', value: '(?<code>\\b\\d{4}\\b)' },
    }),
  ];

  qRecall.edges = [
    createEdge({
      label: 'any 4 digits answer',
      to: 'done',
      condition: { type: 'regex', value: '\\b\\d{4}\\b' },
    }),
  ];

  return createFlow({
    id: 'tpl_state',
    name: 'Multi-turn State Tracker',
    description: 'Captures model output via named regex (?<code>\\d{4}) and interpolates it into the next prompt.',
    startId: 'pick',
    nodes: { pick: qPick, recall: qRecall, done: doneEnd },
    settings: { memory: 'isolated' },
  });
}
