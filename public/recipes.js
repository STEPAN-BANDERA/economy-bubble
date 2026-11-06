// Deterministic "n of one item become 1 of another" recipes, generated from the
// exchange's own item names so new tiers and types are picked up automatically.
// Only chains whose ratio is fixed are listed; random rerolls (PoE2 essences,
// soul cores) are left out because their outcome is a gamble.

const POE1 = [
  { how: 'Sell 3 to any vendor', n: 3, chain: ['Whispering', 'Muttering', 'Weeping', 'Wailing', 'Screaming', 'Shrieking', 'Deafening'], name: (t, k) => `${t} Essence of ${k}`, re: /^(\w+) Essence of (.+)$/ },
  { how: 'Sell 3 to any vendor', n: 3, chain: ['Clear', 'Sepia', 'Amber', 'Verdant', 'Teal', 'Azure', 'Indigo', 'Violet', 'Crimson', 'Black', 'Opalescent', 'Silver'], name: t => `${t} Oil`, re: /^(\w+) Oil$/ },
];
const POE2 = [
  { how: 'Reforging bench, 3 of the same', n: 3, chain: ['Lesser', '', 'Greater'], name: (t, k) => `${t ? t + ' ' : ''}${k} Rune`, re: /^(?:(Lesser|Greater) )?(\w+) Rune$/ },
  { how: 'Reforging bench, 3 of the same', n: 3, chain: ['Diluted Liquid Ire', 'Diluted Liquid Guilt', 'Diluted Liquid Greed', 'Liquid Paranoia', 'Liquid Envy', 'Liquid Disgust', 'Liquid Despair', 'Concentrated Liquid Fear', 'Concentrated Liquid Suffering', 'Concentrated Liquid Isolation'], name: t => t, fixed: true },
];

// A full stack of shards or splinters turns into the whole item by itself.
const STACKS = {
  poe1: [
    ['Transmutation Shard', 'Orb of Transmutation', 20], ['Alteration Shard', 'Orb of Alteration', 20],
    ['Alchemy Shard', 'Orb of Alchemy', 20], ['Chaos Shard', 'Chaos Orb', 20], ['Regal Shard', 'Regal Orb', 20],
    ['Exalted Shard', 'Exalted Orb', 20], ['Annulment Shard', 'Orb of Annulment', 20], ['Divine Shard', 'Divine Orb', 20],
    ['Mirror Shard', 'Mirror of Kalandra', 20], ['Fracturing Shard', 'Fracturing Orb', 20],
    ['Simulacrum Splinter', 'Simulacrum', 300],
    ...['Eternal Empire', 'Karui', 'Maraketh', 'Templar', 'Vaal'].map(k => [`Timeless ${k} Splinter`, `Timeless ${k} Emblem`, 100]),
  ],
  poe2: [
    ['Transmutation Shard', 'Orb of Transmutation', 20], ['Regal Shard', 'Regal Orb', 20],
    ['Chance Shard', 'Orb of Chance', 20], ["Artificer's Shard", "Artificer's Orb", 20],
  ],
};

export function buildRecipes(game, items) {
  const byName = new Map(Object.entries(items).map(([id, it]) => [it.name, id]));
  const out = [];
  const add = (fromName, toName, n, how) => {
    const from = byName.get(fromName), to = byName.get(toName);
    if (from && to) out.push({ id: `${from}>${to}`, from, to, n, how });
  };
  for (const rule of game === 'poe2' ? POE2 : POE1) {
    if (rule.fixed) {
      for (let i = 0; i + 1 < rule.chain.length; i++) add(rule.chain[i], rule.chain[i + 1], rule.n, rule.how);
      continue;
    }
    // Every kind ("Wrath", "Desert", ...) that appears with a chain tier.
    const kinds = new Set();
    for (const name of byName.keys()) {
      const m = name.match(rule.re);
      if (m && rule.chain.includes(m[1] ?? '')) kinds.add(m[2] ?? '');
    }
    for (const k of kinds) {
      for (let i = 0; i + 1 < rule.chain.length; i++) add(rule.name(rule.chain[i], k), rule.name(rule.chain[i + 1], k), rule.n, rule.how);
    }
  }
  for (const [from, to, n] of STACKS[game] || []) add(from, to, n, `A full stack of ${n} becomes 1`);
  return out;
}
