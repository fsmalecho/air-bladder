import { TABLES } from "./content-packs.js";

/** @name CONFIG.Cairn */
export const Cairn = {};

// The tables every generator reads are NAMES ONLY. This system ships no
// compendiums: each name below is looked up in the Warden's Generadores
// compendium (module/content-packs.js), so the addresses here are one half of a
// contract whose other half is the content the Warden points the system at.
// Never a raw literal — always a TABLES key, so renaming a table is one edit in
// content-packs.js and not a hunt through every generator.

// Cairn 2e generation config. Backgrounds, gear and bonds come from their own
// compendiums (see character-generator.js); this covers the shared biography,
// which draws the 8 physical/personality traits and rolls age.
// 2e drops the 1e system's Misfortune and Reputation.
Cairn.characterGenerator2e = {
  // Cairn 2e starts every character with 3d6 coins, on top of any coins their
  // bond or background choice-tables grant.
  gold: "3d6",
  biography: {
    // No sentence template here, on purpose (review #13). One lived here —
    // "I have a <strong>{physique}</strong> physique, …" — with no reader:
    // the sheet composes the biography per RENDER from the CAIRN.Bio.* keys
    // (actor-sheet.js), which is what lets a Spanish client re-word it.
    // Left in place it read as the sentence's authority, and an edit to it
    // would have changed nothing a user could see.
    //
    // The age formula: RAW Cairn 2e, 2d20 + 10 (user ruling, 2026-08-21 —
    // rules as written; the retired min-age's 21 default was an OVERRIDE,
    // and preserving it as the new default briefly happened and was reversed
    // the same day, so ages 12..20 are possible again out of the box, as the
    // book says). This is the ONE copy: the `age-formula` setting registers
    // it as its default and rollAge falls back to it when the Warden's own
    // formula is blank or invalid. A Warden who wants the old floor writes
    // the pool form {2d20 + 10, 21}kh — max(roll, 21), the hint's example;
    // the docs/dice-formulas.md guide explains the whole notation.
    // (min-age/max-age clamping is RETIRED, 2026-08-21 — issue #21: clamping
    // piled most ages onto the bound; a Warden who wants a range edits the
    // dice instead.)
    age: "2d20 + 10",
    items: {
      physique: TABLES.physique,
      skin: TABLES.skin,
      hair: TABLES.hair,
      face: TABLES.face,
      speech: TABLES.speech,
      clothing: TABLES.clothing,
      vice: TABLES.vice,
      virtue: TABLES.virtue,
    }
  }
};

// The two PERSON generators (2026-08-20 split). Both draw names from the same
// table — a hireling has no other source: a 2e character takes its name from
// its background's name list, which neither of these has an equivalent of.
//
// The HIRELING's statblock is shipped runtime data (module/npc-careers-2e.json,
// the twelve 2e careers) rather than a table, so only the name is configurable
// here. The NPC's four traits and its Background ARE tables.
//
// These are the WARDEN'S tables and their drawn state must stay clean. Every
// path below rolls with `table.roll()`, which cannot mark a row drawn — the one
// rule that outlived the shipped packs, because a Warden's own table is exactly
// the thing a stray `draw()` would quietly exhaust over a campaign.
Cairn.npcGenerator = {
  name: TABLES.names,
  // The Faction die's table resolves WORLD FIRST (findTableByName), so a
  // Warden's own RollTable of this name beats the copy in their Generadores
  // compendium — the faction list is campaign machinery and lives where they
  // edit it most easily.
  faction: TABLES.faction,
  // Role `npc` only. `background` answers the same question `profession` does
  // for a hireling, off a different table — which is the whole of what
  // separates the two generators.
  background: TABLES.background,
  // The four NPC traits. `virtue` and `vice` deliberately COLLIDE by key with
  // the 2e biography tables above; for now both resolve to the same table, and
  // the collision is kept because the SHAPE is what the sheet and the NPC
  // generator branch on — same stored key, so nothing is lost when a Warden
  // changes an actor's role.
  traits: {
    quirk: TABLES.quirk,
    goal: TABLES.goal,
    virtue: TABLES.virtue,
    vice: TABLES.vice,
  },
  // Role `npc` only (2026-08-20, user ask). A hireling's statblock comes off
  // its career; an NPC has no career, so it is ROLLED — Cairn's own
  // person-making dice, the same pair Barebones creation uses below and a 2e
  // character uses above. A generator sitting at its schema defaults reads as
  // broken, and a rolled stranger is the answer the table actually wanted.
  ability: "3d6",
  hitProtection: "1d6",
  // `backgroundGear` — a hardcoded English map from NPC Background name to a
  // Barebones counterpart — is GONE (2026-08-29). It keyed on the raw text of a
  // shipped English table, and the Trasfondo table is the Warden's now and in
  // Spanish, so every one of its eighteen keys was dead. What replaced it needs
  // no map at all: an NPC's Background is looked up BY NAME as a `background`
  // Item in the Trasfondos compendium and grants that background's own
  // startingGear (character-generator.js npcBackgroundItem). A Trasfondo row
  // with no matching Item grants nothing, which is a legitimate outcome and not
  // an error — the same "Lord and Politician arrive empty-handed" behaviour the
  // map used to express by omission, now expressed by the content itself.
};

// `Cairn.monsterGenerator` stood here and is GONE (2026-08-29, ruled with the
// monster generator itself): module/monster-generator.js and its directory
// button are deleted, so the eight table addresses had no reader left. The
// `monster` ROLE stays — a monster is made with Crear actor and written by
// hand now.

// Cairn Barebones creation. Abilities/HP/coins follow the SRD; the name comes
// from the same NPC name table the NPC generator uses, because 2e dropped 1e's
// name tables and Barebones ships none of its own.
Cairn.barebonesGenerator = {
  name: TABLES.names,
  ability: "3d6",
  hitProtection: "1d6",
  gold: "3d6",
};

CONFIG.Cairn = Cairn;
