/**
 * PRESTIGE, and the rank it buys.
 *
 * "Todos los Aventureros persiguen el Prestigio, para que algún día se los
 * considere merecedores de la Gran Búsqueda." One stored number on a character,
 * and seven thresholds it crosses.
 *
 * THE RANK IS NOT STORED. It is the highest threshold the number has passed,
 * worked out on every read. A stored rank is a second copy of a fact the number
 * already carries, and second copies go stale — a Warden edits the prestige,
 * forgets the rank, and the sheet says two things at once.
 *
 * THE LABELS ARE THE RULES' OWN WORDS. The book names only the first rank
 * ("Errante") and describes the rest as what the Adventurer is worthy OF, so
 * that is what the sheet prints. Inventing "Caballero", "Consejero" and so on
 * would be putting words in the setting's mouth, and rank names are exactly the
 * sort of thing a Warden wants to choose. They are in lang/es.json under
 * CAIRN.Prestige.Ranks and can be rewritten without touching this file.
 *
 * MERIT IS NOT MECHANISED, on purpose. The rules are explicit that rank only
 * PROVES worth: an Adventurer may hold a position their rank does not merit and
 * make it stick by facing down the opposition. That is a thing that happens at
 * a table, not a field on a sheet.
 */

/** What one resolved Deed is worth, and the unit almost everything else uses. */
export const DEED_PRESTIGE = 1000;

/**
 * The thresholds, lowest first. `key` is the lang key's tail; `at` is the
 * prestige at which the rank is reached.
 */
export const RANKS = [
  { key: "wanderer", at: 0 },
  { key: "knight", at: 1000 },
  { key: "battalion", at: 3000 },
  { key: "council", at: 6000 },
  { key: "lordship", at: 9000 },
  { key: "seat", at: 12000 },
  { key: "legend", at: 15000 },
];

const num = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

/** The rank a given prestige has reached. Never null: zero is a rank. */
export const rankFor = (prestige) => {
  const p = num(prestige);
  let found = RANKS[0];
  for (const rank of RANKS) {
    if (p >= rank.at) found = rank;
    else break;
  }
  return found;
};

/** The next one up, and how far off it is. Null at the top of the ladder. */
export const nextRankFor = (prestige) => {
  const p = num(prestige);
  const next = RANKS.find((r) => r.at > p);
  return next ? { ...next, needed: next.at - p } : null;
};

export const rankLabel = (key) => game.i18n.localize(`CAIRN.Prestige.Ranks.${key}`);

/**
 * Everything the sheet needs about a character's standing, in one object.
 * @returns {{prestige, rank, rankLabel, next, nextLabel, needed, progress}}
 */
export const standing = (prestige) => {
  const p = Math.max(0, num(prestige));
  const rank = rankFor(p);
  const next = nextRankFor(p);
  // How far along the CURRENT step, for the bar under the number. At the top of
  // the ladder there is no next threshold to be a fraction of, so it is full.
  const span = next ? next.at - rank.at : 0;
  const progress = next ? Math.min(1, Math.max(0, (p - rank.at) / (span || 1))) : 1;
  return {
    prestige: p,
    rank: rank.key,
    rankLabel: rankLabel(rank.key),
    next: next?.key ?? null,
    nextLabel: next ? rankLabel(next.key) : null,
    needed: next?.needed ?? 0,
    atTop: !next,
    progress,
  };
};
