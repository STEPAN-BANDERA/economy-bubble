// The Build maker's passive tree view: the whole tree drawn as SVG, the planned build's nodes, links, masteries
// and jewel sockets lit up, with panning, zooming and each node's wording (GGG's own, from the tree export) on hover. Positions come from
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

// A socketed large cluster jewel's passives, as the game lays out an 8-passive one with 3 notables: 12 places 30 degrees
// apart round the ring, the entrance at place 0 facing the socket; jewel sockets at 4 and 8, the notables at 6, 10 and
// 2 (best first), small passives at 0, 7 and 5. Path of Building's cluster tables give the same places (a check, not
// the source). The places taken are linked in order round the ring, the last back to the entrance.
const CLUSTER_PLACES = 12;
const CLUSTER_SOCKET_PLACES = [4, 8];
const CLUSTER_NOTABLE_PLACES = [6, 10, 2];
const CLUSTER_SMALL_PLACES = [0, 7, 5];

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
  const clusters = clusterLayouts(tree, planned.jewels || []);
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
  const floating = new Set(planned.floating || []);
  svg.innerHTML = drawingOf(tree) + radiusPart(tree, planned.jewels || []) + clusterPart(clusters)
    + litPart(tree, allocated, masteryText, jewelOf, floating);
  const applyView = () => {
    const box = views.get(key);
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  };
  applyView();
  const tooltip = X.el('div', { class: 'tv-tip', hidden: true });
  attachPanAndZoom(svg, key, applyView, whole);
  attachTooltip(svg, tooltip, tree, allocated, masteryText, jewelOf, clusters, describeEffect);
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

// The areas of the radius jewels socketed (public/buildradius.js): a circle, or a ring for Thread of Hope, round the
// socket or round Impossible Escape's keystone.
function radiusPart(tree, jewels) {
  const parts = [];
  for (const jewel of jewels) {
    const centre = jewel.area ? tree.nodes.get(jewel.area.centre)?.position : null;
    if (!centre) {
      continue;
    }
    const className = 'tv-radius' + (jewel.free ? ' tv-radius-free' : '');
    parts.push(`<circle class="${className}" cx="${centre.x}" cy="${centre.y}" r="${jewel.area.outer}"/>`);
    if (jewel.area.inner > 0) {
      parts.push(`<circle class="${className}" cx="${centre.x}" cy="${centre.y}" r="${jewel.area.inner}"/>`);
    }
  }
  return parts.join('');
}

// The build's part, drawn over the rest: its links, then its nodes and masteries. A passive taken through a
// free-allocation jewel (floating) isn't joined to the tree, so its links aren't lit.
function litPart(tree, allocated, masteryText, jewelOf, floating) {
  const links = [];
  eachLink(tree, (node, other) => {
    if (allocated.has(node.id) && allocated.has(other.id) && !floating.has(node.id) && !floating.has(other.id)) {
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
    let extra = '';
    if (node.kind === 'jewel' && jewelOf.get(id)?.kind === 'cluster') {
      extra = ' tv-cluster';
    } else if (node.kind === 'jewel' && (jewelOf.get(id)?.kind === 'radius' || jewelOf.get(id)?.kind === 'timeless')) {
      extra = ' tv-unique-jewel';
    } else if (floating.has(id)) {
      extra = ' tv-free';
    }
    parts.push(nodeShape(node, 'tv-node on tv-' + node.kind + extra));
  }
  return parts.join('');
}

// ---------- socketed cluster jewels ----------
// Each large cluster the build socketed, laid out on its socket's ring: [{socket, jewel, ring, places: [{index, kind,
// x, y, name}]}]. A socket without ring data (a tree file built before it was kept) draws no cluster.
function clusterLayouts(tree, jewels) {
  const layouts = [];
  for (const jewel of jewels) {
    if (jewel.kind !== 'cluster') {
      continue;
    }
    const ring = tree.nodes.get(jewel.socket)?.clusterRing;
    if (!ring) {
      continue;
    }
    const places = [];
    for (const index of CLUSTER_SOCKET_PLACES) {
      places.push(clusterPlace(ring, index, 'socket', 'Jewel socket inside the cluster (allocated on the way to the notables; no jewel planned in it)'));
    }
    const notables = jewel.notables || [];
    for (let position = 0; position < CLUSTER_NOTABLE_PLACES.length; position += 1) {
      places.push(clusterPlace(ring, CLUSTER_NOTABLE_PLACES[position], 'notable', notables[position] || 'Cluster notable'));
    }
    for (const index of CLUSTER_SMALL_PLACES) {
      places.push(clusterPlace(ring, index, 'small', (jewel.clusterType || 'Cluster') + ' small passive'));
    }
    places.sort((first, second) => first.index - second.index);
    layouts.push({ socket: jewel.socket, socketPosition: tree.nodes.get(jewel.socket).position, jewel, ring, places });
  }
  return layouts;
}

// A place on the ring: angles count clockwise from straight up, as the tree's own orbits do.
function clusterPlace(ring, index, kind, name) {
  const [centreX, centreY, radius, entranceDegrees] = ring;
  const angle = (entranceDegrees + index * 360 / CLUSTER_PLACES) * Math.PI / 180;
  return { index, kind, name, x: Math.round(centreX + radius * Math.sin(angle)), y: Math.round(centreY - radius * Math.cos(angle)) };
}

// The clusters' links (the socket to the entrance, then round the ring) and passives: all 8 are allocated, the two
// sockets inside too, since every way round the ring to the notables passes one.
function clusterPart(clusters) {
  const parts = [];
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    const cluster = clusters[clusterIndex];
    const [, , radius] = cluster.ring;
    const places = cluster.places;
    let links = '';
    const entrance = places[0];
    const socketPosition = cluster.socketPosition;
    if (socketPosition) {
      links += `M${socketPosition.x} ${socketPosition.y}L${entrance.x} ${entrance.y}`;
    }
    for (let position = 0; position < places.length; position += 1) {
      const from = places[position];
      const to = places[(position + 1) % places.length];
      links += `M${from.x} ${from.y}A${radius} ${radius} 0 0 1 ${to.x} ${to.y}`;
    }
    parts.push(`<path class="tv-link on tv-cluster-link" d="${links}"/>`);
    for (let position = 0; position < places.length; position += 1) {
      const place = places[position];
      const kind = place.kind === 'socket' ? 'jewel' : place.kind;
      const radiusOfPlace = NODE_RADIUS[kind];
      const data = `data-cluster="${clusterIndex}:${position}"`;
      if (kind === 'jewel') {
        parts.push(`<rect class="tv-node on tv-jewel tv-cluster-socket" x="${place.x - radiusOfPlace}" y="${place.y - radiusOfPlace}" width="${2 * radiusOfPlace}" height="${2 * radiusOfPlace}" transform="rotate(45 ${place.x} ${place.y})" ${data}/>`);
      } else {
        parts.push(`<circle class="tv-node on tv-${kind} tv-cluster-node" cx="${place.x}" cy="${place.y}" r="${radiusOfPlace}" ${data}/>`);
      }
    }
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
function attachTooltip(svg, tooltip, tree, allocated, masteryText, jewelOf, clusters, describeEffect) {
  svg.addEventListener('pointerover', event => {
    const target = event.target;
    const lines = describeTarget(target, tree, allocated, masteryText, jewelOf, clusters, describeEffect);
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

// GGG's own wording of the node; a tree file built before the wording was kept falls back to our reading of it.
function hoverWording(node, describeEffect) {
  if (node.text) {
    return node.text.split('\n');
  }
  const lines = [];
  for (const effect of node.effects.slice(0, 6)) {
    lines.push(describeEffect(effect));
  }
  return lines;
}

// A cluster's passive: the notable's name, or the small passive's lines as the generator reads them.
function describeClusterPlace(clusterKey, clusters, describeEffect) {
  const [clusterIndex, position] = clusterKey.split(':').map(Number);
  const cluster = clusters[clusterIndex];
  const place = cluster?.places[position];
  if (!place) {
    return null;
  }
  const lines = [place.name, cluster.jewel.name];
  if (place.kind === 'small') {
    for (const effect of cluster.jewel.smallEffects || []) {
      lines.push(describeEffect(effect));
    }
  }
  lines.push('(allocated)');
  return lines;
}

function describeTarget(target, tree, allocated, masteryText, jewelOf, clusters, describeEffect) {
  const clusterKey = target.getAttribute?.('data-cluster');
  if (clusterKey) {
    return describeClusterPlace(clusterKey, clusters, describeEffect);
  }
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
    for (const line of hoverWording(node, describeEffect)) {
      lines.push(line);
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
