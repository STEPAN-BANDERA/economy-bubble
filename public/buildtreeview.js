// The Build maker's passive tree view: the whole tree drawn as SVG, the planned build's nodes, links, masteries
// and jewel sockets lit up, with panning, zooming and a description of each node on hover. Positions come from
// GGG's tree export (scripts/build_sources.py works them out from each node's group, orbit and slot).
//
//   treeView(X, tree, planned, key, describeEffect) -> an element
//
// tree: public/buildtree.js's prepared tree; planned: the build's planned tree ({nodes, masteries, jewels});
// key: what the view's zoom is remembered under while the page re-renders; describeEffect: the generator's wording
// of an effect, for the hover text.

const SVG = 'http://www.w3.org/2000/svg';
const NODE_RADIUS = { small: 36, notable: 58, keystone: 80, jewel: 52, start: 100 };
const MASTERY_RADIUS = 44;
const FIT_PADDING = 700;
const ZOOM_STEP = 1.25;
const MIN_WIDTH = 600;
const VIEW_HEIGHT_PX = 460;

const views = new Map(); // key -> {x, y, w, h}: the zoom and pan of each view, kept across re-renders
const drawings = new WeakMap(); // tree -> the static parts of the drawing

export function treeView(X, tree, planned, key, describeEffect) {
  const allocated = new Set(planned.nodes || []);
  const masteryText = new Map();
  for (const mastery of planned.masteries || []) {
    masteryText.set(mastery.id, mastery);
  }
  const jewelOf = new Map();
  for (const jewel of planned.jewels || []) {
    jewelOf.set(jewel.socket, jewel);
  }
  const bounds = boundsOf(tree, [...allocated]);
  const whole = boundsOf(tree, [...tree.nodes.keys()]);
  if (!views.has(key)) {
    views.set(key, fitBox(bounds));
  }
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'tv-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Passive tree: ' + allocated.size + ' nodes allocated');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.height = VIEW_HEIGHT_PX + 'px';
  svg.innerHTML = drawingOf(tree) + litPart(tree, allocated, masteryText, jewelOf);
  const applyView = () => {
    const box = views.get(key);
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  };
  applyView();
  const tooltip = X.el('div', { class: 'tv-tip', hidden: true });
  attachPanAndZoom(svg, key, applyView, whole);
  attachTooltip(svg, tooltip, tree, allocated, masteryText, jewelOf, describeEffect);
  const zoomBy = factor => () => {
    zoomAround(views.get(key), factor, null);
    applyView();
  };
  const reset = box => () => {
    views.set(key, fitBox(box));
    applyView();
  };
  return X.el('div', { class: 'tv' },
    X.el('div', { class: 'tv-bar' },
      X.el('span', { class: 'muted small' }, 'Passive tree · ' + planned.points + ' points · drag to move, wheel to zoom'),
      X.el('span', { class: 'tv-buttons' },
        X.el('button', { type: 'button', class: 'ghost', onclick: zoomBy(1 / ZOOM_STEP), 'aria-label': 'Zoom in' }, '+'),
        X.el('button', { type: 'button', class: 'ghost', onclick: zoomBy(ZOOM_STEP), 'aria-label': 'Zoom out' }, '−'),
        X.el('button', { type: 'button', class: 'ghost', onclick: reset(bounds) }, 'Fit build'),
        X.el('button', { type: 'button', class: 'ghost', onclick: reset(whole) }, 'Whole tree'))),
    X.el('div', { class: 'tv-frame' }, svg, tooltip));
}

// ---------- drawing ----------
function boundsOf(tree, ids) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const position = tree.nodes.get(id)?.position;
    if (!position) {
      continue;
    }
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }
  if (!isFinite(minX)) {
    return { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  }
  return { minX, minY, maxX, maxY };
}

function fitBox(bounds) {
  const w = Math.max(MIN_WIDTH, bounds.maxX - bounds.minX + 2 * FIT_PADDING);
  const h = Math.max(MIN_WIDTH * 0.6, bounds.maxY - bounds.minY + 2 * FIT_PADDING);
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  return { x: centreX - w / 2, y: centreY - h / 2, w, h };
}

// Every link once: an arc along the orbit when both ends share a group and orbit, a straight line otherwise.
function linkPath(tree, from, to) {
  const a = from.position;
  const b = to.position;
  if (a.group === b.group && a.orbit === b.orbit && a.orbit > 0) {
    const centre = tree.groups[a.group];
    const radius = tree.orbitRadii[a.orbit];
    if (centre && radius) {
      let turn = Math.atan2(b.y - centre.y, b.x - centre.x) - Math.atan2(a.y - centre.y, a.x - centre.x);
      while (turn <= -Math.PI) {
        turn += 2 * Math.PI;
      }
      while (turn > Math.PI) {
        turn -= 2 * Math.PI;
      }
      return `M${a.x} ${a.y}A${radius} ${radius} 0 0 ${turn > 0 ? 1 : 0} ${b.x} ${b.y}`;
    }
  }
  return `M${a.x} ${a.y}L${b.x} ${b.y}`;
}

function eachLink(tree, visit) {
  for (const node of tree.nodes.values()) {
    if (!node.position) {
      continue;
    }
    for (const otherId of node.neighbours) {
      const other = tree.nodes.get(otherId);
      if (!other?.position || otherId < node.id) {
        continue;
      }
      visit(node, other);
    }
  }
}

function nodeRadius(node) {
  return NODE_RADIUS[node.kind] ?? NODE_RADIUS.small;
}

// The parts that don't depend on the build, drawn once per tree.
function drawingOf(tree) {
  if (drawings.has(tree)) {
    return drawings.get(tree);
  }
  const links = [];
  eachLink(tree, (node, other) => links.push(linkPath(tree, node, other)));
  const parts = [`<path class="tv-link" d="${links.join('')}"/>`];
  for (const mastery of tree.masteries) {
    if (mastery.position) {
      parts.push(`<circle class="tv-mastery" cx="${mastery.position.x}" cy="${mastery.position.y}" r="${MASTERY_RADIUS}" data-mastery="${mastery.id}"/>`);
    }
  }
  for (const node of tree.nodes.values()) {
    if (!node.position) {
      continue;
    }
    parts.push(nodeShape(node, 'tv-node tv-' + node.kind));
  }
  const drawing = parts.join('');
  drawings.set(tree, drawing);
  return drawing;
}

function nodeShape(node, className) {
  const { x, y } = node.position;
  const radius = nodeRadius(node);
  if (node.kind === 'jewel') {
    return `<rect class="${className}" x="${x - radius}" y="${y - radius}" width="${2 * radius}" height="${2 * radius}" transform="rotate(45 ${x} ${y})" data-node="${node.id}"/>`;
  }
  return `<circle class="${className}" cx="${x}" cy="${y}" r="${radius}" data-node="${node.id}"/>`;
}

// The build's part, drawn over the rest: its links, then its nodes and masteries.
function litPart(tree, allocated, masteryText, jewelOf) {
  const links = [];
  eachLink(tree, (node, other) => {
    if (allocated.has(node.id) && allocated.has(other.id)) {
      links.push(linkPath(tree, node, other));
    }
  });
  const parts = [`<path class="tv-link on" d="${links.join('')}"/>`];
  for (const mastery of tree.masteries) {
    if (mastery.position && masteryText.has(mastery.id)) {
      parts.push(`<circle class="tv-mastery on" cx="${mastery.position.x}" cy="${mastery.position.y}" r="${MASTERY_RADIUS * 1.3}" data-mastery="${mastery.id}"/>`);
    }
  }
  for (const id of allocated) {
    const node = tree.nodes.get(id);
    if (!node?.position) {
      continue;
    }
    const extra = node.kind === 'jewel' && jewelOf.get(id)?.kind === 'cluster' ? ' tv-cluster' : '';
    parts.push(nodeShape(node, 'tv-node on tv-' + node.kind + extra));
  }
  return parts.join('');
}

// ---------- moving around ----------
function zoomAround(box, factor, point) {
  const centreX = point ? point.x : box.x + box.w / 2;
  const centreY = point ? point.y : box.y + box.h / 2;
  box.x = centreX - (centreX - box.x) * factor;
  box.y = centreY - (centreY - box.y) * factor;
  box.w *= factor;
  box.h *= factor;
}

function svgPoint(svg, event) {
  const matrix = svg.getScreenCTM();
  if (!matrix) {
    return null;
  }
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function attachPanAndZoom(svg, key, applyView, whole) {
  const largest = Math.max(whole.maxX - whole.minX, whole.maxY - whole.minY) * 1.6;
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    const box = views.get(key);
    const factor = event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    if ((factor > 1 && box.w * factor > largest) || (factor < 1 && box.w * factor < MIN_WIDTH)) {
      return;
    }
    zoomAround(box, factor, svgPoint(svg, event));
    applyView();
  }, { passive: false });
  let dragging = null;
  svg.addEventListener('pointerdown', event => {
    dragging = { x: event.clientX, y: event.clientY };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', event => {
    if (!dragging) {
      return;
    }
    const box = views.get(key);
    const scale = box.w / svg.clientWidth;
    box.x -= (event.clientX - dragging.x) * scale;
    box.y -= (event.clientY - dragging.y) * scale;
    dragging = { x: event.clientX, y: event.clientY };
    applyView();
  });
  const stop = event => {
    dragging = null;
    svg.classList.remove('dragging');
    if (svg.hasPointerCapture?.(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
  };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
}

// ---------- hover text ----------
function attachTooltip(svg, tooltip, tree, allocated, masteryText, jewelOf, describeEffect) {
  svg.addEventListener('pointerover', event => {
    const target = event.target;
    const lines = describeTarget(target, tree, allocated, masteryText, jewelOf, describeEffect);
    if (!lines) {
      tooltip.hidden = true;
      return;
    }
    tooltip.replaceChildren();
    lines.forEach((line, index) => {
      const row = document.createElement(index === 0 ? 'strong' : 'div');
      row.textContent = line;
      tooltip.append(row);
    });
    tooltip.hidden = false;
  });
  svg.addEventListener('pointermove', event => {
    if (tooltip.hidden) {
      return;
    }
    const frame = svg.getBoundingClientRect();
    tooltip.style.left = Math.min(frame.width - 240, event.clientX - frame.left + 14) + 'px';
    tooltip.style.top = (event.clientY - frame.top + 14) + 'px';
  });
  svg.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
  });
}

function describeTarget(target, tree, allocated, masteryText, jewelOf, describeEffect) {
  const nodeId = target.getAttribute?.('data-node');
  if (nodeId) {
    const node = tree.nodes.get(nodeId);
    if (!node) {
      return null;
    }
    const lines = [node.name || (node.kind === 'jewel' ? 'Jewel socket' : 'Passive')];
    if (node.kind === 'jewel') {
      const jewel = jewelOf.get(nodeId);
      lines.push(jewel ? jewel.name : node.largeCluster ? 'Takes a jewel or a large cluster jewel' : 'Takes a jewel');
    }
    for (const effect of node.effects.slice(0, 6)) {
      lines.push(describeEffect(effect));
    }
    if (allocated.has(nodeId)) {
      lines.push('(allocated)');
    }
    return lines;
  }
  const masteryId = target.getAttribute?.('data-mastery');
  if (masteryId) {
    const chosen = masteryText.get(masteryId);
    const mastery = tree.masteries.find(entry => entry.id === masteryId);
    if (!mastery) {
      return null;
    }
    return chosen ? [mastery.name, ...chosen.text.split('\n'), '(chosen)'] : [mastery.name];
  }
  return null;
}
