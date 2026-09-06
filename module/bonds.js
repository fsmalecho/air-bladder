/**
 * THE BOND WEB: who knows whom, and what is between them.
 *
 * NOT THE OTHER GRAPH. `connectedTo` in actor.js is a graph too, and a
 * different animal: it is CUSTODY — which horses, sacks and hirelings a
 * character has with them — it is one-way, it is capped, and it drives Foundry
 * PERMISSIONS, so that a player who owns the rider owns the horse. That one
 * stays where it is, doing its job with its interface parked. This is the
 * social web the user asked for on 2026-09-05: a person knows a person, both
 * sheets say so, and nothing about it touches who may open what.
 *
 * ONE EDGE, TWO LABELS, and that is the whole design. A bond is a single
 * record naming two actors and what each says the other is:
 *
 *     { id, a, b, aSays: "mi hermana mayor", bSays: "mi hermana pequeña" }
 *
 * Reciprocity is then not a rule anybody has to enforce — it is the shape of
 * the record. The bond exists on both sheets or on neither, because there is
 * only one of it. And the two directions may DISAGREE, which is what makes the
 * interesting ones expressible: mentor and apprentice, creditor and debtor,
 * lord and vassal are all one bond seen from two sides. Leave one side blank
 * and it mirrors the other, so the symmetric case ("hermanas") costs one field.
 *
 * WHY A WORLD SETTING and not a field on each actor. The user's ruling: only
 * the Warden writes. That closes the question, because writing an actor
 * document you do not own is a wall in Foundry and a socket relay is the only
 * way through it. With one writer there is one store, and one store cannot
 * disagree with itself — the alternative, half an edge on each actor, is two
 * writes that can drift apart and a scan of every actor in the world to find
 * the other halves.
 *
 * BY UUID, never by name. Renaming an actor is then free: the row reads the
 * name at render. The cost is a bond outliving its actor, which `pruneBonds`
 * clears on delete and every reader skips in the meantime.
 */

import { SETTINGS_NS } from "./settings.js";

/** @typedef {{id: String, a: String, b: String, aSays: String, bSays: String, secret: Boolean}} Bond */

/* -------------------------------------------------------------------------- */
/*  The store                                                                   */
/* -------------------------------------------------------------------------- */

/** Every bond in the world. Never throws: a sheet renders before settings are
 *  ready often enough that a guard is cheaper than the alternative. */
export const allBonds = () => {
  try {
    const raw = game.settings.get(SETTINGS_NS, "bonds");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

/** Warden-only, and Foundry is the wall: a world setting refuses a player's
 *  write regardless of what this returns. */
export const canEditBonds = () => !!game.user?.isGM;

const writeBonds = async (next) => {
  if (!canEditBonds()) return false;
  await game.settings.set(SETTINGS_NS, "bonds", next);
  return true;
};

/* -------------------------------------------------------------------------- */
/*  Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** A world actor from a stored uuid, or null. `fromUuidSync` is safe for world
 *  documents and this never asks about anything else — see `isBondable`. */
const resolve = (uuid) => {
  try {
    const doc = fromUuidSync(uuid);
    return doc instanceof Actor ? doc : null;
  } catch {
    return null;
  }
};

/**
 * Can this actor be an end of a bond?
 *
 * World actors only. A compendium entry is a template rather than a person —
 * bonding one would tie the web to a document the world does not own. An
 * unlinked token actor is a copy that dies with its token, so a bond to it
 * would rot the moment the scene is cleared.
 */
export const isBondable = (actor) => !!actor && !actor.pack && !actor.isToken;

/** The bond between these two, whichever way round it was written. One per
 *  pair, which is why adding an existing pair edits rather than duplicates. */
export const bondBetween = (uuidA, uuidB) => allBonds().find(
  (b) => (b.a === uuidA && b.b === uuidB) || (b.a === uuidB && b.b === uuidA)) ?? null;

/**
 * One actor's bonds, ready to render: the other person, what this side says
 * they are, and what they say back.
 *
 * THE MIRROR is here rather than at write time on purpose. Stored blank, a side
 * follows the other for ever — including after the other is edited — which is
 * what "leave it blank and it says the same" should mean. Filled in at write
 * time it would freeze a copy that then silently stops agreeing.
 *
 * SECRET bonds are dropped for a player. Same honesty as the calendar's notes:
 * they ride in the same world setting, so the client HAS them and simply does
 * not draw them. It is tidiness, not secrecy against a determined reader.
 *
 * @param {Actor} actor
 * @returns {Array<{id, uuid, name, img, says, saysBack, secret, isCharacter}>}
 */
export const bondsFor = (actor) => {
  if (!actor?.uuid) return [];
  const gm = !!game.user?.isGM;
  const rows = [];

  for (const bond of allBonds()) {
    if (bond.secret && !gm) continue;
    const mine = bond.a === actor.uuid ? "a" : (bond.b === actor.uuid ? "b" : null);
    if (!mine) continue;

    const other = resolve(mine === "a" ? bond.b : bond.a);
    if (!other) continue;              // pruned late, or a broken world

    const says = String((mine === "a" ? bond.aSays : bond.bSays) ?? "").trim();
    const back = String((mine === "a" ? bond.bSays : bond.aSays) ?? "").trim();
    rows.push({
      id: bond.id,
      uuid: other.uuid,
      name: other.name,
      img: other.img,
      says: says || back,              // blank mirrors the other side
      saysBack: back || says,
      secret: !!bond.secret,
      isCharacter: other.type === "character",
    });
  }

  // Player characters first — at a table they are who a row is usually about —
  // then by name, in the reader's own language rather than by code point.
  return rows.sort((x, y) => (Number(y.isCharacter) - Number(x.isCharacter))
    || x.name.localeCompare(y.name, game.i18n?.lang ?? "es"));
};

/* -------------------------------------------------------------------------- */
/*  Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Make a bond, or rewrite the one these two already have.
 *
 * ONE PER PAIR. Two people have one relationship with each other, however many
 * things it is made of; a second row for the same pair is a sheet that lists a
 * person twice and two places to edit the same fact. "Ana debe dinero a Berta y
 * además son hermanas" is one bond whose labels say both.
 *
 * @param {Actor} actorA
 * @param {Actor} actorB
 * @param {{aSays?: String, bSays?: String, secret?: Boolean}} labels
 */
export const setBond = async (actorA, actorB, { aSays = "", bSays = "", secret = false } = {}) => {
  if (!canEditBonds()) return false;
  if (!isBondable(actorA) || !isBondable(actorB)) return false;
  // Nobody is their own contact. Refused rather than warned: it can only be a
  // misclick, and the pair rule below would make it unrepresentable anyway.
  if (actorA.uuid === actorB.uuid) return false;

  const bonds = allBonds().map((b) => ({ ...b }));
  const existing = bonds.find(
    (b) => (b.a === actorA.uuid && b.b === actorB.uuid)
        || (b.a === actorB.uuid && b.b === actorA.uuid));

  if (existing) {
    // Written from the other end: the labels arrive as A-then-B for the pair
    // the caller named, so they swap into the stored order rather than
    // overwriting the wrong side.
    const flipped = existing.a === actorB.uuid;
    existing.aSays = flipped ? bSays : aSays;
    existing.bSays = flipped ? aSays : bSays;
    existing.secret = !!secret;
  } else {
    bonds.push({
      id: foundry.utils.randomID(),
      a: actorA.uuid,
      b: actorB.uuid,
      aSays: String(aSays ?? ""),
      bSays: String(bSays ?? ""),
      secret: !!secret,
    });
  }
  return writeBonds(bonds);
};

/** @param {String} id */
export const deleteBond = async (id) => {
  if (!canEditBonds()) return false;
  const next = allBonds().filter((b) => b.id !== id);
  return writeBonds(next);
};

/**
 * Drop every bond touching a deleted actor.
 *
 * Run from the `deleteActor` hook, and guarded to ONE client: the hook fires on
 * every connected client, and four Wardens racing the same write is four
 * chances for the last one to land on a stale copy. `game.users.activeGM` names
 * exactly one of them.
 */
export const pruneBonds = async (uuid) => {
  if (game.users?.activeGM?.id !== game.user?.id) return false;
  const bonds = allBonds();
  const next = bonds.filter((b) => b.a !== uuid && b.b !== uuid);
  if (next.length === bonds.length) return false;
  return writeBonds(next);
};
