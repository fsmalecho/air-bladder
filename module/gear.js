/**
 * Shared gear resolution for Mondolme.
 *
 * Gear is the single editable source of truth: it lives in Item compendia that a
 * Warden can unlock and edit. Character generation (2e AND Barebones), hireling
 * loadouts, bonds, and the marketplace all reference an item BY NAME and resolve
 * it here — so editing a pack item once flows everywhere it is granted.
 *
 * This is the resolve-time half. The author-time half (turning an inline
 * {name, tags, uses, ...} record into an item's type/system fields) is
 * `buildGearItem`, kept here too so the two halves stay in one place; the
 * tools/import/gear-2e.mjs authoring script carries a byte-identical copy of that
 * inference (Node can't import this browser module across the ESM/CJS boundary,
 * so the copies are kept in sync by hand — see the note there).
 *
 * Nothing here touches Foundry globals at module load; `game`/`foundry` are read
 * only inside resolveGearItem's body.
 */

import { iconForItem, SPELLSCROLL_ICON } from "./icons.js";
import { itemByName } from "./content-packs.js";

// The eight-pack precedence list that used to live here — seven gear packs plus
// two spellbook packs, each a shipped compendium id — is GONE (2026-08-29). The
// system ships no packs: gear and spells alike are ONE compendium the Warden
// names in a setting, resolved by `itemByName` (module/content-packs.js). The
// precedence rules that list encoded (which pack wins a duplicate name, whether
// market-only goods were reachable) cannot arise inside a single compendium,
// which is the whole reason the list could be deleted rather than re-pointed.

// Genuine spelling variants — NOT mere casing (the resolver is already
// case-insensitive). Key: lowercased grant spelling → canonical pack item name.
/**
 * Spellings a grant may use that are not the item's own name.
 *
 * EMPTY ON PURPOSE. Every entry here mapped one English spelling in the
 * upstream shipped content onto another ("torches" -> "Torch", "plate" ->
 * "Plate Mail"). None of that content exists any more: items now come from the
 * Warden's own Objetos compendium, named by the Warden, in Spanish.
 *
 * The mechanism is kept rather than deleted so a Warden whose backgrounds say
 * "antorchas" while the item is "Antorcha" has somewhere to say so, without
 * renaming either. Add pairs as `["lo que dice la concesión", "Nombre del objeto"]` —
 * the key must be lowercase; `resolveGearItem` lowercases before it looks.
 */
export const GEAR_ALIASES = new Map([]);

/* -------------------------------------------------------------------------- */
/*  What a granted item IS, for ordering it                                     */
/* -------------------------------------------------------------------------- */

/**
 * Light sources, BY NAME. There is no field for this: `weapon` and `armor` are
 * Item types, but a Torch, a Candle and a Lantern are all plain `type: "item"`
 * and nothing in the data says any of them gives light.
 *
 * A keyword match rather than an exact list, because it is right for the
 * background-items pack too — a Wisp Lantern and a Torch Fungus ("when crushed,
 * it creates a heatless light") are genuine light sources and an exact list
 * would have to grow an entry per background. The known cost is the Candle of
 * Ward, a ward that happens to burn, which files here; one item in the wrong
 * block, against a rule that keeps working when someone adds a Bullseye Lantern.
 */
export const LIGHT_SOURCE_RE = /\b(torch(es)?|lanterns?|lamps?|candles?)\b/i;

/**
 * What FEEDS a light source: lowercased fuel name → lowercased source name, so
 * the oil can be filed directly beneath the lamp it belongs to.
 *
 * An exact map and NOT a regex, and the asymmetry with LIGHT_SOURCE_RE above is
 * deliberate: `\boil\b` would swallow Fire Oil (a thrown incendiary) and
 * Miracle Oil, neither of which has ever gone into a lantern. A keyword rule is
 * safe for lights because every word in it names a light; there is no such word
 * for fuel.
 */
export const LIGHT_FUEL = new Map([
  ["oil can", "lantern"],
]);

/** Food, which sits at the very bottom of a granted loadout. */
export const RATIONS_RE = /\brations?\b/i;

/** True for a light source or the fuel that feeds one — the block that sits
 *  directly above Rations. */
export const isLightGear = (name) =>
  LIGHT_SOURCE_RE.test(String(name ?? "")) || LIGHT_FUEL.has(String(name ?? "").trim().toLowerCase());

/**
 * The six ordering bands a granted loadout is arranged into, lowest first.
 * Tested IN ORDER, which is what settles the overlaps: the Candle Helmet is
 * `type: "armor"`, so it files as armor rather than as a light, and a
 * spellbook named for a candle would still file as a book — type outranks
 * name throughout.
 *
 * `book` (2026-08-21, user ask): magic sorts together near the top, directly
 * after weapons and armor. ONE band for the Libro and the Hechizo — including
 * a Hechizo with Pergamino ticked — because a type test is the only marker
 * that survives renaming a spell, and a scroll is still the same type as the
 * spell it holds.
 */
export const GRANT_BANDS = { weapon: 0, armor: 1, book: 2, other: 3, light: 4, rations: 5 };

/** Which band a built item belongs to. @param {Object} item @returns {Number} */
export const grantBand = (item) => {
  if (item?.type === "weapon") return GRANT_BANDS.weapon;
  if (item?.type === "armor") return GRANT_BANDS.armor;
  if (item?.type === "book" || item?.type === "spell") return GRANT_BANDS.book;
  const name = String(item?.name ?? "");
  if (RATIONS_RE.test(name)) return GRANT_BANDS.rations;
  if (isLightGear(name)) return GRANT_BANDS.light;
  return GRANT_BANDS.other;
};

/**
 * Arrange a freshly built loadout and write each item's `sort`: weapons, then
 * armor, then everything else in the order the generator built it, then the
 * light sources with each one's fuel directly beneath it, then Rations.
 *
 * `sort` is Foundry's own field and the one `_sortItemsForDisplay` honours when
 * drag-to-reorder is on, so the player can still drag any row afterwards and
 * the printed page follows without knowing this function exists. Spaced by
 * CONST.SORT_INTEGER_DENSITY, matching core, so `performIntegerSort` has room
 * to insert between two rows rather than having to renormalise the whole list
 * on the first drag.
 *
 * Stable within a band: the "everything else" band keeps build order, which is
 * the order the generator granted things in and the only order it has.
 *
 * @param {Object[]} items  built item payloads, mutated in place and returned
 * @returns {Object[]}
 */
export const orderGrantedItems = (items) => {
  const list = items ?? [];
  const bands = [[], [], [], [], [], []];
  for (const item of list) bands[grantBand(item)].push(item);

  // The light band pairs up: each fuel goes directly beneath the source it
  // feeds. A fuel whose source was never granted keeps its place in the band
  // rather than being dropped or promoted — an oil can with no lamp is still
  // lamp oil, and the Warden can see they are short a lamp.
  const lights = bands[GRANT_BANDS.light];
  const sources = lights.filter((i) => !LIGHT_FUEL.has(String(i.name ?? "").trim().toLowerCase()));
  const fuels = lights.filter((i) => LIGHT_FUEL.has(String(i.name ?? "").trim().toLowerCase()));
  const paired = [];
  const placed = new Set();
  for (const source of sources) {
    paired.push(source);
    const lower = String(source.name ?? "").toLowerCase();
    for (const fuel of fuels) {
      if (placed.has(fuel)) continue;
      const feeds = LIGHT_FUEL.get(String(fuel.name ?? "").trim().toLowerCase());
      if (feeds && lower.includes(feeds)) { paired.push(fuel); placed.add(fuel); }
    }
  }
  // An orphan keeps its place rather than being tracked on the payload itself:
  // a scratch property set on a built item would ride into the created document.
  for (const fuel of fuels) if (!placed.has(fuel)) paired.push(fuel);
  bands[GRANT_BANDS.light] = paired;

  const ordered = bands.flat();
  ordered.forEach((item, i) => { item.sort = (i + 1) * CONST.SORT_INTEGER_DENSITY; });
  return ordered;
};

/**
 * A grant may name a spell as "Spellbook (X)", "Scroll (X)", or "X Spellbook".
 * Return the bare spell name X (the name to resolve), else null.
 */
export const spellNameFromGrant = (name) => {
  const s = String(name).trim();
  const m =
    s.match(/^spellbook\s*\((.+)\)$/i) ||
    s.match(/^scroll\s*\((.+)\)$/i) ||
    s.match(/^(.+?)\s+spellbook$/i);
  return m ? m[1].trim() : null;
};

/**
 * True when a grant names a SCROLL specifically ("Scroll (X)") rather than a book
 * ("Spellbook (X)", "X Spellbook"). Both route to the same spell in the Objetos
 * compendium, but a scroll must resolve to a single-use petty item, a book to the
 * slot-taking spellbook — spellNameFromGrant deliberately erases that difference,
 * so resolveGearItem consults this to decide which to build.
 */
export const isScrollGrant = (name) => /^scroll\s*\(.+\)$/i.test(String(name).trim());

/**
 * A single-use petty scroll built from a resolved spell document: the SAME
 * `spell` type with `scroll` ticked, the spell's own text as its description, and
 * stored under the bare spell name — the inventory row adds the "Spellscroll — "
 * prefix at display time, exactly as it does for a book. THE one definition of
 * "what a scroll is", shared by named scroll grants (resolveGearItem) and the
 * random-scroll path (character-generator.js randomScrollItem) so the two cannot
 * drift.
 *
 * This used to emit `type: "item"` under the name "Spellscroll — X", which made a
 * generated scroll a THIRD representation no Warden could author or recognise: not
 * a spellbook, not flagged, identifiable only by a word in its name (which is what
 * `iconForItem` keys the scroll art off). `CairnItem._preUpdate` re-pins petty and
 * the use count on every write, so the values below are the initial state rather
 * than the only thing holding the invariant.
 */
export const spellScrollItem = (book, { quantity = 1, uses } = {}) => ({
  name: book.name,
  type: "spell",
  img: SPELLSCROLL_ICON,
  system: {
    // toObject() rather than deepClone — see resolveGearItem. The spread saved
    // this one from mutating the pack, but it also copied prepared/derived
    // fields off the live model into stored data.
    ...book.system.toObject(),
    scroll: true,
    weightless: true,
    equipped: false,
    quantity,
    uses: { value: uses ?? 1, max: 1 },
  },
});

/**
 * Author-time inference: map an inline {name, tags, uses/charges, description,
 * cost} record to an item's {type, system}. The one place tag→field inference
 * lives. Rules:
 *   - a whole-string dice tag (d6, d8, d6+d6, 2d6) → weapon + damageFormula
 *   - an "N Armor" tag                             → armor + system.armor = N
 *   - "petty" → weightless, "bulky" → bulky, "blast" → blast (weapons)
 *   - uses / charges / maxCharges → uses{value,max}; else lift "N use(s)" from prose
 * Weapon wins over armor when a record carries both (e.g. a bow tagged 1 Armor).
 */
export const buildGearItem = (g) => {
  const tags = g.tags ?? [];
  const lower = tags.map((t) => String(t).toLowerCase());
  const damageTag = tags.find((t) => /^\s*\d*d\d+(\s*\+\s*\d*d\d+)*\s*$/i.test(String(t)));
  const armorTag = tags.find((t) => /armor/i.test(String(t)));

  // "charges" is the relabelled "uses" field (relic-style items); fold either
  // spelling into uses. A structured count always beats a prose one.
  let usesMax = g.uses ?? g.maxCharges ?? g.charges ?? 0;
  let usesValue = g.uses ?? g.charges ?? usesMax;
  if (!usesMax) {
    const m = String(g.description ?? "").match(/\b(\d+)\s+uses?\b/i);
    if (m) { usesMax = Number(m[1]); usesValue = usesMax; }
  }

  const system = {
    description: g.description ?? "",
    weightless: lower.includes("petty"),
    bulky: lower.includes("bulky"),
    equipped: false,
    cost: g.cost ?? 0,
    quantity: 1,
    uses: { value: usesValue, max: usesMax },
  };

  let type = "item";
  if (damageTag) {
    type = "weapon";
    system.damageFormula = String(damageTag).trim();
    system.criticalDamage = "";
    system.blast = lower.includes("blast");
  } else if (armorTag) {
    type = "armor";
    const n = parseInt(String(armorTag), 10);
    system.armor = Number.isNaN(n) ? 1 : n;
  }
  return { name: g.name, type, img: iconForItem(type, g.name), system };
};

/**
 * Resolve-time: find a gear item by name in the Warden's Objetos compendium
 * (case-insensitive, honouring aliases and spell routing) and return a fresh
 * owned-item payload — never the pack document itself — with per-grant
 * quantity/uses overrides applied. Returns null on a miss; generation degrades
 * gracefully rather than throwing.
 *
 * A MISS IS NOW REPORTED TO THE WARDEN, not just to the console (2026-08-29).
 * This is the highest-impact silent failure in the system: every background,
 * bond, career and creation-table grant comes through here, so a compendium the
 * Warden has not assigned — or has assigned to the wrong thing — used to produce
 * a character with an empty inventory and no explanation anywhere the Warden
 * would look. `itemByName` reports it, and reports it ONCE per name per session
 * (content-packs.js dedupes), which is what makes it safe to say so from inside
 * a loop that resolves a dozen names.
 *
 * Still not cached: the match is found in the pack INDEX (names only, kept in
 * memory and updated live when a document changes), then that one document is
 * materialized with `getDocument`. So an in-session edit to an item is reflected
 * on the next resolve — the whole point of the editable-compendium model (edit →
 * regenerate → change appears) — without loading every document in the pack.
 */
export const resolveGearItem = async (name, { quantity = 1, uses } = {}) => {
  const spell = spellNameFromGrant(name);
  const targetName = spell ?? GEAR_ALIASES.get(String(name).trim().toLowerCase()) ?? name;
  /* A SECOND ALIAS PASS stood here and is GONE with the module that held its
     map. It rewrote two spell names (Marble Craze → Marble Madness, Missile
     Shield → Shield) while a rules setting said the world was in the other of
     two magic modes, so a grant resolved against the re-worded copy of a spell
     instead of the canon one. There is ONE Objetos compendium and one wording
     now — whichever the Warden put in it — so which text a spell has is a
     property of their content, not of a mode, and there is nothing left to
     alias between. GEAR_ALIASES above is a different map (typo/synonym gear
     names) and is untouched. */

  const found = await itemByName(targetName);
  if (!found) {
    console.warn(`resolveGearItem: no item named "${name}" in the configured Objetos compendium`);
    return null;
  }

  // A "Scroll (X)" grant is the spell as a single-use petty scroll; every other
  // spell grant is the Hechizo itself, permanent and castable in its own right.
  //
  // THE GRANT NAMES THE FORM, and nothing else does any more. A setting used to
  // force EVERY spell grant into a scroll ("found magic is a scroll you copy
  // into your grimoire"), which made sense only while a scroll could be written
  // into a carried book — a gesture that went with the bound-page machinery. A
  // Hechizo casts itself now, so turning every grant into one-use paper would
  // hand out magic that can never be kept and can never be filed anywhere.
  if (found.type === "spell" && isScrollGrant(name)) {
    return spellScrollItem(found, { quantity, uses });
  }

  const item = {
    name: found.name,
    type: found.type,
    img: found.img,
    // toObject(), NOT deepClone. `found.system` is a TypeDataModel, and
    // foundry.utils.deepClone returns any non-plain object UNCHANGED — by
    // reference (common/utils/helpers.mjs:280-282, "Unsupported advanced
    // objects"). So this used to hand back the compendium document's own
    // system, and the two writes below mutated the pack in place: every item
    // resolved in a session aliased one object per pack entry, last write wins.
    // It was invisible until a grant asked for `uses`, because everything else
    // was writing the same value back.
    system: found.system.toObject(),
  };
  item.system.quantity = quantity;
  if (uses != null) item.system.uses = { value: uses, max: uses };
  return item;
};
