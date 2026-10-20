/**
 * flow-storage.js — persistent browser storage and library manager for flows.
 * Handles autosave, flow versioning, listing, duplication, and backups in localStorage.
 */

const STORAGE_SAVED_KEY = 'llm_edge_bench_saved_flows';
const STORAGE_CURRENT_KEY = 'llm_edge_bench_current_flow';

/**
 * Reads the full dictionary of saved flows.
 * @returns {Record<string, { flow: any, createdAt: number, updatedAt: number }>}
 */
function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_SAVED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Failed to read saved flows from localStorage:', err);
    return {};
  }
}

/**
 * Writes the full dictionary of saved flows to localStorage.
 * @param {Record<string, { flow: any, createdAt: number, updatedAt: number }>} dict
 */
function writeStorage(dict) {
  try {
    localStorage.setItem(STORAGE_SAVED_KEY, JSON.stringify(dict));
    return true;
  } catch (err) {
    console.error('Failed to write saved flows to localStorage:', err);
    return false;
  }
}

/**
 * Returns metadata list of all saved flows, sorted by updatedAt descending.
 * @returns {Array<{ id: string, name: string, description: string, nodeCount: number, edgeCount: number, startId: string, createdAt: number, updatedAt: number, flow: any }>}
 */
export function listSavedFlows() {
  const dict = readStorage();
  const list = Object.values(dict).map((entry) => {
    const flow = entry.flow || {};
    const nodes = flow.nodes || {};
    const nodeIds = Object.keys(nodes);
    let edgeCount = 0;
    for (const n of Object.values(nodes)) {
      edgeCount += (n.edges || []).length;
    }
    return {
      id: flow.id,
      name: flow.name || 'Untitled Flow',
      description: flow.description || '',
      nodeCount: nodeIds.length,
      edgeCount,
      startId: flow.startId || null,
      createdAt: entry.createdAt || Date.now(),
      updatedAt: entry.updatedAt || Date.now(),
      flow,
    };
  });

  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Gets a specific flow by ID.
 * @param {string} id
 * @returns {any | null}
 */
export function getSavedFlow(id) {
  if (!id) return null;
  const dict = readStorage();
  return dict[id]?.flow || null;
}

/**
 * Saves a flow to storage (creating or updating).
 * Also mirrors it to STORAGE_CURRENT_KEY if isCurrent is true.
 * @param {any} flow
 * @param {boolean} [isCurrent=true]
 */
export function saveFlow(flow, isCurrent = true) {
  if (!flow || !flow.id) return false;
  const dict = readStorage();
  const now = Date.now();
  const existing = dict[flow.id];

  dict[flow.id] = {
    flow,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const ok = writeStorage(dict);
  if (isCurrent) {
    try {
      localStorage.setItem(STORAGE_CURRENT_KEY, JSON.stringify(flow));
    } catch { /* quota exceeded */ }
  }
  return ok;
}

/**
 * Deletes a flow from storage by ID.
 * @param {string} id
 */
export function deleteSavedFlow(id) {
  if (!id) return false;
  const dict = readStorage();
  if (dict[id]) {
    delete dict[id];
    writeStorage(dict);
    return true;
  }
  return false;
}

/**
 * Duplicates an existing flow, assigns a new ID and '(Copy)' suffix.
 * @param {any} flow
 * @returns {any} cloned flow
 */
export function duplicateSavedFlow(flow) {
  if (!flow) return null;
  const clone = JSON.parse(JSON.stringify(flow));
  clone.id = `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  clone.name = `${flow.name || 'Flow'} (Copy)`;
  saveFlow(clone, true);
  return clone;
}

/**
 * Reads the currently active flow from localStorage.
 * @returns {any | null}
 */
export function getCurrentSavedFlow() {
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Initializes storage with default templates if the saved flows library is empty.
 * @param {Array<any>} templates
 */
export function initStorageWithTemplates(templates = []) {
  const dict = readStorage();
  if (Object.keys(dict).length === 0 && templates.length > 0) {
    const now = Date.now();
    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i];
      dict[tpl.id] = {
        flow: tpl,
        createdAt: now - (templates.length - i) * 60000,
        updatedAt: now - (templates.length - i) * 60000,
      };
    }
    writeStorage(dict);
  }
}
