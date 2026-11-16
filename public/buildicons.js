// Small icons for the Build maker's cards: each support, keystone, notable, mastery, jewel, unique, aura and flask
// is drawn as its in-game picture, and its name shows in a pop-up on hover or keyboard focus (or a tap on a phone).
// public/data/builds/icons-poe1.json (scripts/build_icons.py) says where each picture is; the pictures themselves
// come from Grinding Gear Games' image server (web.poecdn.com). Until that file loads, or for a name it doesn't
// know, a piece is shown as its name, as before.
const ICONS_FILE = 'data/builds/icons-poe1.json';
const ICON_SIZE = 26; // pixels; also in style.css (.bm-icon)
const TIP_GAP = 6; // pixels between an icon and its pop-up
const TIP_MARGIN = 8; // the pop-up keeps this far from the window's edges

const icons = {
  status: 'idle', // idle -> loading -> ready | failed
  sheets: [], passives: new Map(), items: new Map(), itemImageUrl: '',
};

// ---------- loading ----------
// Starts loading the icon file the first time a card asks; the cards are drawn again (rerender) when it arrives.
function loadIconsOnce(rerender) {
  if (icons.status !== 'idle') {
    return;
  }
  icons.status = 'loading';
  fetch(ICONS_FILE)
    .then(response => {
      if (!response.ok) {
        throw new Error(ICONS_FILE + ' answered ' + response.status);
      }
      return response.json();
    })
    .then(data => {
      icons.sheets = data.sheets;
      icons.passives = new Map(Object.entries(data.passives));
      icons.items = new Map(Object.entries(data.items));
      icons.itemImageUrl = data.itemImageUrl;
      icons.status = 'ready';
      rerender();
    })
    .catch(() => {
      icons.status = 'failed'; // the cards keep showing names
    });
}

// ---------- finding a piece's picture ----------
// The names the cards hold aren't always an item's or node's name: an aura can say "Anger (Eternal Blessing)",
// a jewel or mastery line is "Name: what it does", and a transfigured gem ("Armageddon Brand of Volatility")
// has its base gem's picture. Each form is tried in turn.
// A cluster jewel line puts its brackets before the colon: "Large Cluster Jewel (Spell Damage): Conjured Wall, ...".
function namesToTry(name) {
  const tries = [name];
  const colon = name.indexOf(':');
  const beforeColon = colon > 0 ? name.slice(0, colon) : name;
  if (beforeColon !== name) {
    tries.push(beforeColon);
  }
  const withoutBrackets = beforeColon.replace(/\s*\([^)]*\)\s*$/, '');
  if (withoutBrackets !== beforeColon) {
    tries.push(withoutBrackets);
  }
  const transfigured = withoutBrackets.match(/^(.+) of [A-Z][\w' -]*$/);
  if (transfigured) {
    tries.push(transfigured[1]);
  }
  return tries;
}

function passiveSpot(name) {
  for (const candidate of namesToTry(name)) {
    if (icons.passives.has(candidate)) {
      return icons.passives.get(candidate);
    }
  }
  return null;
}

function itemPath(name) {
  for (const candidate of namesToTry(name)) {
    if (icons.items.has(candidate)) {
      return icons.items.get(candidate);
    }
  }
  return null;
}

// A passive's picture is one square of a sprite sheet: the sheet is scaled so that square fills the icon.
function passivePicture(X, spot) {
  const [sheetIndex, x, y, width, height] = spot;
  const sheet = icons.sheets[sheetIndex];
  const scale = ICON_SIZE / Math.max(width, height);
  const style = [
    'background-image:url("' + sheet.url + '")',
    'background-size:' + (sheet.w * scale).toFixed(1) + 'px ' + (sheet.h * scale).toFixed(1) + 'px',
    'background-position:' + (-x * scale).toFixed(1) + 'px ' + (-y * scale).toFixed(1) + 'px',
  ].join(';');
  return X.el('span', { class: 'bm-icon-sprite', style });
}

// Some item art is several layers side by side in one picture, which the game draws on top of each other:
// a skill gem is three squares (its skill's symbol, a shine, the gem), a flask three tall frames (its metal
// decoration, the glass, the liquid). Once the picture has loaded its shape tells which; such a picture is
// drawn as stacked layers instead, the first frame on top.
const LAYERED_SHAPES = [
  { frames: 3, frameWidthOverHeight: 1 }, // skill gems
  { frames: 3, frameWidthOverHeight: 0.5 }, // flasks
];

function layeredShape(width, height) {
  for (const shape of LAYERED_SHAPES) {
    const expectedWidth = height * shape.frameWidthOverHeight * shape.frames;
    if (Math.abs(width - expectedWidth) < 1) {
      return shape;
    }
  }
  return null;
}

function stackedLayers(X, source, shape) {
  const frameHeight = ICON_SIZE;
  const frameWidth = ICON_SIZE * shape.frameWidthOverHeight;
  const images = [];
  const positions = [];
  for (let frame = 0; frame < shape.frames; frame += 1) {
    images.push('url("' + source + '")');
    positions.push(-frame * frameWidth + 'px 0');
  }
  const style = [
    'width:' + frameWidth + 'px',
    'height:' + frameHeight + 'px',
    'background-image:' + images.join(','),
    'background-size:' + frameWidth * shape.frames + 'px ' + frameHeight + 'px',
    'background-position:' + positions.join(','),
  ].join(';');
  return X.el('span', { class: 'bm-icon-sprite', style });
}

function itemPicture(X, path) {
  const source = icons.itemImageUrl + path.split('/').map(encodeURIComponent).join('/') + '.png';
  const image = X.el('img', { src: source, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' });
  image.addEventListener('load', () => {
    const shape = layeredShape(image.naturalWidth, image.naturalHeight);
    if (shape) {
      image.replaceWith(stackedLayers(X, source, shape));
    }
  }, { once: true });
  return image;
}

// kind: 'passive' looks on the tree's sprite sheets, 'item' among gems, uniques, flasks and jewels. A passive
// not on the tree may still have an item's picture: a timeless jewel's keystone shows its jewel.
function picture(X, name, kind) {
  if (icons.status !== 'ready') {
    return null;
  }
  if (kind === 'passive') {
    const spot = passiveSpot(name);
    if (spot) {
      return passivePicture(X, spot);
    }
  }
  const path = itemPath(name);
  return path ? itemPicture(X, path) : null;
}

// ---------- drawing a line of icons ----------
// One piece: its picture with the name in a pop-up, or its name in words where there is no picture.
// tip is the pop-up's text (the name, and a share or the mastery's option where the card has one).
function pieceText(X, piece) {
  return X.el('li', { class: 'bm-icon-text' }, piece.label, piece.note ? X.el('span', { class: 'muted' }, ' ' + piece.note) : null);
}

function pieceIcon(X, piece, kind, shape) {
  const image = picture(X, piece.name, kind);
  if (!image) {
    return pieceText(X, piece);
  }
  const tip = piece.note ? piece.tip + ' · ' + piece.note : piece.tip;
  const item = X.el('li', {},
    X.el('span', { class: 'bm-icon bm-icon-' + shape, tabindex: 0, role: 'img', 'aria-label': tip, 'data-tip': tip }, image));
  // A picture poecdn doesn't have (or that doesn't load) turns back into the piece's name.
  if (image.tagName === 'IMG') {
    image.addEventListener('error', () => item.replaceWith(pieceText(X, piece)), { once: true });
  }
  return item;
}

// pieces: [{ name, label?, tip?, note? }]. name finds the picture; label is the words shown without one (name by
// default); tip is the pop-up (label by default); note is added after both (a share, say).
// options: kind ('passive' or 'item'), shape ('square' or 'round'), title (the whole line's browser tooltip),
// extra (an element after the icons).
export function iconLine(X, label, pieces, options = {}) {
  if (!pieces || pieces.length === 0) {
    return null;
  }
  loadIconsOnce(X.rerender);
  watchTips();
  const items = [];
  for (const piece of pieces) {
    const filled = { ...piece, label: piece.label ?? piece.name };
    filled.tip = piece.tip ?? filled.label;
    items.push(pieceIcon(X, filled, options.kind ?? 'item', options.shape ?? 'square'));
  }
  return X.el('div', { class: 'bm-list bm-icon-list', title: options.title ?? null },
    X.el('span', { class: 'bm-list-label' }, label),
    X.el('ul', {}, items),
    options.extra ?? null);
}

// ---------- the pop-up ----------
// One pop-up for the whole page, placed by script so it stays inside the window (a card at the edge of the
// screen would otherwise cut it off) and so long texts (a mastery's option) can wrap.
let tipElement = null;
let tipOwner = null;

function showTip(owner) {
  if (!tipElement) {
    tipElement = document.createElement('div');
    tipElement.className = 'bm-tip';
    tipElement.setAttribute('aria-hidden', 'true'); // screen readers hear the icon's own label
    document.body.append(tipElement);
  }
  tipOwner = owner;
  tipElement.textContent = owner.dataset.tip;
  tipElement.hidden = false;
  placeTip(owner);
}

function placeTip(owner) {
  const box = owner.getBoundingClientRect();
  const tipWidth = tipElement.offsetWidth;
  const tipHeight = tipElement.offsetHeight;
  const centred = box.left + box.width / 2 - tipWidth / 2;
  const left = Math.max(TIP_MARGIN, Math.min(centred, window.innerWidth - tipWidth - TIP_MARGIN));
  let top = box.top - tipHeight - TIP_GAP;
  if (top < TIP_MARGIN) {
    top = box.bottom + TIP_GAP; // no room above: below the icon
  }
  tipElement.style.left = left + 'px';
  tipElement.style.top = top + 'px';
}

function hideTip() {
  tipOwner = null;
  if (tipElement) {
    tipElement.hidden = true;
  }
}

function tipOwnerOf(target) {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest('[data-tip]');
}

let watching = false;
function watchTips() {
  if (watching || typeof document === 'undefined') {
    return;
  }
  watching = true;
  // Moving onto anything that isn't an icon hides the pop-up, which also covers an icon a redraw removed.
  document.addEventListener('mouseover', event => {
    const owner = tipOwnerOf(event.target);
    if (owner) {
      showTip(owner);
    } else if (tipOwner && document.activeElement !== tipOwner) {
      hideTip();
    }
  });
  document.addEventListener('focusin', event => {
    const owner = tipOwnerOf(event.target);
    if (owner) {
      showTip(owner);
    } else {
      hideTip();
    }
  });
  document.addEventListener('focusout', event => {
    if (tipOwnerOf(event.target) === tipOwner) {
      hideTip();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideTip();
    }
  });
  window.addEventListener('scroll', hideTip, { passive: true, capture: true });
  window.addEventListener('resize', hideTip, { passive: true });
}
