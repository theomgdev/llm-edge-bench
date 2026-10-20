/**
 * graph.js — interactive DAG/graph visualizer & canvas editor.
 *
 * Direct DOM + SVG rendering. Zero framework dependencies.
 * Supports:
 *   - Pan & zoom (wheel, drag background)
 *   - Node drag & snap
 *   - Port-to-port edge dragging
 *   - Live node glow during benchmark execution
 *   - SVG cubic bezier curves with directional arrows & condition badges
 */

import { describeCondition } from '../../core/matchers.js';
import { nodeLabel } from '../../core/engine.js';

export class GraphView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {SVGSVGElement} opts.svg
   * @param {SVGGElement} opts.edgesLayer
   * @param {HTMLElement} opts.nodesLayer
   * @param {SVGPathElement} opts.draftEdge
   * @param {HTMLElement} opts.emptyHint
   * @param {HTMLElement} opts.hudZoom
   * @param {HTMLElement} opts.hudNodeCount
   * @param {HTMLElement} opts.hudEdgeCount
   * @param {(nodeId:string|null)=>void} opts.onSelectNode
   * @param {(edgeId:string|null, fromNodeId:string|null)=>void} opts.onSelectEdge
   * @param {(fromNodeId:string, toNodeId:string)=>void} opts.onCreateEdge
   * @param {()=>void} opts.onFlowMutated
   */
  constructor(opts) {
    this.opts = opts;
    this.flow = null;

    // Viewport transform: pan (x,y) and scale
    this.panX = 40;
    this.panY = 40;
    this.scale = 1.0;

    this.selectedNodeId = null;
    this.selectedEdge = null; // { edgeId, fromNodeId }

    this.activeNodeId = null; // for live run highlighting
    this.activeEdgeId = null;

    // Drag states
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    this.draggingNode = null; // { id, startX, startY, origX, origY }
    this.draftConn = null;    // { fromNodeId, startX, startY }

    this.nodeEls = new Map(); // id -> HTMLElement

    this.#initEvents();
  }

  setFlow(flow) {
    this.flow = flow;
    this.selectedNodeId = null;
    this.selectedEdge = null;
    this.activeNodeId = null;
    this.activeEdgeId = null;
    this.render();
  }

  render() {
    this.#applyTransform();
    this.#renderNodes();
    this.#renderEdges();
    this.#updateHud();
  }

  selectNode(id) {
    this.selectedNodeId = id;
    this.selectedEdge = null;
    for (const [nid, el] of this.nodeEls.entries()) {
      el.classList.toggle('selected', nid === id);
    }
    this.#updateEdgeStyles();
    this.opts.onSelectNode?.(id);
  }

  selectEdge(edgeId, fromNodeId) {
    this.selectedEdge = edgeId ? { edgeId, fromNodeId } : null;
    this.selectedNodeId = null;
    for (const el of this.nodeEls.values()) el.classList.remove('selected');
    this.#updateEdgeStyles();
    this.opts.onSelectEdge?.(edgeId, fromNodeId);
  }

  clearSelection() {
    this.selectedNodeId = null;
    this.selectedEdge = null;
    for (const el of this.nodeEls.values()) el.classList.remove('selected');
    this.#updateEdgeStyles();
    this.opts.onClearSelection?.();
  }

  setActiveRunState(nodeId, edgeId) {
    this.activeNodeId = nodeId;
    this.activeEdgeId = edgeId;
    for (const [nid, el] of this.nodeEls.entries()) {
      el.classList.toggle('is-active', nid === nodeId);
    }
    this.#updateEdgeStyles();
  }

  // ---------------------------------------------------------------- Nodes rendering
  #renderNodes() {
    const layer = this.opts.nodesLayer;
    layer.innerHTML = '';
    this.nodeEls.clear();

    if (!this.flow) return;
    const nodes = Object.values(this.flow.nodes || {});
    this.opts.emptyHint.style.display = nodes.length ? 'none' : 'block';

    for (const node of nodes) {
      const el = document.createElement('div');
      el.className = `bench-node ${node.type === 'end' ? 'node-end' : 'node-prompt'}`;
      if (node.id === this.flow.startId) el.classList.add('start-node');
      if (node.id === this.selectedNodeId) el.classList.add('selected');
      if (node.id === this.activeNodeId) el.classList.add('is-active');

      const x = node.ui?.x ?? 80;
      const y = node.ui?.y ?? 80;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.dataset.nodeId = node.id;

      // Badges
      let badgeHtml = '';
      if (node.type === 'end') {
        const cls = node.outcome === 'pass' ? 'badge-pass' : 'badge-fail';
        badgeHtml = `<span class="badge ${cls}">${(node.outcome || 'END').toUpperCase()}</span>`;
      } else if (node.maxAttempts) {
        badgeHtml = `<span class="badge badge-attempts">${node.maxAttempts}x</span>`;
      }

      el.innerHTML = `
        <div class="node-header">
          <span class="node-tag">${node.type === 'end' ? 'Outcome' : 'Prompt'}</span>
          <div class="node-badges">${badgeHtml}</div>
        </div>
        <div class="node-title" style="padding: 0 12px 4px 12px;">${escapeHtml(nodeLabel(node))}</div>
        <div class="node-body">${escapeHtml(node.prompt || (node.type === 'end' ? 'Terminal state' : 'No prompt set.'))}</div>
        <div class="node-footer">
          <span>${(node.edges || []).length} branches</span>
          <span>${node.score ? (node.score > 0 ? `+${node.score}` : node.score) + ' pts' : ''}</span>
        </div>
        <div class="port port-in" data-port="in" title="Incoming connection"></div>
        ${node.type !== 'end' ? '<div class="port port-out" data-port="out" title="Drag to connect"></div>' : ''}
      `;

      // Node selection & drag
      el.addEventListener('mousedown', (e) => {
        if (e.target.dataset.port === 'out') return; // port takes over
        e.stopPropagation();
        this.selectNode(node.id);
        this.draggingNode = {
          id: node.id,
          startX: e.clientX,
          startY: e.clientY,
          origX: node.ui?.x ?? 0,
          origY: node.ui?.y ?? 0,
        };
      });

      // Port dragging (create edge)
      const outPort = el.querySelector('.port-out');
      if (outPort) {
        outPort.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          const p = this.#getPortPos(node.id, 'out');
          this.draftConn = { fromNodeId: node.id, startX: p.x, startY: p.y };
          this.opts.draftEdge.style.display = 'block';
        });
      }

      layer.appendChild(el);
      this.nodeEls.set(node.id, el);
    }
  }

  // ---------------------------------------------------------------- Edges rendering
  #renderEdges() {
    const layer = this.opts.edgesLayer;
    layer.innerHTML = '';
    if (!this.flow) return;

    for (const node of Object.values(this.flow.nodes || {})) {
      for (const edge of node.edges || []) {
        if (!edge.to || !this.flow.nodes[edge.to]) continue;
        const g = this.#createEdgeGroup(node.id, edge);
        layer.appendChild(g);
      }
    }
  }

  #createEdgeGroup(fromNodeId, edge) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.edgeId = edge.id;
    g.dataset.fromNode = fromNodeId;
    g.dataset.toNode = edge.to;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('edge-path');
    path.setAttribute('marker-end', 'url(#arrow)');

    const p1 = this.#getPortPos(fromNodeId, 'out');
    const p2 = this.#getPortPos(edge.to, 'in');
    const d = this.#calcBezier(p1, p2);
    path.setAttribute('d', d);

    path.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectEdge(edge.id, fromNodeId);
    });

    g.appendChild(path);

    // Midpoint label
    const mid = this.#calcMidpoint(p1, p2);
    const labelText = edge.label || describeCondition(edge.condition);
    if (labelText) {
      const lg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      lg.classList.add('edge-label-group');

      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.classList.add('edge-label-bg');

      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.classList.add('edge-label-text');
      txt.textContent = labelText;
      txt.setAttribute('x', mid.x);
      txt.setAttribute('y', mid.y);

      lg.appendChild(bg);
      lg.appendChild(txt);
      lg.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectEdge(edge.id, fromNodeId);
      });
      g.appendChild(lg);

      // Size label background after text layout
      requestAnimationFrame(() => {
        try {
          const bbox = txt.getBBox();
          bg.setAttribute('x', bbox.x - 6);
          bg.setAttribute('y', bbox.y - 3);
          bg.setAttribute('width', bbox.width + 12);
          bg.setAttribute('height', bbox.height + 6);
        } catch { /* SVG may be detached */ }
      });
    }

    return g;
  }

  #updateEdgeStyles() {
    const groups = this.opts.edgesLayer.querySelectorAll('g[data-edge-id]');
    for (const g of groups) {
      const eid = g.dataset.edgeId;
      const isSel = this.selectedEdge && this.selectedEdge.edgeId === eid;
      const isTaken = this.activeEdgeId === eid;
      const path = g.querySelector('.edge-path');
      if (path) {
        path.classList.toggle('selected', !!isSel);
        path.classList.toggle('taken', !!isTaken);
        path.setAttribute('marker-end', isTaken ? 'url(#arrow-active)' : 'url(#arrow)');
      }
    }
  }

  // ---------------------------------------------------------------- Geometry
  #getPortPos(nodeId, kind) {
    const el = this.nodeEls.get(nodeId);
    const n = this.flow?.nodes?.[nodeId];
    const x = n?.ui?.x ?? 0;
    const y = n?.ui?.y ?? 0;

    // The ports are styled at `top: 50%; transform: translateY(-50%)`.
    // That means the port circle's vertical center is EXACTLY at 50% of the node height.
    const h = el ? el.offsetHeight : (n?.type === 'end' ? 135 : 154);
    const w = el ? el.offsetWidth : (n?.type === 'end' ? 220 : 260);

    const portX = kind === 'out' ? (x + w) : x;
    const portY = y + Math.round(h / 2);

    return { x: portX, y: portY };
  }

  #calcBezier(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    // Forward curve: smooth horizontal-to-horizontal cubic bezier (Blender / Unreal style)
    if (dx >= 20) {
      // Adaptive softness: scales with horizontal distance, with generous minimum
      const offset = Math.max(50, Math.min(dx * 0.55, 320));
      const c1x = p1.x + offset;
      const c1y = p1.y;
      const c2x = p2.x - offset;
      const c2y = p2.y;
      return `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    }

    // Backward / Loop connection (dx < 20):
    // Two smooth C1-continuous cubic curves passing through a rounded apex
    const absDy = Math.abs(dy);
    const loopX = Math.max(60, Math.min(140, Math.abs(dx) * 0.35 + 60));
    const clearance = Math.max(50, 85 - absDy * 0.15);
    const apexY = Math.min(p1.y, p2.y) - clearance;
    const midX = (p1.x + p2.x) / 2;

    return `M ${p1.x} ${p1.y} C ${p1.x + loopX} ${p1.y}, ${p1.x + loopX} ${apexY}, ${midX} ${apexY} C ${p2.x - loopX} ${apexY}, ${p2.x - loopX} ${p2.y}, ${p2.x} ${p2.y}`;
  }

  #calcMidpoint(p1, p2) {
    const dx = p2.x - p1.x;
    if (dx < 20) {
      const absDy = Math.abs(p2.y - p1.y);
      const clearance = Math.max(50, 85 - absDy * 0.15);
      return { x: (p1.x + p2.x) / 2, y: Math.min(p1.y, p2.y) - clearance };
    }
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }

  // ---------------------------------------------------------------- Viewport transform
  #applyTransform() {
    const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    this.opts.nodesLayer.style.transform = t;
    this.opts.edgesLayer.setAttribute('transform', `translate(${this.panX}, ${this.panY}) scale(${this.scale})`);
    if (this.opts.draftEdge) {
      this.opts.draftEdge.setAttribute('transform', `translate(${this.panX}, ${this.panY}) scale(${this.scale})`);
    }
    this.opts.hudZoom.textContent = `${Math.round(this.scale * 100)}%`;
  }

  #updateHud() {
    if (!this.flow) return;
    const n = Object.keys(this.flow.nodes || {}).length;
    let e = 0;
    for (const node of Object.values(this.flow.nodes || {})) e += (node.edges || []).length;
    this.opts.hudNodeCount.textContent = `${n} node${n === 1 ? '' : 's'}`;
    this.opts.hudEdgeCount.textContent = `${e} edge${e === 1 ? '' : 's'}`;
  }

  clientToGraph(clientX, clientY) {
    const rect = this.opts.container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.panX) / this.scale,
      y: (clientY - rect.top - this.panY) / this.scale,
    };
  }

  fitView() {
    if (!this.flow) return;
    const nodes = Object.values(this.flow.nodes || {});
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const x = n.ui?.x ?? 0, y = n.ui?.y ?? 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 260);
      maxY = Math.max(maxY, y + 140);
    }
    const rect = this.opts.container.getBoundingClientRect();
    const pad = 60;
    const graphW = maxX - minX + pad * 2;
    const graphH = maxY - minY + pad * 2;
    const sX = rect.width / graphW;
    const sY = rect.height / graphH;
    this.scale = Math.max(0.3, Math.min(1.4, Math.min(sX, sY)));
    this.panX = rect.width / 2 - ((minX + maxX) / 2) * this.scale;
    this.panY = rect.height / 2 - ((minY + maxY) / 2) * this.scale;
    this.render();
  }

  autoLayout() {
    if (!this.flow) return;
    // Layer assignment via BFS from start node
    const layers = new Map();
    const queue = [{ id: this.flow.startId, depth: 0 }];
    const visited = new Set();

    while (queue.length) {
      const { id, depth } = queue.shift();
      if (!id || visited.has(id) || !this.flow.nodes[id]) continue;
      visited.add(id);
      layers.set(id, Math.max(layers.get(id) || 0, depth));
      const n = this.flow.nodes[id];
      for (const e of n.edges || []) if (e.to) queue.push({ id: e.to, depth: depth + 1 });
      if (n.fallbackTarget) queue.push({ id: n.fallbackTarget, depth: depth + 1 });
    }

    // Unreachable nodes land on rightmost layer
    const maxDepth = Math.max(0, ...Array.from(layers.values()));
    for (const id of Object.keys(this.flow.nodes)) {
      if (!layers.has(id)) layers.set(id, maxDepth + 1);
    }

    // Group by layer
    const byLayer = new Map();
    for (const [id, l] of layers.entries()) {
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(id);
    }

    const colWidth = 440;
    const rowHeight = 180;
    const startX = 60;
    const startY = 80;

    for (const [layerIdx, ids] of byLayer.entries()) {
      ids.forEach((id, rowIdx) => {
        const n = this.flow.nodes[id];
        if (n) {
          n.ui = {
            x: startX + layerIdx * colWidth,
            y: startY + rowIdx * rowHeight,
          };
        }
      });
    }

    this.render();
    this.fitView();
    this.opts.onFlowMutated?.();
  }

  // ---------------------------------------------------------------- Events
  #initEvents() {
    const c = this.opts.container;

    // Pan with mouse drag on background
    c.addEventListener('mousedown', (e) => {
      if (e.target !== c && e.target !== this.opts.svg && !e.target.classList.contains('canvas-grid')) return;
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
      c.classList.add('panning');
      this.clearSelection();
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        this.panX = e.clientX - this.panStart.x;
        this.panY = e.clientY - this.panStart.y;
        this.#applyTransform();
        return;
      }
      if (this.draggingNode) {
        const dx = (e.clientX - this.draggingNode.startX) / this.scale;
        const dy = (e.clientY - this.draggingNode.startY) / this.scale;
        if (Math.hypot(dx, dy) > 2) {
          this.draggingNode.moved = true;
        }
        const n = this.flow?.nodes?.[this.draggingNode.id];
        if (n) {
          n.ui = {
            x: Math.round((this.draggingNode.origX + dx) / 10) * 10,
            y: Math.round((this.draggingNode.origY + dy) / 10) * 10,
          };
          const el = this.nodeEls.get(this.draggingNode.id);
          if (el) { el.style.left = `${n.ui.x}px`; el.style.top = `${n.ui.y}px`; }
          this.#renderEdges();
        }
        return;
      }
      if (this.draftConn) {
        const p2 = this.clientToGraph(e.clientX, e.clientY);
        const p1 = { x: this.draftConn.startX, y: this.draftConn.startY };
        const d = this.#calcBezier(p1, p2);
        this.opts.draftEdge.setAttribute('d', d);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isPanning) {
        this.isPanning = false;
        c.classList.remove('panning');
      }
      if (this.draggingNode) {
        const moved = this.draggingNode.moved;
        this.draggingNode = null;
        if (moved) {
          this.opts.onFlowMutated?.();
        }
      }
      if (this.draftConn) {
        // Did we drop onto an in-port?
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const nodeEl = target?.closest('.bench-node');
        const toNodeId = nodeEl?.dataset?.nodeId;
        if (toNodeId && toNodeId !== this.draftConn.fromNodeId) {
          this.opts.onCreateEdge?.(this.draftConn.fromNodeId, toNodeId);
        }
        this.draftConn = null;
        this.opts.draftEdge.style.display = 'none';
        this.opts.draftEdge.setAttribute('d', '');
      }
    });

    // Zoom on wheel (centered at mouse)
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(0.2, Math.min(2.5, this.scale * factor));

      // preserve point under cursor
      this.panX = mouseX - (mouseX - this.panX) * (newScale / this.scale);
      this.panY = mouseY - (mouseY - this.panY) * (newScale / this.scale);
      this.scale = newScale;
      this.#applyTransform();
    }, { passive: false });
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
