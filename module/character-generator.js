import { CairnActor } from "./actor/actor.js";
import { resultText, findTableByName } from "./compendium.js";
import {
  docFromPack, documentsOfType, generatorTable, generatorText, itemByName,
  warnNoTable, TABLES,
} from "./content-packs.js";
import { Cairn } from "./config.js";
import { evaluateFormula, formatCount } from "./utils.js";
import {
  resolveGearItem, GEAR_ALIASES, spellScrollItem,
  orderGrantedItems, isLightGear, RATIONS_RE,
} from "./gear.js";
import { containerClass, iconForTransport } from "./icons.js";
import { connectionHeadroom, maxConnections, connectedOwnershipShape, OWNERSHIP_SYNC_FLAG } from "./connections.js";
import { SETTINGS_NS } from "./settings.js";
import { PERSON_ROLES, BG_ABILITY_KEYS, BG_MAX_TABLES, bgTableDie } from "./data-models.js";

// Foundry validates a document flag's scope against real package ids, so flags
// use the system id "mondolme" (NOT the internal "cairn" JS/settings namespace,
// which is fine for game.settings but is rejected by Document#getFlag/setFlag).
/** Flag scope for grant provenance. Exported so other modules (the Kettlewright
 *  importer) tag and read the same namespace rather than hardcoding a copy. */
export const FLAG_SCOPE = "mondolme";

/*
 * Cairn 2e character generation.
 *
 * Gear is NEVER inlined here: a background's starting gear, a question's item, and a
 * choice-table option's items are all BY-NAME references into the editable gear
 * pool. `resolveGearItem` (module/gear.js) turns each reference into a fresh
 * owned-item payload cloned from the current pack document — so editing a pool
 * item flows into every character generated afterwards. That single-source-of-
 * truth is the whole reason this system was rebuilt off the fork's inlined model.
 */

/* -------------------------------------------------------------------------- */
/*  Portrait / token art                                                       */
/* -------------------------------------------------------------------------- */

// The manifest is a list of paired basenames that live in BOTH
// character_portraits/ and character_tokens/ (see tools/import/portraits.mjs).
// Fetched lazily and cached so neither generation nor the gallery needs the
// FILES_BROWSE permission that listing a server folder would require -- both run
// player-side.
let _portraitManifest = null;

/** @returns {Promise<{portraitDir:String, tokenDir:String, names:String[]}>} */
export const getPortraitManifest = async () => {
  if (_portraitManifest === null) {
    try {
      const resp = await fetch("systems/mondolme/module/portrait-manifest.json");
      _portraitManifest = resp.ok ? await resp.json() : { names: [] };
    } catch {
      _portraitManifest = { names: [] };
    }
  }
  return _portraitManifest;
};

// The Game-Icons gallery: 2,275 game-icons.net glyphs in 38 categories, browsed
// category-first in the portrait picker (see tools/import/game-icons.mjs). Same
// lazy-fetch-and-cache shape as the portraits above, and for the same reason —
// a player picking art cannot enumerate a server folder. Kept here rather than
// in icons.js because that file is deliberately Foundry-free so the Node
// importers can import it; a fetch would end that.
let _gameIconManifest = null;

/** @returns {Promise<{iconDir:String, categories:{key:String, names:String[]}[]}>} */
export const getGameIconManifest = async () => {
  if (_gameIconManifest === null) {
    try {
      const resp = await fetch("systems/mondolme/module/game-icons-manifest.json");
      _gameIconManifest = resp.ok ? await resp.json() : { categories: [] };
    } catch {
      _gameIconManifest = { categories: [] };
    }
  }
  return _gameIconManifest;
};

// The Tlomdev gallery: tlomdev's CC BY-SA 4.0 token drawings, browsed by the
// artist's own category folders, plus Kettlewright's copies under
// "kettlewright-portraits" (see tools/import/tlomdev.mjs). Same
// lazy-fetch-and-cache shape as the two above, for the same reason.
let _tlomdevManifest = null;

/** @returns {Promise<{artDir:String, categories:{key:String, names:String[]}[]}>} */
export const getTlomdevManifest = async () => {
  if (_tlomdevManifest === null) {
    try {
      const resp = await fetch("systems/mondolme/module/tlomdev-manifest.json");
      _tlomdevManifest = resp.ok ? await resp.json() : { categories: [] };
    } catch {
      _tlomdevManifest = { categories: [] };
    }
  }
  return _tlomdevManifest;
};

// The Lydia Comer gallery: her monster art (© Lydia Comer, all rights reserved,
// by direct grant — NOT Creative Commons; see lydia-comer/license.txt). Same
// lazy-fetch-and-cache shape as the three above, for the same reason.
//
// Shaped unlike either of them: it is a PAIRED gallery, a flat list of
// {portrait, token} the way Aspeheim's is, not category folders. Each creature
// is a square drawing plus the circle-cropped token made from it, matched by
// stem. `pairs` holds BOTH filenames rather than one shared name the way
// portrait-manifest.json does — a habit from when the halves carried different
// extensions (.jpg square, .png circle), kept now that both are .webp because
// the two halves live in different folders and nothing should quietly depend on
// their names agreeing.
let _lydiaManifest = null;

/** @returns {Promise<{portraitDir:String, tokenDir:String, pairs:{portrait:String, token:String}[]}>} */
export const getLydiaManifest = async () => {
  if (_lydiaManifest === null) {
    try {
      const resp = await fetch("systems/mondolme/module/lydia-manifest.json");
      _lydiaManifest = resp.ok ? await resp.json() : { pairs: [] };
    } catch {
      _lydiaManifest = { pairs: [] };
    }
  }
  return _lydiaManifest;
};

/** Full portrait paths for the Lydia gallery, in manifest order. */
const lydiaPortraits = (m) =>
  (m?.pairs ?? []).map((p) => `${m.portraitDir}/${p.portrait}`);

// --- Custom portraits (GM-curated, per-world local pool) --------------------
// A folder of the GM's own portraits, scanned into a world setting so players
// (who lack FILES_BROWSE) can still see and pick them. When non-empty it REPLACES
// the shipped art for auto-assignment; empty, everything falls back to Aspeheim.
// Custom portraits have no paired token file, so each image doubles as its token.

const IMAGE_RE = /\.(?:webp|png|jpe?g|gif|svg|avif|bmp)$/i;

// How far the custom-portrait scan walks, and how many folders it will visit.
// Both exist because the scan is one HTTP round trip per folder, run on the
// Warden's client while they wait, and the setting is a free-text path — point
// it at the data root by mistake and an uncapped walk would crawl the whole
// install. Six levels is deeper than anyone files portraits; 200 folders is far
// above a portrait collection and far below a Foundry data directory. Hitting
// either is warned about rather than passed over in silence, because a short
// list looks exactly like a small collection.
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_DIRS = 200;

/**
 * The FilePicker implementation. Named in full, not resolved through a
 * v13/v14 chain: the target is v14 and nothing older, and the global
 * `FilePicker` such a chain ends on is a deprecation shim (client.mjs:213,
 * 230). The same three-way lookup stood in art-picker.js and went with this
 * one.
 */
const filePicker = () => foundry.applications.apps.FilePicker.implementation;

/** The configured custom-portrait folder (data-root-relative), or "" if blank. */
export const customPortraitFolder = () =>
  String(game.settings.get(SETTINGS_NS, "custom-portrait-folder") ?? "").trim();

/**
 * The cached custom portrait image paths. Written by a GM refresh, read by anyone
 * — so players need no FILES_BROWSE to use custom portraits. Always a string[].
 * @returns {String[]}
 */
export const getCustomPortraitPaths = () => {
  const list = game.settings.get(SETTINGS_NS, "custom-portrait-list");
  return Array.isArray(list) ? list.filter((s) => typeof s === "string" && s) : [];
};

/* --- Reserved category folders (issue #18, fsmalecho) ----------------------
 * A Warden can keep one custom folder per KIND of thing being made: a folder
 * named `pc`, `npc`, `monster` or `companion` at the TOP LEVEL of the custom
 * folder becomes that category's auto-assignment pool. Everything else is one
 * general pool, which is what a Warden using none of these names has always
 * had.
 *
 * Reserved by CONVENTION rather than by four more settings, deliberately: it
 * would be four more rows in the Character Generation submenu, a
 * second folder setting is a second folder to scan on every Warden's login
 * (the scan is one HTTP round trip per directory, capped at 200), and the
 * picker already renders subfolders as tiles. Nothing here adds a register()
 * call, so the counts in CLAUDE.md stand.
 *
 * THE GENERAL POOL EXCLUDES THE RESERVED FOLDERS, and that is a ruling rather
 * than an implementation detail. If it did not, a Warden who filed only
 * `monster/` would have every player character generated from monster art —
 * the reserved folder would have made things worse for the one category they
 * had bothered to sort.
 *
 * No cross-category fallback either: a Warden with only `pc/` filled gets the
 * shipped art on NPCs, not their PC art. "NPCs borrow PC art but monsters do
 * not" is a rule nobody can hold in their head.
 *
 * TOP LEVEL only, so `Kindred/monster` is an ordinary folder — but anything
 * NESTED inside a reserved one counts toward it, which keeps the "file them
 * however you like" promise inside each category.
 *
 * `character`/`characters` is deliberately NOT reserved. It is the likeliest
 * name for a folder a Warden already uses to mean ALL their portraits, and
 * capturing it would silently take their NPC art away.
 */
export const PORTRAIT_CATEGORIES = ["pc", "npc", "monster", "companion"];

const RESERVED_FOLDERS = new Map([
  ["pc", "pc"], ["pcs", "pc"],
  ["npc", "npc"], ["npcs", "npc"],
  ["monster", "monster"], ["monsters", "monster"],
  ["companion", "companion"], ["companions", "companion"],
]);

/**
 * The category a top-level folder name reserves, or null for an ordinary one.
 * Percent-decoded first: `browse` hands back web paths, so a folder arrives as
 * "OSR%20Fantasy". None of the reserved names contains a character that
 * encodes, but decoding is what keeps that true of the COMPARISON rather than
 * true by luck.
 *
 * EXPORTED so the art picker can label a reserved folder tile without keeping
 * a second copy of the alias list. A second copy of one list is this project's
 * most-repeated bug: CREATURE_CATEGORIES, the settings groups and the pack
 * count have each gone stale that way.
 * @param {String} segment
 * @returns {String|null}
 */
export const reservedPortraitCategory = (segment) => {
  let name = String(segment ?? "");
  try { name = decodeURIComponent(name); } catch { /* malformed escape: match as written */ }
  return RESERVED_FOLDERS.get(name.trim().toLowerCase()) ?? null;
};

/**
 * The flat cached list, bucketed into the four reserved categories plus
 * `general`. Derived on every call rather than cached: the list changes under
 * a Warden's Refresh and there is no invalidation hook worth owning for a walk
 * over a few hundred strings.
 *
 * A path that does not sit under the configured root falls to GENERAL — the
 * same rule `splitCustomPaths` states in art-picker.js: a path this cannot
 * classify must never become a path this hides.
 * @returns {Object<String, String[]>}
 */
const customBuckets = () => {
  const root = customPortraitFolder().replace(/\/+$/, "");
  const prefix = root ? `${root}/` : "";
  const buckets = { general: [] };
  for (const cat of PORTRAIT_CATEGORIES) buckets[cat] = [];
  for (const p of getCustomPortraitPaths()) {
    const rest = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : null;
    const cut = rest === null ? -1 : rest.indexOf("/");
    const cat = cut > 0 ? reservedPortraitCategory(rest.slice(0, cut)) : null;
    buckets[cat ?? "general"].push(p);
  }
  return buckets;
};

/**
 * The categories that inherit the GENERAL pool when they have no reserved
 * folder of their own — and the two that do not.
 *
 * The general pool is historically a pool of PEOPLE: until this change the
 * custom folder fed exactly three things, all of them someone with a face
 * (a player character, an npc person, a Kettlewright import). So `pc` and
 * `npc` inheriting it IS the old behaviour, unchanged for every Warden who
 * never adopts a reserved name.
 *
 * `monster` and `companion` deliberately do NOT inherit it, and that is the
 * opposite of what it looks like. Both already have a category-appropriate
 * shipped fallback — game-icons creature glyphs for a monster, the pack
 * document's own art or a class icon for a beast — and handing them the
 * general pool instead would mean a Warden with an unsorted folder of
 * portraits woke up to every generated monster wearing a shopkeeper's face
 * and every granted mule wearing a woman's. Neither of them ever drew from
 * this pool before; opting in by naming a folder is how they start.
 */
const GENERAL_POOL_CATEGORIES = new Set(["pc", "npc"]);

/**
 * The custom images a category may draw from: its own reserved folder when
 * that holds anything, else the general pool for the two categories above,
 * else nothing. Empty means "no custom art for this category" and the caller
 * falls back to whatever shipped art it owns — which is NOT the same art for
 * every category, so that fallback stays with the caller rather than being
 * decided here.
 *
 * `null` asks for the general pool outright, which is what an un-converted
 * caller gets and what every caller got before this existed.
 * @param {String|null} [category] one of PORTRAIT_CATEGORIES
 * @returns {String[]}
 */
export const customPoolFor = (category = null) => {
  const buckets = customBuckets();
  if (!category) return buckets.general;
  if (buckets[category]?.length) return buckets[category];
  return GENERAL_POOL_CATEGORIES.has(category) ? buckets.general : [];
};

/**
 * The portrait category an actor belongs to, or null for one that wears no
 * portrait at all (a cart, a chest — they take class icons from the container
 * gallery). BOTH person roles land on `npc`: a hireling SHARES the npc folder
 * (user ruling 2026-08-21), deliberately not a fifth reserved name — the
 * generator's own call sites have always passed "npc" for hirelings, and this
 * mapping said `role === "npc"` instead, which went stale the day the split
 * brought the hireling role back and sent the sheet die to the general pool.
 * @param {Actor} actor
 * @returns {String|null}
 */
export const portraitCategoryFor = (actor) => {
  if (!actor) return null;
  if (actor.type === "character") return "pc";
  const role = actor.npcRole
    ?? (["npc", "hireling"].includes(actor.type) ? (actor.system?.role || "npc") : null);
  if (role === "monster" || role === "companion") return role;
  return PERSON_ROLES.includes(role) ? "npc" : null;
};

/**
 * Ensure the custom-portrait folder exists (GM-side; needs FILES permission).
 * Non-fatal: a host that forbids creation just leaves it absent and the feature
 * falls back to shipped art. Never throws.
 */
export const ensureCustomPortraitFolder = async () => {
  const dir = customPortraitFolder();
  if (!dir) return;
  const FP = filePicker();
  try {
    await FP.browse("data", dir); // already there
  } catch {
    try { await FP.createDirectory("data", dir); }
    catch { /* permission/quirk — leave absent, shipped art still works */ }
  }
};

/**
 * Scan the custom-portrait folder and cache its image list into the world setting.
 * GM only (writing a world setting and listing a folder both require it). Returns
 * the fresh list; non-fatal — on failure keeps and returns the prior cache.
 * @returns {Promise<String[]>}
 */
export const refreshCustomPortraits = async () => {
  if (!game.user?.isGM) return getCustomPortraitPaths();
  const dir = customPortraitFolder();
  if (!dir) { await game.settings.set(SETTINGS_NS, "custom-portrait-list", []); return []; }
  try {
    const FP = filePicker();
    const root = await FP.browse("data", dir);
    const files = (root?.files ?? []).filter((f) => IMAGE_RE.test(f));
    // SUBFOLDERS, to any depth (2026-08-14, user report, twice). `browse`
    // returns `{dirs, files}` for the target directory ALONE and does not
    // recurse — and this read only `files`, throwing the folder list away. A
    // Warden who had organised their portraits into category folders
    // (clerics-paladins, thieves, magic-users…) therefore got a browse that
    // returned eleven dirs and zero files, an empty cache, and a picker reading
    // "No custom portraits found" over a folder that was full. The information
    // was already arriving; nothing was reading it.
    //
    // The first fix walked ONE level, on the reasoning that one level is what
    // the shipped galleries use. That reasoning was about OUR folders, not the
    // Warden's: a folder inside a category folder is an ordinary way to file
    // art, and on the live server it produced the same silent nothing the
    // original bug did — a category tile that simply never appeared. So the
    // walk is now breadth-first to `MAX_SCAN_DEPTH`, and the limits are stated
    // in the constants rather than implied by the code.
    //
    // A failed subfolder is skipped, not fatal: one unreadable folder must not
    // cost the Warden every other portrait they have. `seen` guards against a
    // directory link that points back up its own tree — the walk is over paths,
    // so a cycle would otherwise never terminate.
    const seen = new Set([dir]);
    const queue = (root?.dirs ?? []).map((path) => ({ path, depth: 1 }));
    let scanned = 0;
    let truncated = false;
    while (queue.length) {
      const { path, depth } = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      if (++scanned > MAX_SCAN_DIRS) { truncated = true; break; }
      let res;
      try {
        res = await FP.browse("data", path);
      } catch (e) {
        console.warn(`Mondolme | could not scan custom portrait subfolder ${path}:`, e);
        continue;
      }
      files.push(...(res?.files ?? []).filter((f) => IMAGE_RE.test(f)));
      const subs = res?.dirs ?? [];
      if (depth < MAX_SCAN_DEPTH) queue.push(...subs.map((p) => ({ path: p, depth: depth + 1 })));
      else if (subs.length) truncated = true;
    }
    if (truncated) {
      console.warn(`Mondolme | custom portrait scan stopped early in "${dir}" — `
        + `more than ${MAX_SCAN_DIRS} folders or deeper than ${MAX_SCAN_DEPTH} levels. `
        + "Some portraits will be missing from the Custom tab.");
    }
    await game.settings.set(SETTINGS_NS, "custom-portrait-list", files);
    return files;
  } catch (e) {
    console.warn("Mondolme | could not scan custom portrait folder:", e);
    return getCustomPortraitPaths();
  }
};

/**
 * The tlomdev category every generated actor's portrait is drawn from
 * (user ruling 2026-08-18, replacing the Aspeheim pairs for characters, NPCs
 * and hirelings alike). 70 drawings of people; the sibling folders are beasts,
 * statues and the like, so the KEY is the whole of the decision.
 */
const DEFAULT_PORTRAIT_CATEGORY = "humanoid";

/**
 * Every path in the default portrait category, or [] when the manifest is
 * missing or has been re-keyed. Callers treat empty as "no shipped pool".
 * @returns {Promise<String[]>}
 */
const defaultPortraitPool = async () => {
  const tl = await getTlomdevManifest();
  const dir = tl?.artDir ?? "systems/mondolme/art/tlomdev";
  const cat = (tl?.categories ?? []).find((c) => c.key === DEFAULT_PORTRAIT_CATEGORY);
  return (cat?.names ?? []).map((n) => `${dir}/${DEFAULT_PORTRAIT_CATEGORY}/${n}`);
};

/**
 * A random {img, token} portrait pair for a new character/hireling/npc. Draws
 * ONLY from the GM's custom pool when it is non-empty; otherwise from tlomdev's
 * `humanoid` folder. Null only if BOTH are empty.
 *
 * `category` picks WHICH custom pool (issue #18): a reserved `pc/` or `npc/`
 * folder when the Warden keeps one, else the general pool. Omitting it asks
 * for the general pool, which is what every caller got before categories
 * existed — so an un-converted caller behaves exactly as it always did. The
 * shipped fallback is NOT category-aware and must not become so here: it would
 * serve a monster badly, 70 drawings of people for a thing that is not one.
 * (The monster generator that picked its own game-icons creature art is gone,
 * 2026-08-29; a monster takes whatever art its maker gives it.)
 *
 * THE TOKEN IS THE PORTRAIT. Aspeheim's gallery was the one paired set this
 * drew from — two folders sharing a filename, a 1000px face and a 256px token
 * drawn for the canvas — and tlomdev ships no token half, so a drawing is its
 * own token exactly as a custom upload is. That is a real loss of the prepped
 * canvas art and it was accepted at ruling time; the 240px source is already
 * token-sized, and the sheet portrait renders well below its own resolution.
 *
 * Aspeheim's gallery still SHIPS and is still offered in the picker for every
 * face-wearing role — this changes what generation ASSIGNS, nothing else. And
 * nothing rewrites an existing actor: an img is copied onto the document at
 * creation and never re-read, so every character made before today keeps the
 * portrait and paired token it already has.
 * @param {String|null} [category] one of PORTRAIT_CATEGORIES
 * @returns {Promise<{img:String, token:String}|null>}
 */
export const randomPortraitPair = async (category = null) => {
  const custom = customPoolFor(category);
  const pool = custom.length ? custom : await defaultPortraitPool();
  if (!pool.length) return null;
  const path = pool[Math.floor(Math.random() * pool.length)];
  return { img: path, token: path };
};

/**
 * The prepped token image paired with a portrait path, or null when the
 * portrait isn't from one of the two PAIRED galleries (e.g. a custom upload, a
 * game-icons glyph, a tlomdev drawing — each of which is its own token).
 * Callers decide the fallback.
 *
 * TWO galleries answer here. Aspeheim's halves share one filename across two
 * folders, so a basename lookup settles it. Lydia's manifest names both halves
 * and the lookup is by the PORTRAIT filename — which was load-bearing while the
 * halves were .jpg and .png, and is merely honest now that both are .webp.
 * Matching on the DIRECTORY as well as the name is the part that still matters:
 * an Aspeheim and a Lydia file could in principle share a stem, and the answer
 * must not depend on which gallery is consulted first.
 * @param {String} portraitPath
 * @returns {Promise<String|null>}
 */
export const pairedTokenFor = async (portraitPath) => {
  const src = String(portraitPath ?? "");
  const base = src.split("/").pop();

  const m = await getPortraitManifest();
  if (m?.names?.includes(base) && src === `${m.portraitDir}/${base}`) return `${m.tokenDir}/${base}`;

  const l = await getLydiaManifest();
  const pair = (l?.pairs ?? []).find((p) => src === `${l.portraitDir}/${p.portrait}`);
  return pair ? `${l.tokenDir}/${pair.token}` : null;
};

/**
 * The pool `img` belongs to inside a category gallery (game-icons or tlomdev):
 * every file of the category the image sits in, or null when it is not from
 * one. Membership is checked against the MANIFEST, not just the path shape, so
 * a stale path to a renamed file falls through to the caller's fallback.
 */
const categoryPoolFor = (img, dir, categories) => {
  if (!dir || !img.startsWith(`${dir}/`)) return null;
  const rest = img.slice(dir.length + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const key = rest.slice(0, slash);
  const cat = categories.find((c) => c.key === key);
  return cat?.names?.includes(rest.slice(slash + 1))
    ? cat.names.map((n) => `${dir}/${key}/${n}`)
    : null;
};

/**
 * The portrait die re-rolls WITHIN THE FOLDER the current portrait came from:
 * an Aspeheim face rolls another Aspeheim face, a custom portrait another from
 * the Warden's folder, a game-icons or tlomdev pick another from the SAME
 * CATEGORY — a beast stays a beast rather than turning into a librarian's
 * portrait. Only when the current image is from no known gallery folder (the
 * default mystery-man, a pasted URL, a Kind glyph) does it fall back to the
 * auto-assignment pool (custom when non-empty, else the generator's own default
 * folder), which was the die's whole behaviour before this rule.
 *
 * Avoids returning the current image while the pool holds anything else, so
 * the die always visibly does something.
 *
 * `category` scopes the CUSTOM half (issue #18). The promise in the first
 * sentence was never kept for custom art: every custom image was one folder as
 * far as this function was concerned, so the die on a monster wearing the
 * Warden's art could hand it a shopkeeper's face. With a reserved folder in
 * play the pool is that folder, so a monster stays a monster — the same
 * promise the category galleries below already make.
 * @param {String} current the actor's current img
 * @param {String|null} [category] one of PORTRAIT_CATEGORIES, from portraitCategoryFor
 * @returns {Promise<String|null>} a portrait src, or null when every pool is empty
 */
export const randomPortraitInSameFolder = async (current, category = null) => {
  const img = String(current ?? "");
  const m = await getPortraitManifest();
  const portraitDir = m?.portraitDir ?? "systems/mondolme/art/jon-aspeheim/portraits";
  const aspeheim = (m?.names ?? []).map((n) => `${portraitDir}/${n}`);
  const custom = customPoolFor(category);
  // The WHOLE cached list, only to answer "is this image custom art at all".
  // `customPoolFor` can legitimately return nothing (a monster in a world with
  // no `monster/` folder inherits no general pool), and testing membership
  // against that would send a monster wearing the Warden's own art down to the
  // bottom fallback and hand it a tlomdev human. Today that case re-rolls
  // inside the custom folder, and it still does.
  const customAll = getCustomPortraitPaths();

  let pool = null;
  if (aspeheim.includes(img)) pool = aspeheim;
  if (!pool && customAll.includes(img)) pool = custom.length ? custom : customAll;
  if (!pool) {
    // Lydia's gallery is flat, so the whole of it is the folder — a dragon can
    // roll into a were-rat, which is the same promise the category galleries
    // make one folder down. It is never the FALLBACK pool at the bottom of this
    // function, though: these are creatures, and the die on an actor wearing no
    // known art must not turn a hireling into a black pudding.
    const l = await getLydiaManifest();
    const lydia = lydiaPortraits(l);
    if (lydia.includes(img)) pool = lydia;
  }
  if (!pool) {
    const gi = await getGameIconManifest();
    pool = categoryPoolFor(img, gi?.iconDir ?? "systems/mondolme/art/game-icons", gi?.categories ?? []);
  }
  if (!pool) {
    const tl = await getTlomdevManifest();
    pool = categoryPoolFor(img, tl?.artDir ?? "systems/mondolme/art/tlomdev", tl?.categories ?? []);
  }
  // Unknown art falls back to whatever GENERATION would have assigned, so the
  // die and the generator cannot disagree about what the house pool is. That is
  // tlomdev's `humanoid` folder since 2026-08-18 — it was Aspeheim before, and
  // an Aspeheim portrait still re-rolls within Aspeheim above, because the
  // gallery still ships and this branch is only for art from no known folder.
  if (!pool) pool = custom.length ? custom : await defaultPortraitPool();

  if (!pool.length) return null;
  const others = pool.filter((src) => src !== img);
  const choices = others.length ? others : pool;
  return choices[Math.floor(Math.random() * choices.length)];
};

/**
 * The shipped tlomdev copy of a Kettlewright stock portrait ("portrait17.webp"),
 * or null when the name is not in the shipped set. The Kettlewright importer
 * maps stock picks through this — the filenames under
 * tlomdev/kettlewright-portraits/ are Kettlewright's own numbering on purpose.
 * @param {String} name a bare filename as Kettlewright's export stores it
 * @returns {Promise<String|null>}
 */
export const kettlewrightPortraitPath = async (name) => {
  const tl = await getTlomdevManifest();
  const cat = tl?.categories?.find((c) => c.key === "kettlewright-portraits");
  return cat?.names?.includes(name) ? `${tl.artDir}/${cat.key}/${name}` : null;
};

/* -------------------------------------------------------------------------- */
/*  Shared dice/table rolls                                                    */
/* -------------------------------------------------------------------------- */

/*
 * These three return the evaluated Roll, NOT its total, so the generation chat
 * card (postGenerationRolls) can hand the real Roll objects to ChatMessage and
 * let Dice So Nice animate them. Callers read `.total` themselves. rollAge is
 * deliberately NOT part of this: age is excluded from the card, and it answers
 * with a NUMBER off the background's own age formula, not a Roll.
 */

/** @param {String} formula @returns {Promise<{STR:Roll,DEX:Roll,WIL:Roll}>} */
export const rollAbilities = async (formula) => ({
  STR: await evaluateFormula(formula),
  DEX: await evaluateFormula(formula),
  WIL: await evaluateFormula(formula),
});

/** @param {String} formula @returns {Promise<Roll>} */
export const rollHitProtection = async (formula) => evaluateFormula(formula);

/** @param {String} formula @returns {Promise<Roll>} */
export const rollGold = async (formula) => evaluateFormula(formula);

/**
 * Roll an age from the BACKGROUND's own `ageFormula`, falling back to the
 * caller's formula (the config's one copy, RAW `2d20 + 10`) when the
 * background says nothing or says something that does not parse.
 *
 * The formula moved off the world setting and onto the background (the
 * `age-formula` setting is gone): age is a fact about the life a background
 * describes, and one number for every background in the world could not say
 * that — an apprentice and a retired soldier do not share a spread. A
 * background with no formula still gets the system default, so nothing has to
 * be filled in for the die to work.
 *
 * The bounds this replaced are staying replaced (2026-08-21, issue #21 both
 * ways — fsmalecho asked for the ceiling AND then reported what clamping did):
 * holding 2d20 + 10 under a ceiling of 30 made ~57% of rolls exactly 30,
 * because a clamp piles the distribution onto its bound. The Warden edits the
 * DICE, so a chosen range arrives as a spread.
 *
 * Blank falls back SILENTLY — blank is "use the default", not a mistake. A
 * non-blank formula that fails Roll.validate falls back too and WARNS,
 * naming the rejected text: a typo the Warden never hears about is just
 * "the field does nothing". Validation is on the RAW text, which is right
 * in both dice-notation dialects — the Cairn keep-highest rewrite only maps
 * valid arithmetic to valid pool syntax. A formula carrying an `@` reference
 * is refused the same way, BEFORE Roll.validate gets a say — see the guard
 * below for why the validator cannot be trusted about that class.
 *
 * ROLLS ONLY, and deliberately. Age is a free-text input on the sheet
 * (templates/parts/bio-block.html) with this die beside it, so a hand-typed
 * age is nobody's business but the player's — the old bounds never
 * constrained it and the formula does not either.
 *
 * The single choke point for age: every generation call site and the sheet's
 * re-roll come through here, so the background's formula lands everywhere at
 * once. A generator with no background (npc, hireling) passes null and gets
 * the default.
 * @param {CairnItem|null} bg  the background whose formula applies, or null
 * @param {String} fallback @returns {Promise<Number>}
 */
export const rollAge = async (bg, fallback) => {
  const { formula, configured, usable } = effectiveAgeFormula(bg, fallback);
  if (!usable && configured) {
    ui.notifications.warn(game.i18n.format("CAIRN.Notify.BadAgeFormula", { formula: configured }));
  }
  return (await evaluateFormula(formula)).total;
};

/**
 * The formula the age die will ACTUALLY roll: the background's `ageFormula`
 * when it is set and usable, else `fallback`. ONE answer for the die above and
 * for the sheet's tooltip beside Age (review #18 finding 10: the tooltip said
 * "(2d20 + 10)" while the die obeyed the configured formula), so the two
 * cannot disagree — the tooltip shows what a click will roll, fallback
 * included.
 *
 * `usable` is the test rollAge always applied. `@` references are refused
 * before validation — warden-damage.js's guard, copied because the same two
 * client stubs make Roll.validate lie about the whole class: it replaces every
 * `@ref` with "1" before evaluating (dice/roll.mjs:772-790) so it ACCEPTS
 * them, while real evaluation resolves them with `{missing: "0"}` (:689-701) —
 * so "2d20 + @bonus" passed the gate and rolled "2d20 + 0", and "@x + 3" made
 * every age exactly 3, with the warn-and-fall-back contract unreachable for
 * the one input class that needed it most (review #17). Generation has no
 * actor to resolve against, so refusing is the honest answer, not a
 * workaround.
 * @param {CairnItem|null} bg  the background whose formula applies, or null
 * @param {string} fallback
 * @returns {{formula: string, configured: string, usable: boolean}}
 *   `configured` is the background's trimmed formula (blank when unset), for
 *   the warning.
 */
export const effectiveAgeFormula = (bg, fallback) => {
  const configured = String(bg?.system?.ageFormula ?? "").trim();
  const candidate = configured || String(fallback ?? "");
  const usable = !candidate.includes("@") && Roll.validate(candidate);
  return { formula: usable ? candidate : fallback, configured, usable };
};

/**
 * Draw one text result from each named table (used for the eight 2e traits).
 *
 * The values are BARE TABLE NAMES now, not "pack;Table" addresses: every one of
 * them lives in the Warden's Generadores compendium, so the pack half of the old
 * string said the same thing eight times. `generatorText` degrades a missing
 * table to "" exactly as `drawTableText` did — generation must never throw
 * half-way and leave a part-built actor — and tells the Warden which table is
 * missing on the way past, once per table per session.
 * @param {Object<string,string>} items  key -> table name
 * @returns {Promise<Object<string,string>>}
 */
export const rollTextItems = async (items) => {
  const data = {};
  for (const [key, name] of Object.entries(items)) {
    data[key] = await generatorText(name);
  }
  return data;
};

/**
 * Roll a name off a name table. Cairn 2e dropped 1e's name tables, so everything
 * that needs a random person's name — a hireling, an NPC, a player character
 * — draws from the Nombres table. Uses roll(), never draw(), so the table's
 * drawn state is never mutated.
 * @param {String} tableName  a Generadores table name (CONFIG.Cairn.*.name)
 * @param {String} fallback  used when the table is missing or empty
 * @returns {Promise<String>}
 */
export const rollNameFromTable = async (tableName, fallback) => {
  const table = tableName ? await generatorTable(tableName) : null;
  if (!table) return fallback;
  const { results } = await table.roll();
  return resultText(results[0]).trim() || fallback;
};

/* -------------------------------------------------------------------------- */
/*  Gear references -> owned items                                             */
/* -------------------------------------------------------------------------- */

/**
 * Turn a snapshot (a frozen copy of an item, as authored on a custom background
 * via drag-to-snapshot) into a fresh owned-item payload. This is the portable
 * counterpart to by-name resolution: the item travels *inside* the background, so
 * a GM's one-off gear resolves even on a table that has never seen it. Per-grant
 * quantity/uses still override, exactly as by-name resolution does.
 * @param {Object} data  a serialized item {name, type, img, system}
 * @param {{quantity?:Number, uses?:Number}} [overrides]
 * @returns {Object}
 */
const ownedFromSnapshot = (data, { quantity, uses } = {}) => {
  const system = foundry.utils.deepClone(data.system ?? {});
  system.quantity = quantity ?? system.quantity ?? 1;
  system.equipped = false;
  if (uses != null) system.uses = { value: uses, max: uses };
  return { name: data.name, type: data.type ?? "item", img: data.img, system };
};

/**
 * Resolve one gear reference to an owned-item payload, or null on a miss
 * (resolveGearItem warns). A reference is EITHER a snapshot (`itemData`, a frozen
 * copy authored on a custom background — self-contained, always resolves) OR a
 * by-name pointer {name, quantity?, uses?} into the canonical packs. The
 * `uses`/`quantity` on a reference override, letting two backgrounds grant the
 * same item with different counts.
 * @param {{name:String, quantity?:Number, uses?:Number, itemData?:Object}} ref
 * @returns {Promise<Object|null>}
 */
const resolveRef = (ref) =>
  ref?.itemData
    ? Promise.resolve(ownedFromSnapshot(ref.itemData, { quantity: ref.quantity ?? 1, uses: ref.uses }))
    : resolveGearItem(ref.name, { quantity: ref.quantity ?? 1, uses: ref.uses });

/** Resolve an array of references, dropping any that miss. @returns {Promise<Object[]>} */
export const resolveRefs = async (refs) =>
  (await Promise.all((refs ?? []).map(resolveRef))).filter(Boolean);

/**
 * Tag a built item with the generation source that granted it, so the sheet can
 * later find and remove exactly those items when that source is re-rolled (a
 * specific background question). Starting gear carries the "background"
 * source; base/bought gear carries none and is never touched by a re-roll.
 * @param {Object} item @param {String} source  e.g. "question:0"
 */
export const withGrantSource = (item, source) => ({
  ...item,
  flags: { ...(item.flags ?? {}), [FLAG_SCOPE]: { ...(item.flags?.[FLAG_SCOPE] ?? {}), grantSource: source } },
});

/**
 * Mundane background gear that needs no "Background" source chip — light and
 * food whose provenance nobody tracks. Left untagged on purpose.
 *
 * Asked of the SHARED classification in gear.js rather than of a second regex
 * of its own, so "what counts as a light" is decided in one place: the ordering
 * rules and this rule were two overlapping lists, and a third copy of a list is
 * a third thing to drift. One consequence, intended rather than incidental —
 * the old regex named only rations, torches and lanterns, so a granted CANDLE
 * wore a Background chip until now and no longer does. That is exactly what the
 * sentence above says should happen to it.
 *
 * PC path only: buildNpcItems tags every grant it makes, chip or no chip,
 * because an untagged grant is indistinguishable from a Warden's own gift and
 * would survive every re-roll.
 */
const isUntaggedMundaneGear = (name) =>
  RATIONS_RE.test(String(name ?? "")) || isLightGear(name);

/** Tag built starting gear "background" (so it can show a source chip later),
 *  EXCEPT the mundane items above, which stay untagged. */
const tagBackgroundGear = (items) =>
  items.map((it) => (isUntaggedMundaneGear(it.name) ? it : withGrantSource(it, "background")));

/* -------------------------------------------------------------------------- */
/*  Obligations — REMOVED                                                      */
/* -------------------------------------------------------------------------- */

/* The whole obligations section stood here and is GONE (2026-09-02, user ruling:
   "no quiero obligaciones, ni tablas de obligaciones").

   It held `bondsTable`, `bondKey`, `BOND_DRAW_ATTEMPTS`, `drawBond`,
   `bondRecordFrom`, `mentionsSecondBond` and `bondEntitlement`: a draw on the
   Obligaciones table with duplicate-avoidance, a record with a stable id whose
   granted items were tagged `bond:<id>`, and the entitlement rule that decided
   how many a character was owed. Everything downstream went with it —
   `CharacterData.bonds`, `BackgroundData.secondBond` and `.bondsTable`, the
   sheet's three handlers and its section, the printed block, and the
   «Obligaciones» entry in `TABLES`. */

/* -------------------------------------------------------------------------- */
/*  Background choice tables                                                    */
/* -------------------------------------------------------------------------- */

/** A zeroed FUE/DES/VOL/PG tally. */
export const noAbilityBonuses = () => Object.fromEntries(BG_ABILITY_KEYS.map((k) => [k, 0]));

/**
 * The four ability bonuses a table option grants, as whole numbers. An option
 * is a free-form record (see BackgroundData.tables), so anything missing or
 * unparseable reads 0; NEGATIVES ARE LEGAL and are the point of the field — a
 * background may cost a character strength as readily as give it.
 * @param {Object} opt @returns {{str:Number,dex:Number,wil:Number,hp:Number}}
 */
export const optionAbilityBonuses = (opt) => Object.fromEntries(BG_ABILITY_KEYS.map((k) => {
  const n = Number(opt?.[k]);
  return [k, Number.isFinite(n) ? Math.trunc(n) : 0];
}));

/**
 * Starting values plus bonuses, CLAMPED AT ZERO.
 *
 * A negative bonus can take an ability below nothing, and nothing is the floor:
 * Cairn has no negative ability scores, and a character minted with STR -1
 * would fail every save it can never pass and break the deprivation and
 * damage arithmetic downstream. The clamp is per ability and applied once, on
 * the sum — so a -3 against a 2 lands on 0 and not on -1, and two bonuses on
 * one ability cannot each clamp separately and inflate the result.
 * @param {Object} base  {str,dex,wil,hp}
 * @param {Object} bonuses  {str,dex,wil,hp}
 * @returns {{str:Number,dex:Number,wil:Number,hp:Number}}
 */
export const withAbilityBonuses = (base, bonuses) => Object.fromEntries(
  BG_ABILITY_KEYS.map((k) => [k, Math.max(0, (base?.[k] ?? 0) + (bonuses?.[k] ?? 0))])
);

/** Where each bonus key lands on a character. `hp` is Hit Protection, which is
 *  a value/max pair like the three abilities but not one of them. */
const ABILITY_PATHS = { str: "system.abilities.STR", dex: "system.abilities.DEX", wil: "system.abilities.WIL", hp: "system.hp" };

/**
 * The actor update that moves a character's four starting numbers by a SIGNED
 * delta — what a background swap or a re-rolled question owes, and the exact
 * counterpart of the gold arithmetic beside it: give back what the old answer
 * granted, apply what the new one grants.
 *
 * `max` carries the change and `value` follows it, so a wounded character stays
 * wounded by the same amount and a healthy one stays full. Both floor at 0, and
 * `value` is additionally held at or under the new `max` — a -2 on a character
 * already at full must not leave value above max.
 *
 * Keys with a zero delta are omitted entirely, so a swap between two backgrounds
 * that grant nothing writes nothing.
 * @param {CairnActor} actor @param {Object} delta  {str,dex,wil,hp}, signed
 * @returns {Object} a flat update object (possibly empty)
 */
export const abilityDeltaUpdate = (actor, delta) => {
  const update = {};
  for (const k of BG_ABILITY_KEYS) {
    const d = delta?.[k] ?? 0;
    if (!d) continue;
    const path = ABILITY_PATHS[k];
    const cur = foundry.utils.getProperty(actor, path) ?? {};
    const max = Math.max(0, (cur.max ?? 0) + d);
    update[`${path}.max`] = max;
    update[`${path}.value`] = Math.min(Math.max(0, (cur.value ?? 0) + d), max);
  }
  return update;
};

/** The signed difference between two bonus tallies (new minus old). */
export const abilityBonusDelta = (next, prev) => Object.fromEntries(
  BG_ABILITY_KEYS.map((k) => [k, (next?.[k] ?? 0) - (prev?.[k] ?? 0)])
);

/**
 * Roll each of a background's choice tables (e.g. "What went horribly wrong?")
 * and collect what the rolled option grants: narrative, gear (resolved against
 * the pool), bonus gold, and the four ability bonuses. Each table becomes a
 * structured {question, answer, gold, abilities} entry, index-aligned with
 * bg.system.tables, so the sheet can re-roll one question in isolation later;
 * its items are tagged question:<i>.
 *
 * THE DIE IS THE TABLE'S OWN (`table.die`, one of d4/d6/d8/d10/d12), not the
 * option count. Those two agree whenever the authoring form wrote the table —
 * it resizes the rows to the die — and where a hand-edited document disagrees,
 * the DIE is the truth: it is what the Warden chose and what the printed table
 * says. A face with no row falls back to the first option rather than granting
 * nothing, so a short table degrades instead of silently skipping a question.
 *
 * An option may also grant a CONTAINER (Kettlewright's donkey, Outrider's horse,
 * Bonekeeper's burial wagon). A container is an Actor, not an embedded item, so
 * those specs are only collected here and minted once the character Actor exists
 * — see grantContainers.
 * @param {CairnItem} bg
 * @returns {Promise<{questions:Object[], items:Object[], containers:Object[], gold:Number, abilities:Object}>}
 *   `abilities` is the SUM of every rolled option's bonuses, for the caller to
 *   apply on top of the starting values (withAbilityBonuses).
 */
/**
 * The SAME shape `applyChoiceTables` returns, with nothing rolled: one blank
 * record per question, no items, no containers, no gold, no ability bonuses.
 *
 * This is what generation and a background swap use now (2026-09-02, user
 * ruling): a character arrives with its background's questions ASKED and
 * unanswered, and the player rolls each one from the Trasfondo tab, where the
 * gold, the item and the ability bonuses that answer carries arrive at that
 * moment. `applyChoiceTables` itself is untouched and still rolls everything —
 * `previewBackground` is a DRY RUN of what a full roll-through would give, and
 * a preview that stopped rolling would report nothing at all.
 *
 * Index-aligned with `bg.system.tables`, exactly as the rolling version is:
 * the sheet's roll control addresses a question by its index, and a blank
 * record is the empty starting state that `#onRerollQuestion` fills — the same
 * swap-out/swap-in it does for a re-roll, with nothing to swap out.
 * @param {CairnItem} bg
 * @returns {{questions:Object[], items:Object[], containers:Object[], gold:Number, abilities:Object}}
 */
export const emptyChoiceTables = (bg) => ({
  questions: (bg?.system?.tables ?? []).map((t) => ({
    // `heading` is the group title an author may put above this question. It is
    // COPIED here as a fallback only — the sheet reads the live background so an
    // edited heading reaches characters already built — and matters for a
    // character whose background has since been deleted.
    heading: t.heading ?? "",
    question: t.question ?? "", answer: "", gold: 0, abilities: noAbilityBonuses(),
  })),
  items: [],
  containers: [],
  gold: 0,
  abilities: noAbilityBonuses(),
});

export const applyChoiceTables = async (bg) => {
  const out = { questions: [], items: [], containers: [], gold: 0, abilities: noAbilityBonuses() };
  const tables = bg.system.tables ?? [];
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const options = table.options ?? [];
    if (!options.length) {
      out.questions.push({ heading: table.heading ?? "", question: table.question ?? "", answer: "", gold: 0, abilities: noAbilityBonuses() });
      continue;
    }
    const roll = await evaluateFormula(`1d${bgTableDie(table)}`);
    const opt = options[roll.total - 1] ?? options[0];
    const gold = opt.bonusGold ?? 0;
    const abilities = optionAbilityBonuses(opt);
    const items = (await resolveRefs(opt.items)).map((it) => withGrantSource(it, `question:${i}`));
    out.items.push(...items);
    // The option's own prose rides along with the container spec. What the
    // background PROMISED about this beast — "4 HP. +6 slots (only +2 slots if
    // carrying two people)" — belongs ON the beast, not only in the question
    // list on the character it is connected to.
    out.containers.push(...(opt.containers ?? []).map((c) => ({
      ...c, grantSource: `question:${i}`,
    })));
    out.gold += gold;
    for (const k of BG_ABILITY_KEYS) out.abilities[k] += abilities[k];
    // `abilities` is stored ON the question for the same reason `gold` is: the
    // sheet's per-question re-roll has to give back what this answer granted
    // before it grants the next one's.
    out.questions.push({ heading: table.heading ?? "", question: table.question ?? "", answer: opt.description ?? "", gold, abilities });
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/*  Authoring preview / linter                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How a single gear/option reference would resolve at generation. A snapshot is
 * self-contained; an instruction row rolls a random item; a by-name reference
 * resolves only if the canonical packs carry that name; an empty name never
 * resolves. This is the check the sheet's preview surfaces so a grant that would
 * silently vanish (resolveGearItem returns null on a miss, resolveRefs drops it)
 * becomes visible before it reaches a player — or another GM.
 * @returns {Promise<"snapshot"|"rolled"|"name"|"missing"|"empty">}
 */
const classifyRef = async (ref) => {
  if (ref?.itemData) return "snapshot";
  const lower = String(ref?.name ?? "").trim().toLowerCase();
  if (!lower) return "empty";
  if (INSTRUCTION_ROWS.has(lower)) return "rolled";
  return (await resolveGearItem(ref.name)) ? "name" : "missing";
};

/**
 * A dry-run report on a draft background, powering the sheet's "Test ×10" button.
 * Two halves, no actor created and nothing persisted:
 *  - a STATIC lint (deterministic): every starting-gear ref and every table-option
 *    item classified snapshot/rolled/name/missing/empty, plus discovery checks
 *    (source must be "2e", an archetype, at least one example name). This is the
 *    pre-share, is-it-self-contained linter (docs/custom-backgrounds-plan.md §7/§9).
 *  - a SAMPLING run (n iterations of the REAL applyChoiceTables): which of each
 *    table's options fired, the choice-gold spread and the ability-bonus
 *    spread, so a Warden sees the shape of what they built.
 *
 * The starting abilities are reported as the background states them — fixed
 * four, or "rolled" — because that is half of what a Warden is checking when
 * they press the button: the bonuses below mean one thing on top of a fixed 10
 * and another on top of 3d6.
 * @param {CairnItem} bg
 * @param {Number} [n=10]
 * @returns {Promise<Object>}
 */
export const previewBackground = async (bg, n = 10) => {
  const problems = [];
  const sys = bg.system ?? {};

  /* The SOURCE lint stood here and is GONE (2026-09-02) with `system.source`. */
  if (!sys.archetype) problems.push({ level: "warn", msg: game.i18n.localize("CAIRN.BgAuthor.LintArchetype") });
  if (!(sys.names ?? []).some((s) => String(s).trim())) problems.push({ level: "warn", msg: game.i18n.localize("CAIRN.BgAuthor.LintNames") });

  // An unusable age formula is a silent no-op at generation (rollAge falls back
  // and warns there); saying so HERE is the point of a linter.
  const ageFormula = String(sys.ageFormula ?? "").trim();
  if (ageFormula && !effectiveAgeFormula(bg, Cairn.characterGenerator2e.biography.age).usable) {
    problems.push({ level: "error", msg: game.i18n.format("CAIRN.BgAuthor.LintBadAge", { formula: ageFormula }) });
  }

  const gear = [];
  for (const ref of sys.startingGear ?? []) {
    const kind = await classifyRef(ref);
    gear.push({ name: ref.name ?? "", kind });
    if (kind === "missing") problems.push({ level: "error", msg: game.i18n.format("CAIRN.BgAuthor.LintMissingGear", { name: ref.name }) });
    if (kind === "empty") problems.push({ level: "warn", msg: game.i18n.localize("CAIRN.BgAuthor.LintEmptyGear") });
  }

  const tables = [];
  const rawTables = sys.tables ?? [];
  if (rawTables.length > BG_MAX_TABLES) {
    problems.push({ level: "error", msg: game.i18n.format("CAIRN.BgAuthor.LintTooManyTables", { max: BG_MAX_TABLES, n: rawTables.length }) });
  }
  for (let ti = 0; ti < rawTables.length; ti++) {
    const die = bgTableDie(rawTables[ti]);
    const options = [];
    for (let oi = 0; oi < (rawTables[ti].options ?? []).length; oi++) {
      const opt = rawTables[ti].options[oi];
      const items = [];
      for (const it of opt.items ?? []) {
        const kind = await classifyRef(it);
        items.push({ name: it.name ?? "", kind });
        if (kind === "missing") problems.push({ level: "error", msg: game.i18n.format("CAIRN.BgAuthor.LintMissingOption", { t: ti + 1, o: oi + 1, name: it.name }) });
      }
      const abilities = optionAbilityBonuses(opt);
      const hasBonus = BG_ABILITY_KEYS.some((k) => abilities[k] !== 0);
      const blank = !String(opt.description ?? "").trim() && !items.length && !(opt.bonusGold > 0)
        && !(opt.containers ?? []).length && !hasBonus;
      if (blank) problems.push({ level: "warn", msg: game.i18n.format("CAIRN.BgAuthor.LintEmptyOption", { t: ti + 1, o: oi + 1 }) });
      options.push({ description: opt.description ?? "", bonusGold: opt.bonusGold ?? 0, items, abilities, hasBonus, blank });
    }
    // Rows and faces must match: a short table means faces that fall back to
    // option 1, a long one means rows the die can never reach. The authoring
    // form keeps them level, so this only fires on a hand-edited document.
    if (options.length !== die) {
      problems.push({ level: "error", msg: game.i18n.format("CAIRN.BgAuthor.LintDieMismatch", { t: ti + 1, die, n: options.length }) });
    }
    tables.push({ question: rawTables[ti].question ?? "", die, options, fired: new Array(options.length).fill(0) });
  }

  let goldMin = Infinity, goldMax = -Infinity, goldSum = 0;
  // The ability-bonus spread across the sample, per ability: what the tables
  // add to (or take off) the starting numbers, whichever way those arrived.
  const abilityStats = Object.fromEntries(BG_ABILITY_KEYS.map((k) => [k, { min: Infinity, max: -Infinity, sum: 0 }]));
  for (let i = 0; i < n; i++) {
    const choices = await applyChoiceTables(bg);
    const g = choices.gold ?? 0;
    goldSum += g; goldMin = Math.min(goldMin, g); goldMax = Math.max(goldMax, g);
    for (const k of BG_ABILITY_KEYS) {
      const v = choices.abilities[k] ?? 0;
      const s = abilityStats[k];
      s.sum += v; s.min = Math.min(s.min, v); s.max = Math.max(s.max, v);
    }
    choices.questions.forEach((q, ti) => {
      const idx = tables[ti]?.options.findIndex((o) => o.description === q.answer) ?? -1;
      if (idx >= 0) tables[ti].fired[idx] += 1;
    });
  }
  const sampling = {
    n,
    goldMin: goldMin === Infinity ? 0 : goldMin,
    goldMax: goldMax === -Infinity ? 0 : goldMax,
    goldAvg: n ? Math.round(goldSum / n) : 0,
    abilities: Object.fromEntries(BG_ABILITY_KEYS.map((k) => {
      const s = abilityStats[k];
      return [k, {
        min: s.min === Infinity ? 0 : s.min,
        max: s.max === -Infinity ? 0 : s.max,
        avg: n ? Math.round(s.sum / n) : 0,
      }];
    })),
  };

  // What the character STARTS on, before the bonuses above: the background's
  // own four, or the dice.
  const sa = sys.startingAbilities ?? {};
  const startingAbilities = {
    enabled: !!sa.enabled,
    ...Object.fromEntries(BG_ABILITY_KEYS.map((k) => [k, Number(sa[k]) || 0])),
  };
  const ageFormulaEffective = effectiveAgeFormula(bg, Cairn.characterGenerator2e.biography.age).formula;
  const bgLanguages = (sys.languages ?? []).filter((s) => String(s).trim());

  return { name: bg.name, gear, tables, sampling, problems, startingAbilities, ageFormula: ageFormulaEffective, languages: bgLanguages };
};

/* -------------------------------------------------------------------------- */
/*  Background-granted containers                                              */
/* -------------------------------------------------------------------------- */

/** A wagon or cart is a vehicle; anything else a background grants (a donkey, a
 *  horse breed) is a mount. No container weighs on the carrier — they are reached
 *  through the Containers tab and never count against the carrier's own slots. */
const containerKindFor = (name) => (/\b(wagon|cart|sled|sledge)\b/i.test(name) ? "vehicle" : "mount");

/**
 * Mint the container Actors a background's rolled options granted, connected
 * to the new character and inheriting its ownership — the same shape the shop
 * produces (marketplace.js acquireTransport), so a granted donkey and a bought
 * one behave identically.
 *
 * The spec's name is resolved against the Warden's Objetos compendium first, so
 * retuning "Donkey" there changes every donkey granted afterwards; the grant's
 * own `slots` still wins, because that number is the background's (a Rivertooth
 * is +6 where a Blacklegged Dandy is +4). A name the compendium does not carry —
 * the one-off beasts — is minted from the spec alone.
 *
 * Each container is flagged with the question that granted it, so a re-roll or a
 * regenerate can delete exactly those and leave bought/manual containers alone.
 * @param {CairnActor} actor
 * @param {Object[]} specs  {name, slots, grantSource, load?, carried_by?}
 * @returns {Promise<CairnActor[]>}  the containers created
 */
export const grantContainers = async (actor, specs) => {
  if (!actor || !specs?.length) return [];
  // The connection ceiling, CLAMPED rather than refused outright: a background
  // granting three beasts to a keeper with room for one still owes the
  // character that one. What was dropped is SAID — a silent clamp reads as
  // "the background granted nothing", which is a bug report waiting to be
  // filed against the wrong code. At zero headroom nothing can land, so that
  // case gets the plain at-the-ceiling message instead of a count of zero
  // survivors. On the player path this clamp runs in the player's browser and
  // cannot bind anyone; the socket broker re-clamps on the Warden's client,
  // which is the wall. This copy exists so the player is TOLD — the broker
  // can only console.warn on a client the player is not looking at.
  const headroom = connectionHeadroom(actor);
  if (headroom <= 0) {
    ui.notifications.warn(game.i18n.format("CAIRN.Notify.ConnectionLimit", { name: actor.name, max: maxConnections() }));
    return [];
  }
  if (specs.length > headroom) {
    ui.notifications.warn(game.i18n.format("CAIRN.Notify.ConnectionLimitPartial", {
      name: actor.name,
      max: maxConnections(),
      count: specs.length - headroom,
    }));
    specs = specs.slice(0, headroom);
  }
  // Named beasts and vehicles resolve BY NAME out of the Warden's Objetos
  // compendium (2026-08-29). The dedicated Mounts & Transports ACTOR pack this
  // used to read is gone with every other shipped pack, so what a granted
  // "Rivertooth" resolves to is whatever the Warden authored under that name —
  // and the payload below takes each field only `??`-wise, so a document that
  // carries no `hp` or no `role` (an Item rather than an Actor, say) degrades to
  // exactly the same defaults a beast the compendium has never heard of gets.
  // QUIET on a miss: a one-off "Mangy Wolfdog" that no compendium carries is the
  // documented normal case here, not a content mistake to report.
  // Resolve a spec against that editable pack (art/stats/description), with
  // sensible fallbacks for one-off beasts the pack doesn't carry. `kind` only
  // matters on the no-document path (icon + class inference by name); a resolved
  // Actor carries its class outright.
  // A one-off beast the pack does not carry takes the Warden's own art when
  // they keep a reserved `companion/` folder (issue #18), else the class icon
  // it has always taken. Two bounds, both deliberate:
  //
  //   - A RESOLVED document's own art always wins. Same doctrine as the
  //     `!data.img` guard on the npc auto-portrait: something that arrived
  //     wearing art keeps it. So a granted Rivertooth keeps its illustration
  //     and only a "Mangy Wolfdog" gets a face from the folder.
  //   - `customPoolFor("companion")` is the reserved folder ALONE — it inherits
  //     no general pool — so this is silent for every Warden who has not named
  //     one, and a folder of human portraits never lands on a mule.
  //
  // Rolled per spec rather than once, so two granted beasts are two beasts.
  const companionArt = () => {
    const pool = customPoolFor("companion");
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  };
  const resolve = async (spec) => {
    const doc = await itemByName(spec.name, { quiet: true });
    // `role` decides mount-or-vehicle only when the resolved document HAS one;
    // otherwise the name does, exactly as it does for an unresolved beast. A
    // document with no role used to be impossible (the old pack held Actors
    // only) and reading `doc.system.role === "companion"` through it would have
    // filed every resolved beast as a vehicle.
    const kind = doc?.system?.role
      ? (doc.system.role === "companion" ? "mount" : "vehicle")
      : containerKindFor(spec.name);
    const art = doc?.img
      ?? (kind === "mount" ? companionArt() : null)
      ?? iconForTransport(spec.name, kind);
    return { doc, kind, art };
  };

  /* A granted beast or vehicle is ALWAYS an Actor now.
   *
   * There used to be a fork here: with the Containers tab off, each rolled
   * container was recorded as a weightless inventory ITEM instead. That was
   * tolerable while a container was a bag of slots. It is not tolerable now --
   * an Outrider's horse is a creature with 6 HP, and collapsing it into an
   * inventory line because a DISPLAY setting is off is a lie about what the
   * character has. The user's words: "an outrider's horse should never appear in
   * their inventory."
   *
   * Deleting the fork exposed what it was really doing, which was not display at
   * all: it was the reason a PLAYER could generate an Outrider. Minting an Actor
   * needs ACTOR_CREATE, which players do not have, so the item branch was a
   * permissions workaround wearing a display setting's name. Hence the broker
   * below. */
  /* Resolved ONCE, because the keeper's notes need the same answers the payload
   * does: what this thing IS (role + Kind) and, where the granting option said
   * nothing itself, the stock description off its pack document. */
  const entries = await Promise.all(specs.map(async (spec) => {
    const { doc, kind, art } = await resolve(spec);
    return {
      spec, doc, kind, art,
      cls: doc?.system?.containerClass || containerClass(spec.name, kind),
      role: doc?.system?.role
        ?? ({ mount: "companion", vehicle: "transport", worn: "container", pile: "container" }[kind] ?? "companion"),
    };
  }));
  const payloads = entries.map(({ spec, doc, art, cls, role }) => {
    return {
      type: "npc",
      name: spec.name,
      img: art,
      prototypeToken: { texture: { src: art } },
      system: {
        connectedTo: actor.uuid,
        slots: spec.slots ?? doc?.system?.slots ?? 0,
        description: doc?.system?.description ?? "",
        // The Actor document records its class; a one-off beast with no document
        // infers it from the name the way the sheet does. Leaving it blank would
        // have shipped a horse whose art and one-word label were both decided by
        // a keyword table at render time, rather than recorded once at creation.
        containerClass: cls,
        // A resolved pack Actor states its role; a one-off beast maps its
        // inferred kind (a granted "Mangy Wolfdog" is a mount-shaped creature
        // and keeps its stat block, exactly as the old animate default did).
        role,
        cost: doc?.system?.cost ?? 0,
        generationEnabled: false,
        ...(doc?.system?.hp ? { hp: { value: doc.system.hp.value, max: doc.system.hp.max } } : {}),
        ...(doc?.system?.armorOverride != null ? { armorOverride: doc.system.armorOverride } : {}),
        // The ABILITIES too — the stat block travels whole. hp/armorOverride
        // have been copied since review #5 ("a granted Rivertooth arrived with
        // the schema's default 6 HP"); abilities joined 2026-08-08 when the
        // Falcon arrived, whose whole point is DEX 16 — landing it with the
        // schema's 10/10/10 is the same bug class. Via toObject(), never by
        // reference: a DataModel getter hands back the LIVE object, and a
        // shared reference here poisons the pack document.
        // Tested on the FIELD, not on `doc`: what the name resolves to is now
        // whatever the Warden authored, and an item that carries no ability
        // block must leave the schema's own defaults standing rather than
        // writing `abilities: undefined` over them.
        ...(doc?.system?.abilities ? { abilities: doc.system.toObject().abilities } : {}),
      },
      flags: {
        [FLAG_SCOPE]: { grantSource: spec.grantSource ?? "background" },
      },
    };
  });

  // A player cannot create an Actor, so ask the Warden's client to do it. Returns
  // [] on the player's side -- the documents appear when the GM's client answers.
  if (!game.user.hasPermission("ACTOR_CREATE")) {
    await requestGrantedActors(payloads, actor);
    return [];
  }

  // ONE batched create, then ONE batched follow-up (review 2026-08-04, the
  // same rule the orphan sweep in actor.js already paid for): a per-payload
  // create+update loop that dies midway leaves the first mule connected and
  // owned while the cart never comes into being — a partially-granted
  // background with nothing naming the missing half.
  const made = (await CairnActor.createDocuments(payloads)).filter(Boolean);
  if (!made.length) return made;
  // The CONNECTED ownership shape, not the old wholesale copy — same change
  // as the till's (marketplace.js). GM-only for the same reason as ever:
  // Foundry refuses an `ownership` write from anyone below Assistant, and
  // for a player with ACTOR_CREATE that threw AFTER the container was
  // created and linked, aborting the loop. A player with ACTOR_CREATE
  // already owns what they create; the sync flag asks the active GM's
  // client to fill in the OBSERVER default their client cannot write —
  // same tail as the till's. (The common player path never gets here at
  // all: it goes through the broker above, which writes the shape on the
  // Warden's client.)
  if (game.user.isGM) {
    await CairnActor.updateDocuments(made.map((c) => ({
      _id: c.id,
      ownership: foundry.data.operators.ForcedReplacement.create(connectedOwnershipShape(actor)),
    })));
  } else {
    await CairnActor.updateDocuments(made.map((c) => ({
      _id: c.id, [`flags.mondolme.${OWNERSHIP_SYNC_FLAG}`]: true,
    })));
    for (const c of made) {
      game.socket.emit(`system.${game.system.id}`, { action: "ownershipSync", childUuid: c.uuid });
    }
  }
  return made;
};

/**
 * Every container connected to this actor that GENERATION granted (it carries
 * a grantSource flag). Bought and hand-made containers have no such flag and are
 * never returned, so a regenerate cannot delete a player's mule.
 * @param {CairnActor} actor @returns {CairnActor[]}
 */
export const grantedContainersOf = (actor) =>
  (game.actors ?? []).filter(
    (a) => a.system?.connectedTo === actor.uuid && a.getFlag(FLAG_SCOPE, "grantSource")
  );

/**
 * Ask the Warden's client to create the Actors a player's generation granted.
 *
 * `Actor.create` needs ACTOR_CREATE, which players do not have, and granting it
 * world-wide to fix one background would let players create any actor at all.
 * This is Foundry's standard shape for a player-initiated GM action: emit on the
 * system socket, let exactly ONE client — `game.users.activeGM`, so two logged-in
 * GMs cannot both act and mint doubles — do the write.
 *
 * Fire-and-forget by design. Generation must not block on another client
 * answering, and the documents simply appear when it does. The one thing worth
 * saying out loud is the case where nobody can act.
 * @param {object[]} payloads
 * @param {CairnActor} owner
 */
export const requestGrantedActors = async (payloads, owner) => {
  if (!payloads.length) return;
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.NoGmForGrant"));
    return;
  }
  // No `userId` in the payload, deliberately. The broker identifies the sender
  // by the server-authenticated id Foundry passes as the handler's second
  // argument — a self-declared id in the message is exactly what an attacker
  // would forge, and the first version of this socket was ownable because the
  // receiving side trusted it (review #5).
  game.socket.emit(`system.${game.system.id}`, {
    action: "grantActors",
    payloads,
    ownerUuid: owner.uuid,
  });
};

/**
 * Ask the Warden's client to generate a character for the CURRENT user.
 *
 * The directory shows Generate PC to players who hold no ACTOR_CREATE at all —
 * making a character is the one creation the game owes every player, and
 * granting the world-wide right for it would open all the others. Same shape
 * as requestGrantedActors above: emit, and exactly one GM client answers,
 * running this same generator with the requester stamped OWNER into the
 * create data. Fire-and-forget — the pcGenerated answer (cairn.js) opens the
 * sheet on this client when the document lands. The payload carries nothing:
 * WHO asked is the server-authenticated senderId on the receiving side.
 */
export const requestPcGeneration = async () => {
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.NoWardenForPcGen"));
    return;
  }
  // The CONFIRM is the player's, exactly as it is on the direct path — ask it
  // HERE, on the clicking client, and send only the answer. Asked on the
  // answering side instead, the dialog pops on the Warden's screen out of
  // nowhere and the player's request hangs on someone else's modal (which is
  // precisely how the first cut of this relay behaved).
  if (!(await confirmGeneration())) return; // ✕ is an instruction, here as everywhere
  ui.notifications.info(game.i18n.localize("CAIRN.Notify.PcGenRequested"));
  game.socket.emit(`system.${game.system.id}`, { action: "generatePC" });
};

/**
 * May the current user run a (re)generation that could create or delete this
 * actor's container Actors? Deleting an Actor requires an Assistant GM+ (Foundry
 * gates it by ROLE, with no player-grantable permission — unlike ACTOR_CREATE), so
 * a plain player cannot. This is the UP-FRONT guard: (re)generation deletes items
 * BEFORE it touches containers, so a mid-way permission throw corrupts the
 * character — better to refuse before mutating anything, with a clear notice.
 *
 * A container op is only in play when there is an existing granted container to
 * DELETE. Creation is brokered (see below), and there is no "containers feature"
 * switch any more — `show-containers-tab` was the display toggle this comment
 * used to call one, and it is gone. Pass `source` to scope the delete check to
 * one grant source (a single question's containers) rather than all of them.
 * @param {CairnActor} actor @param {String|null} source
 * @returns {Boolean} true to proceed
 */
export const canRegenerateContainers = (actor, source = null, warnKey = "CAIRN.Notify.NoContainerRegen") => {
  if (game.user.isGM) return true; // isGM === role >= ASSISTANT, exactly what Actor delete needs
  // CREATION is no longer a reason to refuse: a player's grants are brokered to
  // the Warden's client over the system socket (requestGrantedActors). Only a
  // DELETE still needs Assistant+, because there is no broker for it and there
  // should not be -- a socket that deletes actors on request is a very different
  // thing from one that creates the ones a background just rolled.
  //
  // This used to read `show-containers-tab` as `mayCreate`, which is how a
  // DISPLAY setting came to decide a permission: with the tab on, every non-GM
  // was refused whether or not anything needed deleting. That coupling is gone.
  const existing = grantedContainersOf(actor);
  const mustDelete = source
    ? existing.some((c) => c.getFlag(FLAG_SCOPE, "grantSource") === source)
    : existing.length > 0;
  if (!mustDelete) return true;
  // The refusal is shared; the SENTENCE is not. This guard began as the
  // regenerate check and its message says "ask them to re-roll it for you" —
  // correct there, and wrong the moment the background swap started calling it,
  // because that instructs a player to request an operation that discards their
  // abilities, HP and traits when all they touched was a background. Callers that
  // refuse a different operation pass their own key.
  ui.notifications.warn(game.i18n.localize(warnKey));
  return false;
};

/**
 * Delete container Actors — ONE batched operation, not a per-actor loop
 * (review #13 #20). The loop was N sequential server round trips, and a
 * throw mid-loop left the earlier deletes committed with nothing recording
 * where it stopped; a batch is one request that the caller sees succeed or
 * fail whole. Returns the targets on success, re-raises on failure.
 *
 * It used to prune the keeper's `system.containers` uuid array in the same
 * breath — ahead of the delete, so CairnActor._onDeleteOperation's own prune
 * found nothing to do, and putting uuids back if a delete threw so a failure
 * could not orphan a live Actor. That array went with the `container` type
 * (2026-07-31): the link is one field on the CHILD now, so deleting the child
 * IS the whole operation and there is no second half to keep in step.
 * @param {CairnActor} actor @param {CairnActor[]} targets
 * @returns {Promise<CairnActor[]>}
 * @private
 */
const deleteContainers = async (actor, targets) => {
  if (!targets.length) return [];
  await CairnActor.deleteDocuments(targets.map((c) => c.id));
  return targets;
};

/**
 * Delete every generation-granted container this actor keeps (a regenerate
 * re-rolls the background's options, so last roll's donkey has to go).
 * @param {CairnActor} actor
 */
export const clearGrantedContainers = async (actor) => {
  // The bullets those grants left go with them, but NOT from here: the delete
  // itself is what removes them (CairnActor._onDeleteOperation → pruneGrantNotes),
  // so every route that ends a grant cleans up the same way — this one, a
  // re-rolled question, a changed background, and a Warden deleting the mule
  // straight out of the directory.
  await deleteContainers(actor, grantedContainersOf(actor));
};

/**
 * Swap the containers granted by ONE source (a re-rolled question): delete just
 * that source's, mint the new option's. Containers from other questions, and any
 * the player bought, are untouched — the Actor-side twin of the sheet's
 * _replaceGrantedItems.
 * @param {CairnActor} actor @param {String} source e.g. "question:1"
 * @param {Object[]} specs  the new option's container specs
 */
export const replaceGrantedContainers = async (actor, source, specs) => {
  const stale = grantedContainersOf(actor).filter((c) => c.getFlag(FLAG_SCOPE, "grantSource") === source);
  // The previous answer's bullet goes with the beast it described — carried by
  // the delete, not by this function (see clearGrantedContainers) — and the new
  // one is added by grantContainers below.
  await deleteContainers(actor, stale);
  return grantContainers(actor, (specs ?? []).map((c) => ({ ...c, grantSource: source })));
};

/* -------------------------------------------------------------------------- */
/*  Generation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generate a Cairn 2e character: starting abilities and Hit Protection (the
 * background's own four, or 3d6 a piece and 1d6 when it does not state them), a
 * 2e background (chosen or random) with a name drawn from its list and its
 * starting gear granted from the pool (weapons/armor equipped), the eight
 * physical/personality traits, an age off the background's own dice, and the
 * languages the background grants.
 *
 * What it NO LONGER rolls (2026-09-02, user ruling): the background's question
 * answers and the character's obligations. Both arrive EMPTY — one blank
 * record per question, one blank slot per entitled obligation — and the player
 * rolls each from the Trasfondo tab, where the gold, the item and the ability
 * bonuses that answer carries arrive at that moment rather than at creation.
 * @param {CairnItem|null} chosenBg  a background Item, or null to pick at random
 * @returns {Promise<Object|null>}
 */
export const generate2eCharacter = async (chosenBg = null) => {
  // Through the shared pool, NOT a pack read of its own — the rule that outlived
  // the packs (issue #9: an inline pack read here ignored the Warden's choices,
  // so random generation and the picker rolled different pools). Today the pool
  // is one compendium minus the switched-off rows, and going through it is what
  // keeps the eye toggle honest for a RANDOM draw and not just the picker.
  const backgrounds = await getBackgroundsFor("2e");
  if (!chosenBg && !backgrounds.length) {
    ui.notifications?.warn(game.i18n.localize("CAIRN.NoBackgrounds2e"));
    return null;
  }
  // A chosen background (from a picker / persisted across regenerate) is used
  // as-is; otherwise pick at random. Everything else derives from it.
  const bg = chosenBg ?? backgrounds[Math.floor(Math.random() * backgrounds.length)];
  const names = bg.system.names ?? [];
  const name = names.length ? names[Math.floor(Math.random() * names.length)] : bg.name;

  // Starting gear: resolve each reference against the editable pool, tag it
  // "background", and equip weapons/armor so Armor derives to its intended value
  // (pool items are equipped:false).
  const gear = tagBackgroundGear(await resolveRefs(bg.system.startingGear));
  for (const it of gear) {
    if (it.type === "weapon" || it.type === "armor") it.system.equipped = true;
  }

  const traits = await rollTextItems(Cairn.characterGenerator2e.biography.items);
  // The age dice are the BACKGROUND's now, not a world setting — a blank or
  // unusable formula falls back to the system default, warning in the second
  // case (rollAge).
  const age = String(await rollAge(bg, Cairn.characterGenerator2e.biography.age));
  // Rolled WITH the age, not left to the sheet's die: the two are one fact
  // about a person, and a generated character that knows how old it is but not
  // when it was born reads as half-finished. Degrades to "" like every other
  // trait draw when the table is missing — generation never stops for content.
  const birthday = await generatorText(TABLES.birthday);
  // NOT rolled (2026-09-02, user ruling): the background's questions arrive
  // ASKED and unanswered, and the player rolls each from the Trasfondo tab —
  // where its gold, its item and its ability bonuses arrive with the answer.
  // The shape is identical to a rolled run (`emptyChoiceTables`), so every sum
  // below still reads `choices.gold` / `choices.abilities` and simply adds zero.
  const choices = emptyChoiceTables(bg);

  const goldRoll = await rollGold(Cairn.characterGenerator2e.gold);

  // THE STARTING NUMBERS. A background that states its own four supplies them
  // outright and NOTHING is rolled for them — no 3d6, no 1d6, and no Roll
  // objects, which is why `rolls` below carries only what actually happened.
  // Otherwise the dice run exactly as they always have.
  const fixed = bg.system.startingAbilities ?? {};
  const useFixed = !!fixed.enabled;
  const hpRoll = useFixed ? null : await rollHitProtection("1d6");
  const abilityRolls = useFixed ? null : await rollAbilities("3d6");
  const base = useFixed
    ? { str: Number(fixed.str) || 0, dex: Number(fixed.dex) || 0, wil: Number(fixed.wil) || 0, hp: Number(fixed.hp) || 0 }
    : { str: abilityRolls.STR.total, dex: abilityRolls.DEX.total, wil: abilityRolls.WIL.total, hp: hpRoll.total };
  // The rolled options' bonuses go on top either way — a fixed background can
  // still be moved by its own questions. Below zero is clamped to zero
  // (withAbilityBonuses).
  const start = withAbilityBonuses(base, choices.abilities);

  return {
    name,
    hp: start.hp,
    // The bare gold roll: an unrolled question and an unrolled obligation both
    // grant nothing, so there is no bonus left to add here. `choices.gold` is
    // kept in the sum rather than dropped — it is the same shape a rolled run
    // returns, and reads zero.
    gold: goldRoll.total + choices.gold,
    abilities: {
      STR: start.str,
      DEX: start.dex,
      WIL: start.wil,
    },
    // The Rolls the generation chat card shows, carried out whole so
    // postGenerationRolls can hand them to ChatMessage for Dice So Nice.
    // characterToActorData never reads this key, so it stops here and never
    // reaches the document. `gold` is the BARE roll -- the gold FIELD above adds
    // background-choice gold on top, and the card must show what the
    // dice on screen actually read, not the bonus-inflated total.
    //
    // hp/STR/DEX/WIL are ABSENT when the background fixed them: there is no die
    // to animate and none to report. postGenerationRolls falls back to the
    // character's own starting numbers for those lines, so the card still shows
    // the four values — it just does not claim they were rolled.
    rolls: {
      ...(hpRoll ? { hp: hpRoll } : {}),
      ...(abilityRolls ? { STR: abilityRolls.STR, DEX: abilityRolls.DEX, WIL: abilityRolls.WIL } : {}),
      gold: goldRoll,
    },
    background: bg.name,
    backgroundUuid: bg.uuid,
    age,
    birthday,
    // The languages this background grants at creation, copied by NAME onto the
    // character (characterToActorData). A background that grants none hands over
    // an empty list, which is what clears a regenerated character's.
    languages: [...(bg.system.languages ?? [])],
    traits,
    // Arranged before it is handed over (gear.js orderGrantedItems): weapons,
    // armor, everything else in the order it was granted, the light with its
    // fuel beneath it, Rations last. It writes each item's `sort`, which is
    // Foundry's own field, so the player can drag any row afterwards and the
    // printed page follows without knowing this happened.
    items: orderGrantedItems([...gear, ...choices.items]),
    // Container Actors cannot ride in items[]; they are minted after the actor
    // exists (createActorWithCharacter / updateActorWithCharacter).
    // A background can grant a container outright as well as from a choice table
    // — the Mountebank's cart is part of the act, not a roll. Both kinds go here;
    // changeBackground already combines them the same way.
    containers: [
      ...(bg.system.containers ?? []).map((c) => ({ ...c, grantSource: "background" })),
      ...choices.containers,
    ],
    questions: choices.questions,
  };
};

/* ==========================================================================
 * The creation tables
 *
 * Everything below is generation and nothing else. A background may carry no
 * archetype, no prose and no question tables at all — a name and three gear
 * references is a complete background — and this section is what fills the rest
 * of such a character in.
 *
 * The three creation steps are RollTables in the Warden's Generadores compendium
 * (Arma, Armadura, Equipo) whose results REFERENCE pool items, so a Warden
 * restocks a step by dragging an item into the table. Rolling is always
 * table.roll(), never draw(): drawing marks results as used and would silently
 * exhaust a table over a campaign.
 * ======================================================================== */

/** One creation table, by name. A miss is reported by `generatorTable` and the
 *  step degrades to nothing — the character is one item short, and the Warden is
 *  told which table would have filled it. */
const creationTable = async (name) => generatorTable(name);

/**
 * One random spellbook DOCUMENT — a draw on the Hechizos table.
 *
 * A TABLE, not an index scan of a pack (2026-08-29). This used to enumerate
 * every `spellbook` item in a shipped Spellbooks compendium and pick uniformly;
 * with one Objetos compendium holding every item in the game, "every spellbook
 * in the pack" is no longer a pool anybody curated. A RollTable IS that curation
 * — the Warden decides what a random spell can be, and can weight it — and its
 * rows point at spellbook Items exactly as the market tables point at goods.
 *
 * The mode fork went with it: which wording a random spell has is a property of
 * what the Warden put in the table, not of which pack — or which setting — it
 * was read out of.
 *
 * No cache, on purpose: a Warden's edit to the table must be drawable at once.
 * @returns {Promise<CairnItem|null>}
 */
export const randomSpellbookDoc = async () => {
  const table = await generatorTable(TABLES.spells);
  if (!table) return null;
  const { results } = await table.roll();
  const result = results?.[0] ?? null;
  const doc = result?.documentUuid ? await fromUuid(result.documentUuid) : null;
  // The type filter is load-bearing and stays: a table row can point at
  // anything, and a Dagger must not come out of "a random spellbook". Console
  // only — the Warden has a working table with one bad row, which is not the
  // same failure as having no table, and the notification for THAT already fired
  // above.
  if (doc?.documentName !== "Item" || doc.type !== "spell") {
    console.warn(`Mondolme | the "${TABLES.spells}" row `
      + `"${resultText(result)}" does not point at a spell item`);
    return null;
  }
  return doc;
};

/** A random spell as an owned item, named for the spell it holds. The
 *  inventory list adds the "Hechizo — " prefix at display time
 *  (templates/parts/items-list.html), so the stored name stays the bare spell
 *  name — baking the prefix in here too would double it. */
export const randomSpellbookItem = async () => {
  const b = await randomSpellbookDoc();
  if (!b) return null;
  // A setting used to turn this draw into a SCROLL and is gone with it: the
  // The "Spellbook" / "Random Spellbook" gear instructions hand out the Hechizo the
  // table drew, permanent and castable in its own right. `randomScrollItem`
  // below is still how an instruction row asks for paper — the same split
  // resolveGearItem makes between "Spellbook (X)" and "Scroll (X)".
  // toObject(), not deepClone — deepClone returns a TypeDataModel by reference,
  // so this would alias the compendium document. See gear.js resolveGearItem.
  return { name: b.name, type: b.type, img: b.img, system: b.system.toObject() };
};

/** A random spellbook as a single-use petty scroll. The spell's effect is the
 *  description; casting consumes it. */
export const randomScrollItem = async () => {
  const b = await randomSpellbookDoc();
  if (!b) return null;
  return spellScrollItem(b);   // shared scroll shape — see gear.js
};

/**
 * Turn one rolled table result into something a character can be given.
 * Three shapes, decided by what the result points at:
 *   - a carrier npc Actor   → a container spec (minted as a connected NPC later)
 *   - a nested ROLLTABLE    → roll that table and resolve its result instead
 *   - anything else         → the pool item of that name, or, for the SRD's two
 *                             instruction rows, a random spellbook or scroll
 *
 * The first two branches now ask what the referenced document IS, rather than which
 * pack it came out of. They used to compare `result.documentCollection` against two
 * hardcoded pack ids — `documentCollection` is deprecated `{since: 13, until: 15}`,
 * but the pack id was only ever standing in for the question the docstring above
 * actually asks. Keying on the document closes a gap as a side effect: a Warden's
 * own creation table pointing at a world RollTable, or at a transport they made,
 * used to fall through to the gear-pool lookup and resolve to nothing.
 *
 * The third branch deliberately still resolves BY NAME against the gear pool, and
 * not by uuid. That is the pool's whole job — one canonical Dagger, whichever pack
 * a table points at — and it is why a gear row needs no uuid at all.
 *
 * @param {TableResult} result
 * @returns {Promise<{item?:Object, container?:Object, name:String}|null>}
 */
const resolveCreationResult = async (result) => {
  if (!result) return null;
  const name = resultText(result).trim();
  const doc = result.type === CONST.TABLE_RESULT_TYPES.DOCUMENT
    ? await fromUuid(result.documentUuid)
    : null;

  // The `doc.type === "transport"` branch stood here and went with that ITEM
  // type: a row pointing at a legacy transport Item became a container spec.
  // A carrier is an npc ACTOR now, which the branch below has always handled.
  // A row still pointing at an Item falls through to the by-name gear lookup,
  // which is the same answer any other Item row gets.
  //
  // A row can point at a Mounts & Transports NPC (a Cart or Wagon row does, and
  // a Warden's own table can too). Same shape out: a
  // container SPEC, not the document — grantContainers re-resolves by name, so
  // the grant still picks up the Warden's edits to the pack document.
  if (doc?.documentName === "Actor" && doc.type === "npc") {
    return { container: { name: doc.name, slots: doc.system.slots ?? 0 }, name };
  }
  if (doc?.documentName === "RollTable") {
    const { results } = await doc.roll();
    return resolveCreationResult(results[0]);
  }
  const lower = name.toLowerCase();
  if (GEAR_INSTRUCTIONS.scroll.has(lower)) {
    const s = await randomScrollItem();
    return s ? { item: s, name: s.name } : null;
  }
  if (GEAR_INSTRUCTIONS.spellbook.has(lower)) {
    const s = await randomSpellbookItem();
    return s ? { item: s, name: s.name } : null;
  }
  if (lower === "none") return { name };            // the armor table's empty row
  const item = await resolveGearItem(name);
  return item ? { item, name: item.name } : null;
};

/** Roll one creation table and resolve what came up. */
const rollCreationTable = async (tableName) => {
  const table = await creationTable(tableName);
  if (!table) return null;
  const { results } = await table.roll();
  return resolveCreationResult(results[0]);
};

/**
 * Roll one item off the Additional Gear table (creation step 6), rerolling a
 * name already held — the SRD lets you reroll duplicate gear — and rerolling a
 * transport, which is a container Actor and cannot be an extra item here.
 * @param {Set<string>} avoid  lowercased names already granted
 */
/** The starting-gear rows the SRD writes as an INSTRUCTION rather than an item.
 *  Kept as one list so the dispatch below and the duplicate-guard that seeds
 *  `avoid` can never disagree about what counts as a literal item. */
/**
 * The instruction rows a Warden may type into a background's starting gear
 * INSTEAD of an item name: each one means "roll something here" rather than
 * "grant the item called this".
 *
 * Spanish, because the Warden authoring the background is writing Spanish. The
 * old English spellings are still accepted — they cost one Set entry each and
 * they are what any background written against the upstream system says.
 */
const GEAR_INSTRUCTIONS = {
  extraGear: new Set(["equipo adicional aleatorio", "random additional gear"]),
  scroll: new Set(["pergamino de hechizo aleatorio", "scroll of random spellbook"]),
  spellbook: new Set([
    "hechizo", "hechizo aleatorio", "spellbook", "random spellbook",
  ]),
};

const INSTRUCTION_ROWS = new Set([
  ...GEAR_INSTRUCTIONS.extraGear,
  ...GEAR_INSTRUCTIONS.scroll,
  ...GEAR_INSTRUCTIONS.spellbook,
]);

const rollAdditionalGear = async (avoid = new Set()) => {
  for (let tries = 0; tries < 50; tries++) {
    const got = await rollCreationTable(TABLES.gear);
    if (!got?.item) continue;                        // a cart/wagon, or unresolved
    if (avoid.has(got.name.toLowerCase())) continue;
    return got.item;
  }
  return null;
};

/**
 * Resolve a background's starting gear, honouring the rows the SRD writes as an
 * INSTRUCTION rather than an item — "hechizo", "pergamino de hechizo aleatorio",
 * "equipo adicional aleatorio" (GEAR_INSTRUCTIONS above). A plain reference
 * lookup silently drops every one of them, leaving that character an item short
 * with no error.
 *
 * A background with no such rows passes straight through; it is shared so that
 * generation and a background swap can never disagree.
 * @param {CairnItem} bg
 * @param {Set<string>} [avoid]  names already granted, for the Additional Gear roll
 * @returns {Promise<Object[]>}
 */
export const resolveStartingGear = async (bg, avoid = new Set()) => {
  const out = [];
  const refs = bg.system.startingGear ?? [];

  // Seed `avoid` with everything this background grants OUTRIGHT, before rolling
  // anything. The SRD says to reroll duplicates, and `avoid` was only being filled
  // as the loop went — so an item listed AFTER the "Random Additional Gear" row
  // was invisible to that roll and could be handed out twice. The Merchant is
  // "Random Additional Gear, Stylus, Wagon" and Stylus is row 90 of the same d100
  // table, so roughly one Merchant in a hundred carried two of them (likewise the
  // Fence and Peddler, whose Sack sits after the roll). Seeding up front
  // makes the guard independent of the order the SRD happens to list gear in.
  // Both the reference name and what it resolves to are added, because an alias
  // means those differ ("Torches" -> "Torch") and the roll compares resolved
  // names.
  for (const ref of refs) {
    const name = String(ref.name).trim().toLowerCase();
    if (INSTRUCTION_ROWS.has(name)) continue;
    avoid.add(name);
    const alias = GEAR_ALIASES.get(name);
    if (alias) avoid.add(alias.toLowerCase());
  }

  for (const ref of refs) {
    const lower = String(ref.name).trim().toLowerCase();
    let item = null;
    // A snapshot travels inside the background (custom-authored gear), so it
    // resolves without ever touching the canonical packs or the instruction rows.
    if (ref.itemData) item = ownedFromSnapshot(ref.itemData, { quantity: ref.quantity ?? 1, uses: ref.uses });
    else if (GEAR_INSTRUCTIONS.extraGear.has(lower)) item = await rollAdditionalGear(avoid);
    else if (GEAR_INSTRUCTIONS.scroll.has(lower)) item = await randomScrollItem();
    else if (GEAR_INSTRUCTIONS.spellbook.has(lower)) item = await randomSpellbookItem();
    else item = await resolveGearItem(ref.name, { quantity: ref.quantity ?? 1, uses: ref.uses });
    if (item) { out.push(item); avoid.add(item.name.toLowerCase()); }
  }
  return out;
};

/**
 * Steps 5 and 6 of the equipment procedure: Rations and a Torch, a
 * rolled Weapon and Armor — both equipped, and "None" armor buys a SECOND
 * Additional Gear roll — then the Additional Gear roll(s). Five items by
 * construction.
 *
 * Shared by the character generator and the NPC kit since 2026-08-21
 * (user ruling): a generated NPC runs the SAME procedure a character
 * does, weapon and armor included, superseding the rations-torch-and-one-find
 * subset — and with the armor table now in play for NPCs, the no-armor
 * compensation roll comes with it, retiring the old "paying out for a loss
 * nobody took" carve-out. One routine, not a copy, so the two cannot drift.
 * @param {Set<string>} avoid  lower-cased names already granted; grows with
 *   every item handed out so the gear rolls cannot duplicate
 * @returns {Promise<Object[]>}
 */
const rollStandardEquipment = async (avoid = new Set()) => {
  // Every character starts with these; they come from the SRD's
  // procedure, not from the background, so a PC's carry no source chip.
  const base = await resolveRefs([{ name: "Raciones", uses: 3 }, { name: "Antorcha", uses: 3 }]);
  for (const i of base) avoid.add(i.name.toLowerCase());

  // Step 5: Armor and Weapon, both equipped. "None" armor buys an extra gear roll.
  const weapon = (await rollCreationTable(TABLES.weapon))?.item ?? null;
  if (weapon) { weapon.system.equipped = true; avoid.add(weapon.name.toLowerCase()); }
  const armor = (await rollCreationTable(TABLES.armor))?.item ?? null;
  if (armor) { armor.system.equipped = true; avoid.add(armor.name.toLowerCase()); }

  // Step 6 — Additional Gear, always.
  const extras = [];
  for (let i = 0; i < 1 + (armor ? 0 : 1); i++) {
    const x = await rollAdditionalGear(avoid);
    if (x) { extras.push(x); avoid.add(x.name.toLowerCase()); }
  }
  return [...base, ...(weapon ? [weapon] : []), ...(armor ? [armor] : []), ...extras];
};

/* `generateBarebonesCharacter` and the whole SOURCE switchboard —
   `CONTENT_SOURCES`, `enabledContentSources`, `promptContentSource` — stood here
   and are GONE (2026-09-02, user ruling: "eliminar cualquier referencia a Cairn
   Barebones. La generación de personaje será solo una").

   There is ONE generator now (`generate2eCharacter`), so there is nothing to
   choose between and no dialog to choose it in. What survived is the player's
   ROLL CONFIRM, which the source picker used to carry as a side job: a player's
   click on Generate must not silently mint a character, and with no picker to
   act as the interrupt, the confirm below is the only one left. */

/**
 * Ask a PLAYER before minting a character. The Warden's own button keeps rolling
 * instantly (user ruling): they clicked a tool, a player may have clicked by
 * accident, and there is no undo on a created actor.
 *
 * Runs on the ACTING user's client in both fresh paths (the GM directory button
 * via createCharacter, and requestPcGeneration, which deliberately prompts on the
 * clicking player's client). Regenerate never reaches here — it passes a
 * background.
 * @returns {Promise<Boolean>} false = the user declined (No or ✕)
 */
export const confirmGeneration = async () => {
  if (game.user.isGM) return true;
  // ✕ resolves falsy — an instruction ("not now"), not a default.
  return !!(await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("CAIRN.GeneratePcConfirmTitle") },
    content: `<p>${game.i18n.localize("CAIRN.GeneratePcConfirm")}</p>`,
    rejectClose: false,
  }));
};

/**
 * Generate a character. A background may be passed to keep it across a
 * regenerate, in which case nothing is asked — Regenerate is not a fresh mint.
 * @param {CairnItem|null} [background]
 * @returns {Promise<Object|null>} null = the user declined
 */
export const generateCharacter = async (background = null) => {
  if (!background && !(await confirmGeneration())) return null;
  return generate2eCharacter(background);
};

/* ==========================================================================
 * Choosing a background
 *
 * A background is a document with a uuid, and the gear it grants is tagged, so
 * ONE picker and ONE swap serve every one of them. A background that carries an
 * archetype and a description is grouped and previewed; one that carries neither
 * falls back to a flat list whose summary is the gear it grants.
 * ======================================================================== */

/**
 * THE background source: every `background` Item in the Warden's Trasfondos
 * compendium (2026-08-29).
 *
 * Four sources collapsed into this one. There used to be several shipped packs
 * and a scan of every world and module Item compendium for `background` items —
 * four provenances, three settings toggles gating them, and a picker section
 * built out of the difference. None of them can exist now: the system ships no
 * packs, so every background a world has is one the Warden put in one
 * compendium, and "is this one canon?" has no answer left to give.
 *
 * What survives untouched is the per-background EYE TOGGLE — `disabledBackgrounds`,
 * stored as uuids in a world setting — because that is a Warden's choice about
 * their own content rather than a fact about where it came from.
 *
 * @param {Object} [opts]
 * @param {Boolean} [opts.includeDisabled]  the Warden's picker view, which shows
 *   switched-off backgrounds greyed rather than hiding them
 * @returns {Promise<CairnItem[]>}
 */
export const allBackgrounds = async ({ includeDisabled = false } = {}) => {
  const docs = await documentsOfType("backgrounds", "background");
  if (includeDisabled) return docs;
  const off = disabledBackgrounds();
  return docs.filter((b) => !off.has(b.uuid));
};

/** The background with this name, or null. Used to keep a character's background
 *  across a regenerate when only its name was stored, to resolve a failed
 *  career's keepsake, and to find an NPC Background's gear.
 *  @returns {Promise<CairnItem|null>} */
export const backgroundByName = async (name, { npcFirst = false } = {}) => {
  // Two background compendiums now: the players' and the NPC generator's. They
  // may be the same pack, or two — a Warden who wants short NPC backgrounds
  // keeps them apart. Both are searched either way, only the ORDER changes, so
  // one pack configured twice behaves exactly as one pack, and a name that only
  // exists on the other side still resolves instead of silently granting nothing.
  const order = npcFirst ? ["npcBackgrounds", "backgrounds"] : ["backgrounds", "npcBackgrounds"];
  for (const kind of order) {
    const doc = await docFromPack(kind, name, { quiet: true });
    if (doc?.type === "background") return doc;
  }
  return null;
};

/* `getBarebonesBackgrounds` / `getBarebonesBackgroundByName` stood here and are
   GONE (2026-09-02). They were aliases for `allBackgrounds` / `backgroundByName`,
   kept only so the dev probes in tools/ could keep their old spelling. */

/**
 * The backgrounds the Warden has switched off — the picker rows' eye toggle
 * (2026-08-04). Stored as UUIDs in a world setting, never on the documents,
 * because a compendium the Warden shares or re-imports must not carry one
 * world's switched-off list into another.
 * @returns {Set<String>}
 */
export const disabledBackgrounds = () =>
  new Set(game.settings.get(SETTINGS_NS, "disabled-backgrounds") ?? []);

/**
 * Flip one background's disabled state, refusing the disable that would leave
 * generation with NOTHING to roll — the same "can never do nothing" invariant
 * the pool holds, enforced at the only place the state changes. (The pool can
 * still go empty another way — the Warden re-points the Trasfondos setting at an
 * empty compendium — and that case keeps its existing answer: generation
 * notifies and does nothing.)
 * @param {String} uuid
 * @returns {Promise<Set<String>|null>}  the new set, or null if refused
 */
export const toggleBackgroundDisabled = async (uuid) => {
  const off = disabledBackgrounds();
  if (off.has(uuid)) {
    off.delete(uuid);
  } else {
    const left = (await allBackgrounds()).filter((b) => b.uuid !== uuid);
    if (!left.length) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.LastBackground"));
      return null;
    }
    off.add(uuid);
  }
  await game.settings.set(SETTINGS_NS, "disabled-backgrounds", [...off]);
  return off;
};

/**
 * Every background a character may be built on.
 *
 * A thin alias for `allBackgrounds` since the compendium rework, and kept as a
 * name of its own because the callers that ask this question — generation and
 * the background swap — read better saying it in these words.
 * @returns {Promise<CairnItem[]>}
 */
export const getBackgroundsFor = async () => allBackgrounds();

/** Archetype grouping order; anything else falls to the end, alphabetically. */
const ARCHETYPE_ORDER = ["Fighter", "Wizard", "Thief"];

/**
 * Backgrounds grouped by archetype, each group name-sorted. A compendium whose
 * backgrounds carry no archetype at all comes back as ONE unnamed group, which
 * the picker renders as a plain alphabetical list.
 * @returns {Promise<{archetype:String, backgrounds:CairnItem[]}[]>}
 */
export const getBackgroundsByArchetype = async () => {
  // The Warden's view keeps disabled backgrounds VISIBLE — the picker greys them
  // and offers the re-enable toggle; hiding them would make a disable
  // permanent-by-accident. Players get the filtered pool.
  //
  // The separate "Custom" SECTION this used to append is gone with the packs it
  // was built out of (2026-08-29). It existed to tell the Player's Guide twenty
  // from everything else at a glance, and membership was by PROVENANCE — which
  // pack a background came out of. One compendium has no provenances to compare,
  // so a Warden who still wants that grouping has a better tool for it than a
  // hardcoded section: give those backgrounds an archetype of their own and they
  // group under it.
  const backgrounds = await allBackgrounds({ includeDisabled: game.user.isGM });
  const byName = (x, y) => x.name.localeCompare(y.name, game.i18n.lang);

  if (!backgrounds.some((b) => b.system.archetype)) {
    // No archetypes at all: one
    // unnamed group the picker renders as a plain alphabetical list.
    return backgrounds.length
      ? [{ archetype: "", backgrounds: [...backgrounds].sort(byName) }]
      : [];
  }
  const groups = new Map();
  for (const bg of backgrounds) {
    const a = bg.system.archetype || "Other";
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(bg);
  }
  const order = [
    ...ARCHETYPE_ORDER.filter((a) => groups.has(a)),
    ...[...groups.keys()].filter((a) => !ARCHETYPE_ORDER.includes(a)).sort(),
  ];
  return order.map((a) => ({ archetype: a, backgrounds: groups.get(a).sort(byName) }));
};

/**
 * The one-line summary shown beside a background's name in the picker: the first
 * sentence of its description, or — for a background with no prose, which is
 * every gear-only one — the gear it grants. The gear line is DERIVED from the
 * references rather than stored, so it cannot go stale when a Warden edits them.
 * @param {CairnItem} bg
 * @returns {String}
 */
export const backgroundTagline = (bg) => {
  const text = String(bg.system?.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text) return (text.match(/^.*?[.!?](\s|$)/)?.[0] ?? text).trim();
  // This used to lowercase the "Slots" LABEL and concatenate "+N " onto it:
  // `toLowerCase()` is locale-unaware (German capitalises nouns and Turkish
  // dotless-i is the classic casualty), and "+2 slots" is English word order
  // nobody could reorder. `CAIRN.NSlot` is the counted noun, already lowercase
  // and already the translator's, and formatCount picks its plural form —
  // "+1 slots" was the other half of the same bug.
  const gear = (bg.system?.startingGear ?? []).map((g) => g.name);
  const carried = (bg.system?.containers ?? []).map((c) => game.i18n.format(
    "CAIRN.BgTagline.Carried",
    { name: c.name, slots: formatCount("CAIRN.NSlot", c.slots) }
  ));
  // Narrow conjunction: "A, B, C" in English, the locale's own form elsewhere.
  const list = new Intl.ListFormat(game.i18n.lang ?? "en", { style: "narrow", type: "conjunction" });
  return list.format([...gear, ...carried]);
};

/**
 * Display label for an archetype. The stored value is the English identity (it
 * groups and sorts, and a Warden-authored background may carry anything), so it is
 * translated only on the way to the screen, falling back to the raw string for a
 * custom archetype that has no key.
 * @param {String} archetype
 * @returns {String}
 */
const archetypeLabel = (archetype) => {
  const key = `CAIRN.Archetype.${archetype}`;
  const hit = game.i18n.localize(key);
  return hit === key ? archetype : hit;
};

/** Escape for interpolation into the picker's HTML. */
const bgEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Sentinel radio value for the "Random" row. */
const BG_RANDOM = "__random__";

/**
 * The background picker. Grouped by archetype with a live description panel when
 * the backgrounds have prose; a single wide column when they do not, where each
 * row already shows everything the background gives you and a panel would only
 * repeat it.
 *
 * Instance pattern (as _onEditPortrait): render, then wire listeners on
 * dialog.element. Button callbacks resolve directly and a wrapped close() covers
 * manual dismissal (X / Escape); the `done` guard stops that close from
 * overwriting a choice already made.
 *
 * The `source` parameter is GONE (2026-09-02): there is one pool and one
 * generator, so every caller was passing the same string.
 * @param {String|null} currentUuid  pre-checked, so the dialog opens on the current pick
 * @returns {Promise<{bg: CairnItem|null}|false>}  bg null = random; false = cancelled
 */
export const promptBackground = async (currentUuid = null) => {
  const groups = await getBackgroundsByArchetype();
  const all = groups.flatMap((g) => g.backgrounds);
  if (!all.length) return false;
  const hasProse = all.some((b) => b.system.description);

  // The eye toggle is the WARDEN's control (ruled 2026-08-04). Players never
  // reach this branch with a disabled row — their pool is already filtered.
  const showEyes = game.user.isGM;
  const off = disabledBackgrounds();

  let list = `<label class="bg-pick-row"><input type="radio" name="bg" value="${BG_RANDOM}"${currentUuid ? "" : " checked"}>
    <span class="bg-pick-name"><i class="fas fa-dice"></i> ${game.i18n.localize("CAIRN.RandomBackground")}</span></label>`;
  const descs = {};
  for (const g of groups) {
    if (g.archetype) list += `<div class="bg-pick-group">${bgEsc(archetypeLabel(g.archetype))}</div>`;
    for (const bg of g.backgrounds) {
      descs[bg.uuid] = bg.system.description ?? "";
      // A disabled row cannot be checked — including the pre-check on the
      // character's current background; "nothing checked reads as Random".
      const isOff = off.has(bg.uuid);
      const eye = showEyes
        ? `<button type="button" class="bg-pick-eye" data-uuid="${bg.uuid}"
             title="${game.i18n.localize(isOff ? "CAIRN.BgPickEnable" : "CAIRN.BgPickDisable")}">
             <i class="fas ${isOff ? "fa-eye-slash" : "fa-eye"}"></i></button>`
        : "";
      list += `<label class="bg-pick-row${isOff ? " bg-pick-off" : ""}">
        <input type="radio" name="bg" value="${bg.uuid}"${bg.uuid === currentUuid && !isOff ? " checked" : ""}${isOff ? " disabled" : ""}>
        <span class="bg-pick-name">${bgEsc(bg.name)}</span>
        <span class="bg-pick-tag">${bgEsc(backgroundTagline(bg))}</span>${eye}</label>`;
    }
  }
  // The authoring pointer (user ruling 2026-08-05, "option 1"): the picker is
  // the moment someone is looking at what backgrounds exist, so the how-to
  // link lives here.
  const GUIDE_URL = "https://github.com/fsmalecho/air-bladder/blob/mondolme/docs/creating-custom-backgrounds.md";
  const foot = `<div class="bg-pick-foot">${game.i18n.localize("CAIRN.BgPickFootQuestion")}
        <a href="${GUIDE_URL}" target="_blank" rel="noopener">${game.i18n.localize("CAIRN.BgPickFootLink")}</a></div>`;
  const content = hasProse
    ? `<div class="bg-picker"><div class="bg-pick-list">${list}</div><div class="bg-pick-desc"></div>${foot}</div>`
    : `<div class="bg-picker single"><div class="bg-pick-list">${list}</div>${foot}</div>`;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize("CAIRN.ChooseBackground"), icon: "fas fa-book-open" },
      position: { width: hasProse ? 620 : 560 },
      content,
      buttons: [
        {
          action: "choose",
          label: game.i18n.localize("CAIRN.Choose"),
          default: true,
          callback: () => {
            const form = dialog.element.querySelector("form") ?? dialog.element;
            // Nothing checked (a Warden emptied the pack) reads as Random.
            finish(form?.elements?.bg?.value || BG_RANDOM);
          },
        },
        { action: "cancel", label: game.i18n.localize("CAIRN.Cancel"), callback: () => finish(false) },
      ],
    });
    const origClose = dialog.close.bind(dialog);
    dialog.close = (...a) => { finish(false); return origClose(...a); };
    dialog.render(true).then(() => {
      // DialogV2 serializes content to innerHTML, so listeners go on the LIVE
      // nodes here, after render — never on the built string's nodes.
      // The eye toggles (Warden only). The row is a <label>, so the click must
      // not fall through and check the radio it sits beside.
      dialog.element.querySelectorAll(".bg-pick-eye").forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const uuid = btn.dataset.uuid;
          const now = await toggleBackgroundDisabled(uuid);
          if (now === null) return; // refused: it was the last enabled background
          const isOff = now.has(uuid);
          const row = btn.closest(".bg-pick-row");
          row.classList.toggle("bg-pick-off", isOff);
          const radio = row.querySelector('input[name="bg"]');
          radio.disabled = isOff;
          if (isOff && radio.checked) {
            // The selection cannot rest on a background players can't have.
            radio.checked = false;
            const rand = dialog.element.querySelector(`input[name="bg"][value="${BG_RANDOM}"]`);
            if (rand) { rand.checked = true; rand.dispatchEvent(new Event("change")); }
          }
          btn.title = game.i18n.localize(isOff ? "CAIRN.BgPickEnable" : "CAIRN.BgPickDisable");
          btn.querySelector("i").className = `fas ${isOff ? "fa-eye-slash" : "fa-eye"}`;
        });
      });
      if (!hasProse) return;
      const panel = dialog.element.querySelector(".bg-pick-desc");
      const update = (v) => {
        panel.innerHTML = v === BG_RANDOM
          ? `<em>${game.i18n.localize("CAIRN.RandomBackgroundHint")}</em>`
          : (descs[v] ?? "");
      };
      dialog.element.querySelectorAll('input[name="bg"]').forEach((r) => {
        r.addEventListener("change", () => update(r.value));
        if (r.checked) update(r.value);
      });
    });
  }).then(async (choice) => {
    if (!choice) return false;
    return { bg: choice === BG_RANDOM ? null : await fromUuid(choice) };
  });
};

/* THE FAILED CAREER is GONE (2026-09-02, user ruling: "eliminar cualquier
   referencia a Cairn Barebones"). `promptFailedCareer`, `rollFailedCareerName`,
   `failedCareerItemFromBg`, `buildFailedCareerItem` and
   `replaceFailedCareerKeepsake` stood here. It was a Knave-style flourish that
   only ever applied to a Barebones character: a second background NAME plus one
   weightless keepsake off that career's gear. Its setting, its sheet block, its
   three sheet actions and its stored field went with it. */

/**
 * Swap a character's background WITHOUT re-rolling the character. Replaces the
 * background name/uuid, the gear it granted, its containers, and (2e) its two
 * questions and the gear those granted, adjusting coins for the question delta.
 * KEEPS name, traits, age, portrait, omen, scars, notes, conditions, and
 * anything bought or picked up — regenerating all of that is Regenerate's job,
 * and conflating the two is why the fork needed four functions.
 *
 * The four STARTING NUMBERS are the exception, and have been since 2026-09-02:
 * a background sets them every time one is applied (see below).
 * A null `newBg` picks a random one, never the current.
 * @param {CairnActor} actor
 * @param {CairnItem|null} [newBg]
 */
export const changeBackground = async (actor, newBg = null) => {
  if (!canRegenerateContainers(actor)) return; // bail before deleting anything
  let bg = newBg;
  if (!bg) {
    const backgrounds = await getBackgroundsFor();
    // Say why nothing happened. An empty pool is entirely reachable — an
    // unassigned or empty Trasfondos compendium — so a bare `return` would read
    // as a dead button.
    if (!backgrounds.length) {
      ui.notifications?.warn(game.i18n.localize("CAIRN.NoBackgrounds2e"));
      return;
    }
    const pool = backgrounds.filter((b) => b.uuid !== actor.system.backgroundUuid);
    const from = pool.length ? pool : backgrounds;
    bg = from[Math.floor(Math.random() * from.length)];
  }

  // Out with the old: everything the OLD background put there, and nothing else.
  // Matched by the grant tag; legacy untagged starting gear is matched by the old
  // background's own reference names, one item apiece, so a character generated
  // before tagging existed still swaps cleanly.
  const oldBg = actor.system.backgroundUuid ? await fromUuid(actor.system.backgroundUuid) : null;
  const toDelete = [];
  const claimed = new Set();
  for (const i of actor.items) {
    const src = String(i.getFlag(FLAG_SCOPE, "grantSource") ?? "");
    if (src === "background" || src.startsWith("question:")) { claimed.add(i.id); toDelete.push(i.id); }
  }
  for (const g of oldBg?.system?.startingGear ?? []) {
    const hit = actor.items.find(
      (i) => !claimed.has(i.id) && !i.getFlag(FLAG_SCOPE, "grantSource") && i.name === g.name
    );
    if (hit) { claimed.add(hit.id); toDelete.push(hit.id); }
  }
  // abNoStatusCard on every write in this swap (and in the generators below):
  // a background change is MACHINERY, and the change log defines "manual" as
  // an operation without the flag — without it a swap floods the ledger with a
  // dozen add/remove lines and a gold line nobody typed.
  if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete, { render: false, abNoStatusCard: true });
  await clearGrantedContainers(actor);

  // In with the new. Weapons and armor arrive equipped, as at generation, so
  // Armor derives to the value the background intends. resolveStartingGear, not a
  // plain reference lookup, so a background whose gear includes an instruction
  // ("hechizo", "equipo adicional aleatorio") grants it here too.
  const gear = tagBackgroundGear(await resolveStartingGear(bg));
  for (const it of gear) {
    if (it.type === "weapon" || it.type === "armor") it.system.equipped = true;
  }
  // EMPTY, exactly as generation is since 2026-09-02: a swapped-in background
  // asks its questions and answers none of them. Rolling here while generation
  // does not would mean a character got its answers by taking the long way
  // round, and the Trasfondo tab's dice are the one way in either case. The
  // trade below is unchanged and still correct — the OLD answers' gold and
  // ability bonuses come off, and the new (zero) ones go on.
  const choices = emptyChoiceTables(bg);
  const newItems = [...gear, ...choices.items];
  if (newItems.length) await actor.createEmbeddedDocuments("Item", newItems, { render: false, abNoStatusCard: true });
  await grantContainers(actor, [
    ...(bg.system.containers ?? []).map((c) => ({ ...c, grantSource: "background" })),
    ...choices.containers,
  ]);

  // THE STARTING NUMBERS — set by the background EVERY time one is applied
  // (2026-09-02, user ruling: "siempre"). This function used to leave a
  // character's four numbers strictly alone, on the reasoning that a swap is
  // not a re-roll; the report that overturned it is the one that matters —
  // dragging a Trasfondo onto a fresh PJ left it sitting on the schema
  // defaults (10/10/10 and 6 Hit Protection), so the background's own
  // «Características iniciales» box did nothing at all and neither did the
  // dice it stands in for.
  //
  // Same rule as generation, and deliberately the same three lines: a
  // background that FIXES its four supplies them outright and nothing is
  // rolled; otherwise 3d6 a piece and 1d6 Hit Protection. The (empty) answers'
  // bonuses go on top either way, clamped at zero.
  //
  // `value` follows `max` exactly — a swap mints a starting character, so it
  // arrives whole rather than carrying the last one's wounds.
  const fixed = bg.system.startingAbilities ?? {};
  const useFixed = !!fixed.enabled;
  const hpRoll = useFixed ? null : await rollHitProtection("1d6");
  const abilityRolls = useFixed ? null : await rollAbilities("3d6");
  const baseAbilities = useFixed
    ? { str: Number(fixed.str) || 0, dex: Number(fixed.dex) || 0, wil: Number(fixed.wil) || 0, hp: Number(fixed.hp) || 0 }
    : { str: abilityRolls.STR.total, dex: abilityRolls.DEX.total, wil: abilityRolls.WIL.total, hp: hpRoll.total };
  const start = withAbilityBonuses(baseAbilities, choices.abilities);

  // Trade the old questions' coins for the new ones'.
  const oldQGold = (actor.system.questions ?? []).reduce((n, q) => n + (q.gold ?? 0), 0);
  // …and their ABILITY bonuses, the same trade in the same place: take back what
  // the old answers granted, apply what the new ones grant. The character's own
  // base numbers are NOT touched — a swap has never re-rolled 3d6 and does not
  // start now, so a background that fixes its starting abilities changes only
  // the characters GENERATED on it, never one it is swapped onto.
  const oldQBonus = (actor.system.questions ?? []).reduce((acc, q) => {
    for (const k of BG_ABILITY_KEYS) acc[k] += q.abilities?.[k] ?? 0;
    return acc;
  }, noAbilityBonuses());
  const update = {
    "system.background": bg.name,
    "system.backgroundUuid": bg.uuid,
    "system.questions": choices.questions,
    "system.gold": Math.max(0, (actor.system.gold ?? 0) - oldQGold + choices.gold),
    // ABSOLUTE, not the signed delta this line used to carry: `start` above is
    // already the whole answer, question bonuses included, so a delta on top
    // would apply them twice. `oldQBonus` survives as the GOLD trade's twin
    // above and is deliberately not read here.
    "system.abilities.STR.value": start.str, "system.abilities.STR.max": start.str,
    "system.abilities.DEX.value": start.dex, "system.abilities.DEX.max": start.dex,
    "system.abilities.WIL.value": start.wil, "system.abilities.WIL.max": start.wil,
    "system.hp.value": start.hp, "system.hp.max": start.hp,
  };
  await actor.update(update, { abNoStatusCard: true });

  // The dice are SHOWN when there were dice: a player who drags a Trasfondo
  // onto a character and watches four numbers change is owed the throw that
  // made them. Nothing is posted for a background that FIXES its four — there
  // was no roll to report — and `postGenerationRolls` itself obeys the
  // show-generation-rolls switch, so this asks the question once, where the
  // generator asks it.
  if (abilityRolls) {
    await postGenerationRolls(actor, {
      hp: start.hp,
      abilities: { STR: start.str, DEX: start.dex, WIL: start.wil },
      rolls: { hp: hpRoll, STR: abilityRolls.STR, DEX: abilityRolls.DEX, WIL: abilityRolls.WIL },
    }, null, { waitForDice: false });
  }
};

/* -------------------------------------------------------------------------- */
/*  Actor create / update                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {Object} characterData
 * @returns {Object} Foundry create/update data for a character
 */
const characterToActorData = (characterData) => ({
  name: characterData.name,
  system: {
    // Generated actors land with the Randomization switch OFF, explicitly —
    // the schema initial says the same since 2026-08-02, but the generator's
    // intent should survive any future default change (the container and
    // marketplace writers already model this).
    generationEnabled: false,
    abilities: {
      STR: { value: characterData.abilities.STR, max: characterData.abilities.STR },
      DEX: { value: characterData.abilities.DEX, max: characterData.abilities.DEX },
      WIL: { value: characterData.abilities.WIL, max: characterData.abilities.WIL },
    },
    hp: { max: characterData.hp, value: characterData.hp },
    background: characterData.background,
    backgroundUuid: characterData.backgroundUuid ?? "",
    age: characterData.age ?? "",
    birthday: characterData.birthday ?? "",
    // The languages the background granted, by NAME. Set unconditionally, like
    // the omen and scar resets below: a background that grants none hands over
    // an empty list, and regenerating onto it must clear the last one's.
    languages: characterData.languages ?? [],
    ...(characterData.traits ? { traits: characterData.traits } : {}),
    // 2e stores the background's choice-table answers as structured,
    // individually re-rollable questions.
    biography: characterData.biography ?? "",
    questions: characterData.questions ?? [],
    // Omens and Scars are never generated: a player enables and fills each by
    // hand. Set unconditionally so regenerating in place resets both.
    omenEnabled: false,
    omen: "",
    scarEnabled: false,
    scars: [],
    // A fresh (or regenerated) character is never critically wounded (STR-only).
    critical: false,
    // Armor is auto-derived from equipped gear; no manual override on (re)generate.
    armorOverride: null,
    gold: characterData.gold,
  },
  items: characterData.items,
  prototypeToken: {
    name: characterData.name,
    disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
    actorLink: true,
    // No `vision` key: it is not in PrototypeToken's schema and was pruned
    // silently, so every PC generated before 2026-08-02 arrived blind. Sight is
    // stamped in CairnActor#_preCreate, which every creation route reaches.
  },
  type: "character",
});

/**
 * @param {Object} characterData
 * @returns {Promise<CairnActor|null>}
 */
export const createActorWithCharacter = async (characterData, { folder = null, ownership = null } = {}) => {
  if (!characterData) return null;
  const data = characterToActorData(characterData);
  // A random portrait + its paired token, assigned ONLY here on creation.
  // characterToActorData deliberately omits img/texture.src, so Regenerate (which
  // goes through updateActorWithCharacter with the same data) cannot disturb a
  // portrait the player picked -- the persistence is by omission.
  const pair = await randomPortraitPair("pc");
  if (pair) {
    data.img = pair.img;
    data.prototypeToken.texture = { src: pair.token };
  }
  // A destination folder, when a caller has one. The createDialog switchboard
  // that threaded the folder "+"'s destination through here is gone
  // (2026-08-29), so every current caller passes nothing and lands at root;
  // the parameter stays for a macro or a future caller that does have one.
  if (folder) data.folder = folder;
  // The generatePC relay mints on the Warden's client FOR a player, so the
  // requester's OWNER must be in the CREATE data, not patched on after:
  // grantContainers below derives each granted mule's connected-ownership
  // shape from the keeper's ownership, and a late patch would hand the player
  // a character whose own mount they cannot open.
  if (ownership) data.ownership = ownership;
  const actor = await CairnActor.create(data);
  await grantContainers(actor, characterData.containers);
  return actor;
};

/**
 * @param {CairnActor} actor
 * @param {Object} characterData
 * @returns {Promise<CairnActor>}
 */
export const updateActorWithCharacter = async (actor, characterData) => {
  if (!characterData) return actor;
  const data = characterToActorData(characterData);
  // Items go through createEmbeddedDocuments, never through `actor.update({items})`:
  // the update route creates the embedded documents server-side without firing a
  // single createItem hook, so anything listening — a module, a world script —
  // sees a regenerate as an actor whose inventory changed with no item ever
  // created. changeBackground above has used the hook-firing route all along.
  // `render: false` + data-update last mirrors it: one render, inventory present.
  const items = data.items ?? [];
  delete data.items;
  // abNoStatusCard on both embedded writes: regenerating is machinery, and the
  // change log must not report a rebuild as a player emptying and refilling
  // their own pack. The data update below already carries the flag.
  await actor.deleteEmbeddedDocuments("Item", [], { deleteAll: true, render: false, abNoStatusCard: true });
  // Containers are Actors, so re-rolling the inventory has to clear them by hand.
  // Only GENERATION-granted ones (they carry a grantSource flag) are deleted —
  // a bought mule or a hand-made chest survives a regenerate.
  await clearGrantedContainers(actor);
  if (items.length) await actor.createEmbeddedDocuments("Item", items, { render: false, abNoStatusCard: true });
  // `characterToActorData` clears `critical` unconditionally, and regenerating is
  // REPLACING this person, not healing them -- without this the rebuild announces a
  // stabilization that never happened. Same argument and same flag as regenerateHireling
  // and rerollHirelingCareer; this path and regenerateMonster were the two that
  // missed it. See CairnActor#_onUpdate.
  await actor.update(data, { abNoStatusCard: true });
  await grantContainers(actor, characterData.containers);
  // The tokens follow through CairnActor's rename rule (every scene, only the
  // ones still wearing the old name) — this used to rename the ACTIVE scene's
  // tokens by hand, unconditionally.
  return actor;
};

/** Message flag (under FLAG_SCOPE) carrying a generation card's numbers. */
export const GENERATION_ROLLS_FLAG = "generationRolls";

/**
 * The generation-rolls card body, built in THIS client's language from the
 * numbers alone. Used at composition (the stored content, in the composer's
 * language) and again on every render by `localizeGenerationCard` below — the
 * stored card is the composer's, and on the player-request relay the composer
 * is the Warden's client, so a player in another language read the Warden's
 * labels (review #18; the cast card's precedent from #16). A plain string
 * build rather than the Handlebars template it replaces, so the render-time
 * rebuild is synchronous: the name is escaped, the numbers are numbers.
 * @param {{name: string, hp: number, str: number, dex: number, wil: number, gold: number}} r
 * @returns {string}
 */
export const generationRollsCard = ({ name, hp, str, dex, wil, gold }) => {
  const L = (k) => game.i18n.localize(k);
  const row = (label, value) =>
    `<div class="gen-roll-row"><span class="gen-roll-label">${label}:</span> <span class="gen-roll-value">${Number(value)}</span></div>`;
  const line = game.i18n.format("CAIRN.GenerationRolls", { name: foundry.utils.escapeHTML(String(name ?? "")) });
  return `<div class="cairn-generation-rolls">
    <div class="gen-rolls-title">${line}</div>
    <div class="gen-rolls-grid">
        ${row(L("CAIRN.HitProtection"), hp)}
        ${row(L("STR"), str)}
        ${row(L("DEX"), dex)}
        ${row(L("WIL"), wil)}
        ${Number.isFinite(Number(gold)) ? row(L("CAIRN.Gold"), gold) : ""}
    </div>
</div>`;
};

/**
 * Rebuild a generation-rolls card in the VIEWER's language from its flag.
 * Called from the renderChatMessageHTML hook (cairn.js), beside the cast
 * card it copies. Display-only: the message is never written, so this runs on
 * a player's client with no permission at all, and re-runs idempotently on
 * every re-render because it rebuilds from the flag, not from what is shown.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export const localizeGenerationCard = (message, html) => {
  const r = message.getFlag(FLAG_SCOPE, GENERATION_ROLLS_FLAG);
  if (!r) return;
  const card = html.querySelector(".cairn-generation-rolls");
  if (card) card.outerHTML = generationRollsCard(r);
};

/**
 * Post the five generation rolls -- HP, STR, DEX, WIL, Gold -- as ONE chat message.
 *
 * The Rolls ride in `rolls:`, which is what earns the dice: Dice So Nice animates
 * every roll on a created ChatMessage with no integration code on our side, and
 * core's _preCreate supplies CONFIG.sounds.dice when rolls are present and no
 * sound is given. So this needs no `game.dice3d` call, and a world without DSN
 * still gets a card and a dice sound.
 *
 * That also settles the relay: a player without ACTOR_CREATE has their character
 * generated on the Warden's client (the generatePC socket branch in cairn.js), and
 * a chat message BROADCASTS -- so the player sees their own dice. A bare
 * dice3d.showForRoll() would have animated on the Warden's screen alone, which a
 * Warden testing solo cannot tell apart from working.
 *
 * Called ONLY from createCharacter and regenerateActor, never from
 * createActorWithCharacter/updateActorWithCharacter: about fourteen dev probes
 * build characters through those directly, and they must stay chat-silent. Name,
 * background and portrait re-rolls never reach here at all -- none of them is a
 * Roll (two are Math.random picks, one is a table roll() with displayChat false).
 *
 * The speaker reads "<Character> (<Roller>)" -- the character who was rolled, and
 * the person who rolled them. `roller` is passed explicitly rather than taken from
 * `game.user` because of the same relay: on that path this code runs on the
 * Warden's client, so `game.user` is the Warden and the card would credit them for
 * a character the player made. The relay hands us the requesting user instead.
 *
 * @param {CairnActor|null} actor
 * @param {Object|null} characterData  a generator's return, carrying `.rolls`
 * @param {User|null} [roller]  who rolled; defaults to whoever is running this
 * @param {Object} [options]
 * @param {boolean} [options.waitForDice=true]  hold until Dice So Nice has
 *   finished animating, so the caller's sheet opens AFTER the dice land.
 * @returns {Promise<ChatMessage|null>}  the posted card, for a caller that wants
 *   to wait on it itself.
 */
const postGenerationRolls = async (actor, characterData, roller = null, { waitForDice = true } = {}) => {
  const rolls = characterData?.rolls;
  if (!actor || !rolls) return;
  if (!game.settings.get(SETTINGS_NS, "show-generation-rolls")) return;
  // A chat failure must never cost the actor: it is already created and saved by
  // the time we get here, so this is reported and swallowed, never rethrown.
  try {
    // The numbers the card shows, stored on the message as a FLAG so every
    // viewer's client rebuilds the card in its own language at render
    // (localizeGenerationCard, off the renderChatMessageHTML hook). The
    // content stored beside it is the same card in the composer's language.
    //
    // hp/STR/DEX/WIL fall back to the character's own starting numbers, because
    // a background may FIX them (BackgroundData.startingAbilities) and then
    // there is no die for that line — see generate2eCharacter's `rolls`. The
    // card still shows all four values; only the animated dice are missing,
    // which is the honest picture of what happened.
    const numbers = {
      name: actor.name,
      hp: rolls.hp?.total ?? characterData.hp,
      str: rolls.STR?.total ?? characterData.abilities?.STR,
      dex: rolls.DEX?.total ?? characterData.abilities?.DEX,
      wil: rolls.WIL?.total ?? characterData.abilities?.WIL,
      // The BARE gold roll, not actor.system.gold -- background-choice
      // gold are added on top of it, and the card must agree with the dice.
      // OPTIONAL since 2026-09-02: a background swap re-rolls the four starting
      // numbers and no coins (changeBackground), so there is no gold Roll to
      // report and the card simply omits the row. `undefined` does not survive
      // into the flag either, so the re-localized card omits it too.
      gold: rolls.gold?.total,
    };
    const content = generationRollsCard(numbers);
    // The card's header names the PLAYER, not the character: it reads as one
    // sentence down the card -- "Warden" / "rolled a new character!" / "Ada".
    // getSpeaker would otherwise put the actor's name there, which duplicates the
    // name line and loses the only place the roller is identified. Only these
    // generation cards read this way; every other card keeps the plain speaker.
    const speaker = ChatMessage.getSpeaker({ actor });
    const who = (roller ?? game.user)?.name;
    if (who) speaker.alias = who;
    const message = await ChatMessage.create({
      speaker,
      // Only the Rolls that HAPPENED — a fixed-ability background rolled no
      // dice for hp/STR/DEX/WIL, and a hole in this array is a Roll that cannot
      // be reconstructed on the receiving client.
      rolls: [rolls.hp, rolls.STR, rolls.DEX, rolls.WIL, rolls.gold].filter(Boolean),
      content,
      flags: { [FLAG_SCOPE]: { [GENERATION_ROLLS_FLAG]: numbers } },
    });
    if (waitForDice) await awaitDiceAnimation(message?.id);
    return message ?? null;
  } catch (err) {
    console.error("Mondolme | could not post the generation rolls to chat:", err);
    return null;
  }
};

/**
 * Hold until Dice So Nice has finished throwing a message's dice.
 *
 * The point is ORDERING, not decoration: `ChatMessage.create` resolves as soon as
 * the document is saved, but DSN animates for seconds afterwards, so a caller
 * that opened the new character's sheet on that resolution put the sheet on
 * screen while the dice were still in the air — the sheet spoiled its own roll.
 * Waiting here rather than at each render site fixes all three of them at once
 * (the Create Actor dialog, the directory button, and the player relay).
 *
 * Safe with no DSN and safe with DSN configured away: `game.dice3d` is undefined
 * unless the module is active, and DSN's own API resolves immediately when its
 * visibility is "none", when `immediatelyDisplayChatMessages` is set, or when the
 * message is not animating (main.js, waitFor3DAnimationByMessageID). So the delay
 * happens exactly when there is an animation to wait for and never otherwise —
 * which is why this needs no setting of its own.
 *
 * The timeout is the part that earns its keep. DSN resolves on its
 * `diceSoNiceRollComplete` hook, and a hook that never fires (a failed throw, a
 * module error) would otherwise hang character generation forever with no error
 * anywhere. A cap turns the worst case back into today's behaviour.
 *
 * @param {string|null|undefined} messageId
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=20000]
 * @returns {Promise<boolean>}  true if the animation actually completed
 */
export const awaitDiceAnimation = async (messageId, { timeoutMs = 20000 } = {}) => {
  if (!messageId || typeof game.dice3d?.waitFor3DAnimationByMessageID !== "function") return false;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(game.dice3d.waitFor3DAnimationByMessageID(messageId)).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch (err) {
    // Never let a dice module's failure cost somebody their character: by the
    // time we are here the actor exists and is saved.
    console.warn("Mondolme | waiting on the dice animation failed:", err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * The generation card for an actor, newest first — how a client that did NOT
 * post it (the player, on the relay path) finds the animation to wait for.
 * @param {CairnActor|null} actor
 * @returns {ChatMessage|null}
 */
export const findGenerationRollMessage = (actor) => {
  if (!actor) return null;
  const messages = game.messages?.contents ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.rolls?.length && m.speaker?.actor === actor.id) return m;
  }
  return null;
};

/**
 * @param {Object} [options]
 * @param {User|null} [options.roller]  who asked for this character. Only the
 *   generatePC relay passes it: there, this runs on the Warden's client for a
 *   player, and the chat card must credit the player, not whoever executed it.
 * @returns {Promise<CairnActor|null>}
 */
export const createCharacter = async ({ folder = null, ownership = null, roller = null } = {}) => {
  // No background and no `source`: `generateCharacter` asks a PLAYER to confirm
  // and never asks the Warden, which is what every caller of this wants. On the
  // generatePC relay this runs on the Warden's client, so nothing is asked here
  // — the player was already asked on their own (requestPcGeneration).
  const characterData = await generateCharacter(null);
  const actor = await createActorWithCharacter(characterData, { folder, ownership });
  await postGenerationRolls(actor, characterData, roller);
  return actor;
};

/**
 * Regenerate an existing character: re-roll stats/gear/traits but PERSIST the
 * background (keyed by uuid), so "Regenerate" re-rolls the character within the
 * same background.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const regenerateActor = async (actor) => {
  if (!canRegenerateContainers(actor)) return actor; // bail before wiping items
  let bg = actor.system.backgroundUuid ? await fromUuid(actor.system.backgroundUuid) : null;
  // A character made before backgrounds had uuids is keyed by name.
  if (!bg && actor.system.background) bg = await backgroundByName(actor.system.background);
  const characterData = await generateCharacter(bg);
  const updated = await updateActorWithCharacter(actor, characterData);
  await postGenerationRolls(updated, characterData);
  return updated;
};

/* ==========================================================================
 * NPC careers
 * A GM-created helper drawn from Cairn 2e's twelve example hirelings
 * (resources/hirelings.md, shipped as module/npc-careers-2e.json by
 * tools/import/npc-careers-2e.mjs). Each is a canonical statblock: a Profession, a
 * daily rate, fixed HP + STR/DEX/WIL, and a specific gear loadout (its weapon and
 * armor included). No omens/scars/traits/questions -- generated NPCs are
 * deliberately simple.
 *
 * Its gear is BY-NAME REFERENCES into the editable pool, exactly like a
 * background's starting gear: resolveGearItem clones the current pool document,
 * so editing an item flows into every NPC generated afterwards.
 * ======================================================================== */

/** The 2e careers catalogue (shipped runtime data), fetched once and cached. */
let _npcCareers2e = null;
export const getNpcCareers2e = async () => {
  if (_npcCareers2e === null) {
    try {
      const resp = await fetch("systems/mondolme/module/npc-careers-2e.json");
      _npcCareers2e = resp.ok ? await resp.json() : [];
    } catch {
      _npcCareers2e = [];
    }
  }
  return _npcCareers2e;
};

/**
 * A random career entry, optionally avoiding a profession name so a re-roll
 * always changes.
 * @param {String|null} avoidName
 * @returns {Promise<Object|null>}
 */
const randomCareer = async (avoidName = null) => {
  const list = await getNpcCareers2e();
  if (!list.length) return null;
  const pool = avoidName ? list.filter((h) => h.name !== avoidName) : list;
  const from = pool.length ? pool : list;
  return from[Math.floor(Math.random() * from.length)];
};

/**
 * A generated NPC's name. 2e characters take their name from their background's
 * name list, which an NPC has no equivalent of, so this draws from the Warden's
 * 2e NPC name table. roll(), never draw(), so the Warden's table keeps a clean
 * drawn state.
 * @returns {Promise<String>}
 */
const rollNpcName = () =>
  rollNameFromTable(Cairn.npcGenerator.name, game.i18n.localize("CAIRN.Npc"));

/**
 * A generated NPC's canonical loadout, resolved from the pool: weapons and armor
 * equipped (so Armor derives via calcArmor to the book value -- pool items are
 * equipped:false), each tagged grantSource "profession" so a profession re-roll
 * replaces exactly these and leaves GM-added gear alone.
 * @param {Object} entry
 * @returns {Promise<Object[]>}
 */
const buildHirelingItems = async (entry) => {
  const items = await resolveRefs(entry?.gear ?? []);
  return items.map((item) => {
    if (item.type === "weapon" || item.type === "armor") item.system.equipped = true;
    return withGrantSource(item, "profession");
  });
};

/**
 * A generated person's abilities, at full. Shared by BOTH person generators
 * since 2026-08-20 — a hireling's numbers come off its career and an NPC's off
 * 3d6, but a fresh person is a fresh person, and the two must not differ on
 * whether `max` gets written.
 */
const personAbilityData = (abilities) => ({
  STR: { value: abilities.STR, max: abilities.STR },
  DEX: { value: abilities.DEX, max: abilities.DEX },
  WIL: { value: abilities.WIL, max: abilities.WIL },
});

/** Generate a full HIRELING from a random 2e career. @returns {Promise<Object>} */
export const generateHireling = async () => {
  const h = await randomCareer();
  return {
    name: await rollNpcName(),
    profession: h?.name ?? "",
    rate: h?.rate ?? 0,
    abilities: h?.abilities ?? { STR: 10, DEX: 10, WIL: 10 },
    hp: h?.hp ?? 6,
    // A person, not just a statblock (2026-08-01): the biography the PC
    // generator rolls, through the SAME paths — rollTextItems draws the eight
    // biography trait tables. `rollAge` takes NULL for the background: a
    // hireling has a career, not a background Item, so there is no `ageFormula`
    // to honour and the system default is the whole answer.
    // PRONOUNS ARE NEVER ROLLED (2026-08-20, user ruling). They were a uniform
    // pick of three from 2026-08-01 until now, on the reasoning that a
    // generated stranger needs an answer on arrival. They do not: pronouns are
    // not a trait off a table and there is no table for them, so the dice were
    // deciding something no die should. Stated blank rather than omitted, so a
    // full re-roll — a whole new person — clears the last one's.
    pronouns: "",
    age: String(await rollAge(null, Cairn.characterGenerator2e.biography.age)),
    traits: await rollTextItems(Cairn.characterGenerator2e.biography.items),
    items: orderGrantedItems(await buildHirelingItems(h)),
  };
};

/* `hirelingToActorData` and `createHireling` stood here and are GONE
   (2026-08-29, ruled): the Crear seguidor button is deleted with the rest of
   the generators, and those two were reachable from nothing else. The ROLE
   `hireling` is untouched — it is still the schema initial for an npc, still
   an option in the Rol select, and `generateHireling` / `regenerateHireling` /
   `rerollHirelingCareer` below all still serve the sheet's dice for an
   existing one. What is gone is only the make-me-one-from-nothing button; a
   hireling starts blank from Create Actor now. */

/**
 * Full re-roll of an existing NPC: a fresh random statblock (new profession,
 * day-rate, abilities, HP and gear) AND a fresh biography (pronouns, age,
 * traits) — this is a whole new person. Keeps the name, portrait and free-form
 * notes -- the update omits them.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const regenerateHireling = async (actor) => {
  const h = await generateHireling();
  await actor.deleteEmbeddedDocuments("Item", [], { deleteAll: true, render: false, abNoStatusCard: true });
  // createEmbeddedDocuments, never `items` inside the update: the update route
  // creates embedded documents without firing createItem hooks. Same order as
  // rerollHirelingCareer below — create render:false, then one update renders.
  // abNoStatusCard keeps the rebuild out of the change log, like the update's.
  if (h.items?.length) await actor.createEmbeddedDocuments("Item", h.items, { render: false, abNoStatusCard: true });
  await actor.update({
    system: {
      // Set alongside the rate, never separately: role hireling AND forHire gate
      // the day-rate row between them, so writing a rate without both stores a
      // number the sheet will never render.
      role: "hireling",
      forHire: true,
      profession: h.profession,
      dayRate: h.rate,
      abilities: personAbilityData(h.abilities),
      hp: { value: h.hp, max: h.hp },
      // The biography re-rolls with everything else: a regenerate is a whole
      // new person. The PARTIAL re-rolls below keep all three by OMISSION —
      // profession and name are not identity, so do not add these there.
      pronouns: h.pronouns,
      age: h.age,
      traits: h.traits,
      critical: false,
      // A whole new person resets the same defensive/status/wealth fields the
      // create payload the deleted `hirelingToActorData` set — omitting them left the OLD npc's
      // armorOverride, gold, deprived and panicked on the regenerated one.
      armorOverride: null,
      gold: 0,
      deprived: false,
      panicked: false,
    },
  }, {
    // Regenerating is REPLACING this person, not healing them: clearing
    // `critical` here must not announce a stabilization in chat. See
    // CairnActor#_onUpdate.
    abNoStatusCard: true,
  });
  return actor;
};

/**
 * Profession re-roll: swap to a different example statblock and adopt the whole
 * of it -- Profession, day-rate, abilities, HP and granted gear (a 2e career's
 * stats ARE its profession). Keeps the name, portrait, notes, any GM-added
 * items, and the biography (pronouns/age/traits) — identity fields, kept by
 * OMISSION from the update; a new job is not a new person.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const rerollHirelingCareer = async (actor) =>
  applyHirelingCareer(actor, await randomCareer(actor.system.profession));

/**
 * The CHOSEN-career half of the pair (2026-08-21, user ask): the magnifying
 * glass beside the Career field, the same deliberate-choice affordance the PC
 * sheet's background picker is. Adopts the WHOLE career exactly as the die
 * does — statblock, rate, gear — because a career's stats ARE its identity;
 * a picker that swapped only the word would leave a Blacksmith with a
 * scholar's arms.
 * @param {CairnActor} actor @param {String} name  the ENGLISH career name
 * @returns {Promise<CairnActor>}
 */
export const pickHirelingCareer = async (actor, name) => {
  const h = (await getNpcCareers2e()).find((c) => c.name === name);
  return h ? applyHirelingCareer(actor, h) : actor;
};

/** Shared by the Career die and the Career picker — one apply, so the two can
 *  never disagree about what adopting a career means. @private */
const applyHirelingCareer = async (actor, h) => {
  const items = await buildHirelingItems(h);
  const stale = actor.items
    .filter((i) => i.getFlag(FLAG_SCOPE, "grantSource") === "profession")
    .map((i) => i.id);
  if (stale.length) await actor.deleteEmbeddedDocuments("Item", stale, { render: false, abNoStatusCard: true });
  if (items.length) await actor.createEmbeddedDocuments("Item", items, { render: false, abNoStatusCard: true });
  // Arrange the RESULT (2026-08-21). A career swap replaces the whole granted
  // loadout, and without this the new items ride the append seam in career-list
  // order — Rations first, the sword last, the arrangement inverted. The same
  // whole-inventory pass regenerateNpc runs, and for the same reason: what a
  // swap leaves behind should read like a freshly generated person.
  await reorderInventory(actor);
  await actor.update({
    system: {
      // See regenerateHireling: the pair travels with the rate it gates.
      role: "hireling",
      forHire: true,
      profession: h?.name ?? "",
      dayRate: h?.rate ?? 0,
      abilities: personAbilityData(h?.abilities ?? { STR: 10, DEX: 10, WIL: 10 }),
      hp: { value: h?.hp ?? 6, max: h?.hp ?? 6 },
      critical: false,
    },
  }, {
    // Same as regenerateHireling: a re-rolled career is a new statblock, not a
    // recovery, so the cleared `critical` stays out of chat.
    abNoStatusCard: true,
  });
  return actor;
};

/**
 * Re-roll only an NPC's NAME, leaving its statblock alone.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const rerollNpcName = async (actor) => {
  await actor.update({ name: await rollNpcName() });
  // The tokens follow through CairnActor's rename rule (every scene, only the
  // ones still wearing the old name) — this used to rename the ACTIVE scene's
  // tokens by hand, unconditionally.
  return actor;
};

/**
 * Re-roll only an NPC's or Monster's FACTION, leaving everything else alone.
 * The table resolves BY NAME, world first (findTableByName): a Warden's own
 * Facción table beats the copy in their Generadores compendium, so the list
 * they edit most easily is the one that deals. roll(), never draw() —
 * the Warden's-tables invariant (module/config.js).
 *
 * A missing or empty table changes nothing — degrade, never blank.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const rerollNpcFaction = async (actor) => {
  const tableName = CONFIG.Cairn?.npcGenerator?.faction;
  const table = tableName ? await findTableByName(tableName) : null;
  if (!table) return actor;
  const { results } = await table.roll();
  const raw = resultText(results[0]).trim();
  if (raw) await actor.update({ "system.faction": raw });
  return actor;
};


/* ==========================================================================
 * NPCs — the people the party MEETS (2026-08-20)
 *
 * The other half of the hireling/npc split. A hireling is a statblock with a
 * day rate; an NPC is somebody: a Background off the Trasfondo table, and four
 * traits — Peculiaridad, Objetivo, Virtud, Defecto — off the Warden's own
 * tables.
 *
 * Two deliberate absences, and both are the point rather than an omission:
 *
 *   - NO GEAR. An NPC arrives with an empty inventory. Slots are NOT written
 *     either, so `calcCurrentMaxSlots` falls through to the Warden's
 *     `max-equip-slots` setting (ten by default) — writing 10 here would
 *     override a Warden who chose eight, to say the thing their setting
 *     already says.
 *   - NO ROLLED STATS. Abilities and HP take the schema defaults (10/10/10,
 *     6 HP). The Warden's Guide gives NPCs no stat line, and a generator that
 *     invented one would be making up rules — the house position everywhere
 *     else in this system. A Warden fills them in if the innkeeper ends up in
 *     a fight.
 *
 * Faction is likewise not rolled, matching hirelings: it stays the sheet's own
 * die, because a campaign's factions are the Warden's to hand out.
 * ======================================================================== */

/**
 * The six APPEARANCE traits of the 2e biography, without virtue and vice.
 *
 * An NPC shows all ten trait rows, but its Virtue and Vice are addressed
 * through the NPC map rather than the 2e one — same stored keys, and the two
 * maps are free to name different tables. Derived from the 2e config by
 * subtraction rather than written out again, so a table re-pointed there
 * reaches NPCs too and the two lists cannot drift.
 * @returns {Object<String,String>} key -> table name
 */
const appearanceTables = () => {
  const all = CONFIG.Cairn?.characterGenerator2e?.biography?.items ?? {};
  return Object.fromEntries(Object.entries(all).filter(([k]) => !["virtue", "vice"].includes(k)));
};

/**
 * Roll an NPC's ten traits: the six appearance ones from the 2e biography map,
 * then the four NPC ones. Order matters — the NPC tables are second, so their virtue and
 * vice WIN over the 2e pair if `appearanceTables` ever stops filtering them out.
 * @returns {Promise<Object<String,String>>}
 */
const rollNpcTraits = async () => ({
  ...(await rollTextItems(appearanceTables())),
  ...(await rollTextItems(CONFIG.Cairn?.npcGenerator?.traits ?? {})),
});

/**
 * The `background` Item an NPC's rolled Background NAMES, or null.
 *
 * THE lookup that replaced `Cairn.npcGenerator.backgroundGear` (2026-08-29). That
 * was a hardcoded English map from one shipped table's eighteen rows to their
 * nearest gear list — a translation table between two lists this
 * system no longer ships either of. What stands in its place needs no map at
 * all: the Trasfondo table's rows and the Trasfondos compendium's backgrounds
 * are both the Warden's, so a row that names a background they wrote FINDS it,
 * and one that does not simply grants nothing.
 *
 * A row with no matching background is a LEGITIMATE outcome, not an error — the
 * old map expressed exactly this by leaving Lord and Politician out, on the
 * grounds that rank and office are not occupations that come with a kit. So the
 * lookup is quiet: no warning, no gear, no fuss.
 * @param {String} name  the Background text stored on the actor
 * @returns {Promise<CairnItem|null>}
 */
const npcBackgroundItem = async (name) =>
  backgroundByName(String(name ?? "").trim(), { npcFirst: true });

/**
 * The gear an NPC's Background hands them: that background's OWN startingGear,
 * resolved the same way a character's and a hireling's are — by-NAME references
 * into the editable gear pool, so a Warden editing an item changes what every
 * NPC generated afterwards carries.
 *
 * Through `resolveStartingGear`, NOT a bare `resolveRefs`. A background may write
 * a row as an INSTRUCTION rather than an item ("Random Additional Gear", "Scroll
 * of Random Spellbook", "Spellbook") and a plain reference lookup drops every one
 * of them without a word — that is the whole reason the shared resolver is
 * exported.
 *
 * What it deliberately does NOT do is grant CONTAINERS, even when the background
 * declares one. A container is a second ACTOR, connected, which the Actor
 * Directory always lists — a Warden generating a dozen NPCs would be minting
 * carts faster than they can want them. A hireling's career grants no container
 * either, so items-only is also the answer that matches the other person role.
 *
 * Tagged grantSource "background", the whole set and not just the interesting
 * half: `tagBackgroundGear` deliberately leaves rations/torches/lanterns
 * untagged so a PC's sheet shows no source chip on them, and an NPC cannot
 * afford that — a re-rolled Background finds its old gear BY the tag, so an
 * untagged grant would survive every re-roll and pile up. The hireling's
 * buildHirelingItems tags all of its own for the same reason.
 * @param {CairnItem} bg  the background Item, already resolved by the caller
 * @returns {Promise<Object[]>}
 */
const buildNpcItems = async (bg, avoid = new Set()) => {
  if (!bg) return [];
  const items = await resolveStartingGear(bg, avoid);
  return items.map((item) => {
    if (item.type === "weapon" || item.type === "armor") item.system.equipped = true;
    return withGrantSource(item, "background");
  });
};

/**
 * The KIT every generated NPC carries whatever their Background: the WHOLE
 * equipment procedure — rations, a torch, a rolled weapon and armor
 * (equipped), and the Additional Gear roll(s) — via the same
 * rollStandardEquipment the character generator runs (user ruling
 * 2026-08-21, superseding the previous day's rations-torch-and-one-find
 * subset: an NPC's generation grant uses the SAME randomization a player
 * character gets, weapons and armor included). The kit exists because the
 * Background alone left an NPC with two or three items while a hireling
 * arrives with six off its career — user report, 2026-08-20 — and the fix has
 * always been to run the procedure rather than to pad the list.
 *
 * Tagged "npc-kit", and BOTH halves of that matter. Tagged, so a full re-roll
 * can find it — an untagged grant is indistinguishable from a Warden's gift and
 * would pile up one kit per re-roll. Not "background", because grantSourceLabel
 * maps an unknown source to "" and rations wearing a "Background" chip is the
 * very thing tagBackgroundGear exists to avoid on the character sheet.
 * @param {Set<string>} avoid  lower-cased names already granted
 * @returns {Promise<Object[]>}
 */
const buildNpcKit = async (avoid = new Set()) =>
  (await rollStandardEquipment(avoid)).map((i) => withGrantSource(i, "npc-kit"));

/**
 * Everything a newly generated NPC carries, in one `avoid` set so the Additional
 * Gear roll cannot hand back something the Background already gave. Rations and
 * Torch seed it up front for the same reason the PC path seeds them.
 * @returns {Promise<Object[]>}
 */
const buildNpcGear = async (background) => {
  // A Background with no background ITEM of that name grants NOTHING AT ALL, kit
  // included (user ruling 2026-08-21, reversing the 2026-08-20 "the kit does not
  // care what you do for a living"). It used to be Lord and Politician, named in
  // a map; it is now whatever the Warden's Trasfondo table names that their
  // Trasfondos compendium does not answer for — rank and office arrive
  // empty-handed, and the Warden equips them deliberately or not at all. The
  // Background die and picker apply the same rule to an EXISTING NPC
  // (applyNpcBackground), so generating a Lord and swapping to Lord end up with
  // the same person.
  const bg = await npcBackgroundItem(background);
  if (!bg) return [];
  const avoid = new Set(["rations", "torch"]);
  const items = await buildNpcItems(bg, avoid);
  return [...items, ...(await buildNpcKit(avoid))];
};

/**
 * The NPC items a generator owns, by source. "background" is the Background's
 * own gear, which the Background die replaces; "npc-kit" is the rations, torch
 * and random item, which only a WHOLE new person replaces. Anything untagged is
 * the Warden's and is never touched.
 * @param {CairnActor} actor @param {String[]} sources @returns {String[]} ids
 */
const npcGrantedItemIds = (actor, sources = ["background"]) => actor.items
  .filter((i) => sources.includes(i.getFlag(FLAG_SCOPE, "grantSource")))
  .map((i) => i.id);

/**
 * Re-arrange an EXISTING actor's whole inventory by the granted-loadout rules.
 *
 * Only regenerateNpc needs this, and only because it is the one full
 * regeneration that KEEPS items: it deletes just the tagged grant, so a
 * Warden's own untagged gifts survive at whatever sort they had — 0 for
 * anything never dragged, which renders ABOVE every item the new loadout
 * numbered. Its hireling twin deletes the inventory outright and needs none of
 * this.
 *
 * Ordinary acquisition is deliberately NOT re-arranged: a newly created item
 * appends instead (CairnItem._preCreateOperation), because the arrangement is
 * the state a generated person ARRIVES in, not a rule enforced for life over a
 * list its owner is free to drag.
 *
 * Shims rather than the documents themselves — orderGrantedItems writes `sort`
 * onto whatever it is handed, and writing it onto a live document would be a
 * mutation outside an update.
 *
 * The bound-page exception this used to carry went with pages: a Libro's three
 * spells are fields on the book, so no row of the inventory belongs to another
 * row any more and every item takes a number.
 * @param {CairnActor} actor
 */
const reorderInventory = async (actor) => {
  const shims = actor.items.map((i) => ({ _id: i.id, name: i.name, type: i.type }));
  const updates = orderGrantedItems(shims).map((i) => ({ _id: i._id, sort: i.sort }));
  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates, { render: false, abNoStatusCard: true });
  }
};

/** One Background off the Trasfondo table, or "" when it is missing (which
 *  `generatorText` reports, once per session). */
const rollNpcBackground = async () => {
  const tableName = CONFIG.Cairn?.npcGenerator?.background;
  return tableName ? generatorText(tableName) : "";
};

/** Generate a full NPC person. @returns {Promise<Object>} */
export const generateNpc = async () => {
  // Rolled, not looked up (2026-08-20, user ask): a hireling's numbers arrive
  // with its career and an NPC has no career, so an NPC is made the way every
  // other person in Cairn is — 3d6 a piece and 1d6 Hit Protection. No `rolls`
  // key beside them: neither person generator posts a generation chat card, so
  // the Roll objects would have no reader (see characterGenerator's `rolls`).
  const abilityRolls = await rollAbilities(Cairn.npcGenerator.ability);
  const hpRoll = await rollHitProtection(Cairn.npcGenerator.hitProtection);
  const background = await rollNpcBackground();
  return {
    name: await rollNpcName(),
    background,
    abilities: {
      STR: abilityRolls.STR.total,
      DEX: abilityRolls.DEX.total,
      WIL: abilityRolls.WIL.total,
    },
    hp: hpRoll.total,
    // Same paths a hireling's biography uses, so the two cannot diverge on
    // anything that is not the point of the split: rollAge takes null for the
    // background (an NPC's Background is a line of TEXT off a table, not a
    // background Item, so it carries no age formula), and pronouns are left
    // BLANK for the Warden to state — see generateHireling for the ruling.
    pronouns: "",
    age: String(await rollAge(null, Cairn.characterGenerator2e.biography.age)),
    traits: await rollNpcTraits(),
    items: orderGrantedItems(await buildNpcGear(background)),
  };
};

/** @returns {Object} Foundry create/update data for a generated NPC. */
const npcToActorData = (n) => ({
  name: n.name || "NPC",
  type: "npc",
  system: {
    role: "npc",
    // Off-by-default, stated rather than inherited — see characterToActorData.
    generationEnabled: false,
    background: n.background ?? "",
    abilities: personAbilityData(n.abilities),
    hp: { value: n.hp, max: n.hp },
    pronouns: n.pronouns ?? "",
    age: n.age ?? "",
    traits: n.traits ?? {},
    gold: 0,
    deprived: false,
    panicked: false,
    critical: false,
    armorOverride: null,
  },
  // The Background's gear and the kit, or none for a Background with no
  // matching Trasfondo. Still stated rather than omitted, so an empty pack
  // reads as a decision.
  items: n.items ?? [],
  // Players get a LIMITED view of a generated NPC (user ruling 2026-08-21).
  // CairnActor._preCreate has defaulted every unconnected person-npc to
  // LIMITED since 2026-08-01, so this is the generator stating its intent
  // explicitly rather than inheriting it — the same pattern as
  // generationEnabled above — and what the ruling actually ADDED is the
  // sheet's limited RENDERING: LIMITED used to open the full sheet, stats and
  // all, so the level was a label with no wall behind it. Create-time only —
  // regenerateNpc must not reset whatever the Warden has granted since.
  ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED },
});

/**
 * Create a fully-generated NPC actor with a random portrait + paired token
 * (assigned on creation only, like a player character; re-rolls preserve it by
 * omission).
 * @returns {Promise<CairnActor>}
 */
export const createNpc = async ({ folder = null } = {}) => {
  const data = npcToActorData(await generateNpc());
  const pair = await randomPortraitPair("npc");
  if (pair) {
    data.img = pair.img;
    data.prototypeToken = { ...(data.prototypeToken ?? {}), texture: { src: pair.token } };
  }
  // A destination folder, when a caller has one — see createCharacter above.
  if (folder) data.folder = folder;
  return CairnActor.create(data);
};

/**
 * Full re-roll of an existing NPC: a new Background, a new statblock, a new set
 * of traits and a new pronouns/age — a whole new person. Keeps the name,
 * portrait and free-form notes by OMISSION, exactly as regenerateHireling does.
 *
 * Items: everything GENERATION gave — the Background's gear and the kit alike —
 * is deleted and re-granted, because this is a different person. What survives
 * is whatever a Warden added by hand, which differs from the hireling twin:
 * that one deletes the whole inventory, since a hireling's inventory IS its
 * career. The two are told apart by the grantSource flag and nothing else,
 * which is why both builders tag every item they make.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const regenerateNpc = async (actor) => {
  const n = await generateNpc();
  const stale = npcGrantedItemIds(actor, ["background", "npc-kit"]);
  if (stale.length) await actor.deleteEmbeddedDocuments("Item", stale, { render: false, abNoStatusCard: true });
  if (n.items?.length) await actor.createEmbeddedDocuments("Item", n.items, { render: false, abNoStatusCard: true });
  // The WHOLE inventory, not only the batch just created — see reorderInventory.
  // render:false here too, so this and the delete and the create above still
  // resolve into the single render the update below performs.
  await reorderInventory(actor);
  await actor.update({
    system: {
      role: "npc",
      background: n.background,
      // A whole new person is a whole new statblock, the same as its hireling
      // twin — and BOTH halves of each ability, so a re-rolled NPC arrives at
      // full rather than carrying the last one's damage on a new maximum.
      abilities: personAbilityData(n.abilities),
      hp: { value: n.hp, max: n.hp },
      pronouns: n.pronouns,
      age: n.age,
      traits: n.traits,
      critical: false,
      // The same defensive/status/wealth reset regenerateHireling does: a whole
      // new person must not inherit the last one's armorOverride or panic.
      armorOverride: null,
      gold: 0,
      deprived: false,
      panicked: false,
    },
  }, {
    // Regenerating is REPLACING this person, not healing them: clearing
    // `critical` here must not announce a stabilization in chat.
    abNoStatusCard: true,
  });
  return actor;
};

/**
 * Re-roll an NPC's BACKGROUND and the gear that Background grants — the
 * Background die, the counterpart of the hireling's Career die. It stops there:
 * a hireling's career carries its statblock TOO, and re-rolling a Background
 * must not re-roll the person.
 *
 * The KIT survives a trade-for-trade swap: changing what someone does for a
 * living does not change whether they packed food. Two exceptions, both
 * 2026-08-21 (user ruling): landing Lord or Politician WIPES it — the NPC ends
 * up holding what generating that Background grants, which for those two is
 * nothing — and a swap that finds NO kit (the NPC was one of those two, or was
 * generated as one) packs a fresh one. A surviving kit seeds `avoid`, so a
 * Background whose gear rolls on the Additional Gear table cannot hand back
 * what they carry.
 *
 * Avoids returning the current value while the table holds anything else, so
 * the die always visibly does something.
 * @param {CairnActor} actor
 * @returns {Promise<CairnActor>}
 */
export const rerollNpcBackground = async (actor) => {
  const current = String(actor.system.background ?? "").trim();
  let rolled = "";
  for (let i = 0; i < 8; i++) {
    rolled = await rollNpcBackground();
    if (rolled && rolled !== current) break;
  }
  if (!rolled) return actor;
  return applyNpcBackground(actor, rolled);
};

/**
 * The CHOSEN-Background half (2026-08-21, user ask): the magnifying glass
 * beside the Background field. Same apply as the die, so a picked Background
 * and a rolled one are the same event — the old trade's gear goes, and the kit
 * follows applyNpcBackground's rules: kept trade-for-trade, wiped by a
 * Background with no Item of its own, repacked when none survives.
 * @param {CairnActor} actor @param {String} text  the row text, verbatim
 * @returns {Promise<CairnActor>}
 */
export const pickNpcBackground = async (actor, text) =>
  applyNpcBackground(actor, String(text ?? "").trim());

/** Shared by the Background die and picker — one apply, so the two can never
 *  disagree about what changing a Background means. @private */
const applyNpcBackground = async (actor, rolled) => {
  if (!rolled) return actor;
  // A Background the Trasfondos compendium has no Item for takes EVERYTHING the
  // generators gave, kit included (user ruling 2026-08-21, reversing the same
  // day's "a new station does not unpack the bag"): after any swap the NPC
  // holds what GENERATING the new Background would grant, and for one with no
  // Item that is nothing. The Warden's own items are untagged and stay, as
  // everywhere. Resolved ONCE and passed down, so the die, the picker and the
  // gear builder cannot disagree about whether this Background exists.
  const bg = await npcBackgroundItem(rolled);
  const geared = !!bg;
  // Old grant out, new grant in — the same shape as applyHirelingCareer, and
  // `render: false` on both so one update renders rather than three.
  const stale = npcGrantedItemIds(actor, geared ? ["background"] : ["background", "npc-kit"]);
  if (stale.length) await actor.deleteEmbeddedDocuments("Item", stale, { render: false, abNoStatusCard: true });
  // Seeded from what the actor still carries — the kit and any Warden gift — so
  // an instruction row rolls something they do not already have.
  const avoid = new Set(actor.items
    .filter((i) => !stale.includes(i.id))
    .map((i) => i.name.toLowerCase()));
  const items = geared ? await buildNpcItems(bg, avoid) : [];
  // A kit only when NONE survives — this NPC was, or was generated as, someone
  // whose Background has no Item and whose bag is therefore empty by the ruling
  // above. PRESENCE is the test, never the old Background's name: however the
  // kit went missing, a geared Background packs one, exactly as generation would
  // (the reported miss, 2026-08-21: a Politician swapped to Peddler held the
  // Peddler's Sack and nothing else).
  if (geared && npcGrantedItemIds(actor, ["npc-kit"]).length === 0) {
    items.push(...await buildNpcKit(avoid));
  }
  if (items.length) await actor.createEmbeddedDocuments("Item", items, { render: false, abNoStatusCard: true });
  // Same whole-inventory arrangement a career swap gets — see applyHirelingCareer.
  await reorderInventory(actor);
  await actor.update({ "system.background": rolled });
  return actor;
};

/* --------------------------------------------------------------------------
 * The person-sheet pickers (2026-08-21, user ask): the magnifying glass the PC
 * sheet's background row already has, brought to the Career, Background and
 * Faction rows — a Warden picks a specific value instead of rolling one, and
 * the picker is offered whether or not the Randomization toggle is on, because
 * a deliberate choice is not randomization. All three share one dialog shape:
 * radio rows, a Random row on top, ENGLISH value stored where the
 * stored string is a match key, translated label shown.
 * ------------------------------------------------------------------------ */

/** One radio-list picker dialog. `rows` are {value, label, tag?}; resolves the
 *  chosen value, BG_RANDOM for the Random row, or false. @private */
const promptFromRows = (titleKey, rows, current = null) => {
  let list = `<label class="bg-pick-row"><input type="radio" name="bg" value="${BG_RANDOM}"${current ? "" : " checked"}>
    <span class="bg-pick-name"><i class="fas fa-dice"></i> ${game.i18n.localize("CAIRN.RandomBackground")}</span></label>`;
  for (const row of rows) {
    list += `<label class="bg-pick-row"><input type="radio" name="bg" value="${bgEsc(row.value)}"${row.value === current ? " checked" : ""}>
      <span class="bg-pick-name">${bgEsc(row.label)}</span>${row.tag ? `<span class="bg-pick-tag">${row.tag}</span>` : ""}</label>`;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize(titleKey), icon: "fas fa-magnifying-glass" },
      position: { width: 420 },
      content: `<div class="bg-picker single"><div class="bg-pick-list">${list}</div></div>`,
      buttons: [
        {
          action: "choose",
          label: game.i18n.localize("CAIRN.Choose"),
          default: true,
          callback: () => {
            const form = dialog.element.querySelector("form") ?? dialog.element;
            finish(form?.elements?.bg?.value || BG_RANDOM);
          },
        },
        { action: "cancel", label: game.i18n.localize("CAIRN.Cancel"), callback: () => finish(false) },
      ],
    });
    const origClose = dialog.close.bind(dialog);
    dialog.close = (...a) => { finish(false); return origClose(...a); };
    dialog.render(true);
  });
};

/**
 * Pick a hireling's career by name, or Random (which defers to the die's own
 * path so "random" means the same thing both ways). Applies on choice.
 * @param {CairnActor} actor @returns {Promise<CairnActor>}
 */
export const promptHirelingCareer = async (actor) => {
  const careers = await getNpcCareers2e();
  if (!careers.length) return actor;
  const current = String(actor.system.profession ?? "").trim();
  const rows = [...careers]
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
    .map((c) => ({
      value: c.name,
      label: c.name,
      // The rate and the loadout are what a Warden picks a career FOR.
      tag: bgEsc(`${c.rate ?? 0} ${game.i18n.localize("CAIRN.DayRateSuffix")} · `
        + (c.gear ?? []).map((g) => g.name ?? g).join(", ")),
    }));
  const choice = await promptFromRows("CAIRN.PickCareer", rows, current);
  if (!choice) return actor;
  if (choice === BG_RANDOM) return rerollHirelingCareer(actor);
  return pickHirelingCareer(actor, choice);
};

/**
 * Pick an NPC's Background off the Trasfondo table, or Random via the die's own
 * path. The VALUE is the raw row text — the stored string is what the gear
 * lookup matches a `background` Item's NAME against.
 * @param {CairnActor} actor @returns {Promise<CairnActor>}
 */
export const promptNpcBackground = async (actor) => {
  // `generatorTable` non-quiet: this button did NOTHING AT ALL when the table
  // was missing — no dialog, no message, a magnifying glass that swallowed the
  // click — which is the worst shape a failure can take on a control a Warden
  // is about to press again. Reported once per session, like every other miss.
  const tableName = CONFIG.Cairn?.npcGenerator?.background;
  const table = tableName ? await generatorTable(tableName) : null;
  if (!table) return actor;
  const current = String(actor.system.background ?? "").trim();
  const rows = table.results.map((r) => String(resultText(r)).trim()).filter(Boolean)
    .map((text) => ({ value: text, label: text }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  const choice = await promptFromRows("CAIRN.PickBackground", rows, current);
  if (!choice) return actor;
  if (choice === BG_RANDOM) return rerollNpcBackground(actor);
  return pickNpcBackground(actor, choice);
};

/**
 * Pick a faction off the same world-first table the Faction die rolls.
 * Random defers to the die.
 * @param {CairnActor} actor @returns {Promise<CairnActor>}
 */
export const promptNpcFaction = async (actor) => {
  const tableName = CONFIG.Cairn?.npcGenerator?.faction;
  // World-first (findTableByName), so a Warden's own Facción table wins — which
  // is also why the miss is reported by hand rather than by `generatorTable`:
  // the lookup is wider than one compendium, and only the caller knows it came
  // up empty everywhere. Same silent-button fix as promptNpcBackground.
  const table = tableName ? await findTableByName(tableName) : null;
  if (!table) {
    warnNoTable("generators", tableName);
    return actor;
  }
  const rows = table.results.map((r) => String(resultText(r)).trim()).filter(Boolean)
    .map((text) => ({ value: text, label: text }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  const current = String(actor.system.faction ?? "").trim();
  const choice = await promptFromRows("CAIRN.PickFaction", rows, current);
  if (!choice) return actor;
  if (choice === BG_RANDOM) return rerollNpcFaction(actor);
  await actor.update({ "system.faction": choice });
  return actor;
};
