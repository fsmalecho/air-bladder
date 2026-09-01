/**
 * What is left of the pack-addressed lookups.
 *
 * Six helpers stood here and are GONE (2026-08-29): `compendiumInfoFromString`,
 * `findCompendiumItem`, `drawTable`, `drawTableText`, `drawTableItem` and
 * `resultChatText`. Every one of them took a PACK ID as its first argument, and
 * no caller has one any more — the system ships no packs, and the four the
 * Warden assigns are resolved in module/content-packs.js, which is the only
 * place a pack id may live. Deleted rather than re-pointed, because a helper
 * whose whole signature is the thing that went away cannot be rescued by a new
 * body: `content-packs.js` `docFromPack` / `generatorText` say the same things
 * in the vocabulary that survives.
 *
 * What stays are the three that were never about a pack at all: finding a table
 * by NAME wherever it lives, and reading a drawn row.
 */

/**
 * Find a RollTable by exact name — WORLD FIRST, then every RollTable pack.
 *
 * By name rather than by uuid, deliberately: a uuid pointing into one world's
 * pack is dead the moment the content is shared. The world collection is
 * looked at FIRST because that is the easiest thing for a Warden to make —
 * Tables tab, New Table — so a Warden's own copy always wins and their edits
 * survive the content being replaced, which would overwrite any edit made
 * inside a pack.
 *
 * WIDER than content-packs.js's `generatorTable`, and both exist on purpose:
 * this one answers "the Warden's own copy of this table, from anywhere", which
 * is what the Faction die, the faction generator and the cast mishap card each
 * promise; `generatorTable` answers "this table, in the compendium the Warden
 * nominated", which is what generation reads and what can therefore report a
 * missing one precisely.
 * @param {String} name
 * @returns {Promise<RollTable|null>}
 */
export const findTableByName = async (name) => {
  const wanted = String(name).trim();
  const world = game.tables?.find((t) => t.name === wanted);
  if (world) return world;
  for (const pack of game.packs) {
    if (pack.metadata.type !== "RollTable") continue;
    const entry = (await pack.getIndex()).find((e) => e.name === wanted);
    if (entry) return pack.getDocument(entry._id);
  }
  return null;
};

/**
 * A rolled result's narrative text.
 *
 * `TableResult#text` is DEPRECATED — `{since: 13, until: 15}`, one major sooner than
 * the AppV1 sheets — and survives only as a shim that logs a compatibility warning on
 * every read (common/documents/table-result.mjs:89-94). This is what it did: a text row
 * keeps its prose in `description`, and any other row type (a document reference) is
 * identified by `name`.
 *
 * It lives HERE, next to the other table readers, and not in character-generator.js
 * where it was written. It was applied at exactly one of its call sites for three
 * months — the sheet, the importer, the shop and the generator itself each kept
 * reading `.text` — and a helper nobody can find in the module they are editing is
 * how that happens.
 *
 * @param {TableResult} result
 * @returns {String}
 */
export const resultText = (result) =>
  (result?.type === "text" ? result.description : result?.name) ?? "";

/**
 * The documents a table's results point at.
 *
 * Resolves each row by its `documentUuid`, which is the only non-deprecated way to
 * do it: `documentCollection` (common/documents/table-result.mjs:115-123) and
 * `documentId` (:102-107) both go in v15, and `TABLE_RESULT_TYPES.COMPENDIUM` with
 * them (common/constants.mjs:954-964) — v13 merged the "compendium" row type into
 * "document".
 *
 * That merge is why a row dragged in from the ITEMS SIDEBAR was silently missing
 * from the shop. The type check is not what dropped it: the deprecated
 * `COMPENDIUM` getter returns `"document"`, so a world row matches. It died one line
 * later, in a by-name lookup keyed on `result.documentCollection` — for a world
 * document that getter returns the document NAME ("Item"), which is not a pack id,
 * so the lookup warned and returned undefined. `fromUuid` resolves both kinds.
 *
 * Resolving by uuid also means resolving by ID, so renaming an item in a pack no
 * longer breaks every table that points at it.
 *
 * A row that resolves to nothing is warned about rather than skipped in silence —
 * that is a broken content reference.
 *
 * @param {TableResult[]} results
 * @returns {Promise.<Document[]>}
 */
export const findTableItems = async (results) => {
  const items = [];
  for (const result of results) {
    if (result.type !== CONST.TABLE_RESULT_TYPES.DOCUMENT) continue;
    const doc = await fromUuid(result.documentUuid);
    if (doc) items.push(doc);
    else console.warn(`findTableItems: unresolvable result uuid (${result.documentUuid})`);
  }
  return items;
};
