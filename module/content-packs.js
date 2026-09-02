/**
 * Where the system's content comes from.
 *
 * This system ships NO compendium packs of its own. Every table, background and
 * item it needs is supplied by the Warden — from a module, or from compendiums
 * made in the world — and named through four world settings. This file is the
 * single place that turns those settings into documents; nothing else may hold a
 * pack id.
 *
 * WHY A NAME AND NOT A PACK PICKER. The setting stores what the Warden typed,
 * and a pack is matched on its LABEL (what the compendium sidebar shows) as well
 * as on its full id. A label survives the content being repackaged under a
 * different module id, which a stored id does not — and the Warden is naming a
 * compendium they are looking at, not reading an id out of a manifest.
 *
 * WHY TABLES ARE FOUND BY NAME. Same reason `findTableByName` gives in
 * compendium.js: a uuid into one world's pack dies the moment the content is
 * shared. The names below are the contract between this system and whatever
 * content is pointed at it — rename a table in the content and the feature that
 * reads it goes quiet, which is why every miss here is reported to the Warden
 * rather than swallowed.
 */

/**
 * The settings namespace, read rather than imported.
 *
 * settings.js imports clearPackWarnings from this file, so importing the
 * namespace constant back out of it would close an import cycle. It is not
 * needed: settings.js states the namespace MUST be the package id, and
 * `game.system.id` IS that id — one value, read from the source Foundry uses.
 */
const NS = () => game.system?.id ?? "mondolme";

/**
 * The four settings, and the localization key naming each one in a warning.
 *
 * `kind` values are what every caller passes around; the setting keys stay
 * English like every other key in SETTING_KEYS.
 */
export const PACK_KINDS = {
  generators: { setting: "pack-generators", label: "CAIRN.Settings.PackGenerators.label", type: "RollTable" },
  market: { setting: "pack-market", label: "CAIRN.Settings.PackMarket.label", type: "RollTable" },
  backgrounds: { setting: "pack-backgrounds", label: "CAIRN.Settings.PackBackgrounds.label", type: "Item" },
  npcBackgrounds: { setting: "pack-npc-backgrounds", label: "CAIRN.Settings.PackNpcBackgrounds.label", type: "Item" },
  items: { setting: "pack-items", label: "CAIRN.Settings.PackItems.label", type: "Item" },
};

/**
 * Every table name the code looks for, by the compendium it lives in.
 *
 * These are DATA, not localization keys: they are matched against what the
 * Warden named their tables, so they must not move with the interface language.
 */
export const TABLES = {
  // ---- Generadores ----
  /* `bonds: "Obligaciones"` stood here and is GONE (2026-09-02, user ruling:
     "no quiero obligaciones, ni tablas de obligaciones"). Nothing looks for a
     table of that name any more, so nothing needs to be in the Warden's
     Generadores compendium under it. */
  clothing: "Vestimenta",
  face: "Rostro",
  hair: "Cabello",
  omens: "Presagios",
  physique: "Físico",
  scars: "Cicatrices",
  skin: "Piel",
  speech: "Voz",
  spells: "Hechizos",
  vice: "Defecto",
  virtue: "Virtud",
  background: "Trasfondo",
  faction: "Facción",
  goal: "Objetivo",
  quirk: "Peculiaridad",
  armor: "Armadura",
  gear: "Equipo",
  weapon: "Arma",
  advantage: "Ventaja",
  advantageCount: "Cantidad",
  agenda: "Agenda",
  agent: "Agente",
  obstacle: "Obstáculo",
  trait1: "Rasgo 1",
  trait2: "Rasgo 2",
  birthday: "Cumpleaños",
  names: "Nombres",
  mishaps: "Percances",
};

/** The four market categories, in the order the shop shows them. */
export const MARKET_TABLES = {
  weapons: "Armas",
  armor: "Armadura",
  gear: "Equipo",
  containers: "Contenedores",
};

/** @returns {String} whatever the Warden typed, trimmed; "" when unset. */
export const packSetting = (kind) => {
  const key = PACK_KINDS[kind]?.setting;
  if (!key) return "";
  try {
    return String(game.settings.get(NS(), key) ?? "").trim();
  } catch {
    // Read before registerSettings has run (a hook firing early). Not an error.
    return "";
  }
};

/**
 * Resolve one of the four settings to a live pack.
 *
 * Matching order: exact pack id, then case-insensitive label, then
 * case-insensitive id. Label first among the fuzzy passes because that is the
 * string the Warden can actually see in the sidebar.
 *
 * @param {String} kind  a key of PACK_KINDS
 * @returns {CompendiumCollection|null}
 */
export const packFor = (kind) => {
  const wanted = packSetting(kind);
  if (!wanted) return null;

  const byId = game.packs.get(wanted);
  if (byId) return byId;

  const lower = wanted.toLowerCase();
  return (
    game.packs.find((p) => String(p.metadata.label ?? "").trim().toLowerCase() === lower) ??
    game.packs.find((p) => String(p.collection ?? "").toLowerCase() === lower) ??
    null
  );
};

/**
 * Tell the Warden a compendium is not assigned, once per kind per session.
 *
 * Once per session because the callers are inside generation loops — a character
 * rolls eight traits, and eight identical toasts stacked on top of each other is
 * how a real message gets ignored. The set is cleared whenever a setting changes
 * (see clearPackWarnings), so fixing the setting makes the next miss speak up.
 */
const warned = new Set();

export const clearPackWarnings = () => warned.clear();

/**
 * @param {String} kind
 * @param {Boolean} [force]  report even if this kind already warned this session
 */
export const warnNoPack = (kind, force = false) => {
  const tag = `pack:${kind}`;
  if (!force && warned.has(tag)) return;
  warned.add(tag);
  ui.notifications?.warn(
    game.i18n.format("CAIRN.Notify.NoPackAssigned", {
      setting: game.i18n.localize(PACK_KINDS[kind]?.label ?? kind),
    })
  );
};

/** @param {String} kind @param {String} name */
export const warnNoTable = (kind, name) => {
  const tag = `table:${kind}:${name}`;
  if (warned.has(tag)) return;
  warned.add(tag);
  const pack = packFor(kind);
  ui.notifications?.warn(
    game.i18n.format("CAIRN.Notify.NoTableInPack", {
      table: name,
      pack: pack?.metadata?.label ?? packSetting(kind),
    })
  );
};

/**
 * Find a document by name inside one of the four configured packs.
 *
 * Index match then `getDocument`, for the reason findCompendiumItem states: the
 * old whole-pack `getDocuments()` read every document to look at one name each.
 * Case-insensitive and trimmed, because the Warden typed these names by hand.
 *
 * Reports a missing pack and a missing document differently — they are different
 * mistakes and need different fixes.
 *
 * @param {String} kind
 * @param {String} name
 * @param {Object} [opts]
 * @param {Boolean} [opts.quiet]  resolve to null without telling the Warden
 * @returns {Promise<Document|null>}
 */
export const docFromPack = async (kind, name, { quiet = false } = {}) => {
  const pack = packFor(kind);
  if (!pack) {
    if (!quiet) warnNoPack(kind);
    return null;
  }
  const wanted = String(name).trim().toLowerCase();
  const entry = (await pack.getIndex()).find(
    (e) => String(e.name ?? "").trim().toLowerCase() === wanted
  );
  if (!entry) {
    if (!quiet) warnNoTable(kind, name);
    return null;
  }
  return (await pack.getDocument(entry._id)) ?? null;
};

/** A RollTable out of the Generadores compendium. @returns {Promise<RollTable|null>} */
export const generatorTable = (name, opts) => docFromPack("generators", name, opts);

/** A RollTable out of the Mercado compendium. @returns {Promise<RollTable|null>} */
export const marketTable = (name, opts) => docFromPack("market", name, opts);

/**
 * Draw one row of a Generadores table and return its text.
 *
 * Degrades to "" on any miss, exactly as the drawTableText it replaces did:
 * generation must never throw half-way through and leave a part-built actor.
 * The Warden has already been told which table is missing.
 *
 * @param {String} name
 * @returns {Promise<String>}
 */
export const generatorText = async (name) => {
  const table = await generatorTable(name);
  if (!table) return "";
  try {
    const draw = await table.roll();
    return resultText(draw?.results?.[0]);
  } catch (err) {
    console.error(`Mondolme | the "${name}" draw failed:`, err);
    return "";
  }
};

/** The visible text of one drawn row, whatever result type it is. */
export const resultText = (result) => {
  if (!result) return "";
  return String(result.description ?? result.text ?? result.name ?? "").trim();
};

/**
 * Every Item of a given type in one of the two Item packs.
 *
 * Used for the background chooser (type `background` out of Trasfondos) and for
 * random draws. Index-only where the type is indexed, so nothing is constructed
 * until a caller asks for a specific document.
 *
 * @param {String} kind
 * @param {String} type
 * @param {Object} [opts]
 * @returns {Promise<Array<Object>>}  index entries, each with _id and name
 */
export const indexOfType = async (kind, type, { quiet = false } = {}) => {
  const pack = packFor(kind);
  if (!pack) {
    if (!quiet) warnNoPack(kind);
    return [];
  }
  const index = await pack.getIndex();
  return index.filter((e) => e.type === type);
};

/**
 * Load every Item of a type out of a pack as real documents.
 * @returns {Promise<Array<Item>>}
 */
export const documentsOfType = async (kind, type, opts) => {
  const pack = packFor(kind);
  if (!pack) return [];
  const entries = await indexOfType(kind, type, opts);
  const docs = await Promise.all(entries.map((e) => pack.getDocument(e._id)));
  return docs.filter(Boolean);
};

/**
 * The languages a Warden defined, as a list.
 *
 * Stored as one comma-separated string because that is the fastest thing to
 * type and to re-order; split here so no caller has to know that. Blank entries
 * are dropped, so a trailing comma is harmless.
 *
 * @returns {Array<String>}
 */
export const languages = () => {
  let raw = "";
  try {
    raw = String(game.settings.get(NS(), "languages") ?? "");
  } catch {
    return [];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
};

/**
 * Resolve a gear item BY NAME out of the Objetos compendium.
 *
 * The by-name resolver behind every background and career gear grant.
 * Case-insensitive, because a grant's spelling and the item's spelling are typed
 * by different people at different times.
 *
 * @param {String} name
 * @param {Object} [opts]
 * @returns {Promise<Item|null>}
 */
export const itemByName = async (name, opts) => {
  if (!name) return null;
  return docFromPack("items", name, opts);
};
