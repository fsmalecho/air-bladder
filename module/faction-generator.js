/**
 * The Faction generator — a Warden-only button (in the JOURNAL sidebar since
 * 2026-08-29) that composes the SRD faction tables (Setting Seeds, CC BY-SA
 * 4.0) into a journal dossier. A faction is campaign machinery, not an Actor,
 * and a chat card would scroll away.
 *
 * Every faction is a PAGE of ONE JournalEntry named "Facciones" (2026-08-29,
 * ruled). It used to be an entry per faction, which buried the rest of the
 * journal sidebar under a dozen one-page entries; now the sidebar holds a
 * single folder-like entry and the factions are its pages, in creation order.
 *
 * Every roll resolves BY NAME, WORLD FIRST (findTableByName), so a Warden who
 * has replaced or edited any of the tables feeds the generator their own
 * content automatically — the same contract as the NPC sheet's Faction die.
 * roll(), never draw(): these are the Warden's tables and a draw would dirty
 * their drawn state (the config.js invariant).
 *
 * The loop closes by hand, deliberately: when a rolled faction earns a place
 * in the campaign, the Warden adds its name as a row in their own Facción
 * table — and the sheet die starts dealing it to NPCs
 * and Monsters. The generator invents candidates; the Warden's table is the
 * canon. Clicking again mints another dossier; nothing is ever overwritten.
 */

import { findTableByName, resultText } from "./compendium.js";
import { TABLES } from "./content-packs.js";

/**
 * The suite, by table name — the names content-packs.js publishes, never a
 * literal of its own. Named FACTION_TABLES rather than TABLES so the local
 * suite and the system-wide name map can sit in one file without shadowing.
 *
 * `type` is the same "Facción" table the NPC sheet's Faction die rolls: the
 * generator invents candidates off it and the Warden promotes the keepers back
 * into it, which is the loop this file's header describes.
 */
const FACTION_TABLES = {
  type: TABLES.faction,
  agent: TABLES.agent,
  trait1: TABLES.trait1,
  trait2: TABLES.trait2,
  advantageCount: TABLES.advantageCount,
  advantage: TABLES.advantage,
  agenda: TABLES.agenda,
  obstacle: TABLES.obstacle,
};

/** One rolled cell; "" when the table is missing/empty. */
const rollText = async (tableName) => {
  const table = await findTableByName(tableName);
  if (!table) return "";
  const { results } = await table.roll();
  const raw = resultText(results[0]).trim();
  return raw;
};

/**
 * The SRD Advantages procedure: the (Count) column says HOW MANY advantages
 * the faction has, then the Advantage column is rolled that many times,
 * rerolling repeats. Count is 1–4 against 20 distinct rows, so distinctness
 * always terminates; the attempt cap is a belt for a Warden's edited table
 * that repeats itself.
 * @returns {Promise<String[]>}
 */
const rollAdvantages = async () => {
  const rolled = parseInt(await rollText(FACTION_TABLES.advantageCount), 10);
  const count = Math.min(4, Math.max(1, Number.isNaN(rolled) ? 1 : rolled));
  const out = new Set();
  for (let attempts = 0; attempts < 40 && out.size < count; attempts++) {
    const adv = await rollText(FACTION_TABLES.advantage);
    if (!adv) break;
    out.add(adv);
  }
  return [...out];
};

/**
 * The one JournalEntry every faction lands in, BY NAME.
 *
 * A localization key rather than a bare literal because the entry's name is
 * read by a Warden in the sidebar, and lang/es.json is where this system's
 * user-facing words live. Safe as a LOOKUP key too: system.json maps both `en`
 * and `es` at lang/es.json, so this resolves to the same "Facciones" on every
 * client and two Wardens can never mint two differently-named entries.
 */
const FACTIONS_JOURNAL_KEY = "CAIRN.FactionsJournal";

/**
 * The "Facciones" entry, found by NAME or created empty.
 *
 * By name, not by a stored id: an id would rot the moment a Warden deleted the
 * entry (a dead id and no way back), and the name is what the Warden sees. The
 * cost of that choice is stated plainly — RENAMING the entry hides it from this
 * lookup, so the next faction mints a fresh "Facciones" beside it and the
 * renamed one keeps its pages untouched. Deleting it does the same. Both are
 * recoverable by hand (drag the pages across, or rename it back), and neither
 * loses anything.
 *
 * GM-only visibility: factions are the Warden's machinery. Through the
 * configured document class, so a future subclass is not bypassed.
 * @returns {Promise<JournalEntry|null>}
 */
const factionsJournal = async () => {
  const name = game.i18n.localize(FACTIONS_JOURNAL_KEY);
  const found = game.journal.find((j) => j.name === name);
  if (found) return found;
  const created = await CONFIG.JournalEntry.documentClass.create({
    name,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
  });
  return created ?? null;
};

/**
 * Roll a whole faction and add its dossier as a PAGE of "Facciones". Returns
 * `{entry, page}` (the caller renders the entry on that page), or null when the
 * entry or the page could not be created. A missing table degrades its line to
 * an em-dash — the page still mints, because a Warden mid-edit should get a
 * partial dossier, not an error.
 * @returns {Promise<{entry: JournalEntry, page: JournalEntryPage}|null>}
 */
export const generateFaction = async () => {
  const type = await rollText(FACTION_TABLES.type);
  const agent = await rollText(FACTION_TABLES.agent);
  const trait1 = await rollText(FACTION_TABLES.trait1);
  const trait2 = await rollText(FACTION_TABLES.trait2);
  const advantages = await rollAdvantages();
  const agenda = await rollText(FACTION_TABLES.agenda);
  const obstacle = await rollText(FACTION_TABLES.obstacle);

  // "The Enigmatic Cultists" — obviously a draft name, meant to be replaced.
  // A localizable FORMAT key, because "The <trait> <type>" is English word
  // order and a translator may need to reorder.
  const name = trait1 && type
    ? game.i18n.format("CAIRN.FactionName", { trait: trait1, type })
    : game.i18n.localize("CAIRN.Faction");

  // One key per WHOLE LINE, colon and bold included. Assembling `${label}:` in code hands the
  // translator a noun and keeps the punctuation — French wants a narrow
  // no-break space before a colon, English does not, and neither can be
  // written from the other end.
  //
  // Lists go through Intl.ListFormat rather than a hardcoded ", ". Narrow
  // conjunction leaves the English rendering byte-identical ("A, B, C") while
  // giving every other locale its own form — es "A, B y C", ja "A、B、C". Not
  // `type: "unit"`, which is the measurement joiner and drops the separator
  // altogether in narrow English ("A B C"), as the faction probe found. Worth
  // the care because this
  // dossier is BAKED into a journal at generation time: whatever it writes is
  // permanent, and a Warden is not going to re-punctuate six lines by hand.
  //
  // NOT the sheet biography's approach, deliberately. That is ONE
  // whole-sentence key (CAIRN.Bio.Portrait) with named placeholders, where the
  // whole of the running prose — conjunctions included — is the translator's.
  // This is a bare enumeration after a label — separator only — and that is
  // data the platform already has for every locale, including the ones nobody
  // has translated yet.
  const list = new Intl.ListFormat(game.i18n.lang ?? "en", { style: "narrow", type: "conjunction" });
  const line = (key, value) => `<p>${game.i18n.format(key, { value: value || "&mdash;" })}</p>`;
  const content = [
    line("CAIRN.FactionDossier.Type", type),
    line("CAIRN.FactionDossier.Agent", agent),
    line("CAIRN.FactionDossier.Traits", list.format([trait1, trait2].filter(Boolean))),
    line("CAIRN.FactionDossier.Advantages", list.format(advantages)),
    line("CAIRN.FactionDossier.Agenda", agenda),
    line("CAIRN.FactionDossier.Obstacle", obstacle),
  ].join("\n");

  // One entry, one page per faction. The page is created through the entry's
  // embedded collection rather than in the entry's own `pages` array, because
  // the entry usually already exists — the create-with-pages shape only ever
  // served the very first faction, and having one path for both is what keeps
  // the first and the fiftieth faction identical.
  const entry = await factionsJournal();
  if (!entry) return null;
  const [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [
    { name, type: "text", text: { content } },
  ]);
  return page ? { entry, page } : null;
};
