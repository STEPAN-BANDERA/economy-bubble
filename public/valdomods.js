// Categories for Valdo's map modifiers, so the Valdo's maps tab can exclude a whole kind of
// modifier at once. The groupings and their wording are ours: a modifier goes to the first category
// whose patterns match its text, and anything no pattern reads lands in "Other" rather than being
// guessed. The patterns follow the wording poe.ninja shows for the maps (3.30, Covens of Umbra).

export const OTHER_CATEGORY_ID = 'other';

export const MOD_CATEGORIES = [
  {
    // First, because these decide whether the reward can be had at all, whatever else the map does.
    id: 'claim',
    label: 'Must finish to claim',
    title: 'The reward only drops once every encounter of a kind is completed, opened, released or defended',
    patterns: [
      /must be (completed|opened|released|stabilised)/i,
      /^must (complete|fully complete|successfully defend)/i,
      /to claim reward/i,
      /prevents reward from being claimed/i,
      /durability of ichor pumps/i,
      /cannot choose which ultimatum modifier/i,
    ],
  },
  {
    // A death here costs the map and its reward, or the map runs out on you.
    id: 'lose',
    label: 'Can lose the map',
    title: 'One death, a timer or a closing portal can end the run and lose the reward',
    patterns: [
      /sent to the void/i,
      /becomes fatal/i,
      /increasingly lethal/i,
      /only opens 1 portal/i,
      /portals to area close over time/i,
      /eventually detonate/i,
      /kill things with \d+% or lower life/i,
    ],
  },
  {
    id: 'slow',
    label: 'Slows you down',
    title: 'Less movement speed, no travel skills, or being locked in place',
    patterns: [
      /reduced movement speed/i,
      /travel skills are disabled/i,
      /random movement speed/i,
      /petrification/i,
      /grasping vine/i,
    ],
  },
  {
    // Rules that take away a defence or a share of damage the build was made with.
    id: 'weaker',
    label: 'Weakens your build',
    title: 'Takes away a defence, recovery, aura or damage the character relies on',
    patterns: [
      /players cannot (block|evade|suppress|gain flask charges|recover)/i,
      /less damage per (equipped item|item equipped)/i,
      /reduced effect of non-curse auras/i,
      /increased cost of skills/i,
      /debuffs on players expire/i,
      /only be damaged while within/i,
      /character size/i,
      /malediction/i,
      /driven mad/i,
      /possess players/i,
      /players reflect/i,
    ],
  },
  {
    id: 'bosses',
    label: 'Extra bosses and invaders',
    title: 'Added bosses, boss packs, exiles, apparitions and storms that hunt the player',
    patterns: [
      /map bosses/i,
      /duplicate of map boss/i,
      /area contains the (feared|forgotten|formed|remembered|twisted|elderslayers)/i,
      /gigantic rogue exiles/i,
      /assaulted by/i,
      /maven interferes/i,
      /deatomisation storms/i,
      /creeping agony/i,
      /kitava's heralds/i,
      /meteors/i,
      /corrupting tempest/i,
      /maddening tentacles/i,
      /hexfields/i,
      /detonation totems/i,
      /enemies of all influence types/i,
    ],
  },
  {
    // Before the monster category, which would otherwise take "Monsters drop no Items".
    id: 'loot',
    label: 'Loot and experience',
    title: 'Changes what drops, or stops experience',
    patterns: [
      /drops as currency/i,
      /drop no items/i,
      /do not gain experience/i,
    ],
  },
  {
    id: 'monsters',
    label: 'Tougher monsters',
    title: 'Monsters with more charges, projectiles, thorns, modifiers or possessing spirits',
    patterns: [
      /^monsters /i,
      /^rare monsters/i,
      /^rare and unique monsters/i,
      /^unique monsters/i,
      /^runic monsters/i,
      /^legion monsters/i,
      /union of souls/i,
      /^living weapons/i,
      /inhabited by/i,
      /frost walls/i,
      /additional random modifiers/i,
      /monsters from beyond/i,
      /attract monsters from beyond/i,
    ],
  },
  {
    id: 'party',
    label: 'Solo and portals',
    title: 'Who can enter, and how many ways back in',
    patterns: [
      /maximum number of players/i,
      /only opens \d+ portals/i,
      /portals to area only close/i,
    ],
  },
  {
    // Mostly welcome: more league content, packs and encounters to run through.
    id: 'content',
    label: 'Extra content',
    title: 'Added league encounters, packs and npcs: more to do, usually more loot',
    patterns: [
      /^areas? contains?/i,
      /^area is haunted/i,
      /^area has no chance/i,
      /^abysses in area/i,
      /delirious/i,
      /^players gain/i,
      /rampage/i,
      /shroud walker/i,
      /^smuggler's caches/i,
      /^unstable breaches/i,
      /^incursion architects/i,
      /increased damage while dead/i,
      /cannot be destroyed/i,
      /during rituals/i,
    ],
  },
];

const OTHER_CATEGORY = { id: OTHER_CATEGORY_ID, label: 'Other', title: 'Modifiers no category reads yet', patterns: [] };

export function modCategoryOf(modText) {
  for (const category of MOD_CATEGORIES) {
    for (const pattern of category.patterns) {
      if (pattern.test(modText)) {
        return category;
      }
    }
  }
  return OTHER_CATEGORY;
}

export function allModCategories() {
  return [...MOD_CATEGORIES, OTHER_CATEGORY];
}
