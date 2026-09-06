/**
 * THE PURSE: three denominations, and the arithmetic that keeps them honest.
 *
 * SILVER IS THE STANDARD (2026-09-06, user ruling), and the ONLY unit a price
 * is ever quoted in. An item's value is a decimal number of silver: 0.1 is one
 * copper, 4 is four silver, 30 is three gold. One number, one unit, and two
 * prices can be compared without reading a label first.
 *
 * THE RATES ARE SETTINGS, not constants — 1 gold = 10 silver and 1 silver = 10
 * copper by default. They were briefly 1:10:100 and the user corrected it, which
 * is exactly the argument for settings over constants: the correction was a
 * number in a window rather than an edit here, and nothing else in the system
 * knows a rate. Everything reads them through `rates()`.
 *
 * EVERYTHING GOES THROUGH COPPER. Comparing or subtracting mixed purses by
 * denomination is where change-making bugs live; converting to the smallest
 * coin, doing plain arithmetic, and converting back is one code path with
 * nothing to get wrong. `fromCopper` hands change back in the LARGEST coins
 * that fit, which matters more here than in most games: weight counts COINS,
 * not value, so the way change is given changes what the purse weighs.
 */

import { SETTINGS_NS } from "./settings.js";

/** Largest first — `fromCopper` walks this order, and so does display. */
export const DENOMINATIONS = ["gold", "silver", "copper"];

/** An empty purse, and the shape every function here expects. */
export const emptyPurse = () => ({ gold: 0, silver: 0, copper: 0 });

const num = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

/**
 * The world's exchange rates. Guarded because a sheet can render before
 * settings are ready, and a purse that throws is worse than one that briefly
 * uses the defaults it would have used anyway.
 * @returns {{silverPerGold: Number, copperPerSilver: Number}}
 */
export const rates = () => {
  let silverPerGold = 10;
  let copperPerSilver = 10;
  try {
    silverPerGold = Math.max(1, Math.round(num(game.settings.get(SETTINGS_NS, "silver-per-gold")) || 10));
    copperPerSilver = Math.max(1, Math.round(num(game.settings.get(SETTINGS_NS, "copper-per-silver")) || 10));
  } catch {
    /* defaults */
  }
  return { silverPerGold, copperPerSilver };
};

/** How many copper one gold is worth. */
export const copperPerGold = () => {
  const { silverPerGold, copperPerSilver } = rates();
  return silverPerGold * copperPerSilver;
};

/** A purse's whole value, in copper. */
export const toCopper = (coins = {}) => {
  const { copperPerSilver } = rates();
  return num(coins.gold) * copperPerGold()
    + num(coins.silver) * copperPerSilver
    + num(coins.copper);
};

/**
 * Copper split into the largest coins that fit.
 *
 * Rounded, and deliberately: `money()` in the schema allows fractions so
 * homebrew cannot fail validation, but half a copper coin is not a thing you
 * can put in a pocket, and a fraction here would smear across every conversion.
 */
export const fromCopper = (total) => {
  const { copperPerSilver } = rates();
  const cpg = copperPerGold();
  let left = Math.max(0, Math.round(num(total)));
  const gold = Math.floor(left / cpg);
  left -= gold * cpg;
  const silver = Math.floor(left / copperPerSilver);
  left -= silver * copperPerSilver;
  return { gold, silver, copper: left };
};

/**
 * HOW MANY COINS, which is what encumbrance counts — not what they are worth.
 * A thousand copper is a thousand coins and weighs like it, however little it
 * buys. That is the whole reason a money changer is a useful person to know.
 */
export const coinCount = (coins = {}) =>
  Math.max(0, Math.round(num(coins.gold) + num(coins.silver) + num(coins.copper)));

/**
 * A price, in copper.
 *
 * EVERY PRICE IS IN SILVER, and silver is allowed decimals (2026-09-06, user
 * ruling): 0.1 is one copper, 1 is one silver, 10 is one gold. One number, one
 * unit, and the reader never has to check which coin a price is quoted in.
 *
 * The per-item currency field this replaced lasted a few hours. It was more
 * expressive and strictly worse: it put a unit on every row of the shop, made
 * two prices impossible to compare at a glance, and asked the author of every
 * item to make a choice that a decimal point already makes for them.
 */
export const priceInCopper = (silver) => {
  const { copperPerSilver } = rates();
  return Math.round(num(silver) * copperPerSilver);
};

/** The other way, for showing what a purse is worth as one number. */
export const copperToSilver = (copper) => {
  const { copperPerSilver } = rates();
  return num(copper) / copperPerSilver;
};

/** @returns {Boolean} true when the purse covers that many copper. */
export const canAfford = (coins, costCopper) => toCopper(coins) >= Math.round(num(costCopper));

/**
 * Pay, making change.
 *
 * The shopkeeper breaks the gold coin: everything becomes copper, the price
 * comes off, and the rest returns in the largest coins that fit. That the purse
 * comes back with a different NUMBER of coins is not a side effect to hide —
 * it is the mechanic. Paying can leave a character lighter.
 *
 * @returns {Object|null} the purse after paying, or null if it could not be paid
 */
export const spend = (coins, costCopper) => {
  const cost = Math.round(num(costCopper));
  const have = toCopper(coins);
  if (cost < 0 || have < cost) return null;
  return fromCopper(have - cost);
};

/** Take money in, quoted in silver like every other price. */
export const gain = (coins, silver) => fromCopper(toCopper(coins) + priceInCopper(silver));

/** Is there anything in it at all? */
export const isEmpty = (coins) => toCopper(coins) <= 0;

/**
 * A purse as a short line: "2 mo · 3 mp · 40 mc", dropping empty piles.
 *
 * Empty piles are dropped rather than shown as zeros because the common purse
 * has one or two denominations in it, and "0 mo · 12 mp · 0 mc" makes a reader
 * do subtraction to find the one number that matters. A purse with nothing in
 * it says so in words instead.
 */
export const formatPurse = (coins = {}) => {
  const parts = DENOMINATIONS
    .filter((d) => num(coins[d]) > 0)
    .map((d) => `${Math.round(num(coins[d]))} ${game.i18n.localize(`CAIRN.CoinShort.${d}`)}`);
  return parts.length ? parts.join(" · ") : game.i18n.localize("CAIRN.CoinEmpty");
};
