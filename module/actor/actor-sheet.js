import { regenerateActor, canRegenerateContainers, drawBond, bondRecordFrom, withGrantSource, bondEntitlement, resolveRefs, replaceGrantedContainers, promptBackground, changeBackground, promptFailedCareer, rollFailedCareerName, buildFailedCareerItem, getPortraitManifest, pairedTokenFor, randomPortraitInSameFolder, portraitCategoryFor, regenerateNpc, regenerateHireling, rerollNpcBackground, rerollHirelingCareer, rerollNpcName, rerollNpcFaction, promptHirelingCareer, promptNpcBackground, promptNpcFaction, rollNameFromTable, rollAge, effectiveAgeFormula, optionAbilityBonuses, abilityBonusDelta, abilityDeltaUpdate } from "../character-generator.js";
import { openMarketplace, TRANSPORTS_CATEGORY } from "../marketplace.js";
import { evaluateFormula, cleanDescription, bindEditorClickAwaySave, formatCount, sourceLabel, askDamageQuality, damageFormulaFor, damageQualityLabel } from "../utils.js";
import { resultText } from "../compendium.js";
import { generatorTable, languages, TABLES } from "../content-packs.js";
import { SETTINGS_NS } from "../settings.js";
import { CONTAINER_ART_CHOICES, CONTAINER_CLASSES } from "../icons.js";
import { NPC_ROLES, PERSON_ROLES, bgTableDie } from "../data-models.js";

/**
 * The roles with something to randomize: the two people and the monster.
 * Companions, transports and containers have nothing to roll, so their sheets
 * carry neither the Roll button nor the Randomization toggle (ruled
 * 2026-08-02). One list because the test is made in two places that must agree
 * — `_getFrameButtons` builds the buttons and `#syncGenerationButtons` hides
 * them per render, and a frame renders once.
 */
const GENERATING_ROLES = [...PERSON_ROLES, "monster"];

/**
 * Labels for the four Warden's Guide NPC traits, keyed by the stored trait key.
 *
 * Static keys, not `CAIRN.Trait.${pascal(key)}` — the i18n source gate records a
 * template as a DYNAMIC PREFIX, which would make every `CAIRN.` key count as
 * used and blind the unused-key check (the same reason art-picker.js spells its
 * gallery label keys out).
 *
 * Only consulted for a row whose table came from the NPC map: `virtue` and
 * `vice` exist in BOTH trait sets, and a character's must keep reading its
 * tables-2e name through the content overlay, where a translator has already
 * done it.
 */
const NPC_TRAIT_LABELS = {
  quirk: "CAIRN.Trait.Quirk",
  goal: "CAIRN.Trait.Goal",
  virtue: "CAIRN.Trait.Virtue",
  vice: "CAIRN.Trait.Vice",
};

import { atConnectionLimit, maxConnections, connectionsUiEnabled, brokenOwnershipShape, OWNERSHIP_SYNC_FLAG } from "../connections.js";
import { FATIGUE_NAME, bookPages } from "../item/item.js";
import { castFromBook, castSpell, booksOn, canReadBook } from "../magic.js";
import { pickArt } from "../art-picker.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

/**
 * What a connected actor IS to the character keeping it, keyed by the CHILD's
 * role. WHOLE-SENTENCE format keys, one per relationship — the house rule the
 * biography sentence is built on, and for the same reason: "Contacto de" and
 * "Contratado por" take different prepositions, so no fragment plus a name
 * survives translation.
 *
 * Three roles have a word for it. A MONSTER, a TRANSPORT or a CONTAINER has
 * none — nobody is "contacted by" a cart — so those answer null and both
 * surfaces fall back to what they showed before: the keeper's own sheet header
 * reads the plain "Conectado a: X" (CAIRN.ConnectedToNamed) and the row in the
 * Vínculos list carries no relationship line at all.
 *
 * ONE map, because the sentence is printed in two places that must agree: the
 * Vínculos list on the keeper's sheet, and the connection line on the connected
 * actor's own header.
 */
const RELATIONSHIP_KEYS = {
  npc: "CAIRN.Relationship.Contact",
  companion: "CAIRN.Relationship.Companion",
  hireling: "CAIRN.Relationship.Hired",
};

/**
 * @param {String|null} role  the CONNECTED actor's role
 * @param {String} name  the keeping character's name
 * @returns {String|null} the whole sentence, or null for a role that has none
 */
const relationshipLabel = (role, name) =>
  RELATIONSHIP_KEYS[role] ? game.i18n.format(RELATIONSHIP_KEYS[role], { name: name ?? "" }) : null;

/** The Vínculos list's groups, in render order. A group with no members does
 *  not render (see `connectionGroups`), so the fourth is invisible in a party
 *  of people and holds the mounts, carts and loot piles otherwise. */
const RELATIONSHIP_GROUPS = [
  { key: "npc", heading: "CAIRN.RelationshipGroup.Contacts" },
  { key: "companion", heading: "CAIRN.RelationshipGroup.Companions" },
  { key: "hireling", heading: "CAIRN.RelationshipGroup.Hired" },
  { key: "other", heading: "CAIRN.RelationshipGroup.Other" },
];

/** Which group a connected actor's role falls into. Everything without a
 *  relationship sentence of its own lands in `other`. */
const relationshipGroupFor = (role) => (RELATIONSHIP_KEYS[role] ? role : "other");

/** Tab labels by id. The nav itself is hand-written in each template, because
 *  the labels carry live data (slot counts, connection counts). ONE name per
 *  tab across both sheets since 2026-09-02 — the per-role "Notes" / "Background
 *  & Notes" split is gone with the merge, and both sheets read
 *  CAIRN.LinksAndNotes. */
const TAB_LABELS = {
  items: "CAIRN.Items",
  description: "CAIRN.Description",
  // CHARACTER ONLY: the background's question tables and the character's
  // obligations, which used to sit at the head of the Notes tab.
  background: "CAIRN.Background",
  // The old `containers` tab MERGED INTO THIS ONE (2026-09-02, user ruling):
  // the connections list first, the free-form notes editor below it. What a
  // person READS is "Vínculos" — the relationship graph, one PC to many NPCs —
  // and the tab id stays `notes` because it is the tab that survived.
  notes: "CAIRN.LinksAndNotes",
};

/** Which tabs each actor type shows, in order.
 *
 *  The CHARACTER alone carries `background` (2026-09-02): a PC has a background
 *  with questions to answer and obligations to owe, and nobody else does. The
 *  connections LIST is character-only too, but it is a section inside the Links
 *  & Notes tab now rather than a tab of its own — see container-list.html. */
const TAB_IDS = {
  character: ["items", "description", "background", "notes"],
  // ITEMS FIRST on the non-player sheet too since 2026-09-02 (user ruling: the
  // same three tabs as the character, minus Trasfondo, in the character's
  // order). This list is ORDER only — the tab a fresh sheet OPENS on is
  // `initialTabId` below, which is role-aware and unchanged by the reorder.
  npc: ["items", "description", "notes"],
  // Same set as npc: one sheet, one tab set. A hireling used to get only
  // items+notes, so anything written in its Description was unreachable.
  hireling: ["items", "description", "notes"],
};

/** The tab a FRESH sheet opens on. Role-aware since 2026-08-21 (user ask):
 *  a PERSON-role sheet (npc, hireling) opens on Items, the character's
 *  default. A MONSTER or a thing still opens on Description — a Warden opens
 *  one to remember what it is, statblock and prose, and reaches for its cargo
 *  second (2026-08-01). That used to fall out of Description leading the npc
 *  nav; the 2026-09-02 reorder put Items at the head, so the rule is named
 *  here rather than inherited from list order. `npcRole` is null on a
 *  character, whose list already leads with Items. */
const initialTabId = (doc) => {
  const ids = TAB_IDS[doc?.type] ?? ["items"];
  if (doc?.type === "character") return ids[0];
  if (PERSON_ROLES.includes(doc?.npcRole)) return "items";
  return ids.includes("description") ? "description" : ids[0];
};

/**
 * Memoized table reads for the sheet's static pick-lists (traits, scars, omens).
 *
 * `_prepareContext` runs on EVERY render, and `submitOnChange` is on — so every
 * field edit, every item add/remove and every damage application would otherwise
 * re-resolve ten trait tables plus Cicatrices from the compendium.
 *
 * Cached BY TABLE NAME rather than by pack (2026-08-29). It used to load a whole
 * shipped pack and search the result; the tables are the Warden's now and come
 * out of one compendium `generatorTable` resolves a single document from, so a
 * name is both the finer key and the only one this file still knows.
 *
 * The PROMISE is cached, so concurrent renders share a single round-trip, and
 * what it resolves to is the RAW document — translation stays per-render, so
 * switching language still re-localizes for free. A missing table caches as
 * `null`, and the Warden is told about it once (generatorTable warns, and
 * content-packs dedupes per session) rather than once per render.
 */
const TABLE_CACHE = new Map();

/**
 * @param {String} name
 * @param {Object} [opts]
 * @param {Boolean} [opts.quiet]  for the ONE caller that has its own message —
 *   the Omen die, whose CAIRN.OmenTableMissing predates this and names the
 *   button that was pressed. Everything else takes content-packs' warning,
 *   which is the only word the pick-lists get.
 */
const cachedGeneratorTable = (name, { quiet = false } = {}) => {
  if (!TABLE_CACHE.has(name)) {
    // Drop a rejection rather than caching it forever; the caller sees the same
    // error it would have seen before, and the next render retries.
    const p = generatorTable(name, { quiet })
      .catch((err) => { TABLE_CACHE.delete(name); throw err; });
    TABLE_CACHE.set(name, p);
  }
  return TABLE_CACHE.get(name);
};

// TableResult as well as RollTable: adding a row to a table fires ONLY
// createTableResult — the parent RollTable is not updated — so a Warden who
// added a Scar, an Omen or a trait watched the sheet's pick-lists keep serving
// the cached table for the rest of the session. Editing or deleting a row is the
// same story.
//
// `updateSetting` joins them (2026-08-29) and closes the trap the settings
// created: which compendium these tables come from is now a setting, so pointing
// it at the right one mid-session used to leave every pick-list empty — and a
// MISS is cached like a hit — until the browser reloaded. Clearing on any
// setting write is bluntly wider than needed and costs one re-resolve.
for (const hook of [
  "createRollTable", "updateRollTable", "deleteRollTable",
  "createTableResult", "updateTableResult", "deleteTableResult",
  "updateSetting",
]) {
  Hooks.on(hook, () => TABLE_CACHE.clear());
}

/* -------------------------------------------- */
/*  Row animations (replacing jQuery slideUp/slideDown)                         */
/* -------------------------------------------- */

/** Collapse `el` to nothing over 200ms, then run `after`. The animation is
 *  cosmetic; `after` is the real work, so it runs even if animation is
 *  unavailable or interrupted. */
const slideUp = (el, after = () => {}) => {
  el.style.overflow = "hidden";
  const anim = el.animate(
    [{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
    { duration: 200, easing: "ease-out" }
  );
  anim.finished.then(after, after);
};

/** Reveal `el` from nothing over 200ms. */
const slideDown = (el) => {
  const height = el.scrollHeight;
  el.style.overflow = "hidden";
  el.animate(
    [{ height: "0px", opacity: 0 }, { height: `${height}px`, opacity: 1 }],
    { duration: 200, easing: "ease-out" }
  ).finished.then(() => { el.style.overflow = ""; }, () => { el.style.overflow = ""; });
};

/**
 * Wrap an action handler so it does nothing on a non-editable sheet.
 *
 * AppV1 simply never bound any of these listeners when `options.editable` was
 * false — `activateListeners` returned early — so an observer's sheet was inert
 * beyond Foundry's own controls. ApplicationV2 wires `actions` regardless of
 * editability, so preserving that behaviour means guarding at the handler.
 *
 * For MUTATING actions only. The read set — rolls to chat, description
 * expanders, the collapse toggles — is deliberately unwrapped (review #6):
 * none of them writes the document, and wrapping them meant a Warden opening
 * a monster from a locked compendium could not roll its attack, with a
 * PackLocked toast diagnosing a write-permission problem no write had.
 */
/**
 * Wrap a randomization-surface handler so it refuses whoever the Warden's
 * allow-player-randomization switch denies (`_mayRandomize` — the Warden
 * always passes). Applied to exactly the actions whose CONTROLS hide while
 * the switch is off: the two frame buttons (#syncGenerationButtons) and every
 * control inside a template's `generationEnabled` block — that context is
 * derived as actorFlag && _mayRandomize(), so a hidden control and a refused
 * handler are the same statement. Review #13: only rollActor and
 * toggleGeneration carried the guard in-handler, and rollBackground — a
 * wholesale background-and-gear rewrite — answered a call past its hidden die.
 * The hidden control is the affordance, this is the enforcement: a sheet
 * already open when the switch flips, or a crafted client, must not be a way
 * through (the marketplace acquire() split).
 *
 * The actor's OWN generationEnabled flag is deliberately NOT checked here: a
 * player the switch allows can flip that flag themselves via toggleGeneration,
 * so refusing on it would enforce nothing.
 */
/**
 * May this actor's Omen be shown AT ALL? Two terms, and both surfaces need
 * both — which is the whole reason this is a function.
 *
 * The CONTENT source is structural: Barebones ships no omens table, so the
 * field is 2e's alone whatever any switch says (the lending setting that used
 * to hand it to Barebones was removed 2026-08-09; a legacy Barebones
 * character's stored omen and its `omenEnabled` flag both survive on the
 * document). The SETTING is the Warden's, 2026-08-17: a 2e table that does not
 * use the youngest-member rule turns the field off, on the sheet and on paper
 * alike — one switch, both surfaces, so a field hidden on screen cannot
 * reappear in print.
 *
 * Print carried only the second term for a day (review #16), which is exactly
 * the case the first one exists for: a legacy Barebones character whose sheet
 * hides the Omen printed one.
 *
 * Neither term looks at `system.omenEnabled` — that is the CHARACTER's own
 * switch, asked separately by each surface, and folding it in here would make
 * "this table uses omens" and "this character has one" the same question.
 * @param {CairnActor} actor
 * @returns {boolean}
 */
const omenVisible = (actor) =>
  actor?.system?.contentSource !== "barebones"
  && game.settings.get(SETTINGS_NS, "show-omens");

const mayRandomize = (fn) => function (event, target) {
  if (!this._mayRandomize()) {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.RandomizationDisabled"));
    return undefined;
  }
  return fn.call(this, event, target);
};

/**
 * Randomization gate for a slot that STARTS EMPTY.
 *
 * A question and an obligation now arrive blank and the player rolls them, so
 * the FIRST roll is not randomization at all — it is finishing the character.
 * Gating it behind the Warden's allow-player-randomization switch would leave a
 * player unable to complete a sheet the generator deliberately left unfinished.
 *
 * So: an empty slot always rolls; a filled one is a re-roll and rides the gate
 * like every other die. `data-filled` is written by the template off the same
 * `filled` flag that picks the tooltip, so the two can never disagree.
 */
const mayRandomizeUnlessEmpty = (fn) => function (event, target) {
  const filled = target?.dataset?.filled === "true";
  if (filled && !this._mayRandomize()) {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.RandomizationDisabled"));
    return undefined;
  }
  return fn.call(this, event, target);
};

const owned = (fn) => function (event, target) {
  if (!this.isEditable) {
    // SAY WHY. This used to `return undefined` in silence, which is the worst
    // possible failure for a control that looks clickable: the portrait, every
    // tab-side button and every row icon simply stopped existing, with no
    // notification, no console line and nothing to search for. A Warden with a
    // locked compendium and a Warden without permission got the identical
    // nothing, and so did a bug — an evening went into telling those apart by
    // hand (2026-08-01).
    //
    // `isEditable` has exactly two ways to be false (document-sheet.mjs:123-129):
    // the pack is locked, or this user fails `editPermission` on the document.
    // Name whichever it is, because the fix is different for each.
    const pack = this.document?.pack ? game.packs.get(this.document.pack) : null;
    // `pack.title` needs nothing — core localizes a pack LABEL per viewer
    // already (compendium-collection.mjs:46).
    ui.notifications.warn(pack?.locked
      ? game.i18n.format("CAIRN.Notify.PackLocked", { pack: pack.title ?? pack.collection })
      : game.i18n.format("CAIRN.Notify.NotEditable", { name: this.document.name ?? "" }));
    return undefined;
  }
  return fn.call(this, event, target);
};

/**
 * The actor sheet, on ApplicationV2.
 *
 * One class serves all four actor types; the template and the tab set are chosen
 * per render from `actor.type` (see _configureRenderParts / _getTabsConfig).
 *
 * Two AppV1 behaviours are re-declared rather than inherited, because
 * DocumentSheetV2 defaults them the other way and the sheet silently stops
 * working without them:
 *
 *  - `form.submitOnChange` — the whole UX is "edit a field and it sticks".
 *    AppV1's ActorSheet set this; DocumentSheetV2 defaults it to false.
 *  - `window.resizable` — AppV1's ActorSheet set it; ApplicationV2 defaults false.
 *
 * ApplicationV2 has no `submitOnClose`, so a field edited and left un-blurred is
 * no longer saved by closing the window. `submitOnChange` covers every normal
 * edit; see _processFormData for the one place that mattered.
 *
 * @extends {ActorSheetV2}
 */
export class CairnActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cairn", "sheet", "actor"],
    position: { width: 600, height: 750 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      // Header
      rollActor: owned(mayRandomize(CairnActorSheet.#onRollActor)),
      toggleGeneration: owned(mayRandomize(CairnActorSheet.#onToggleGeneration)),
      // NOT owned(): printing shows nothing the open sheet does not already
      // show this viewer, so being able to open the sheet is the whole gate.
      printSheet: CairnActorSheet.#onPrintSheet,
      // Portrait + name. editPortrait is a PICK, not a die — it stays outside
      // the randomization surface, so it wears no mayRandomize().
      editPortrait: owned(CairnActorSheet.#onEditPortrait),
      rollPortrait: owned(mayRandomize(CairnActorSheet.#onRollPortrait)),
      rollName: owned(mayRandomize(CairnActorSheet.#onRollName)),
      rollProfession: owned(mayRandomize(CairnActorSheet.#onRollProfession)),
      rollFaction: owned(mayRandomize(CairnActorSheet.#onRollFaction)),
      // The person-sheet pickers (2026-08-21): a deliberate choice, not a die,
      // but they ride mayRandomize anyway — on an npc-type sheet that helper
      // answers Warden-only, and the pickers are Warden tools by the same
      // ruling that hides the dice from players.
      pickProfession: owned(mayRandomize(CairnActorSheet.#onPickProfession)),
      pickFaction: owned(mayRandomize(CairnActorSheet.#onPickFaction)),
      // Inventory
      itemCreate: owned(CairnActorSheet.#onItemCreate),
      itemShop: owned(CairnActorSheet.#onItemShop),
      // NOT owned(): editing only OPENS the item's own sheet (a read), which
      // enforces its own edit permission. Like printSheet above, being able to
      // open this actor sheet is the whole gate — owned() wrongly refused a
      // viewer of a locked or limited-permission actor from even looking at an
      // item, warning "not editable" for a view that writes nothing here.
      itemEdit: CairnActorSheet.#onItemEdit,
      itemDelete: owned(CairnActorSheet.#onItemDelete),
      itemToggleEquipped: owned(CairnActorSheet.#onItemToggleEquipped),
      itemAddUse: owned(CairnActorSheet.#onItemAddUse),
      itemRemoveUse: owned(CairnActorSheet.#onItemRemoveUse),
      bookCast: owned(CairnActorSheet.#onBookCast),
      spellCast: owned(CairnActorSheet.#onSpellCast),
      itemDescription: CairnActorSheet.#onItemDescription,
      addFatigue: owned(CairnActorSheet.#onAddFatigue),
      removeFatigue: owned(CairnActorSheet.#onRemoveFatigue),
      rollDamage: CairnActorSheet.#onRollDamage,
      // Connections
      connectionAdd: owned(CairnActorSheet.#onConnectionAdd),
      connectionAttach: owned(CairnActorSheet.#onConnectionAttach),
      connectionDetach: owned(CairnActorSheet.#onConnectionDetach),
      containerUnlink: owned(CairnActorSheet.#onContainerUnlink),
      // Header counters + buttons
      rollAbility: CairnActorSheet.#onRollAbility,
      toggleCritical: owned(CairnActorSheet.#onToggleCritical),
      armorReset: owned(CairnActorSheet.#onArmorReset),
      rest: owned(CairnActorSheet.#onRest),
      restoreAbilities: owned(CairnActorSheet.#onRestoreAbilities),
      dieOfFate: CairnActorSheet.#onDieOfFate,
      // Description tab
      rollAge: owned(mayRandomize(CairnActorSheet.#onRollAge)),
      // The «Cumpleaños» generator, beside the Age die inside the Rasgos panel
      // (2026-09-02). Same gating as every other die on the sheet.
      rollBirthday: owned(mayRandomize(CairnActorSheet.#onRollBirthday)),
      rollOmen: owned(mayRandomize(CairnActorSheet.#onRollOmen)),
      toggleTraits: CairnActorSheet.#onToggleTraits,
      toggleScars: CairnActorSheet.#onToggleScars,
      toggleLanguages: CairnActorSheet.#onToggleLanguages,
      // Background / failed career
      rollBackground: owned(mayRandomize(CairnActorSheet.#onRollBackground)),
      pickBackground: owned(mayRandomize(CairnActorSheet.#onPickBackground)),
      rollFailedCareer: owned(mayRandomize(CairnActorSheet.#onRollFailedCareer)),
      pickFailedCareer: owned(mayRandomize(CairnActorSheet.#onPickFailedCareer)),
      rollFailedCareerItem: owned(mayRandomize(CairnActorSheet.#onRollFailedCareerItem)),
      // Notes tab — the bond/question controls live inside the template's
      // generationEnabled blocks, so they are surface too, add/remove included.
      rerollBond: owned(mayRandomizeUnlessEmpty(CairnActorSheet.#onRerollBond)),
      addBond: owned(mayRandomize(CairnActorSheet.#onAddBond)),
      removeBond: owned(mayRandomize(CairnActorSheet.#onRemoveBond)),
      rerollQuestion: owned(mayRandomizeUnlessEmpty(CairnActorSheet.#onRerollQuestion)),
    },
  };

  /**
   * Replaced per render by _configureRenderParts. Declared because
   * HandlebarsApplicationMixin validates it at construction.
   * @override
   */
  static PARTS = {};

  /** @override */
  static TABS = {
    primary: {
      tabs: [{ id: "items", label: TAB_LABELS.items }],
      initial: "items",
    },
  };

  /**
   * The tab a FRESH sheet opens on, per actor type and role. Core seeds
   * `tabGroups` from static TABS at construction (application.mjs:287-290 —
   * and its own doc says "subclasses may override this property to define
   * default tabs"), so by first render the group already holds the static's
   * "items" and `_prepareTabs`'s `??=` never consults `_getTabsConfig`'s
   * initial. Without this override a monster sheet — whose initial is
   * Description — would open standing on Items regardless. A subclass field
   * initialises after every parent constructor, so `options.document` is set.
   */
  tabGroups = { primary: initialTabId(this.options.document) };

  /* -------------------------------------------- */

  /**
   * The hireling sheet's old <form> carried a `hireling` class, which the whole
   * `.hireling …` block in css/cairn.css hangs off (the stripped name/profession/
   * day-rate stack, and HP joining the ability column). ApplicationV2 owns the
   * form element, so the class has to come from the options instead.
   *
   * Only this one type is added. Adding every type mechanically would put a bare
   * `.container` / `.character` on the window, which is exactly the kind of
   * generic class name a framework stylesheet is liable to claim.
   * @override
   */
  _initializeApplicationOptions(options) {
    const applied = super._initializeApplicationOptions(options);
    // Both non-player types share one sheet, so both need the class its layout is
    // scoped to. PREFIXED deliberately: the old name was `hireling`, which stopped
    // describing anything once npc used the same template, and a bare `.npc` is
    // exactly the generic token the note above warns about.
    if (["npc", "hireling"].includes(options.document?.type)) {
      applied.classes.push("cairn-npc-sheet");
    }
    return applied;
  }

  /**
   * One template per actor type, chosen at render. `static PARTS` cannot vary by
   * document, so this is the hook for it. The shared partials must be declared
   * so HandlebarsApplicationMixin preloads them.
   * @override
   */
  _configureRenderParts(_options) {
    // `hireling` renders the NPC sheet: the two types are one thing now (see
    // ACTOR_DATA_MODELS), so there is one template rather than two that had to be
    // kept in step by hand.
    const t = this.actor.type === "hireling" ? "npc" : this.actor.type;
    return {
      form: {
        template: `systems/mondolme/templates/actor/${t}-sheet.html`,
        templates: [
          "systems/mondolme/templates/parts/items-list.html",
          "systems/mondolme/templates/parts/container-list.html",
          "systems/mondolme/templates/parts/bio-block.html",
        ],
      },
    };
  }

  /**
   * The tab set varies by actor type: a character carries Trasfondo, nobody
   * else does.
   *
   * The Connections tab that used to come and go with `showContainersTab` is
   * GONE (2026-09-02) — the list is a section inside Links & Notes now, and
   * that section carries the same gate. Nothing filters the id list any more,
   * but the vanished-tab reset below stays MANDATORY: it is what catches a
   * character sheet re-rendering onto a tab set that no longer holds the tab
   * the window is standing on (a re-typed document, or this very edit meeting a
   * sheet left open on `containers`).
   * @override
   */
  _getTabsConfig(group) {
    const config = foundry.utils.deepClone(super._getTabsConfig(group));
    if (!config) return config;
    const ids = TAB_IDS[this.actor.type] ?? ["items"];
    config.tabs = ids.map((id) => ({ id, label: TAB_LABELS[id] }));
    // The group's initial is ROLE-aware (`initialTabId`), not the static TABS
    // default ("items") and not blindly the list head: a person-role sheet and
    // a character open on Items, a monster on Description. The vanished-tab
    // reset below lands on the same answer.
    const initial = initialTabId(this.actor);
    config.initial = ids.includes(initial) ? initial : (ids[0] ?? config.initial);
    // THE GUARD. `_prepareTabs` only defaults the group when it is unset
    // (`??=`), so without this the group keeps pointing at a tab that is no
    // longer rendered and NO panel is active — a blank sheet body with no
    // error. Every tab added or removed anywhere in this file relies on it.
    if (!ids.includes(this.tabGroups[group])) this.tabGroups[group] = config.initial;
    return config;
  }

  /**
   * Rows are dragged to reorder an inventory or to hand an item to another actor.
   * ActorSheetV2 hardcodes `.draggable` with no dropSelector, so the whole
   * application is the drop zone (which is what we want) but the drag selector
   * has to be replaced. Overriding the getter is preferable to adding a
   * `draggable` class to every row — that class carries Foundry styling of its own.
   * @override
   */
  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: ".cairn-items-list-row",
      permissions: {
        dragstart: this._canDragStart.bind(this),
        drop: this._canDragDrop.bind(this),
      },
      callbacks: {
        dragstart: this._onDragStart.bind(this),
        dragover: this._onDragOver.bind(this),
        drop: this._onDrop.bind(this),
      },
    });
  }

  #dragDrop = null;

  /**
   * Rows whose description panel is open, by `data-item-id` (an item id, or a
   * connected actor's uuid for a container row).
   *
   * SHEET state, not document state, so it lives on the instance and dies with
   * it. It has to live SOMEWHERE, though: until 2026-08-19 it lived only in the
   * DOM, and `submitOnChange` re-runs `_prepareContext` on every committed
   * keystroke, so editing a quantity three rows down closed the description you
   * had opened to read while editing it. Core has no facility for this —
   * foundryvtt/foundryvtt#12063 asked for one and was closed — which makes it
   * the application's job rather than a gap to work around.
   */
  #expandedRows = new Set();

  /* -------------------------------------------- */

  /**
   * Roll Character and the Randomization toggle, INLINE in the title bar.
   *
   * These were briefly `window.controls`, which is the tidier declaration — but
   * v14 renders controls into the ⋮ dropdown only (`_renderHeaderControl` builds
   * `<li>` elements for a ContextMenu), and burying a control the Warden uses
   * every session behind a menu is a downgrade from what AppV1 showed. Frame
   * buttons are the supported way back: core's own `_getFrameButtons`
   * (`api/application.mjs:738`) renders straight into `.window-header`, and
   * `DocumentSheetV2` already ships two of them (Copy UUID, Import).
   *
   * Two consequences, both handled rather than lived with:
   *
   *  - Frame buttons are built in `_renderFrame`, which runs ONLY on first
   *    render. So state cannot be expressed by re-returning a different array
   *    the way header controls could — #syncGenerationButtons keeps them in
   *    step on every render instead. That is a far cry from AppV1's surgery
   *    (which rewrote the header's innerHTML and had to namespace jQuery events
   *    to stop handlers stacking): these are elements we created once, and only
   *    their label, icon and hidden state move.
   *  - There is no `ownership` filter on frame buttons, unlike header controls,
   *    so the ownership gate is explicit below.
   *
   * `show-generate-header` is `requiresReload: true`, so reading it once at
   * frame time is correct — it cannot change under an open sheet.
   * @override
   */
  _getFrameButtons(options) {
    const buttons = super._getFrameButtons(options);

    // Pop Out is a shortcut to the ⋮ menu's Detach, which opens the sheet in its
    // own browser window. `detach` is CORE's action (application.mjs:72, :86) —
    // this only surfaces it, so there is no behaviour of ours to get wrong.
    // Every actor type gets it and it is NOT gated by `show-generate-header`:
    // it is a plain window control with nothing to do with generation, and
    // hiding it behind that setting would be arbitrary.
    const popOut = { action: "detach", icon: "fas fa-arrow-up-right-from-square", label: "CAIRN.PopOut" };

    const isChar = this.actor.type === "character";
    // Print — EVERY sheet (2026-08-11, the third ruling in the chain:
    // characters only → people and monsters the same day → all, because the
    // user had forgotten Wardens print a container's cargo list too). A
    // thing's PAGE differs — cargo, no statblock, see #fillPrintPage — but
    // the button no longer has a role test, so #syncGenerationButtons no
    // longer syncs it. NO ownership gate, deliberately: the page renders
    // exactly what the sheet already shows this viewer, so being able to
    // open the sheet IS the gate — which is exactly why a LIMITED viewer
    // loses it (2026-08-21): their sheet shows portrait, name and description,
    // and the print page would hand them the statblock the limited view
    // exists to withhold. Frame-time is fine — per-viewer ownership cannot
    // change under that viewer's own open sheet without a re-render anyway,
    // and the handler repeats the test for the crafted-client case.
    const print = this.document.limited ? []
      : [{ action: "printSheet", icon: "fas fa-print", label: "CAIRN.Print" }];

    // npc and hireling are one thing, so both get the NPC generation controls.
    const isNpc = ["hireling", "npc"].includes(this.actor.type);
    // Thing roles — companion, transport, container — get NEITHER button (ruled
    // 2026-08-02): there is nothing to randomize about a cart, so a Roll
    // button and a Randomization readout are noise on its title bar. Only a
    // PERSON (either role since the 2026-08-20 split) or a monster generates.
    // The role can change under an open sheet and the frame builds once, so
    // #syncGenerationButtons applies the same test per render to the buttons
    // this frame did build.
    const rollableRole = !isNpc || GENERATING_ROLES.includes(this.actor.npcRole);
    // Print sits to the RIGHT of Pop Out (user ruling 2026-08-08).
    if (!(isChar || isNpc) || !rollableRole || !this.actor.isOwner) return [popOut, ...print, ...buttons];

    // The toggle is created UNCONDITIONALLY for an owner of a generating type,
    // and only the Roll button rides `show-generate-header`. It used to gate
    // both — harmless while generationEnabled defaulted true, but the toggle
    // is the ONLY user-reachable writer of that flag, and with the default now
    // OFF, hiding it would make Off permanent for the whole world: a hard lock
    // behind a display setting. Roll is also hidden in place (never omitted)
    // while Randomization is off, so the toggle can reveal it without
    // rebuilding the frame — which first render is the only chance to do.
    const showRoll = game.settings.get(SETTINGS_NS, "show-generate-header");
    return [
      // Character → "Roll Character"; NPC → "Roll NPC"; Monster → "Roll
      // Monster" with the Generate Monster button's dragon. The face also
      // follows role changes per render — #syncGenerationButtons.
      ...(showRoll ? [{
        action: "rollActor",
        icon: this.actor.npcRole === "monster" ? "fas fa-dragon" : "fas fa-dice-d6",
        label: this.actor.npcRole === "monster" ? "CAIRN.RollMonster"
          : isNpc ? "CAIRN.RollNpc" : "CAIRN.RegenerateCharacter",
      }] : []),
      { action: "toggleGeneration", icon: "fas fa-toggle-on", label: "CAIRN.RandomizationOn" },
      popOut,
      // To the RIGHT of Pop Out (user ruling 2026-08-08).
      ...print,
      ...buttons,
    ];
  }

  /* -------------------------------------------- */

  /**
   * Give our two frame buttons visible text.
   *
   * `templates/generic/frame-buttons.hbs` renders icon-only buttons and puts the
   * label in `aria-label`, which is right for Foundry's own (Copy UUID, Import)
   * and wrong for these: "Randomization: On" is a STATE READOUT, and a readout
   * you have to hover to read is not a readout. So the labels are added after
   * core has built the frame — decorating elements core owns, not replacing its
   * template.
   * @override
   */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    for (const action of ["rollActor", "toggleGeneration", "detach", "printSheet"]) {
      const button = frame.querySelector(`.window-header button[data-action="${action}"]`);
      if (!button) continue;
      // The template puts the glyph on the BUTTON as classes and leaves it
      // empty. Text needs the glyph in a child instead, so move it.
      const glyph = [...button.classList].filter((c) => c === "fas" || c.startsWith("fa-"));
      button.classList.remove(...glyph, "icon");
      button.classList.add("cairn-header-button");
      const icon = document.createElement("i");
      icon.className = glyph.join(" ");
      // A tooltip that repeats text already on screen is noise. `data-tooltip`
      // is valueless in the template and falls back to aria-label, so drop it.
      button.removeAttribute("data-tooltip");
      button.append(icon, document.createTextNode(button.getAttribute("aria-label") ?? ""));
    }

    // Send the ⋮ menu to the right-hand end, next to ✕.
    //
    // It is not a frame button — `_renderFrame` writes it into the header's
    // static markup between the title and ✕ (application.mjs:848-850), and
    // `_renderFrameButtons` then inserts everything else `beforebegin` of ✕
    // (:887). So anything we add necessarily lands to its RIGHT, leaving ⋮
    // stranded at the front of a row of labelled buttons.
    //
    // Its ContextMenu is bound by selector to the application root
    // (application.mjs:1887), and `#window.controls` holds this element, so
    // moving the node breaks neither.
    const header = frame.querySelector(".window-header");
    const controls = header?.querySelector('button[data-action="toggleControls"]');
    const close = header?.querySelector('button[data-action="close"]');
    if (controls && close) close.before(controls);

    this.#syncGenerationButtons(frame);
    return frame;
  }

  /* -------------------------------------------- */

  /**
   * Hide Pop Out once the sheet is already popped out, and bring it back when it
   * re-docks.
   *
   * Detaching does NOT re-render — `render()` short-circuits to `#move`
   * (application.mjs:537) — so `_onRender` never fires and the button cannot
   * update itself the way the Randomization toggle does. `_updateFrame` looks
   * like the answer and is not: `#move` calls it BEFORE the async
   * window-opening work that sets `window.windowId`, so `_canDetach()` still
   * reads true at that point and the button stays visible. Measured, not
   * assumed — that was the first attempt.
   *
   * These two are the hooks core fires once the move has actually happened
   * (application.mjs:1323, :1427).
   *
   * Re-docking itself stays in the ⋮ menu, where core puts Attach and keeps it
   * correct; a frame button is built once and cannot follow.
   * @override
   */
  _onDetach(from, to) {
    super._onDetach(from, to);
    this.#syncPopOut();
  }

  /** @override */
  _onAttach(from, to) {
    super._onAttach(from, to);
    this.#syncPopOut();
  }

  /**
   * Show Pop Out exactly when core would offer Detach in the ⋮ menu, using
   * core's own predicate rather than a second opinion about what "detached"
   * means.
   */
  #syncPopOut() {
    this.element?.querySelector('.window-header button[data-action="detach"]')
      ?.classList.toggle("cairn-header-hidden", !this._canDetach());
  }

  /* -------------------------------------------- */

  /**
   * May THIS viewer use the randomization surface — the title-bar toggle, the
   * Roll button and the per-line re-roll dice? The Warden always may; players
   * only while the allow-player-randomization switch is on (flipped live by
   * its shipped macro). ONE helper for all its read sites — the frame-button
   * sync, both generationEnabled context derivations, and the mayRandomize()
   * action wrapper that guards every surface handler — so the affordance and
   * the enforcement cannot disagree.
   */
  _mayRandomize() {
    if (game.user.isGM) return true;
    // On an npc-type sheet the whole randomization surface — dice, pickers,
    // both frame buttons — is the Warden's alone (user ruling 2026-08-21): a
    // player who owns a hireling must never see its dice, whatever the
    // allow-player-randomization switch says. That switch keeps meaning what
    // it always meant, but only for player CHARACTERS.
    if (["npc", "hireling"].includes(this.actor.type)) return false;
    return game.settings.get(SETTINGS_NS, "allow-player-randomization");
  }

  /**
   * Keep the two title-bar buttons in step with generation mode: the toggle's
   * own label and icon, and whether Roll Character is showing at all — hiding it
   * while Randomization is off is that toggle's entire purpose.
   *
   * Called from both `_renderFrame` (first paint) and `_onRender` (every
   * subsequent one), because the frame is built once and the content many times.
   * @param {HTMLElement} [root] The frame, when it is not yet `this.element`.
   */
  #syncGenerationButtons(root = this.element) {
    // Print is deliberately NOT synced here since 2026-08-11: every type and
    // role prints, so there is no role test left to re-apply per render.
    const roll = root?.querySelector('.window-header button[data-action="rollActor"]');
    const toggle = root?.querySelector('.window-header button[data-action="toggleGeneration"]');
    if (!roll && !toggle) return;
    // A person re-typed into a mount under an open sheet must LOSE the
    // buttons its frame already built — the frame renders once, so the
    // per-render role test lives here, mirroring _getFrameButtons. (The other
    // direction — a mount re-typed into a person — gets its buttons on the
    // next sheet open; a frame cannot grow buttons it never built.)
    const thing = ["hireling", "npc"].includes(this.actor.type)
      && !GENERATING_ROLES.includes(this.actor.npcRole);
    // The Warden's allow-player-randomization switch: a player loses BOTH
    // buttons while it is off (the setting's onChange re-renders open sheets,
    // which is what brings this sync back around live). Same per-render shape
    // as the role test — the frame builds once.
    const denied = !this._mayRandomize();
    toggle?.classList.toggle("cairn-header-hidden", thing || denied);
    const on = this.actor.system.generationEnabled !== false;
    roll?.classList.toggle("cairn-header-hidden", !on || thing || denied);
    // The Roll button's face follows the ROLE: a monster re-rolls through the
    // tier picker and wears the Generate Monster button's dragon, so the
    // button says what the click does. The role can change under an open
    // sheet and the frame cannot rebuild, so the swap lives here with the
    // rest of the per-render state.
    if (roll) {
      const monster = this.actor.npcRole === "monster";
      const rollLabel = game.i18n.localize(
        monster ? "CAIRN.RollMonster"
          : ["hireling", "npc"].includes(this.actor.type) ? "CAIRN.RollNpc" : "CAIRN.RegenerateCharacter");
      roll.setAttribute("aria-label", rollLabel);
      roll.lastChild.textContent = rollLabel;
      const icon = roll.querySelector("i");
      if (icon) icon.className = monster ? "fas fa-dragon" : "fas fa-dice-d6";
    }
    if (!toggle) return;
    const label = game.i18n.localize(on ? "CAIRN.RandomizationOn" : "CAIRN.RandomizationOff");
    toggle.setAttribute("aria-label", label);
    toggle.lastChild.textContent = label;
    toggle.querySelector("i")?.classList.replace(
      on ? "fa-toggle-off" : "fa-toggle-on",
      on ? "fa-toggle-on" : "fa-toggle-off"
    );
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.actor = this.actor;
    // Whether this user can DELETE a connected actor. Foundry gates Actor
    // deletion by ROLE (Assistant+, and isGM is exactly role >= ASSISTANT) with
    // no player-grantable permission — so a player's trash icon on the
    // Connected tab was an affordance for an action the server always refuses
    // (review #5). The template hides it; unlink and edit remain theirs.
    context.canDeleteActors = game.user.isGM;
    // Manual edge management (Connect / unlink) opened to players on
    // 2026-08-01: the Warden always, else the owner of both ends. THIS half
    // of the pair gates the sheet-level controls, so it asks about the sheet
    // actor only; the per-row/per-target half lives on each row below and in
    // the pickers' filters. Distinct from canDeleteActors, which surfaces a
    // Foundry ROLE gate (Actor deletion is Assistant+, no player-grantable
    // permission) and stays isGM — the reason the two were never one flag.
    context.canManageConnections = game.user.isGM || this.actor.isOwner;
    // The Warden's switch for player shopping (allow-player-marketplace, the
    // shipped macro's setting). Both sheet templates pass this straight into
    // the items-list partial's withShop — it was a hardcoded 1 there until the
    // switch existed. Hiding the button is the affordance; acquire() refusing
    // is the enforcement (the marketplace's own greying/refusal doctrine), so
    // a sheet left open across a flip still cannot buy. GM always shops.
    context.withShop = game.user.isGM || game.settings.get(SETTINGS_NS, "allow-player-marketplace");
    // Per-window id prefix for label[for]/input[id] pairs. Templates hardcoded the
    // field path as the DOM id ("system.gold"), so every open sheet of a type used
    // the SAME ids — and `label[for]` resolves against the first match in tree
    // order, so with two sheets open a click on the second sheet's label toggled
    // the FIRST sheet's checkbox, which submitOnChange then saved. DocumentSheetV2
    // already computes a unique id per window as `rootId`.
    context.idp = context.rootId;

    // Live model, not `toObject(false)`: a TypeDataModel resolves that against the
    // SCHEMA, so prepareData's derived values (slotsUsed, slotsMax, encumbered,
    // armor, coinsPerSlot, containerObjects, goldSlots, showBio…) never reach the
    // template and each renders blank with no error anywhere. Spreading the live
    // model yields stored + derived together as one plain object.
    //
    // Plain COPIES, deliberately: the content-localization pass below rewrites
    // item names and descriptions for display, and must never touch the documents.
    context.system = { ...this.actor.system };
    // Recomputed at RENDER time, not taken from prepareDerivedData.
    //
    // The Connected list is derived from other actors' `connectedTo`, and nothing
    // re-prepares THIS actor when a different one is created, connected or
    // deleted — Foundry only re-prepares the document that changed. So the
    // prepared copy goes stale the moment a background grants a mount or a
    // purchase lands, and the tab shows the previous state until something else
    // happens to touch the owner. Rebuilding it here costs one pass over
    // game.actors per render and cannot be stale by construction.
    context.system.containerObjects = this.actor.connectedActors();
    // The Connections rows, decorated with what THIS user may do to each —
    // unlink needs both ends (the sheet actor and the row's), so it is a
    // per-row fact no single context flag can carry. The template iterates
    // these; containerObjects above stays because other derived surfaces
    // (slot math, worn rows) still read it.
    context.connectionRows = context.system.containerObjects.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      slotsUsed: c.system.slotsUsed,
      slots: c.system.slots,
      canUnlink: game.user.isGM || (this.actor.isOwner && c.isOwner),
      // What this actor IS to the character keeping it, from the CHILD's role
      // — the same sentence the child's own sheet header prints, through the
      // same helper, so the two surfaces cannot drift (they were one ruling).
      role: c.npcRole,
      relationship: relationshipLabel(c.npcRole, this.actor.name),
    }));
    // ...grouped by relationship, with a heading apiece (2026-09-02, user
    // ruling): a flat list of ten said nothing about which of them travel with
    // you and which of them merely owe you a favour. An EMPTY group does not
    // render, and the group a role falls into is `relationshipGroupFor` — the
    // three named ones plus a catch-all for a monster, a transport or a
    // container, whose rows carry no relationship line at all.
    context.connectionGroups = RELATIONSHIP_GROUPS
      .map((g) => ({
        key: g.key,
        heading: game.i18n.localize(g.heading),
        rows: context.connectionRows.filter((r) => relationshipGroupFor(r.role) === g.key),
      }))
      .filter((g) => g.rows.length);
    // ...and the keeper line's break link, same rule from the child's end. A
    // DANGLING keeper (uuid resolving to nothing) has no other end left to
    // own, so the child's owner suffices — that detach is the only recovery
    // the child has.
    const keeperLink = this.actor.system.connectedTo || "";
    const keeperDoc = keeperLink ? game.actors.find((a) => a.uuid === keeperLink) : null;
    context.canDetach = game.user.isGM
      || (this.actor.isOwner && (keeperDoc ? keeperDoc.isOwner : true));
    // Role-driven pick-lists for the NPC sheet header. The Kind list is the
    // CONTAINER_CLASSES table filtered to the current role, so a class added
    // there appears here with nothing else to keep in step; the input itself
    // stays free text — a Warden's own word is a legal Kind.
    if (["npc", "hireling"].includes(this.actor.type)) {
      const role = this.actor.npcRole;
      context.roleChoices = Object.fromEntries(NPC_ROLES.map((r) => [
        r, game.i18n.localize(`CAIRN.Role${r.charAt(0).toUpperCase()}${r.slice(1)}`),
      ]));
      // The job field is ONE row wearing two names (2026-08-20): a hireling has
      // a Career off the 2e careers catalogue, an NPC a Background off the
      // Warden's Guide table. Mutually exclusive on purpose — the template
      // renders one row and one die, so the two can never be shown together and
      // never drift into looking like different controls.
      context.showCareer = role === "hireling";
      context.showBackground = role === "npc";
      // FOR HIRE IS EVERY PERSON'S BOX (2026-09-02, user ruling, reversing the
      // 2026-08-20 "NPCs do not need the For Hire or Day Rate fields"): an
      // innkeeper who will guide the party for 3gp a day is an NPC with a
      // price, and the day rate follows the CHECKBOX rather than the role.
      // A monster, a companion, a cart or a crate gets neither control —
      // `forHire`'s schema initial is TRUE, so every one of them silently
      // stores a ticked box, and the role gate is what keeps that unread.
      //
      // Derived on the document (actor.js `showForHire`/`showDayRate`), where
      // the day rate's gate already lived, so the box and the rate cannot
      // disagree about who is a person. Mirrored onto the context because the
      // template's own `showForHire` predates the derivation.
      //
      // Separate from showCareer: the career row is a FIELD, this is a
      // mechanic, and the template must be able to move one without the other.
      // The stored boolean is never cleared — a re-roled actor gets its old
      // answer back, like every other field the roles do not share.
      context.showForHire = this.actor.system.showForHire === true;
      // Faction shows for anyone who can take sides — either person OR a
      // monster; things have no politics. It used to ride the Career gate,
      // which is why Monsters never saw it: a job is a person's, and a monster
      // has a side without one.
      context.showFaction = GENERATING_ROLES.includes(role);
      context.showKind = ["companion", "transport", "container"].includes(role);
      // The Type select's rows: the CONTAINER_CLASSES table filtered to the
      // current role, so a class added there appears here with nothing else to
      // keep in step. STRICT since 2026-08-02 — the free-text input lives
      // behind the select's "Other…" row, disabled otherwise so submitOnChange
      // never carries a stale word (a disabled control is excluded from
      // FormData). A stored word the table does not know (a legacy custom
      // Kind, or one just typed) selects Other and prefills the input.
      const cls = this.actor.system.containerClass;
      context.kindOptions = Object.entries(CONTAINER_CLASSES)
        .filter(([, v]) => v.role === role)
        .map(([key, v]) => ({ key, label: game.i18n.localize(v.label), selected: key === cls }));
      context.kindIsCustom = !!cls && !CONTAINER_CLASSES[cls];
      context.kindCustomValue = context.kindIsCustom ? cls : "";
      context.professionDisplay = this.actor.system.profession;
      context.backgroundDisplay = this.actor.system.background;
      // `notesTabLabel` lived here and is RETIRED (2026-09-02): both sheets
      // read one static key, CAIRN.LinksAndNotes, straight from their nav. The
      // per-role split it carried ("Notes" on an NPC against the character's
      // "Background & Notes") had nothing left to distinguish once the two tabs
      // merged under one name.
      // The connection line under the header (2026-08-02): the child end's ONE
      // upward edge, expressed as a field rather than a tab — any child role
      // has at most one keeper, so the Connections tab this sheet used to carry
      // could only ever count (0) or (1). Built HERE, at render time, because
      // the label names the KEEPER and nothing re-prepares this document when
      // the keeper is renamed — the prepareDerivedData copy it replaces went
      // stale until something else touched this actor.
      //
      // Label sense is RULED BY THE ROLE since 2026-09-02: the line says what
      // this actor IS to its keeper — "Contacto de X", "Compañero de X",
      // "Contratado por X" — through `relationshipLabel`, THE SAME helper the
      // keeper's own Vínculos list prints beside this actor's name. That was
      // the ask: one sentence, two surfaces, kept in step by having one
      // builder. A monster, a transport or a container has no such word, so
      // those keep the plain "Conectado a: X" this line has always shown.
      //
      // It replaces a `forHire`-driven "Hired by": a hireling is now hired by
      // its ROLE, and reading the checkbox here made the label flicker every
      // time a Warden took somebody off the market.
      //
      // Parked (2026-08-09): with the Connections UI off, the line never gains
      // a label or a control — but it still RENDERS for a person, because
      // showConnectionLine's showForHire arm below is what keeps the For Hire
      // checkbox on screen, and For Hire is the day-rate mechanic, not
      // connections. The builder is skipped, not the line.
      if (!connectionsUiEnabled()) {
        // no connectionLine
      } else if (keeperDoc) {
        context.connectionLine = {
          label: relationshipLabel(role, keeperDoc.name)
            ?? game.i18n.format("CAIRN.ConnectedToNamed", { name: keeperDoc.name }),
          detach: context.canDetach,
        };
      } else if (keeperLink) {
        // A DANGLING link (keeper deleted, uuid resolving to nothing): the
        // child-end detach is the only recovery it has — single-parent-ever
        // refuses to reconnect over it — so the line must surface the break
        // control rather than render nothing.
        context.connectionLine = {
          label: game.i18n.localize("CAIRN.ConnectedToMissing"),
          detach: context.canDetach,
        };
      } else if (this.actor.system.formerlyBelongedTo) {
        context.connectionLine = {
          label: game.i18n.format("CAIRN.FormerlyBelongedTo",
            { name: this.actor.system.formerlyBelongedTo }),
          attach: this.actor.canBeConnected && context.canManageConnections,
        };
      } else if (this.actor.canBeConnected) {
        context.connectionLine = { attach: context.canManageConnections };
      }
      // The line renders whenever it has something to say — and ALWAYS for a
      // PERSON, whose For Hire checkbox lives on it and must stay visible while
      // unticked (the deadlock lesson: never hidden by anything it hides). It
      // follows the checkbox, which is back to both person roles as of
      // 2026-09-02; a monster or a thing with the Connections UI parked has
      // nothing at all to put in the line, so it is not drawn.
      context.showConnectionLine = context.showForHire
        || !!(context.connectionLine
          && (context.connectionLine.label || context.connectionLine.attach));
    }
    let items = this.actor.items.map((i) => ({
      _id: i.id,
      name: i.name,
      type: i.type,
      img: i.img,
      sort: i.sort,
      system: { ...i.system },
    }));

    // `_sortItemsForDisplay` sorts on the same display copy the render below
    // produces (Fatigue's UI label included) and is the SAME helper the printed
    // page uses, so the two cannot drift.
    items = this._sortItemsForDisplay(items);

    // Fatigue is STORED in English (see FATIGUE_NAME) so its identity survives a
    // mixed-language table. Its label is localized here, at display time, from the
    // UI key every language file already carries — so a Spanish player still reads
    // "Fatiga" without the stored document ever being translated.
    const fatigueLabel = game.i18n.localize("CAIRN.Fatigue");
    context.items = items.map((i) => (i.name === FATIGUE_NAME ? { ...i, name: fatigueLabel } : i));

    // The magic row affordances. Character-only: the cast belongs to the
    // carrier, and a pile holding a recovered book offers it to nobody.
    // Everything here is display annotation on the context copies — the
    // ENFORCEMENT lives in the handlers and module/magic.js, which re-derive it.
    //
    /* The transmute affordance (`canTransmute`) stood here and went with the
       bound-page machinery — there is no "write this scroll into the book"
       gesture, because a Libro's three pages are its own fields, typed on its
       own sheet. */
    if (this.actor.type === "character") {
      // EVERY Libro gets its own control, keyed on its own id — the `[0]` guess
      // that offered the cast on the first book only is gone, and with it the
      // question of which book "the" control meant. Two conditions, both
      // re-derived in castFromBook: the book has at least one written page, and
      // the carrier can READ it (module/magic.js `canReadBook` — a book in a
      // language this character does not know is a closed book).
      const castable = new Map(booksOn(this.actor).map((b) =>
        [b.id, canReadBook(b, this.actor) && bookPages(b).length > 0]));
      context.items = context.items.map((i) => {
        // A HECHIZO casts itself, with no book at all; a PERGAMINO is the same
        // cast with a confirmation in front and the paper destroyed after. A
        // scroll generated already-spent is excluded — there is nothing left on
        // the page to read.
        if (i.type === "spell") {
          const ok = !i.system.scroll || (i.system.uses?.value ?? 0) > 0;
          return ok ? { ...i, system: { ...i.system, canCastSpell: true } } : i;
        }
        if (i.type === "book" && castable.get(i._id)) {
          return { ...i, system: { ...i.system, canCast: true } };
        }
        return i;
      });
    }

    // The npc sheet's description editor is TOGGLED (npc-sheet.html), so this is
    // its light-DOM DISPLAY half: translated via monster.desc — the namespace the
    // extractor files EVERY actor doc's description under, mounts and containers
    // included, hence type-keyed for both npc and the hireling alias — and
    // enriched, so @UUID links render as links. The editor's `value` attribute
    // stays the raw stored English; activation swaps this copy out for it
    // (prosemirror-editor.mjs:204), so nothing translated can reach a submit.
    //
    // This block once also computed enrichedBiography and enrichedNotes — and an
    // untranslated enrichedDescription for characters — all four consumed by NO
    // template (the review that caught it: three awaited enrichHTML passes per
    // committed keystroke, for nothing, while the monster.desc translation they
    // were meant to carry never displayed anywhere). enrichedNotes is BACK since
    // 2026-08-02 with a consumer this time: both Notes editors are toggled now
    // (user ask), and a toggled editor needs a display half. The character
    // sheet's copy is built in _prepareCharacterContext.
    if (["npc", "hireling"].includes(this.actor.type)) {
      // cleanDescription AFTER enrich (utils.js): the enriched string reaches
      // innerHTML via {{{ }}}, and a player owns the browser that writes
      // system.description — an injected data-action/name/on* would otherwise
      // ride the enriched output into the viewer's sheet. Enricher output
      // (content-link/inline-roll) carries no data-action, so the strip is safe.
      context.enrichedDescription =
        cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(
          this.actor.system.description,
          { relativeTo: this.actor },
        ));
      // Enriched but NOT translated: notes are the Warden's own prose, and no
      // content namespace files them.
      context.enrichedNotes =
        cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(
          this.actor.system.notes,
          { relativeTo: this.actor },
        ));
      // The Notes empty-state hint lives in the display half now — a ::before
      // anchored to .editor-container is no use, because a toggled editor only
      // grows that container on activation. Monster wording on
      // a monster via a DISTINCT key, not a _wording() variant: that helper
      // keys on type (a monster is type npc) and its has() lookup carries the
      // documented un-translation hazard (#onRollActor's precedent).
      context.notesPlaceholder = game.i18n.localize(
        this.actor.npcRole === "monster" ? "CAIRN.NotesPlaceholderMonster" : "CAIRN.NotesPlaceholder");
      // The Description editor got the same hint on 2026-08-20 (user: it "does
      // not show up until you hover over it"). ONE key, deliberately not the
      // notes pair's role branch: this sheet serves six roles and the other
      // four are a cart, a crate, a mount and a monster, so any wording that
      // names what it is describing is wrong for most of them.
      context.descriptionPlaceholder = game.i18n.localize("CAIRN.DescriptionPlaceholder");
    }

    context.nameDisplay = this.actor.name;

    if (this.actor.type === "character") await this._prepareCharacterContext(context);

    // Non-player actors reuse the character's STR/DEX/WIL/HP behaviour and
    // tooltips, but none of the background/traits/bonds machinery. npc is here
    // too now that it shares the sheet — without it the per-field dice and the
    // ability tooltips were simply absent on an NPC.
    if (["hireling", "npc"].includes(this.actor.type)) {
      this._computeStatContext(context);
      // Same random-generation switch as a character: gates the per-field dice
      // (name, profession, portrait). Role-gated since 2026-08-02: a thing
      // (mount, transport, container) has no generation surface at all, and
      // with its frame buttons gone (_getFrameButtons) a stored `true` from
      // an earlier toggle would otherwise keep live dice with no way left to
      // turn them off. Render-only — the stored flag is untouched.
      context.generationEnabled = GENERATING_ROLES.includes(this.actor.npcRole)
        && this.actor.system.generationEnabled !== false
        // ...and never for a player while the Warden's switch is off — the
        // whole surface goes, not just the title-bar toggle (ruled 2026-08-09).
        && this._mayRandomize();
      // The pickers ride the SAME Randomization toggle as the dice (2026-08-21
      // pm, user ask — REVERSING that morning's ruling, which kept them
      // available with the toggle off): "only available when Randomization is
      // toggled ON". So this is generationEnabled narrowed to person roles,
      // because Career, Background and Faction are the person rows — a
      // monster keeps its faction die but has never had the picker. Still
      // Warden-only on this sheet type via generationEnabled's _mayRandomize
      // term, and the character sheet needs no counterpart: its pickers
      // always sat inside the template's generationEnabled blocks.
      context.canPickGeneration = context.generationEnabled
        && PERSON_ROLES.includes(this.actor.npcRole);
      // LIMITED view (2026-08-21): portrait, name, description — nothing else.
      // `document.limited` is core's own "highest ownership is exactly LIMITED",
      // so the Warden and any observer-or-better viewer never see this branch.
      context.limitedView = this.document.limited;
      // A PERSON gets the character's biography block — pronouns, age, the
      // traits, scars — on the Description tab (2026-08-01). EITHER person role
      // since the 2026-08-20 split: a monster, companion, transport or
      // container has no pronouns, and showBiography false keeps the whole
      // partial out of the render. Omen stays a player-character thing — it is
      // the youngest PARTY member's burden, and no npc is one.
      context.showBiography = PERSON_ROLES.includes(this.actor.npcRole);
      if (context.showBiography) {
        await this._prepareBiographyContext(context);
        context.showScars = true;
        context.showAge = true;
        context.showOmen = false;
      }
    }

    // Tooltips that have an NPC wording must resolve through `_wording` like the
    // dialogs do. npc-sheet.html used to hardcode `CAIRN.DeprivedTipNpc`, which
    // bypassed the rule entirely and so stayed English in every language no matter
    // what a translator did — while the Panicked tooltip beside it, which has no
    // variant, was translated. Resolving here keeps ONE rule and lets the template
    // stay dumb.
    context.deprivedTipKey = this._wording("CAIRN.DeprivedTip");
    context.panickedTipKey = this._wording("CAIRN.PanickedTip");
    return context;
  }

  /**
   * Order an item list the way the inventory tab renders it, so the sheet and the
   * printed page cannot drift (review #12: print built rows in insertion order
   * while the sheet sorted). Manual `sort` when drag-to-reorder is on, else
   * alphabetical by DISPLAY name (localeCompare in the reader's language),
   * equipped first, Fatigue last. Fatigue's label comes from the UI key,
   * matching `_prepareContext`. Returns a copy; the source array is never
   * mutated.
   * @param {Item[]} items
   * @returns {Item[]}
   */
  _sortItemsForDisplay(items) {
    const displayNameOf = (i) =>
      i.name === FATIGUE_NAME ? game.i18n.localize("CAIRN.Fatigue") : i.name;
    const byDisplayName = (a, b) =>
      displayNameOf(a).localeCompare(displayNameOf(b), game.i18n.lang);
    const sorted = [...items];
    // Manual order, always (the `enable-inventory-reorder` gate retired
    // 2026-08-22, user ruling): honour each item's stored `sort` — Foundry's
    // native field, written by the drag-to-reorder handler and by the
    // generators' orderGrantedItems — falling back to display name. Fatigue is
    // NOT forced last; the player controls placement. The retired off-path
    // sorted equipped-first alphabetical with Fatigue last.
    sorted.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || byDisplayName(a, b));
    return sorted;
  }

  /**
   * Window title: "<Role>: <name>" for anything role-bearing, core's
   * "<type label>: <name>" for a character.
   *
   * The ROLE is the prefix (2026-08-02, user ask): "Non-Player Character:
   * Albino Tusks…" said the least informative thing twice and truncated the
   * name for it — "Monster: Albino Tusks Creature" / "Mount: Bucephalus" is
   * what the sheet body already says in the Role select.
   * es note: the CAIRN.Role* value keys are untranslated in es,
   * so a Spanish title shows the English role word — consistent with its Role
   * dropdown today; translator-handoff item.
   * @override
   */
  get title() {
    if (this.actor.type === "character") return super.title;
    const role = this.actor.npcRole;
    if (role) {
      const key = `CAIRN.Role${role.charAt(0).toUpperCase()}${role.slice(1)}`;
      return `${game.i18n.localize(key)}: ${this.actor.name}`;
    }
    return super.title;
  }

  /**
   * Repaint the window title when the ROLE changes, not only the name.
   *
   * Core refreshes the title on exactly one condition — the update diff carries
   * `name` (`api/document-sheet.mjs:163-166`) — which is right for a title that
   * is the document's name and wrong for the one above, where the leading word
   * is derived from `npcRole`. Re-typing a person into a monster under an open
   * sheet left "NPC: Bessie" in the title bar while the Role select, the frame
   * buttons and the sheet body all said monster, and it stayed wrong until the
   * sheet was closed and reopened.
   *
   * This is the title half of what `#syncGenerationButtons` already does for
   * the frame BUTTONS, written for this same scenario: the frame is built once
   * and the content many times, so anything derived on the frame is re-applied
   * per render. Characters are skipped because their title never leaves
   * `super.title`, so there is nothing to keep in step.
   * @inheritDoc
   */
  _configureRenderOptions(options) {
    super._configureRenderOptions(options);
    if (this.hasFrame && options.renderContext && this.actor.type !== "character") {
      options.window = Object.assign(options.window ?? {}, { title: this.title });
    }
  }

  /**
   * The biography block (templates/parts/bio-block.html): trait pick-lists +
   * the constructed sentence, and the Scars checklist. Extracted from
   * _prepareCharacterContext when role-npc PEOPLE got the same block
   * (2026-08-01) — the character path calls it first and keeps everything
   * background-shaped for itself; the npc path calls it alone, gated on role
   * npc (context.showBiography).
   * @private
   */
  /**
   * The background document this actor's age formula comes from, or null.
   *
   * Only characters carry `backgroundUuid` — a hireling has a career and an NPC
   * a line of text — so everyone else answers null and `effectiveAgeFormula`
   * hands back the system default.
   * @returns {Promise<CairnItem|null>}
   * @private
   */
  async _ageBackgroundDoc() {
    const uuid = this.actor.system.backgroundUuid;
    return uuid ? (await fromUuid(uuid)) ?? null : null;
  }

  async _prepareBiographyContext(context) {
    // The age die's tooltip names the formula a click will ROLL — this
    // character's BACKGROUND formula, or the config fallback when that is blank
    // or unusable — through the same helper the die itself reads, so the two
    // cannot disagree (review #18: a literal "(2d20 + 10)" outlived the
    // configured formula by a day). Formatted here rather than with
    // {{localize}} because the value is per-BACKGROUND, not per-language;
    // `data-tooltip` on the control (user ruling), so it looks like the Die of
    // Fate's beside it.
    //
    // Resolved HERE rather than in _prepareCharacterContext because this block
    // is shared with role-npc people, who have no `backgroundUuid` at all and
    // must simply get the default. The resolved document is stashed on the
    // context so the character path below does not look it up a second time.
    context.ageBackground = await this._ageBackgroundDoc();
    context.rollAgeTitle = game.i18n.format("CAIRN.RollAgeTitle", {
      formula: effectiveAgeFormula(context.ageBackground, CONFIG.Cairn?.characterGenerator2e?.biography?.age).formula,
    });
    // Trait pick-lists: each trait's source table supplies a <select> of options
    // so a player can pick a value (or keep an off-table one).
    //
    // WHICH tables depends on the role (2026-08-20). A character or a hireling
    // gets 2e's eight; an NPC gets the six APPEARANCE ones plus the Warden's
    // Guide Quirk, Goal, Virtue and Vice. The last two collide by key on
    // purpose — same stored field, different list — and the spread order is
    // what settles it: the NPC map is second, so its Virtue wins for an NPC and
    // the 2e one is simply never reached.
    //
    // The rows a role does not use are ABSENT rather than blank, which is what
    // keeps an NPC from showing an empty Físico it can never fill and a
    // character from showing an Objetivo. A value already stored under a key the
    // current role does not list stays in the document untouched — nothing here
    // writes — so re-roling an actor and re-roling it back loses nothing.
    const biography2e = CONFIG.Cairn?.characterGenerator2e?.biography?.items ?? {};
    const npcTraits = CONFIG.Cairn?.npcGenerator?.traits ?? {};
    const mapping = this.actor.npcRole === "npc"
      ? {
        ...Object.fromEntries(Object.entries(biography2e).filter(([k]) => !(k in npcTraits))),
        ...npcTraits,
      }
      : biography2e;
    // The mapping's values are BARE TABLE NAMES now — one compendium, so there
    // is no pack half to split off — and each resolves to one document rather
    // than to a whole pack that is then searched. Resolved in parallel because
    // ten sequential awaits on every render is ten round trips the first time
    // and ten cache hits after; `Promise.all` makes the cold case one wait.
    const names = Object.values(mapping);
    const tables = new Map(await Promise.all(
      [...new Set(names)].map(async (name) => [name, await cachedGeneratorTable(name)])
    ));
    context.traitRows = Object.entries(mapping).map(([key, tableName]) => {
      const table = tables.get(tableName) ?? null;
      const value = this.actor.system.traits?.[key] ?? "";
      const texts = table ? table.results.map(resultText).sort() : [];
      return {
        key,
        // A biography trait's label IS its table name (Físico, Piel…). The four
        // NPC traits take a UI key instead: their tables are the Warden's to
        // name, so the label beside the select cannot depend on what they called
        // them.
        label: NPC_TRAIT_LABELS[key] && key in npcTraits
          ? game.i18n.localize(NPC_TRAIT_LABELS[key])
          : tableName,
        value,
        options: texts.map((text) => ({ value: text, display: text, selected: text === value })),
        // An off-table value (legacy free-typed) is preserved as its own option
        // so switching to a dropdown never silently drops it.
        customValue: value && !texts.includes(value) ? value : "",
        customDisplay: value && !texts.includes(value) ? value : "",
      };
    });

    // Live constructed trait sentence + collapsible pick-lists (transient
    // sheet state; defaults collapsed so the sentence is the clean default
    // view). The sentence now OPENS the Description tab and everything that
    // feeds it — the eight pick-lists, the birthday die and the age die —
    // lives inside the «Rasgos» panel below it (2026-09-02, user ruling).
    context.traitSentence = this._buildTraitSentence(
      this.actor.system.traits, this.actor.system.age, this.actor.system.birthday);
    context.traitsCollapsed = this._traitsCollapsed ?? true;

    // Scars pick-list, off the SAME Cicatrices table the damage flow draws from
    // (damage.js _rollScarsTable) — one table, so a scar taken in play and a
    // scar ticked by hand are drawn from the same list. Neither Omen nor Scar is
    // generated: a player ticks the field's checkbox to enable it, then rolls
    // (Omen) or checks scars. Both are descriptive only.
    const scarTable = await cachedGeneratorTable(TABLES.scars);
    const selectedScars = this.actor.system.scars ?? [];
    context.scarOptions = scarTable
      ? scarTable.results.map((r) => {
          const name = resultText(r);
          return {
            name,
            display: name,
            // Our own per-row annotation, not the row's text.
            description: r.flags?.["mondolme"]?.description ?? "",
            selected: selectedScars.includes(name),
          };
        })
      : [];
    context.scarDisplay = selectedScars.length
      ? selectedScars.join(", ")
      : null;
    context.scarsCollapsed = this._scarsCollapsed ?? false;

    // Languages the Warden defined, ticked per actor. Same shape as the scar
    // list above and rendered by the same markup, because it is the same
    // gesture: a flat list of names, none of them generated, ticked by hand.
    // The source is the setting rather than a table — languages are a property
    // of the SETTING, not something anyone rolls for.
    const known = this.actor.system.languages ?? [];
    const worldLanguages = languages();
    context.languageOptions = worldLanguages.map((name) => ({
      name,
      selected: known.includes(name),
    }));
    // A language ticked before the Warden edited the setting out of the list
    // still shows, rather than vanishing from the sheet with the actor still
    // holding it — the actor keeps what it was given until someone unticks it.
    for (const name of known) {
      if (!worldLanguages.includes(name)) context.languageOptions.push({ name, selected: true, orphan: true });
    }
    context.languageDisplay = known.length ? known.join(", ") : null;
    context.languagesCollapsed = this._languagesCollapsed ?? false;
  }

  /**
   * Description tab: the biography block (see _prepareBiographyContext), plus
   * the 2e background header/description; and the Trasfondo tab's questions
   * and obligations (both moved off the Notes tab 2026-09-02).
   * Character-only — the npc path shares only the biography part.
   * @private
   */
  async _prepareCharacterContext(context) {
    await this._prepareBiographyContext(context);

    // Background description (from the linked Item) + a friendly source label,
    // shown in the sheet header. "2e" -> "Cairn 2e". The document was already
    // resolved by the biography block above (for the age formula), so this
    // reads its answer rather than making a second lookup.
    const bg = context.ageBackground ?? null;
    context.backgroundDescription = bg?.system?.description
      ? cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(
          bg.system.description, { relativeTo: this.actor }))
      : "";
    // The background name for the header (generated case).
    context.backgroundName = this.actor.system.background ?? "";
    context.contentSourceLabel = sourceLabel(this.actor.system.contentSource);

    // A generated background (either edition) is a linked document, so its name
    // is a header rather than a free-text field; a hand-made character keeps the
    // editable input.
    context.is2eBackground = this.actor.system.contentSource === "2e";
    context.isBarebonesBackground = this.actor.system.contentSource === "barebones";
    context.hasGeneratedBackground = !!this.actor.system.backgroundUuid;
    // `showBackgroundNotesLabel` lived here (the Notes tab renamed itself once
    // a background was attached). Retired 2026-08-01, and the per-role static
    // variants that replaced it are gone too (2026-09-02): both sheets now read
    // one key, TAB_LABELS.notes / CAIRN.LinksAndNotes, and a character's
    // background has a tab of its own. The DYNAMIC, data-driven rename stays
    // dead: two characters must not disagree on what their own tabs are called.
    // Scars and Age are never generated — a player fills each in by hand after
    // the fact — so they are NOT edition-specific and show on both. Only
    // character CREATION differs between 2e and Barebones (see CLAUDE.md,
    // "One system, two generators").
    context.showScars = true;
    context.showAge = true;
    // Omen is the one exception, and it is a CONTENT question rather than a rule:
    // Barebones ships no omens table, so the field is 2e's alone. (A Warden
    // used to be able to lend it via show-omens-barebones; the lending was
    // removed 2026-08-09. A legacy Barebones character's stored omen text
    // survives on the document — only the field hides.)
    //
    // ...and since 2026-08-17 a Warden can switch the field off for 2e too
    // (show-omens, default ON) — a table that does not use the youngest-member
    // rule. Read live and fanned by the setting's onChange, so flipping it
    // empties an OPEN sheet. Content source stays first: it is the structural
    // answer, and Barebones hides the field whatever the switch says.
    //
    // Render-only, deliberately: #onRollOmen and the .omen-enable listener are
    // NOT gated, because both are reachable only through DOM this context does
    // not render, and render-only is the settled shape for a display toggle
    // here (showFailedCareer, _mayRandomize). The affordance/enforcement split
    // this repo insists on governs ACQUISITION — walking past a slot limit —
    // not whether a field is drawn. Stored omen text is never cleared.
    context.showOmen = omenVisible(this.actor);
    context.omenDisplay = this.actor.system.omen;
    // Barebones-only: the career that didn't work out — a name, plus the one
    // keepsake item below (this line read "Grants nothing" until 2026-08-22).
    // Read the setting live, so a Warden switching it off hides the line on an
    // already-generated character rather than only affecting the next one.
    context.failedCareer = this.actor.system.failedCareer ?? "";
    context.showFailedCareer =
      this.actor.system.contentSource === "barebones" &&
      game.settings.get(SETTINGS_NS, "barebones-failed-career");
    // The single keepsake item the failed career left (grantSource
    // "failed-career") — shown on its own line under the career, with a re-roll
    // dice. It also appears in the inventory tagged "Failed Career" + "Petty".
    context.failedCareerItem =
      this.actor.items.find((i) => i.getFlag("mondolme", "grantSource") === "failed-career")?.name ?? "";

    // Random-generation mode (default on): gates the per-field dice rollers
    // (age, omen). Legacy characters lack the field -> default to enabled.
    // _mayRandomize: while the Warden's allow-player-randomization switch is
    // off, a PLAYER's render derives false even on an actor whose own flag is
    // on — the whole surface hides, render-only, no actor written (ruled
    // 2026-08-09). The Warden's own render is unaffected.
    context.generationEnabled = this.actor.system.generationEnabled !== false
      && this._mayRandomize();

    // TRASFONDO TAB (2026-09-02; this whole block used to head the Notes tab):
    // the background's question tables and the character's obligations. Both
    // arrive from generation EMPTY and are filled by their own die on this tab,
    // which is what `filled` distinguishes — an unrolled slot shows the
    // "sin tirar" placeholder and a "roll" tooltip, a filled one its answer and
    // a "re-roll" tooltip. One control either way, on one handler: rolling an
    // empty slot is the same swap-out/swap-in with nothing to swap out.
    //
    // Obligations are 2e; a legacy Barebones character may still hold one from
    // the retired lending setting, so show the section whenever it has any.
    context.bonds = this._effectiveBonds().map((b) => ({
      ...b,
      filled: !!String(b.description ?? "").trim(),
    }));
    context.showBonds = context.is2eBackground || context.bonds.length > 0;
    // "Add an obligation" shows only while below the background's entitlement
    // (base 1, plus a second for Fieldwarden / Outrider's debt option). A fresh
    // character starts AT its entitlement — in empty slots — so the link is
    // normally hidden, and appears once a rolled ANSWER raises the entitlement.
    context.canAddBond = context.bonds.length < (await this._bondEntitlement(bg));
    context.questions = (this.actor.system.questions ?? []).map((q) => ({
      ...q,
      question: q.question ?? "",
      answer: q.answer ?? "",
      filled: !!String(q.answer ?? "").trim(),
    }));
    // Nothing to show at all: no background questions and no obligations. The
    // tab still renders (it is in the character's tab set unconditionally), so
    // it says so rather than standing empty.
    context.backgroundTabEmpty = !context.showBonds && !(context.is2eBackground && context.questions.length);
    // The Notes editor is TOGGLED (character-sheet.html), so this is its
    // light-DOM DISPLAY half. Enriched but NOT translated: notes are the
    // player's own prose and no content namespace files them.
    context.enrichedNotes =
      cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        this.actor.system.notes,
        { relativeTo: this.actor },
      ));

    // Attribute-loss statuses, ability tooltips, peril/low cues, critical skull.
    this._computeStatContext(context);
  }

  /**
   * Ability/HP peril + "low" cues, the STR-critical skull toggle, per-ability save
   * tooltips, and the attribute-loss status banners (Dead / STR Critical /
   * Paralyzed / Delirious / Overburdened). STR 0 = Dead, DEX 0 = Paralyzed,
   * WIL 0 = Delirious are automatic (derived); Critical Damage is a manual skull.
   * @private
   */
  _computeStatContext(context) {
    // A THING (role transport/container) has no stat block, so it has no
    // derived conditions either -- and this is a correctness guard, not a
    // cosmetic one. Every condition below is derived from an ability being at
    // or below zero (`dead = STR <= 0`), which is exactly the state a crate or
    // a loot pile sits in permanently. Without this the sheet would announce
    // that a barrel is Dead, Paralyzed and Delirious, all three at once, and
    // the red peril cues would paint a stat block the template is not even
    // drawing.
    //
    // Everything is still defined rather than left undefined: the template
    // reads these keys unconditionally in a few places, and a missing lookup in
    // Handlebars is silently empty, which would hide a future mistake here.
    if (this.actor.isThing) {
      context.abilityPeril = {};
      context.abilityLow = {};
      context.hpLow = false;
      context.criticalToggle = {};
      context.criticalActive = {};
      context.abilityTips = {};
      context.statusBanners = [];
      return;
    }

    const ab = this.actor.system.abilities ?? {};
    const val = (k) => Number(ab[k]?.value);
    const max = (k) => Number(ab[k]?.max);
    const dead = val("STR") <= 0;
    const paralyzed = val("DEX") <= 0;
    const delirious = val("WIL") <= 0;
    // Legacy-safe: only a strict boolean true counts as the STR Critical Damage
    // flag. Death overrides it.
    const strCritical = this.actor.system.critical === true && !dead;

    context.abilityPeril = { STR: dead || strCritical, DEX: paralyzed, WIL: delirious };
    // "Low" = current below max but not in peril: amber "reduced" cue (peril's red
    // takes precedence). HP uses it too.
    context.abilityLow = {};
    for (const k of ["STR", "DEX", "WIL"]) context.abilityLow[k] = val(k) < max(k) && !context.abilityPeril[k];
    context.hpLow = Number(this.actor.system.hp?.value) < Number(this.actor.system.hp?.max);
    // Skull offered when STR is damaged and still alive, or already marked.
    context.criticalToggle = { STR: (val("STR") < max("STR") && val("STR") > 0) || strCritical };
    context.criticalActive = { STR: strCritical };

    const L = (k) => game.i18n.localize(k);
    context.abilityTips = { STR: L("CAIRN.StrTip"), DEX: L("CAIRN.DexTip"), WIL: L("CAIRN.WilTip") };

    const banners = [];
    if (dead) {
      banners.push({ key: "dead", icon: "fa-skull", label: L("CAIRN.Dead"), text: L("CAIRN.DeadBanner") });
    } else {
      if (strCritical)
        // One format key rather than "<status> — STR": the ability name is
        // itself localized (STR/FUE), and a translation may not want it last.
        banners.push({
          key: "critical",
          icon: "fa-heart-crack",
          label: game.i18n.format("CAIRN.CriticalDamageStatusFor", { key: L("STR") }),
          text: L("CAIRN.CriticalDamageBanner"),
        });
      if (paralyzed)
        banners.push({ key: "paralyzed", icon: "fa-lock", label: L("CAIRN.Paralyzed"), text: L("CAIRN.ParalyzedBanner") });
      if (delirious)
        banners.push({ key: "delirious", icon: "fa-brain", label: L("CAIRN.Delirious"), text: L("CAIRN.DeliriousBanner") });
    }
    // Encumbrance is a carry state, not an ability loss, but likewise forces HP
    // to 0, so surface it as a persistent banner too. Suppressed when dead.
    if (!dead && this.actor.system.encumbered)
      banners.push({ key: "encumbered", icon: "fa-weight-hanging", label: L("CAIRN.Overburdened"), text: L("CAIRN.OverburdenedBanner") });
    context.statusBanners = banners;
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Everything that is not a click: `change` handlers for the class-managed
   * fields, the two double-click affordances, and the editor click-away save.
   * Clicks are declared as `actions` in DEFAULT_OPTIONS and wired by
   * ApplicationV2 — the action system covers no other event type.
   * @override
   */
  /**
   * Listeners that belong to the FRAME, which is built once and survives every
   * re-render. Binding these in `_onRender` instead would stack a duplicate on
   * each redraw — and this sheet redraws on every committed keystroke, because
   * `submitOnChange` is on.
   * @override
   */
  async _onFirstRender(context, options) {
    // Await the async super (review #13 #22): DocumentSheetV2's registers the
    // sheet in `document.apps` AFTER its own await, and the framework awaits
    // this handler (application.mjs:589) — a sync override dropped that
    // promise, so the registration landed after first-render supposedly
    // finished and a rejection in super's chain was unhandled.
    await super._onFirstRender(context, options);
    bindEditorClickAwaySave(this.element);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;

    // Die of Fate is a READ roll — anyone who can see the sheet may roll it,
    // which is why `owned()` does not wrap it — but it is the one roll rendered
    // as a <button>, and DocumentSheetV2._onRender (the super call above) has
    // just run `_toggleDisabled(true)` over every form element of a
    // non-editable sheet (document-sheet.mjs:230-237, 269-272). The anchors it
    // shares the read set with are not form elements, so only this one went
    // dead: a Warden with a locked-pack monster open could roll its attack but
    // not the die (review #18). Re-enabled after super, for exactly that case.
    if (!this.isEditable) {
      const dof = el.querySelector('[data-action="dieOfFate"]');
      if (dof) dof.disabled = false;
    }

    // The title-bar generation buttons live on the frame, which is built once —
    // so their state is re-applied here, on every render of the content.
    this.#syncGenerationButtons();

    // Drag-to-reorder is always on (its setting retired 2026-08-22), so the
    // sheet always carries the class that gives item rows a grab cursor and
    // shows the reorder hint. The class stays because the CSS keys on it.
    el.classList.add("cairn-reorder-enabled");
    // When grant-source tags are on, mark the sheet so the footer hint under the
    // inventory explains the Background / Bond / Question chips. Character-only:
    // those chips are set at character generation, so no other actor type has them.
    el.classList.toggle(
      "cairn-grant-tags-enabled",
      game.settings.get(SETTINGS_NS, "show-grant-tags") && this.actor.type === "character"
    );

    // Re-open whatever the player had open. ABOVE the isEditable wall, because
    // reading a description is a read: an observer who expanded a row keeps it
    // expanded through a re-render exactly as an owner does.
    this.#restoreExpandedRows();

    const on = (selector, type, handler) =>
      el.querySelectorAll(selector).forEach((node) => node.addEventListener(type, handler));

    // Double-click to open an item's own sheet, on the same title that
    // single-clicks to expand its description. ABOVE the isEditable wall on
    // purpose, and for the reason written on the `itemEdit` action: opening an
    // item's sheet is a READ, and that sheet enforces its own edit permission.
    // The pencil and this double-click are the same affordance on the same row,
    // so gating one and not the other gave one read two answers — and the
    // silent half was the one nothing tells you about.
    on(".cairn-item-title", "dblclick", (ev) => this._openItemSheet(ev.currentTarget));

    if (!this.isEditable) return;

    // Double-click the Items tab label to set this character's equipment limit,
    // when the Warden has enabled per-character limits.
    on("#set-equipment-limit", "dblclick", (ev) => this._onSetEquipmentLimit(ev));

    // Click-to-edit on the EMPTY Notes display (both sheets, 2026-08-08): a
    // toggled editor's only core affordance is the pencil, so an empty notes
    // area activates on a click anywhere in the display half — through core's
    // own toggle button, never a reimplemented activation. With content
    // present clicks stay inert (text selection and links keep working) and
    // the now-visible pencil is the way in. The emptiness test is the
    // placeholder element itself: the template renders it exactly when the
    // stored notes are empty.
    // The npc sheet's Description editor joined this on 2026-08-20 — it is the
    // same toggled editor with the same empty display half, and the hint below
    // is what makes the click meaningful.
    on('.tab[data-tab="notes"] prose-mirror, .npc-description-section prose-mirror', "click", (ev) => {
      const pm = ev.currentTarget;
      if (!pm.classList.contains("inactive")) return;
      if (ev.target.closest("a, button")) return;
      if (!pm.querySelector(".cairn-editor-placeholder")) return;
      pm.querySelector("button.toggle")?.click();
    });

    // Stat inputs (HP + abilities, current & max) are numeric and capped 0-18.
    on(".stat-input", "change", (ev) => {
      const input = ev.currentTarget;
      let n = Math.round(Number(input.value));
      if (!Number.isFinite(n)) n = 0;
      n = Math.min(18, Math.max(0, n));
      if (String(n) !== input.value) input.value = n;
    });

    // The Type select is class-managed (no form name) ON PURPOSE: its "Other…"
    // row is a sentinel, and an unnamed control keeps it out of every submit —
    // nothing that is not a real Kind may ever reach the document. A known key
    // (or blank) is written here, alone, which is the same single-field write
    // the old picker made — _preUpdate answers it with default art and slots
    // only where nothing was hand-set. Other writes NOTHING: it enables and
    // reveals the free-text input, whose own (named) change is the field's one
    // submit path, where _processFormData still maps a typed label to its key.
    // stopPropagation keeps submitOnChange from also firing a same-values
    // submit off the unnamed select's change.
    on(".kind-select", "change", async (ev) => {
      ev.stopPropagation();
      const v = ev.currentTarget.value;
      const input = el.querySelector(".kind-input");
      if (v === "__other__") {
        if (input) {
          input.hidden = false;
          input.disabled = false;
          input.focus();
        }
        return;
      }
      if (input) { input.hidden = true; input.disabled = true; }
      if (v !== (this.actor.system.containerClass || "")) {
        await this.actor.update({ "system.containerClass": v });
      }
    });

    // Armor is class-managed (no form name): the field shows the effective Armor
    // (derived from gear, or an override). Typing a 0-3 value stores an override
    // that supersedes the gear value; clearing it — or the reset icon — returns
    // to auto (system.armorOverride = null).
    on(".armor-input", "change", async (ev) => {
      const raw = ev.currentTarget.value.trim();
      if (raw === "") {
        await this.actor.update({ "system.armorOverride": null });
        return;
      }
      let n = Math.trunc(Number(raw));
      if (!Number.isFinite(n)) n = 0;
      n = Math.min(3, Math.max(0, n));
      await this.actor.update({ "system.armorOverride": n });
    });

    // Deprived / Panicked are class-managed (no form name): toggling ON asks for
    // confirmation that reiterates the condition's tooltip; declining reverts.
    // Toggling OFF (recovering) applies immediately.
    const condition = (selector, field, titleKey, tipKey, questionKey) =>
      on(selector, "change", async (ev) => {
        const desired = ev.currentTarget.checked;
        if (desired && !(await this._confirmAction(titleKey, tipKey, questionKey))) {
          this.render(false);
          return;
        }
        await this.actor.update({ [field]: desired });
      });
    condition(".deprived-check", "system.deprived", "CAIRN.Deprived", "CAIRN.DeprivedTip", "CAIRN.DeprivedConfirm");
    condition(".panicked-check", "system.panicked", "CAIRN.Panicked", "CAIRN.PanickedTip", "CAIRN.PanickedConfirm");

    // Enabling Omen reveals the field; disabling it clears the stored omen so the
    // field resets to the placeholder hint (not a hidden value).
    on(".omen-enable", "change", async (ev) => {
      const enabled = ev.currentTarget.checked;
      const data = { "system.omenEnabled": enabled };
      if (!enabled) data["system.omen"] = "";
      await this.actor.update(data);
    });

    // Enabling Scars reveals the checklist; disabling it clears every picked scar.
    on(".scar-enable", "change", async (ev) => {
      const enabled = ev.currentTarget.checked;
      const data = { "system.scarEnabled": enabled };
      if (!enabled) data["system.scars"] = [];
      await this.actor.update(data);
    });

    // Scars are a checkbox list: persist the set of checked names (including
    // empty). Managed here rather than via form serialization so unchecking the
    // last one reliably stores an empty array. render:false keeps scroll/state.
    on(".scar-check", "change", async () => {
      const scars = [...el.querySelectorAll(".scar-check:checked")].map((o) => o.value);
      await this.actor.update({ "system.scars": scars }, { render: false });
    });

    on(".language-check", "change", async () => {
      const langs = [...el.querySelectorAll(".language-check:checked")].map((o) => o.value);
      await this.actor.update({ "system.languages": langs }, { render: false });
    });
  }

  /* -------------------------------------------- */
  /*  Shared helpers                              */
  /* -------------------------------------------- */

  /** The inventory row a control sits in. */
  static #row(target) {
    return target.closest(".cairn-items-list-row");
  }

  /**
   * A yes/no confirmation whose body reiterates the action's tooltip, then asks
   * the question, so the player re-reads the rule before committing.
   * @param {String} titleKey  i18n key for the dialog title
   * @param {String} tipKey    i18n key for the explanatory text (may be HTML)
   * @param {String} questionKey  i18n key for the yes/no question
   * @returns {Promise<Boolean>}
   * @private
   */
  async _confirmAction(titleKey, tipKey, questionKey) {
    const k = (key) => this._wording(key);
    return foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize(titleKey) },
      content: `<div class="cairn-confirm">${game.i18n.localize(k(tipKey))}<p class="cairn-confirm-q">${game.i18n.localize(k(questionKey))}</p></div>`,
      rejectClose: false,
      modal: true,
    });
  }

  /**
   * Prefer the NPC wording of a string when this sheet is a non-player actor.
   *
   * Rest, Restore, Deprived and Panicked are shared with the character sheet, and
   * their prompts were written for a player: "Is your character deprived?", and a
   * Deprived rule that says "A PC that lacks a crucial need". Asked of a wolf or a
   * hired blacksmith that reads as a bug.
   *
   * Resolved by key EXISTENCE rather than a lookup table, so a string only diverges
   * where the wording genuinely differs -- `CAIRN.PanickedTip` and `CAIRN.RestTip`
   * already say "character" and "the party", and duplicating them under a second key
   * would just be two strings for a translator to keep in step (and would trip
   * `i18n:check`'s equal-to-English report).
   *
   * **`has(npcKey, false)`, not `has(npcKey)`.** The default is `fallback: true`,
   * which consults `_fallback` — the English strings — as well as the active
   * language (client/helpers/localization.mjs:390-396). Since every `…Npc` variant
   * exists in en.json, the test was unconditionally true in EVERY language, and the
   * NPC sheet served the English variant in place of a base key the translator had
   * already done. Not a missing translation: a working one, discarded.
   *
   * It was a regression, not a pre-existing gap. Before the Hireling→NPC fold the
   * hireling sheet used the base keys, so those strings rendered in Spanish in
   * 0.1.7 and in English afterwards. And because only SOME variants exist —
   * `RestTipNpc` and `PanickedTipNpc` do not — a dialog came out half-translated:
   * the tip in Spanish, the question beneath it in English.
   *
   * With `fallback: false` the rule reads the way the name does: use the NPC wording
   * when THIS language has it, otherwise the translated base string, and English
   * only when the language has neither. A translator adding `…Npc` keys turns the
   * NPC wording on for their language with no code change.
   * @param {String} key
   * @returns {String} the same key, or its `…Npc` variant
   * @private
   */
  _wording(key) {
    if (this.actor.type === "character") return key;
    const npcKey = `${key}Npc`;
    return game.i18n.has(npcKey, false) ? npcKey : key;
  }

  /** Open the own sheet of the item (or owned container) a row represents. */
  _openItemSheet(target) {
    const row = CairnActorSheet.#row(target);
    if (!row) return;
    if (row.dataset.isContainer) {
      this.actor.getOwnedContainer(row.dataset.itemId)?.sheet.render(true);
      return;
    }
    const item = this.actor.getOwnedItem(row.dataset.itemId);
    if (!item || item.name === FATIGUE_NAME) return;
    item.sheet.render(true);
  }

  /**
   * The panel a row shows when expanded: a container's contents, or an item's
   * description plus its critical-damage line.
   *
   * Derived from the ROW alone, with no event — which is what lets the click
   * below and the re-render restore share it. Two builders for one panel is how
   * a restore comes back translating the item half and not the container half.
   * @param {HTMLElement} row
   * @returns {HTMLElement|null}
   * @private
   */
  _buildRowDescription(row) {
    if (row.dataset.isContainer) {
      const container = game.actors.find((a) => a.uuid === row.dataset.itemId);
      if (!container) return null;
      // Built with textContent so a container's item names can't inject
      // HTML/script into the keeper's (or GM's) sheet when the row is expanded.
      const div = document.createElement("div");
      div.className = "item-description";
      div.textContent = container.items.map((it) => it.name).join(", ");
      return div;
    }
    const item = this.actor.items.get(row.dataset.itemId);
    if (!item) return null;
    const crit = cleanDescription(item.system.criticalDamage) !== ""
      ? `<div><i class="fa-regular fa-skull"></i> <i>${cleanDescription(item.system.criticalDamage)}</i></div>`
      : "";
    // A relic's Recharge condition, the crit line's treatment — icon plus
    // italics (Malecho's ask, issue #22). Keyed on the TEXT, not the relic
    // flag, the same rule the Charges relabel follows.
    const rechargeText = item.system.recharge ?? "";
    const recharge = cleanDescription(rechargeText) !== ""
      ? `<div><i class="fa-regular fa-arrows-rotate"></i> <i>${cleanDescription(rechargeText)}</i></div>`
      : "";
    // A LIBRO'S PAGES, one line each, in the shape "1. Nombre del hechizo:
    // texto" — the Recharge line's treatment (icon plus italics), which is
    // already how this panel says "here is another fact about this item".
    // Empty pages are skipped by `bookPages`, so a one-spell book shows one
    // line rather than two blanks.
    //
    // The spell's NAME goes through the same cleanDescription sink the two
    // lines above use, and for the same reason: it is player-authored text
    // reaching innerHTML. It is plain text in the schema, so cleaning it is
    // belt-and-braces rather than the only wall — but this panel is the one
    // place a book's page names are rendered, and the rule here is that
    // nothing reaches innerHTML unwashed.
    const pages = item.type === "book"
      ? bookPages(item).map((p) =>
        `<div><i class="fa-regular fa-bookmark"></i> <i>${p.n}. `
        + `${cleanDescription(p.name)}: ${cleanDescription(p.text)}</i></div>`).join("")
      : "";
    const div = document.createElement("div");
    div.className = "item-description";
    const desc = item.system.description;
    div.innerHTML = `${cleanDescription(desc)}${crit}${recharge}${pages}`;
    return div;
  }

  /**
   * Expand or collapse a row's description panel, and REMEMBER which it is —
   * see `#expandedRows` for why the DOM alone was not enough.
   * @private
   */
  _toggleRowDescription(row) {
    const id = row.dataset.itemId;
    if (row.classList.contains("expanded")) {
      const summary = row.querySelector(":scope > .item-description");
      if (summary) slideUp(summary, () => summary.remove());
      this.#expandedRows.delete(id);
    } else {
      const panel = this._buildRowDescription(row);
      if (!panel) return;
      row.append(panel);
      slideDown(panel);
      this.#expandedRows.add(id);
    }
    row.classList.toggle("expanded");
  }

  /**
   * Put every remembered panel back after a render, WITHOUT the slide.
   *
   * The animation is the whole reason this is not just a second call to the
   * toggle: a row that was already open must come back open, not re-open. With
   * `submitOnChange` committing on every keystroke, animating here would make
   * the panel flicker under the cursor of whoever was typing.
   *
   * A row can be legitimately gone — the item dropped, the container
   * disconnected, the row filtered out — so a missing one is FORGOTTEN rather
   * than carried, or the set would grow stale ids for the life of the sheet.
   * @private
   */
  #restoreExpandedRows() {
    if (!this.#expandedRows.size) return;
    for (const id of [...this.#expandedRows]) {
      const row = this.element?.querySelector(`.cairn-items-list-row[data-item-id="${CSS.escape(id)}"]`);
      if (!row) { this.#expandedRows.delete(id); continue; }
      // A partial render leaves untouched parts alone, so a panel may already
      // be sitting there; appending a second one is the bug this guard stops.
      if (row.classList.contains("expanded")) continue;
      const panel = this._buildRowDescription(row);
      if (!panel) { this.#expandedRows.delete(id); continue; }
      row.append(panel);
      row.classList.add("expanded");
    }
  }

  /**
   * The actor's bonds as an array, copied so callers can splice it freely.
   *
   * This used to fold a legacy singular `system.bond` into a one-element list.
   * That shim went with the data-model move: `bond`/`bondGold` were never
   * declared as schema fields, no world was ever built on the version that wrote
   * them, and a strict schema drops them anyway.
   * @returns {{id: String, description: String, gold: Number}[]}
   * @private
   */
  _effectiveBonds() {
    return foundry.utils.duplicate(this.actor.system.bonds ?? []);
  }

  /**
   * How many bonds this character may hold: the base one, plus any the background
   * grants -- Fieldwarden's description and Outrider's "Always pay your debts"
   * answer each carry "roll a second time on the Bonds table". Mirrors the
   * generator's bond count so the sheet and generation agree.
   * @param {CairnItem} [bg] the background item, if already fetched (else looked up)
   * @returns {Promise<Number>}
   * @private
   */
  async _bondEntitlement(bg = undefined) {
    if (bg === undefined) {
      bg = this.actor.system.backgroundUuid ? await fromUuid(this.actor.system.backgroundUuid) : null;
    }
    // Barebones is entitled to no bonds — the lending setting that granted
    // one is retired (2026-08-09). Display policy, so it stays HERE: the
    // generator's clamp uses the SHARED bondEntitlement and must never
    // delete a legacy lent bond because this arm reads 0 — zero only gates
    // "Add a bond"; existing bonds display on content.
    if (this.actor.system.contentSource === "barebones") return 0;
    // The shared rule — one implementation for generation, the Add-a-bond cap
    // and changeBackground's clamp, after its two hand-kept twins drifted
    // apart in wording and agreed only by luck (dedup'd 2026-08-02).
    return bondEntitlement(bg, this.actor.system.questions);
  }

  /**
   * A background dropped on a sheet: swap to it, after asking.
   *
   * Only a character HAS a background — `NpcData` carries no `background` or
   * `backgroundUuid` — so any other actor type says so rather than silently doing
   * nothing or, as before, pocketing the document as gear.
   *
   * A background of the OTHER edition is refused the same way. "A character does not
   * change edition" is the rule the picker already follows (#onPickBackground only ever
   * offers this character's own source), and the drop was the one way around it.
   * Refusing is also the only correct answer to what it actually did when measured: a
   * Barebones character keeps its generated Rations/Torch/weapon/armor — none of which
   * the 2e background knows to remove — so it ended up carrying BOTH loadouts, with
   * duplicates.
   *
   * Confirmed because it is destructive and a drop is easy to do by accident:
   * `changeBackground` deletes everything the old background granted (its starting
   * gear, its rolled answers' items and containers) and re-rolls the new one's. The
   * prompt names the background, since the likeliest mistake is dropping the wrong one.
   * Bonds and the portrait survive — that is `changeBackground`'s contract, shared with
   * the picker.
   * @param {CairnItem} bg
   * @returns {Promise<null>} never an item: nothing is added to the inventory
   */
  async _onDropBackground(bg) {
    if (!this.isEditable) return null;
    if (this.actor.type !== "character") {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.BackgroundNotCharacter"));
      return null;
    }
    const bgSource = bg.system?.source || "2e";
    const mySource = this.actor.system.contentSource || "2e";
    if (bgSource !== mySource) {
      // Named for what they CARRY, not for where they came from: both are edition
      // labels, and a translator reading en.json alone could only guess that from
      // `{background}` / `{character}`, which read like a background and a
      // character name.
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.BackgroundWrongSource", {
        backgroundEdition: sourceLabel(bgSource),
        characterEdition: sourceLabel(mySource),
      }));
      return null;
    }
    if (!this._mayChangeBackground()) return null;
    // Escaped because the result is interpolated into HTML. The name is a
    // stored document field, and a world Item is creatable by any player a
    // Warden has granted Create Item to — the same player→GM escalation this
    // repo has paid for before (see cleanDescription in utils.js), and this
    // dialog renders in the GM's client.
    const bgName = foundry.utils.escapeHTML(bg.name);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CAIRN.ChangeBackgroundTitle") },
      content:
        `<div class="cairn-confirm">${game.i18n.localize("CAIRN.ChangeBackgroundTip")}` +
        `<p class="cairn-confirm-q">${game.i18n.format("CAIRN.ChangeBackgroundQ", { name: bgName })}</p></div>`,
      rejectClose: false,
      modal: true,
    });
    if (!ok) return null;
    await changeBackground(this.actor, bg);
    return null;
  }

  /**
   * May this user swap this character's background at all? Ask BEFORE offering the
   * swap, not after.
   *
   * `changeBackground` already refuses when the answer is no, and warns — but it
   * refuses at the very top, after the UI has already asked. So a player in a
   * containers-on world was shown "change this character's background to X? this
   * deletes its granted gear", answered yes, and got a warning and no change. A
   * destructive question that cannot be honoured is worse than a plain refusal: it
   * tells the player the swap is theirs to make, and then takes it back.
   *
   * The refusal itself is correct and is not the bug — containers are Actors and
   * Foundry gates Actor deletion on ASSISTANT, so no player can regenerate them
   * (see `canRegenerateContainers`). Note how blunt that guard is: with the
   * Containers tab ON it refuses for EVERY non-GM, whatever the character is
   * carrying, because a fresh roll might mint one. So this is not rare — it is
   * every player in such a world, every time.
   *
   * Both places the sheet offers the swap call this first: the drop, above, and the
   * magnifier's picker, which otherwise let a player browse the whole background
   * list before refusing the one they chose. `#onRollBackground` deliberately does
   * NOT — it asks nothing, so `changeBackground`'s own guard is the first and only
   * refusal, and a second copy here would be dead code that reads as protection.
   * The warning key is passed explicitly. `canRegenerateContainers` was written for
   * the REGENERATE path and its default sentence ends "ask them to re-roll it for
   * you" — which, on a background swap, tells a player to request an operation that
   * would discard their abilities, HP and traits when all they did was try to change
   * a background. Same refusal, different thing being refused, so a different
   * sentence.
   * @returns {Boolean} false, having already warned, if the swap would be refused
   */
  _mayChangeBackground() {
    return canRegenerateContainers(this.actor, null, "CAIRN.Notify.NoContainerBackground");
  }

  /**
   * The bonds table this character's background names, or "" for the shipped 2e one.
   * Re-rolling and adding a bond must draw from the SAME table generation used, or a
   * custom background's bonds silently become 2e bonds the first time a player uses
   * the d20 beside one.
   * @returns {Promise<String>}
   */
  async _bondsTableName() {
    const uuid = this.actor.system.backgroundUuid;
    const bg = uuid ? await fromUuid(uuid) : null;
    return bg?.system?.bondsTable ?? "";
  }

  /**
   * Delete the actor's items previously granted by `source` and create the new
   * ones in their place, so re-rolling a bond/question keeps the inventory tab in
   * sync. render:false -- the pending actor.update re-renders once.
   * @param {String} source  e.g. "bond:ab12" or "question:1"
   * @param {Object[]} newItems  resolved + withGrantSource() item data
   * @private
   */
  async _replaceGrantedItems(source, newItems) {
    const oldIds = this.actor.items
      .filter((i) => i.getFlag("mondolme", "grantSource") === source)
      .map((i) => i.id);
    if (oldIds.length) {
      // abNoStatusCard: grant machinery is not a player packing or shedding
      // gear, so it stays out of the manual-change log (every caller here —
      // bonds, questions, the failed-career keepsake — is a re-roll).
      await this.actor.deleteEmbeddedDocuments("Item", oldIds, { render: false, abNoStatusCard: true });
    }
    if (newItems.length) {
      await this.actor.createEmbeddedDocuments("Item", newItems, { render: false, abNoStatusCard: true });
    }
  }

  /** Replace the character's single failed-career keepsake with a fresh random
   *  pick from `careerName`'s gear (or clear it when the career has none). The
   *  item is Petty, so it never affects slots or fatigue. */
  async _grantFailedCareerItem(careerName) {
    // Guard against overlapping re-rolls: each does an async delete+create, so a
    // second click mid-flight would try to delete an item the first already removed.
    if (this._grantingFailedCareerItem) return;
    this._grantingFailedCareerItem = true;
    try {
      const item = careerName ? await buildFailedCareerItem(careerName) : null;
      await this._replaceGrantedItems("failed-career", item ? [item] : []);
      // _replaceGrantedItems renders nothing (render:false, so a trailing update can
      // re-render once); the bond/question re-rolls have that trailing update, this
      // path does not — so refresh the sheet explicitly or the line looks dead.
      this.render(false);
    } finally {
      this._grantingFailedCareerItem = false;
    }
  }

  /**
   * The first-person portrait that OPENS the Description tab: "Soy de físico
   * fornido, de piel curtida, … Nací en pleno invierno y tengo 34 años."
   *
   * ONE WHOLE-SENTENCE KEY, with named placeholders, and never a join of
   * fragments (2026-09-02, user ruling — restated as the house rule). The
   * clause-per-key assembly this replaces could not survive Spanish: "de físico
   * {value}" and "un rostro {value}" take different articles, the vice/virtue
   * pair needs "se dice que soy X pero que también soy Y" rather than a comma
   * list, and an opening «¿» has no fragment to live in at all. A translator
   * owns the whole sentence or owns nothing.
   *
   * FIRST PERSON on a character, THIRD on anyone else — routed through
   * `_wording`, which is how every NPC-worded string on this sheet resolves and
   * is why there is one key and not two builders. The two are genuinely
   * different sentences, not one sentence with swapped verbs: the NPC's also
   * carries Quirk and Goal, the two traits only an npc-role actor stores, so
   * folding them in as an optional clause would be the fragment concatenation
   * this whole note exists to forbid.
   *
   * AN UNSET TRAIT IS A VISIBLE GAP (`CAIRN.Bio.Unset`, "____"), not a dropped
   * clause: the sentence must show the player which of the ten answers is still
   * missing, and a clause that silently disappears reads as a complete portrait
   * of somebody with no hair. It is a localization key rather than a literal so
   * a translator can choose their own blank.
   *
   * Pronoun-accurate wording ("Es alto" / "Es alta") is NOT done, though the
   * pronouns are right there on the document: Spanish adjectives agree in
   * gender, so per-pronoun variants would multiply the translator's work by
   * three for the whole sentence.
   *
   * The printed character page shares this builder (`traitsProse`), so the
   * ruling reaches paper with no second change — blanks included, which is what
   * a sheet printed to be filled in by hand wants anyway.
   * @param {Object} traits
   * @param {String} age
   * @param {String} birthday
   * @returns {String}
   * @private
   */
  _buildTraitSentence(traits = {}, age = "", birthday = "") {
    const blank = game.i18n.localize("CAIRN.Bio.Unset");
    // Every slot resolves to SOMETHING: the stored value, or the visible gap.
    const val = (v) => {
      const s = String(v ?? "").trim();
      return s || blank;
    };
    return game.i18n.format(this._wording("CAIRN.Bio.Portrait"), {
      physique: val(traits?.physique),
      skin: val(traits?.skin),
      hair: val(traits?.hair),
      face: val(traits?.face),
      speech: val(traits?.speech),
      clothing: val(traits?.clothing),
      vice: val(traits?.vice),
      virtue: val(traits?.virtue),
      // Carried for the NPC wording alone; the character sentence names neither
      // placeholder and `format` simply leaves an unused one unused.
      quirk: val(traits?.quirk),
      goal: val(traits?.goal),
      birthday: val(birthday),
      age: val(age),
    });
  }

  /**
   * Print: one standalone page holding the WHOLE character — a detached sheet
   * prints only its displayed tab, which is the reason this exists. Layout
   * modelled on Kettlewright's /print/ page (user example, 2026-08-08).
   *
   * The window is opened SYNCHRONOUSLY in the click gesture: popup blockers
   * allow a user-gesture open and eat one that arrives after an `await`, so the
   * async page build starts only once the window already exists.
   * @this {CairnActorSheet}
   */
  static #onPrintSheet(event) {
    event.preventDefault();
    // The limited view's other half: the button above is the affordance, this
    // is the enforcement (the two-layer rule every guard here follows).
    if (this.document.limited) return;
    const win = window.open("", "_blank");
    if (!win) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.PrintBlocked"));
      return;
    }
    this.#fillPrintPage(win).catch((err) => {
      console.error("Mondolme | the print page failed:", err);
      win.close();
    });
  }

  /**
   * Build the print page into an already-open window, then offer the print
   * dialog (user ruling: the button means print; cancelling leaves the page
   * open to read or re-print).
   *
   * Everything the page needs is made ABSOLUTE (`about:blank` has no base URL
   * to resolve a relative path against), item names and descriptions go
   * through the content overlay so a Spanish player prints Spanish, and the
   * two ProseMirror fields are enriched so an `@UUID` link prints as its
   * name — the page CSS then renders every anchor as plain text, because a
   * content link is useless on paper.
   * @param {Window} win
   */
  async #fillPrintPage(win) {
    const actor = this.actor;
    const sys = actor.system;
    const L = (k) => game.i18n.localize(k);
    // getRoute, not a bare origin join (review #13): a server behind a
    // routePrefix serves systems/ and icons/ under that prefix, and resolving
    // against location.origin alone printed every portrait and item icon as a
    // broken image on such a host. getRoute prepends ROUTE_PREFIX
    // (public/scripts/foundry.mjs:2265) — and must NOT see an already-absolute
    // URL (a remote portrait): it strips and re-joins slashes, so a scheme'd
    // URL comes back mangled. Those are absolute already; pass them through.
    const abs = (p) => {
      if (!p) return null;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(p)) return p;
      return new URL(foundry.utils.getRoute(p), `${location.origin}/`).href;
    };
    // Enriched print fields are written into the print window via document.write
    // (below), so each passes through cleanDescription first — the same innerHTML
    // sink the live sheet guards (see cleanDescription in utils.js). The print
    // window is the viewer's own browser: an injected on*/data-action in a
    // player-owned description would otherwise execute there.
    const enrich = async (html) => (html
      ? cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(html, { relativeTo: actor }))
      : "");

    // Read once for both inventory surfaces (main + connected sections).
    const printGrantTags = game.settings.get(SETTINGS_NS, "show-grant-tags-print");
    // A row per item, Kettlewright's annotations: (petty), (N uses), (dN),
    // bulky and quantity. Notes are TEXT assembled here and escaped by the
    // template — item names are authored free text.
    // `owner` is the actor these items belong to, which is NOT always the one
    // being printed: the connected sections below render a companion's gear.
    // The page-grouping pass that used to wrap this went with bound pages — a
    // Libro's three spells are fields on the book, so no printed row belongs
    // under another printed row any more.
    const rows = (owner, items) => this._sortItemsForDisplay(items).map((it) => {
      const notes = [];
      // The translator's strings AS WRITTEN — no locale-less case transform
      // (review #11: the print page was the only surface lowercasing a
      // localized value, wrong for any language that capitalises the term).
      if (it.system.weightless) notes.push(`(${L("CAIRN.Weightless")})`);
      const uses = it.system.uses?.value ?? 0;
      // formatCount, not a hand-rolled binary fork (review #11): the item
      // sheet and marketplace both learned this in review #9, and the fork
      // here duplicated CAIRN.NUses under two print-only keys while cutting
      // Polish off from its _few form.
      if (uses > 0) notes.push(`(${formatCount("CAIRN.NUses", uses)})`);
      if (it.system.damageFormula) notes.push(`(${it.system.damageFormula})`);
      // An armor row states its Armor points — the book's own notation,
      // "Brigandine (1 Armor)" (user ask 2026-08-11). Whole-string key so
      // the translator owns the word order; the code owns the parens, like
      // every note here. Only ArmorData carries the field, so no type test.
      if ((it.system.armor ?? 0) > 0) notes.push(`(${game.i18n.format("CAIRN.PrintArmorPoints", { armor: it.system.armor })})`);
      // The grant-source tag, under its OWN switch (user ask 2026-08-11) —
      // brackets, and italic via the .notes span like every note here. The
      // UNGATED grantLabelRaw, deliberately: system.grantLabel is emptied
      // whenever the INVENTORY switch is off, and the two switches must not
      // couple (the probe's inv-off leg is the witness).
      if (printGrantTags && it.system.grantLabelRaw) notes.push(`[${it.system.grantLabelRaw}]`);
      if (it.system.bulky) notes.push(`(${L("CAIRN.Bulky")})`);
      if ((it.system.quantity ?? 1) > 1) notes.push(`×${it.system.quantity}`);
      // Fatigue relabelled from the UI key, matching the sheet (review #12).
      const name = it.name === FATIGUE_NAME
        ? game.i18n.localize("CAIRN.Fatigue")
        : it.name;
      // A Libro or Hechizo row carries the same "Libro — " / "Hechizo — " /
      // "Pergamino — " prefix the inventory shows (user report 2026-08-08: the
      // printed sheet dropped it, so a book and its spell read as loose gear).
      // THROUGH the registered helper, so the two surfaces cannot drift —
      // idempotence included: a stored name already carrying a prefix gets no
      // second one.
      const prefix = Handlebars.helpers.spellNamePrefix(it.name, it.type, it.system.scroll);
      return { name: `${prefix}${name}`, notes: notes.join(" ") };
    });

    const isChar = actor.type === "character";
    const mainRows = rows(actor, actor.items.contents);
    // The status line: critical, plus deprived/panicked as text on an NPC
    // page. A CHARACTER prints those two as ALWAYS-PRESENT mark boxes
    // instead (user ask 2026-08-10: the paper sheet needs somewhere to
    // pencil them mid-session even when printed clean) — filled at print
    // time when the condition is already on.
    const status = [
      !isChar && sys.deprived && L("CAIRN.Deprived"),
      !isChar && sys.panicked && L("CAIRN.Panicked"),
      sys.critical && L("CAIRN.CriticalDamage"),
    ].filter(Boolean).join(" · ");
    const traitsProse = this._buildTraitSentence(sys.traits, sys.age, sys.birthday);

    // The background's own prose and its rolled question/answer pairs (user
    // additions 2026-08-08). Each Q&A stays its OWN pair of paragraphs:
    // Kettlewright smushes them into one blob, and the ruling is exactly not that.
    const bg = isChar && sys.backgroundUuid ? await fromUuid(sys.backgroundUuid) : null;
    const backgroundDesc = bg?.system?.description
      ? await enrich(bg.system.description)
      : "";
    const questions = (sys.questions ?? [])
      .filter((q) => String(q?.answer ?? "").trim())
      .map((q) => ({
        question: q.question ?? "",
        answer: q.answer ?? "",
      }));

    // A Connections SECTION was built here from 2026-08-08 and REMOVED
    // 2026-08-13 (user ruling). It printed every connected actor's name, role,
    // stat line and description — and all of that was already on the page: the
    // question or bond that granted the beast prints its prose under its own
    // heading, and whatever a transport or container HOLDS prints as its own
    // inventory section above. Talon's sheet carried the horse three times over.
    // The connected actors themselves still print their inventories (`containers`
    // below); it is only the summary that goes.

    // The line under the name: a character's background (source parenthetical
    // beside it, user ruling 2026-08-08), a person's role and job, a monster's
    // role. Overlay-routed like the sheet header.
    //
    // "Job" is two fields since the 2026-08-20 split, and the printed line asks
    // the same question the sheet does: a hireling's Career (`profession`), an
    // NPC's Background (`background`). Read from the role rather than by
    // falling back through both keys — a hireling stores a blank `background`
    // and an NPC a blank `profession`, so a fallback chain would print the
    // wrong one the moment a Warden re-roled somebody.
    const role = actor.npcRole ?? "hireling";
    const roleLabel = isChar ? "" : L(`CAIRN.Role${role.charAt(0).toUpperCase()}${role.slice(1)}`);
    const jobField = role === "hireling" ? sys.profession : role === "npc" ? sys.background : "";
    const career = isChar ? "" : String(jobField ?? "").trim();
    const subtitle = isChar
      ? (sys.background ?? "")
      : career ? game.i18n.format("CAIRN.PrintRoleCareer", { role: roleLabel, career }) : roleLabel;
    // "Custom" is MEMBERSHIP, not a stored source (the recorded definition:
    // not in the Player's Guide, nothing more — a custom character still
    // stores contentSource "2e"). The test used to be "resolved from anywhere
    // but the canon pack", and with no canon pack left to compare against it is
    // constantly true: every background in a world is one the Warden supplied,
    // so a 2e character with a background always prints the custom label. The
    // branch is gone rather than kept as a comparison that can only answer one
    // way (user ruling 2026-08-08, unchanged — it is the WORLD that changed).
    const isCustomBg = !!bg && sys.contentSource === "2e";

    // The footer credits the art actually ON the page (user ruling
    // 2026-08-08): the portrait's PATH picks its attribution line, so an
    // Aspeheim page never credits Tlomdev and vice versa. Lydia Comer's
    // grant is NOT CC — her line says all rights reserved. A custom image
    // or core's mystery-man earns no art line at all; the game-text credit
    // always prints, because the page always reproduces licensed prose.
    const ART_CREDITS = [
      ["art/jon-aspeheim/", "CAIRN.PrintCreditAspeheim"],
      ["art/tlomdev/", "CAIRN.PrintCreditTlomdev"],
      ["art/lydia-comer/", "CAIRN.PrintCreditLydiaComer"],
      ["art/game-icons/", "CAIRN.PrintCreditGameIcons"],
      ["mondolme/icons/", "CAIRN.PrintCreditGameIcons"],
    ];
    const artCredit = ART_CREDITS.find(([prefix]) => (actor.img ?? "").includes(prefix))?.[1];
    // NO per-background credit line. The `attribution` field it printed is gone
    // from BackgroundData: a Warden writes their own backgrounds in their own
    // world, and a per-document citation line was machinery for a shipped
    // catalogue this system no longer has. Cairn's own credit below is
    // unconditional and covers the rules the page reproduces.
    //
    // The generated-with line is unconditional and joined LAST (user ask
    // 2026-08-21): every footer, every role, ENDS with it.
    const credits = [L("CAIRN.PrintCreditText"),
      artCredit ? L(artCredit) : "",
      L("CAIRN.PrintCreditGenerated")].filter(Boolean).join(" ");

    const context = {
      lang: game.i18n.lang,
      isChar,
      credits,
      name: actor.name ?? "",
      portrait: abs(actor.img),
      // The "Compatible with Cairn 2e" badge, top right of a character page
      // (user ask 2026-08-16 — the header's right side was empty). The SAME
      // unmodified file the sheet shows, shipped under CC BY-SA 4.0 from
      // cairnrpg.com/resources/logos; its attribution to Yochai Gal is the
      // footer credit that already prints on every page, which is why no
      // caption rides with it here (see logo/README.md — ship it unmodified).
      // Character pages only, matching the on-screen surface.
      compatBadge: isChar ? abs(`systems/${game.system.id}/logo/Cairn_Stamp.jpg`) : "",
      subtitle,
      // The source line prints only where it SAYS something (user ask
      // 2026-08-16). Canon 2e is dropped: the compatibility badge above it now
      // states Cairn 2e outright, and a parenthetical repeating the picture
      // beside it is noise. Custom stays — it is the one thing nothing else on
      // the page says — and so does Barebones, which names a different
      // generator rather than restating the badge.
      subtitleSource: !isChar ? ""
        : isCustomBg ? L("CAIRN.PrintSourceCustom")
          : sys.contentSource === "2e" ? ""
            : sourceLabel(sys.contentSource),
      // Barebones only, below the background, labelled per the user's exact
      // wording (2026-08-08). Same gate as the sheet: contentSource AND the
      // world setting, read live.
      failedCareer: isChar && sys.contentSource === "barebones"
        && game.settings.get(SETTINGS_NS, "barebones-failed-career")
        ? (sys.failedCareer ?? "") : "",
      pronouns: sys.pronouns,
      stats: {
        str: sys.abilities.STR.value, strMax: sys.abilities.STR.max,
        dex: sys.abilities.DEX.value, dexMax: sys.abilities.DEX.max,
        wil: sys.abilities.WIL.value, wilMax: sys.abilities.WIL.max,
        // The SOURCE HP, not the derived value: encumbrance and panic zero the
        // derived one, and a printout of "HP 0/4" for a loaded-but-healthy
        // character reads as dying rather than as slow.
        hp: actor._source.system.hp.value, hpMax: sys.hp.max,
        armor: sys.armor ?? 0,
        gold: sys.gold ?? 0,
      },
      status,
      // A thing's page is its CARGO (user ruling 2026-08-11, the ruling
      // that put Print on every sheet): the schema's 10/10/10 on a sack is
      // noise, not information, so the statblock section is creatures-only.
      showStats: !actor.isThing,
      marks: isChar ? { deprived: !!sys.deprived, panicked: !!sys.panicked } : null,
      traitsProse,
      // Kettlewright's two-column band (user rulings 2026-08-08): Stats and
      // Items on the left; the background's description then Traits beside
      // them (Background on top since 2026-08-21). With nothing for the right
      // column — a monster, usually — the band collapses to one column rather
      // than printing at half width. The Q&A prints full-width below the
      // band. Connections was the third right-column section until
      // 2026-08-13; see above.
      hasSide: !!(traitsProse || backgroundDesc),
      backgroundDesc,
      questions,
      // A standalone npc page takes the same rule as the connected sections
      // below (the falcon trap): the slot fraction only where slots are
      // AUTHORED — derived slotsMax floors at the world setting — and no
      // Items section at all on a slotless creature carrying nothing. A
      // character always shows both.
      main: {
        used: sys.slotsUsed, max: sys.slotsMax, rows: mainRows,
        showSlots: isChar || (sys.slots ?? 0) > 0,
        show: isChar || mainRows.length > 0 || (sys.slots ?? 0) > 0,
      },
      // One inventory section per connected actor that can HOLD something —
      // KW's multi-container layout, without the slot fraction for 0 slots. A
      // 0-slot companion carrying nothing is Connections' business, not an
      // empty inventory heading. The test is the AUTHORED `slots` override,
      // never derived slotsMax: calcCurrentMaxSlots floors an npc's maximum
      // at the world's max-equip-slots setting, so a falcon's slotsMax reads
      // 10 while the creature owns no slots at all — the probe's first run
      // caught exactly that.
      containers: actor.connectedActors().map((c) => ({
        name: c.name,
        used: c.system.slotsUsed,
        max: c.system.slotsMax,
        showSlots: (c.system.slots ?? 0) > 0,
        rows: rows(c, c.items.contents),
      })).filter((s) => s.showSlots || s.rows.length),
      description: await enrich(isChar ? sys.description : (sys.description ?? "")),
      bonds: (sys.bonds ?? []).map((b) => String(b?.description ?? "").trim()).filter(Boolean),
      // The Warden's show-omens switch reaches the PAPER too (ruling
      // 2026-08-17: one switch, both surfaces — a field hidden on the sheet
      // must not reappear in print). No template change needed: the section is
      // `{{#if omen}}`, so an empty string drops it whole, heading included —
      // the same empty-sections-are-OMITTED rule the disabled omen already
      // rode.
      //
      // `omenVisible`, not the setting alone: this read carried ONLY the switch
      // and so printed an Omen section for a legacy Barebones character whose
      // own sheet hides it (review #16). The sheet reads the same helper, which
      // is what stops the two answering differently again.
      omen: sys.omenEnabled && omenVisible(actor)
        ? String(sys.omen ?? "").trim()
        : "",
      scars: [...(sys.scars ?? [])],
      notes: await enrich(sys.notes),
    };

    const html = await foundry.applications.handlebars.renderTemplate(
      "systems/mondolme/templates/print/character-print.html", context);
    win.document.open();
    win.document.write(html);
    win.document.close();

    // Print only after the portrait has settled — the browser otherwise
    // snapshots a page with an empty circle where the face goes. The timeout
    // keeps a dead image path from holding the dialog hostage.
    const img = win.document.querySelector("header.pc img");
    if (img && !img.complete) {
      await new Promise((res) => {
        img.addEventListener("load", res, { once: true });
        img.addEventListener("error", res, { once: true });
        setTimeout(res, 3000);
      });
    }
    win.focus();
    win.print();
  }

  /**
   * Set the actor portrait and its token together. The token is the shipped
   * prepped art paired with the portrait by filename; for a custom image with no
   * paired token, the portrait itself is used so the token is never left stale.
   * @private
   */
  async _setPortrait(img) {
    const tokenSrc = (await pairedTokenFor(img)) ?? img;
    await this.actor.update({ img, "prototypeToken.texture.src": tokenSrc });
    for (const token of this.actor.getActiveTokens()) {
      await token.document.update({ "texture.src": tokenSrc });
    }
  }

  /**
   * Set a container's art and its token together. Unlike a character portrait
   * there is no paired token file -- the same image serves both.
   *
   * ART ONLY, since 2026-08-02 (ruled): picking a picture never writes the
   * Kind or the capacity — "change an image should not change the Role or
   * Type". This used to be the gallery's double duty (the barrel glyph also
   * said "this is a barrel"), which meant a Warden could not dress a crate in
   * barrel art without re-kinding it, and the ONLY way to change the role was
   * through the picker. The direction that survives is the other one: a KIND
   * change stamps default art, and only while the current art is stock
   * (CairnActor._preUpdate) — mix and match is the rule, defaults are the
   * courtesy.
   * @param {String} img
   * @private
   */
  async _setContainerArt(img) {
    await this.actor.update({ img, "prototypeToken.texture.src": img });
    for (const token of this.actor.getActiveTokens()) {
      await token.document.update({ "texture.src": img });
    }
  }

  /* -------------------------------------------- */
  /*  Actions — header                            */
  /* -------------------------------------------- */

  /**
   * Roll the whole actor again. BOTH branches ask first.
   *
   * The NPC branch used to re-roll on a single click, on the reasoning that "a
   * hireling's statblock is disposable by design". That was written when only
   * `hireling` reached it. Folding hireling into npc silently widened it to the
   * whole bestiary: all 205 shipped monsters are `type: npc`, at the time none
   * declared `generationEnabled` (it defaulted TRUE then; since e6b362a every
   * shipped monster pins `false`, and since 2026-08-02 the schema initial is
   * false too) and `show-generate-header` defaults true — so the button
   * rendered on every monster for anyone who owned it, and `regenerateNpc`
   * deletes every embedded Item and overwrites the statblock. One click turned
   * a shipped Gorilla into an Alchemist (observed 2026-07-30: `Fists*` → six
   * pieces of gear, STR 14→8, HP 4→2), with no dialog and no undo.
   *
   * The confirmation is NOT worded via `_wording()`: that helper picks a `…Npc`
   * variant whenever `game.i18n.has()` is true, and `has()` consults the English
   * fallback, so a variant key silently un-translates a string every language
   * already has. These are new keys with no base-key twin, so they carry no such
   * risk.
   * @this {CairnActorSheet}
   */
  static async #onRollActor(event) {
    event.preventDefault();
    // The allow-player-randomization refusal is the mayRandomize() wrapper in
    // the action map — one declaration for the whole surface, this handler
    // included, since review #13 found the guard lived here and in
    // #onToggleGeneration while ten hidden dice answered a call unguarded.
    // The same guard the bond/trait re-roll handlers carry. Every branch below
    // AWAITS a dialog and then wipes and rebuilds the actor, so two clicks in
    // quick succession both get past the confirmation and both regenerate --
    // the second one throwing away a character the first just made. Harmless to
    // miss while generation was silent; with the chat card it also posts two
    // sets of dice for one gesture, which is how it would be noticed.
    if (this._rerolling) return;
    this._rerolling = true;
    try {
      // A monster-role npc has NOTHING to re-roll since the monster generator
      // was deleted (2026-08-29): this branch used to open the tier picker and
      // hand off to `regenerateMonster`. The guard STAYS, as a refusal rather
      // than a fall-through, because falling through is the bug — the branches
      // below key on `npcRole === "npc"`, so a monster would take the HIRELING
      // path, have every item deleted and come back as an Alchemist with a day
      // rate. That is precisely the Gorilla-into-Alchemist path this handler's
      // docblock records as closed, and deleting the generator must not reopen
      // it. A monster is written by hand now, so the button says so and stops.
      if (this.actor.npcRole === "monster") {
        ui.notifications.info(game.i18n.localize("CAIRN.Notify.MonsterNoGenerator"));
        return;
      }
      const isNpc = ["hireling", "npc"].includes(this.actor.type);
      // THE WARNING HAS TO MATCH WHAT THE BUTTON DOES, and after the
      // 2026-08-20 split one string could not: the shipped wording promises
      // that "everything it is carrying will be deleted" and that "abilities,
      // HP, career and day rate will be replaced", which is exactly
      // regenerateHireling and none of regenerateNpc — an NPC keeps its gear
      // and its statblock and gets a new Background, traits, pronouns and age.
      // A Warden who cancelled to save gear that was never at risk was talked
      // out of the feature by its own dialog.
      //
      // The unsuffixed CAIRN.NpcRegenerator* pair is the HIRELING's now. Not
      // renamed to say so: its text is still exactly right for that role and
      // renaming would orphan a translation that is still correct, for a
      // reader the comment can serve instead.
      const metNpc = isNpc && this.actor.npcRole === "npc";
      const titleKey = metNpc ? "CAIRN.NpcRoleRegeneratorTitle"
        : isNpc ? "CAIRN.NpcRegeneratorTitle" : "CAIRN.CharacterRegeneratorTitle";
      const confirmKey = metNpc ? "CAIRN.NpcRoleRegeneratorConfirm"
        : isNpc ? "CAIRN.NpcRegeneratorConfirm" : "CAIRN.CharacterRegeneratorConfirm";
      // DialogV2.confirm already makes "No" the default button, so V1's
      // defaultYes: false has no equivalent to carry over.
      const confirm = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize(titleKey) },
        content: `<p>${game.i18n.localize(confirmKey)}</p>`,
        rejectClose: false,
      });
      if (!confirm) return;
      // Two person roles since 2026-08-20, and they regenerate differently: a
      // hireling gets a whole new career, statblock and loadout, an NPC a new
      // Background and traits with their gear left alone. Keyed on the ROLE,
      // not the type — a `hireling`-TYPED document reads role hireling through
      // npcRole whatever it stores, so the alias is covered by the same test.
      if (isNpc) {
        if (this.actor.npcRole === "npc") await regenerateNpc(this.actor);
        else await regenerateHireling(this.actor);
      } else await regenerateActor(this.actor);
    } finally {
      this._rerolling = false;
    }
  }

  /**
   * Flip random-generation mode for this actor. Under AppV1 this had to rewrite
   * the header's innerHTML by hand; here the update alone is enough, because the
   * re-render it triggers reaches `_onRender` → #syncGenerationButtons, which
   * toggles `cairn-header-hidden` on the Roll button already in the frame.
   *
   * NOT through `_getHeaderControls` — this sheet does not override it, and a
   * comment here claimed it did until 2026-08-07. These are FRAME buttons
   * (`_getFrameButtons`, above), and `_renderFrame` runs only on FIRST render,
   * so re-returning a different array would change nothing on a live sheet.
   * That is the whole reason #syncGenerationButtons exists.
   * @this {CairnActorSheet}
   */
  static async #onToggleGeneration(event) {
    event.preventDefault();
    // The switch refusal is the mayRandomize() wrapper in the action map.
    await this.actor.update({ "system.generationEnabled": this.actor.system.generationEnabled === false });
  }

  /* -------------------------------------------- */
  /*  Actions — portrait and name                 */
  /* -------------------------------------------- */

  /**
   * Click the portrait to pick a new one. A container gets the transport/container
   * art gallery instead of the character portrait gallery -- different art, and no
   * paired token file. Every other role, NPCs included, gets the character portrait
   * gallery: an NPC is as much a face at the table as a PC is.
   * @this {CairnActorSheet}
   */
  static async #onEditPortrait(event) {
    // A thing-role npc is a container in every sense that matters here, and a
    // MOUNT wants the horse/mule glyphs, not 80 human portraits — so all three
    // container-line roles get the container gallery.
    const isContainerish = this.actor.isThing || this.actor.npcRole === "companion";
    return isContainerish
      ? this._pickContainerArt(event)
      : this._pickPortrait(event);
  }

  /**
   * Dice on the portrait: roll a random one FROM THE FOLDER THE CURRENT
   * PORTRAIT CAME FROM — Aspeheim rolls Aspeheim, a custom portrait rolls the
   * Warden's folder, a game-icons or tlomdev pick rolls its own category, so a
   * beast stays a beast. An image from no known gallery folder falls back to
   * the auto-assignment pool (custom when non-empty, else Aspeheim), which was
   * this die's whole behaviour before the rule. Reuses _setPortrait so the
   * paired token swaps too (non-Aspeheim art is its own token).
   *
   * The ACTOR decides which custom folder counts (issue #18): a reserved
   * `monster/` folder keeps a monster's die inside it. Passed from here rather
   * than derived down there, because the die is the one caller that has the
   * actor in hand — everything else knows only what it is making.
   * @this {CairnActorSheet}
   */
  static async #onRollPortrait(event) {
    event.preventDefault();
    event.stopPropagation();
    const src = await randomPortraitInSameFolder(this.actor.img, portraitCategoryFor(this.actor));
    if (!src) return;
    await this._setPortrait(src);
  }

  /**
   * Dice beside the name. Both sheets carry one, but they draw from different
   * sources -- an NPC's name comes from its own spark table, a character's
   * from the background's example names.
   *
   * 2e names come from the CURRENT background's example-name list (so the name
   * still suits the background after it has been changed); Barebones falls back
   * to its spark table. Active tokens are renamed too, as regeneration does,
   * so a token on the canvas never keeps the discarded name.
   * @this {CairnActorSheet}
   */
  static async #onRollName(event) {
    event.preventDefault();
    if (["hireling", "npc"].includes(this.actor.type)) {
      await rerollNpcName(this.actor);
      return;
    }
    let name = null;
    if (this.actor.system.contentSource === "2e" && this.actor.system.backgroundUuid) {
      const bg = await fromUuid(this.actor.system.backgroundUuid);
      const names = bg?.system?.names ?? [];
      if (names.length) name = names[Math.floor(Math.random() * names.length)];
    }
    if (!name) {
      name = await rollNameFromTable(CONFIG.Cairn?.barebonesGenerator?.name, this.actor.name);
    }
    if (!name || name === this.actor.name) return;
    // The tokens follow through CairnActor's rename rule (every scene, only
    // the ones still wearing the old name) — this used to rename the ACTIVE
    // scene's tokens by hand, unconditionally, and nothing else did.
    await this.actor.update({ name });
  }

  /**
   * The die beside the job field, which is two fields wearing one control:
   * a hireling's **Career** and an NPC's **Background**. One action because the
   * template renders one row — `showCareer` and `showBackground` are mutually
   * exclusive — and one handler is what stops the two drifting into separate
   * dice that behave differently for no reason a Warden could name.
   *
   * They do different work, and the asymmetry is the split itself: a 2e
   * career's stats ARE its profession, so re-rolling one adopts a whole new
   * statblock and loadout. A Background is one word off a table and touches
   * nothing else. Both keep the name, portrait and notes.
   * @this {CairnActorSheet}
   */
  static async #onRollProfession(event) {
    event.preventDefault();
    if (this.actor.npcRole === "npc") await rerollNpcBackground(this.actor);
    else await rerollHirelingCareer(this.actor);
  }

  /**
   * Faction-only die: fill system.faction from the world-first Facción table.
   * Touches nothing else — a side is not a statblock.
   * @this {CairnActorSheet}
   */
  static async #onRollFaction(event) {
    event.preventDefault();
    await rerollNpcFaction(this.actor);
  }

  /**
   * Career / Background picker (2026-08-21): the magnifying glass beside the
   * die, dispatching on role exactly as the die does. Offered whether or not
   * Randomization is on — a deliberate choice is not randomization — and to
   * the Warden only (see _mayRandomize's npc-type gate).
   * @this {CairnActorSheet}
   */
  static async #onPickProfession(event) {
    event.preventDefault();
    if (this.actor.npcRole === "npc") await promptNpcBackground(this.actor);
    else await promptHirelingCareer(this.actor);
  }

  /** Faction picker: the same world-first table the Faction die rolls.
   *  @this {CairnActorSheet} */
  static async #onPickFaction(event) {
    event.preventDefault();
    await promptNpcFaction(this.actor);
  }

  /* -------------------------------------------- */
  /*  Actions — inventory                         */
  /* -------------------------------------------- */

  /**
   * Handle creating a new Owned Item for the actor.
   * @this {CairnActorSheet}
   */
  static async #onItemCreate(event) {
    event.preventDefault();
    const template = "systems/mondolme/templates/dialog/add-item-dialog.html";
    const content = await foundry.applications.handlebars.renderTemplate(template);

    await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("CAIRN.CreateItem") },
      content,
      ok: {
        icon: "fas fa-check",
        label: game.i18n.localize("CAIRN.CreateItem"),
        // DialogV2 hands the callback the clicked BUTTON; button.form is the
        // dialog's own form, which is why the content template must not carry
        // one of its own.
        callback: async (dialogEvent, button) => {
          const form = button.form;
          if (form.itemname.value.trim() !== "") {
            await this.actor.createOwnedItem({
              name: form.itemname.value,
              type: form.itemtype.value,
              weightless: form.itempetty.checked,
            });
          }
        },
      },
      rejectClose: false,
    });
  }

  /**
   * Open the marketplace (buy/take gear). Anything that cannot KEEP a
   * connection is scoped to gear only — no buying a cart into a sack.
   *
   * Keyed on `canKeepConnected`, which is the same test `acquireTransport`
   * refuses on, so the shop never offers a row it would then reject. It used to
   * be `type === "container"`, which under the roles model excluded nothing: an
   * npc mule IS a container and its sheet carries this link (the same gap
   * review #5 closed on the marketplace's own side, one caller short).
   * @this {CairnActorSheet}
   */
  static #onItemShop(event) {
    event.preventDefault();
    // .catch, because a rejection out of an un-awaited openMarketplace was
    // dropped whole — the button appeared to do nothing, the failure mode
    // the shop's own header comment records having shipped once (review #9).
    const opts = this.actor.canKeepConnected ? undefined : { exclude: TRANSPORTS_CATEGORY };
    openMarketplace(this.actor, opts).catch((err) => {
      console.error("Mondolme | marketplace failed to open:", err);
      ui.notifications.error(game.i18n.localize("CAIRN.Notify.DropFailed"));
    });
  }

  /** @this {CairnActorSheet} */
  static #onItemEdit(event, target) {
    event.preventDefault();
    this._openItemSheet(target);
  }

  /** @this {CairnActorSheet} */
  static #onItemDelete(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    if (!row) return;
    // No optimistic slide, on EITHER branch. Both helpers await a confirm dialog
    // before deleting anything, so sliding here animated the row away while the
    // question was still on screen — answer "no" and the item was still there
    // with its row gone, until something re-rendered the sheet and put it back.
    // The connected-actor branch stopped doing this in review #5 (an Actor delete
    // can also be refused by the server: Assistant+, ungrantable); the item branch
    // — and the feature branch, while the Features UI existed — was not brought in
    // line until review #7, though the decline half of the reasoning covers them
    // all. On success the delete re-renders this sheet
    // — descendant deletes render the parent (client-document.mjs:691-694) — and
    // the row goes with it.
    if (row.dataset.isContainer) this.actor.deleteOwnedContainer(row.dataset.itemId);
    else this.actor.deleteOwnedItem(row.dataset.itemId);
  }

  /**
   * Unlink a connected actor: it survives, connected to nobody, which under the
   * container rule IS a loot pile. Sits beside the trash rather than replacing
   * it, because "destroy this cart" and "drop this cart here" are different
   * intentions and the tab used to offer only one icon for both — one that
   * asked "Delete X?" and then unlinked.
   * @this {CairnActorSheet}
   */
  static #onContainerUnlink(event, target) {
    event.preventDefault();
    // Parked UI (2026-08-09): the control is hidden, the refusal is the wall —
    // a sheet rendered before the park must not be a way in.
    if (!connectionsUiEnabled()) return;
    const row = CairnActorSheet.#row(target);
    if (!row?.dataset.isContainer) return;
    // Both ends, per row — unlinkOwnedContainer re-checks; this just refuses
    // politely if a hidden control got reached anyway.
    const child = game.actors.find((a) => a.uuid === row.dataset.itemId);
    if (!game.user.isGM && !(this.actor.isOwner && child?.isOwner)) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.ConnectionOwnBothEnds"));
      return;
    }
    // Not slid up: unlinking leaves the actor in the world, and the row simply
    // stops matching on the next render. Animating it away would suggest the
    // thing itself had gone.
    this.actor.unlinkOwnedContainer(row.dataset.itemId).then(() => this.render(false));
  }

  /** @this {CairnActorSheet} */
  static async #onItemToggleEquipped(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    const item = this.actor.getOwnedItem(row?.dataset.itemId);
    if (item) await item.update({ "system.equipped": !item.system.equipped });
  }

  /* `#onPageTransmute` stood here and is GONE with the bound-page machinery it
     drove. It turned a spellbook or spellscroll into a page written into the
     carried Grimoire — weightless, grouped under the book, no way back. There
     is no "write this spell into that book" gesture in the system now: a
     Libro's three spells are its own fields, typed on its own sheet. */


  /**
   * The Cast control on a LIBRO's row. The row names WHICH book — that is the
   * whole answer to "which of my two books did you mean" — and the picker then
   * only has to ask which page. Everything real (the page picker, the language
   * gate, the dice cap, the roll, both cards) lives in module/magic.js; every
   * guard re-derives there, so a stale row control cannot cast from a book that
   * has left, emptied, or become unreadable.
   * @this {CairnActorSheet}
   */
  static async #onBookCast(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    const item = this.actor.getOwnedItem(row?.dataset.itemId);
    // `?? null` rather than a bail: with no resolvable book, castFromBook falls
    // back to offering every readable book's pages in one picker — which is the
    // right answer for a row whose item has just gone, and never a silent pick.
    await castFromBook(this.actor, item ?? null);
  }

  /**
   * The Cast control on a HECHIZO's row — no book required, the spell is its
   * own text. With Pergamino ticked it is the same cast, asked about first and
   * destroyed after. All guards re-derive in module/magic.js.
   * @this {CairnActorSheet}
   */
  static async #onSpellCast(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    const item = this.actor.getOwnedItem(row?.dataset.itemId);
    if (item) await castSpell(this.actor, item);
  }

  /** Not exactly quantity, this is about uses. @this {CairnActorSheet} */
  static async #onItemAddUse(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    const item = this.actor.getOwnedItem(row?.dataset.itemId);
    if (!item) return;
    await item.update({
      "system.uses.value": Math.min(item.system.uses.value + 1, item.system.uses.max),
    });
  }

  /** @this {CairnActorSheet} */
  static async #onItemRemoveUse(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    const item = this.actor.getOwnedItem(row?.dataset.itemId);
    if (!item) return;
    // ONE write whether or not the tick rolls a unit over (review #13 #20).
    // The rollover case used to be two sequential updates — quantity first,
    // then the refilled uses — which was two operations for a single click,
    // and once the ledger logs item updates, two whispered cards for one
    // press of one button. Merged, quantity and uses also move together or
    // not at all.
    const update = {};
    let val = Math.max(item.system.uses.value - 1, 0);
    if (val === 0 && item.system.quantity > 1) {
      update["system.quantity"] = item.system.quantity - 1;
      val = item.system.uses.max;
    }
    update["system.uses.value"] = val;
    await item.update(update);
  }

  /**
   * Expand a row to show what it holds: a container's contents, or an item's
   * description plus its critical-damage line.
   * @this {CairnActorSheet}
   */
  static #onItemDescription(event, target) {
    event.preventDefault();
    const row = CairnActorSheet.#row(target);
    if (!row) return;
    this._toggleRowDescription(row);
  }

  /**
   * Fatigue is NEVER refused, at any load. It is a cost the rules impose, not a
   * purchase — a full pack does not stop a spell being cast — so the character
   * takes it and goes over capacity, and the player decides what to shed to get
   * a free slot back.
   *
   * This used to refuse TWICE, here and again inside `createOwnedItem`, which is
   * why `ignoreCapacity` is passed as well as this guard being gone: removing
   * either one alone leaves the button refusing and looks like a landed fix.
   *
   * @this {CairnActorSheet}
   */
  static async #onAddFatigue(event) {
    event.preventDefault();
    // The header is hidden on a thing (system.showFatigue), and this refuses on
    // one. That split is the house rule the marketplace already follows: the
    // hiding is the AFFORDANCE, this is the ENFORCEMENT. A sheet left open while
    // an actor's role changed to container still has a live button, and the
    // action is reachable by uuid regardless of what was rendered.
    if (this.actor.isThing) {
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.NoFatigueOnThing", {
        name: this.actor.name,
      }));
      return;
    }
    await this.actor.createOwnedItem(
      { name: FATIGUE_NAME, type: "item" },
      { ignoreCapacity: true }
    );
    // A notice, never a refusal, and only when this click is what tipped them
    // over. The stored name is English by design, so localize it for display the
    // way the inventory rows do.
    if (this.actor.isEncumbered()) {
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.Overloaded", {
        name: game.i18n.localize("CAIRN.Fatigue"),
      }));
    }
  }

  /** @this {CairnActorSheet} */
  static #onRemoveFatigue(event) {
    event.preventDefault();
    const fatigue = this.actor.items.find((i) => i.name === FATIGUE_NAME);
    if (fatigue) this.actor.deleteOwnedItem(fatigue.id);
  }

  /**
   * Roll a weapon's damage, honouring panic (a panicked character rolls d4
   * regardless of the weapon), the impaired/enhanced choice, and any targeted
   * tokens.
   *
   * Both sheets share `templates/parts/items-list.html`, so a Warden rolling a
   * monster's damage gets the same dialog a player does — one surface, not two.
   *
   * A RANGED WEAPON SPENDS AMMUNITION, and that is the one thing here that
   * touches the item document. See the guard below for where in the sequence
   * the spend happens and why.
   * @this {CairnActorSheet}
   */
  static async #onRollDamage(event, target) {
    event.preventDefault();
    const dataset = target.dataset;
    if (!dataset.roll) return;

    // AMMUNITION. The row's own item, resolved here because this handler has
    // never needed the document before — everything else it uses rides on the
    // control's dataset.
    //
    // An empty quiver REFUSES: no dialog, no roll, no card. Firing a bow with
    // nothing to fire is not an impaired roll, it is not a roll, and the
    // warning is what tells the player which of the two just happened.
    //
    // A non-ranged weapon, and every other row that can roll damage (a
    // monster's claws), is untouched — `usesAsNumbers` is false for all of
    // them, so neither the refusal nor the spend can reach them.
    const rangedItem = (() => {
      const row = CairnActorSheet.#row(target);
      const item = this.actor.items.get(row?.dataset.itemId ?? "");
      return item?.system?.usesAsNumbers ? item : null;
    })();
    if (rangedItem && (rangedItem.system.uses?.value ?? 0) <= 0) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.NoAmmo"));
      return;
    }

    const usePanic = game.settings.get(SETTINGS_NS, "use-panic");
    const panicked = usePanic && this.actor.system.panicked;

    // PANIC IMPOSES IMPAIRED, and offers no choice (user ruling 2026-08-07).
    // Panic's d4 is not a separate substitution any more — it IS the impaired
    // die, expressed through the same helper, which is the tidy-up the design
    // note called optional. A panicked character cannot roll normal or enhanced,
    // so the dialog does not open at all rather than opening with two buttons
    // that would be refused.
    //
    // This does NOT make the mechanic depend on panic. `damageFormulaFor` still
    // reads no setting and no actor; the caller decides. With use-panic off,
    // `panicked` is false and every roll is asked for as normal — which is the
    // whole reason the seam is where it is.
    let quality;
    if (panicked) quality = "impaired";
    else {
      // The item's name goes to the dialog's title. `dataset.label` is stamped by
      // items-list.html as data-label="{{item.name}}", so it is already the
      // display name — a control with none falls back to the plain title.
      quality = await askDamageQuality(dataset.roll, dataset.label ?? "");
      if (quality === null) return; // dismissed: roll nothing
    }
    const formula = damageFormulaFor(quality, dataset.roll);

    // THE SPEND, after the dialog and before the roll. After the dialog because
    // dismissing it rolls nothing and must therefore cost nothing — the `return`
    // above is the only exit between the refusal and here. Before the roll
    // because the arrow leaves the bow whatever the die then says; a miss is
    // still a shot.
    //
    // Re-read off the document rather than trusting the value the refusal saw:
    // the dialog is an await, and a second client (or the +/- controls on the
    // same row) can empty the quiver while it is open. Clamped at 0 so a racing
    // pair of rolls cannot drive the counter negative.
    if (rangedItem) {
      const left = rangedItem.system.uses?.value ?? 0;
      if (left <= 0) {
        ui.notifications.warn(game.i18n.localize("CAIRN.Notify.NoAmmo"));
        return;
      }
      await rangedItem.update({ "system.uses.value": left - 1 });
    }

    const roll = await evaluateFormula(formula, this.actor.getRollData());
    // Two whole-sentence keys, not fragments glued with `+`: word order is not
    // universal, and the translator could not move the weapon name or the
    // parenthetical. Same rule as _buildTraitSentence and _prepareConnectionLabel.
    const label = dataset.label
      ? game.i18n.format(panicked ? "CAIRN.RollingDmgWithWeaponPanic" : "CAIRN.RollingDmgWithWeapon",
        { weapon: dataset.label })
      : "";

    const targetedTokens = Array.from(game.user.targets).map((tk) => tk.id);
    const targetIds = targetedTokens.length ? targetedTokens.join(";") : null;

    const flavor = await foundry.applications.handlebars.renderTemplate(
      "systems/mondolme/templates/chat/dmg-roll-card.html",
      {
        label, targets: targetIds,
        // The weapon travels as a datum too — the attack line rebuilds the
        // sentence at render and cannot read it back out of localized prose.
        weapon: dataset.label ?? "",
        quality: damageQualityLabel(quality, { panicked }),
      }
    );
    roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), flavor });
  }

  /* -------------------------------------------- */
  /*  Actions — connections                       */
  /* -------------------------------------------- */

  /**
   * Connect an EXISTING world actor to this one — the tab's headline gesture.
   * The graph is FLAT (2026-08-01): every edge is PC → non-character, so this
   * renders on a character's sheet and nowhere else. The marketplace link this
   * replaced still exists on the Items tab; the Connections tab is about
   * relationships, not shopping.
   *
   * The pick-list is pre-filtered to what `connectActor` would accept — role
   * may be connected, not already connected, no cycle, and the user can write
   * it — so the dialog never offers a refusal. connectActor still guards; the
   * filter is a courtesy, not the wall.
   * @this {CairnActorSheet}
   */
  static async #onConnectionAdd(event) {
    event.preventDefault();
    // Parked UI (2026-08-09): hidden control, handler wall (stale sheets).
    if (!connectionsUiEnabled()) return;
    // connectActor re-checks; refusing before the dialog just spares a
    // gesture from users who found the action some way the template gating
    // does not cover. This is the keeper-side HALF of the both-ends wall —
    // the candidate filter's canUserModify below is the per-target half, so
    // a player is only ever offered children the whole wall would accept.
    if (!game.user.isGM && !this.actor.isOwner) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.ConnectionOwnBothEnds"));
      return;
    }
    if (!this.actor.canKeepConnected) {
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.NoNesting", { name: this.actor.name ?? "" }));
      return;
    }
    // Refuse at the ceiling BEFORE the picker, not after a choice: the dialog's
    // whole contract is that everything it offers can actually be connected.
    if (atConnectionLimit(this.actor)) {
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.ConnectionLimit", {
        name: this.actor.name ?? "",
        max: maxConnections(),
      }));
      return;
    }
    const candidates = game.actors
      .filter((a) => a.uuid !== this.actor.uuid
        // `canBeConnected` is false for every character now (a PC is never
        // kept), so the Round 2 pair-rule clause that used to sit here — offer
        // characters only to another character — has nothing left to exclude.
        && a.canBeConnected
        && !a.system?.connectedTo
        && !this.actor.wouldCreateConnectionCycle(a)
        && a.canUserModify(game.user, "update"))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if (!candidates.length) {
      ui.notifications.info(game.i18n.localize("CAIRN.Notify.NoConnectables"));
      return;
    }
    const options = candidates
      .map((a) => `<option value="${a.uuid}">${foundry.utils.escapeHTML(a.name)}</option>`)
      .join("");
    const content = `<div class="form-group">
        <label>${game.i18n.localize("CAIRN.ConnectionPick")}</label>
        <select name="connectionTarget">${options}</select>
      </div>`;
    await foundry.applications.api.DialogV2.prompt({
      // ONE verb (2026-08-01): both ends' dialogs read CAIRN.Connect. The
      // handlers stay separate — this one picks a child for a keeper, the
      // attach one picks a keeper for a child — but the word is the word.
      window: { title: game.i18n.localize("CAIRN.Connect") },
      content,
      ok: {
        icon: "fas fa-link",
        label: game.i18n.localize("CAIRN.Connect"),
        callback: async (dialogEvent, button) => {
          const uuid = button.form.connectionTarget?.value;
          const target = game.actors.find((a) => a.uuid === uuid);
          if (target) await this.actor.connectActor(target);
        },
      },
      rejectClose: false,
    });
  }

  /**
   * The same edge from the CHILD end: pick a keeper for THIS actor (Round 2).
   * Renders on any connectable, unconnected actor's tab — a sack, a mount, a
   * player character joining another's roster. The write is identical to Add
   * Connection's (`keeper.connectActor(child)`); only the sheet it starts
   * from differs, so every guard is connectActor's.
   * @this {CairnActorSheet}
   */
  static async #onConnectionAttach(event) {
    event.preventDefault();
    // Parked UI (2026-08-09): hidden control, handler wall (stale sheets).
    if (!connectionsUiEnabled()) return;
    const child = this.actor;
    // The child-side half of the both-ends wall; the keeper filter below adds
    // the other half, so a player is only offered keepers they own.
    if (!game.user.isGM && !child.isOwner) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.ConnectionOwnBothEnds"));
      return;
    }
    if (child.system.connectedTo) return;             // one upward link, ever
    // Refuse from the child's own end. This replaces the Round 2 pair-rule
    // clause in the filter below (which offered a character none but other
    // characters): a PC is never kept, so there is no keeper to narrow to —
    // and unlike a filter that quietly returns an empty list, this says why.
    // It covers the monster and unlinked-token cases in the same breath.
    if (!child.canBeConnected) {
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.CannotConnect", { name: child.name ?? "" }));
      return;
    }
    const keepers = game.actors
      .filter((k) => k.uuid !== child.uuid
        && k.canKeepConnected
        // The per-keeper half of the both-ends wall: a player is offered only
        // keepers they own; the Warden is offered all of them.
        && (game.user.isGM || k.isOwner)
        // A character with no room left is not an eligible keeper. Filtered
        // rather than refused-on-choice, same contract as Add Connection's.
        && !atConnectionLimit(k)
        // Cycle check runs from the PROSPECTIVE KEEPER's side, exactly as
        // connectActor will: if the chain above k passes through child, the
        // link would loop.
        && !k.wouldCreateConnectionCycle(child))
      // Same name sort + label as Add Connection's picker.
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if (!keepers.length) {
      ui.notifications.info(game.i18n.localize("CAIRN.Notify.NoKeepers"));
      return;
    }
    const options = keepers
      .map((k) => `<option value="${k.uuid}">${foundry.utils.escapeHTML(k.name)}</option>`)
      .join("");
    const content = `<div class="form-group">
        <label>${game.i18n.localize("CAIRN.ConnectionPick")}</label>
        <select name="keeperTarget">${options}</select>
      </div>`;
    await foundry.applications.api.DialogV2.prompt({
      // The same ONE verb as Add Connection's dialog — see the note there.
      window: { title: game.i18n.localize("CAIRN.Connect") },
      content,
      ok: {
        icon: "fas fa-link",
        label: game.i18n.localize("CAIRN.Connect"),
        callback: async (dialogEvent, button) => {
          const uuid = button.form.keeperTarget?.value;
          const keeper = game.actors.find((k) => k.uuid === uuid);
          if (keeper) await keeper.connectActor(child);
        },
      },
      rejectClose: false,
    });
  }

  /**
   * Break the upward edge from the CHILD end (Round 2). Routes through the
   * keeper's own unlink — same confirm dialog, same formerlyBelongedTo stamp —
   * so the two ends cannot drift. The fallback
   * matters: a DANGLING link (keeper deleted, uuid resolving to nothing) has
   * no keeper to route through, and single-parent-ever refuses to reconnect
   * over it, so clearing it here is the only recovery the child has.
   * @this {CairnActorSheet}
   */
  static async #onConnectionDetach(event) {
    event.preventDefault();
    // Parked UI (2026-08-09): hidden control, handler wall (stale sheets).
    if (!connectionsUiEnabled()) return;
    const child = this.actor;
    const link = child.system.connectedTo || "";
    if (!link) return;
    const keeper = game.actors.find((a) => a.uuid === link);
    if (keeper) {
      // The both-ends wall lives in unlinkOwnedContainer; this pre-check just
      // says no before the confirm rather than after it.
      if (!game.user.isGM && !(child.isOwner && keeper.isOwner)) {
        ui.notifications.warn(game.i18n.localize("CAIRN.Notify.ConnectionOwnBothEnds"));
        return;
      }
      await keeper.unlinkOwnedContainer(child.uuid);
      return;
    }
    // A DANGLING keeper: the uuid resolves to nothing, so there IS no other
    // end to own — the child's owner suffices. This detach is the only
    // recovery a dangling link has (single-parent-ever refuses to reconnect
    // over it), which is why it must not demand an owner who no longer exists.
    if (!game.user.isGM && !child.isOwner) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.ConnectionOwnBothEnds"));
      return;
    }
    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CAIRN.UnlinkContainerTitle") },
      content: `<div class="cairn-confirm"><p class="cairn-confirm-q">${
        game.i18n.format("CAIRN.UnlinkContainerQ", {
          name: foundry.utils.escapeHTML(child.name ?? ""),
        })}</p></div>`,
      rejectClose: false,
      modal: true,
    });
    if (!proceed) return;
    // No formerlyBelongedTo stamp — the keeper's name is exactly the fact the
    // dangling uuid already failed to preserve. The broken ownership shape
    // rides along exactly as in unlinkOwnedContainer: GM writes it, a player
    // sets the sync flag and asks the active GM's client (monsters excluded).
    const changes = { "system.connectedTo": "" };
    if (child.npcRole !== "monster") {
      if (game.user.isGM) {
        changes.ownership = foundry.data.operators.ForcedReplacement.create(brokenOwnershipShape(child));
      } else {
        changes[`flags.mondolme.${OWNERSHIP_SYNC_FLAG}`] = true;
      }
    }
    await child.update(changes);
    if (!game.user.isGM && child.npcRole !== "monster") {
      game.socket.emit(`system.${game.system.id}`, { action: "ownershipSync", childUuid: child.uuid });
    }
  }

  /* The "Actions — features" section lived here and is gone with the Features
     UI (2026-08-09): #onFeatureCreate/Edit/Delete/Description, their DialogV2
     forms and the FEATURE_FLAGS list. Its two lessons live on with their
     survivors — the DialogV2 element-not-string content dodge is recorded at
     the role-pick dialog (actor.js, "ELEMENT content, not a string") and in
     warden-damage.js, and the sink-side cleaning it needed lives on in
     cleanDescription (utils.js), whose docblock keeps the XSS history. */

  /* -------------------------------------------- */
  /*  Actions — counters and buttons              */
  /* -------------------------------------------- */

  /**
   * A d20 save against an ability. On a failed STR save, offer to mark Critical
   * Damage — but only when STR is damaged and still above 0 (the crawling state;
   * STR 0 is Dead). A generic STR save at full health isn't Critical Damage.
   * Matches the sheet skull's gate.
   * @this {CairnActorSheet}
   */
  static async #onRollAbility(event, target) {
    event.preventDefault();
    const dataset = target.dataset;
    if (!dataset.roll) return;
    const roll = await evaluateFormula(dataset.roll, this.actor.getRollData());
    // A whole-sentence key, not localize()+concat — the translator owns the word order.
    const label = dataset.label ? game.i18n.format("CAIRN.RollingWhat", { what: dataset.label }) : "";
    const rolled = roll.terms[0].results[0].result;
    const failed = roll.total === 0;
    const result = failed ? game.i18n.localize("CAIRN.Fail") : game.i18n.localize("CAIRN.Success");
    const resultCls = failed ? "failure" : "success";
    const str = this.actor.system.abilities?.STR;
    const offerCrit =
      dataset.ability === "STR" && failed &&
      Number(str?.value) > 0 && Number(str?.value) < Number(str?.max);
    const critButton = offerCrit
      ? `<button type="button" class="mark-critical-damage">${game.i18n.localize("CAIRN.MarkCriticalDamage")}</button>`
      : "";
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: label,
      content: `<div class="dice-roll"><div class="dice-result"><div class="dice-formula">${roll.formula}</div><div class="dice-tooltip" style="display: none;"><section class="tooltip-part"><div class="dice"><header class="part-header flexrow"><span class="part-formula">${roll.formula}</span></header><ol class="dice-rolls"><li class="roll die d20">${rolled}</li></ol></div></section></div><h4 class="dice-total ${resultCls}">${result} (${rolled})</h4></div></div>${critButton}`,
    });
  }

  /**
   * Toggle STR Critical Damage (2e). Manual, per house style: the player marks
   * the failed-save crawling state; STR goes red and the banner appears.
   * Dead/Paralyzed/Delirious are automatic (ability at 0), not toggled here.
   * @this {CairnActorSheet}
   */
  static async #onToggleCritical(event) {
    event.preventDefault();
    await this.actor.update({ "system.critical": this.actor.system.critical !== true });
  }

  /** @this {CairnActorSheet} */
  static async #onArmorReset(event) {
    event.preventDefault();
    await this.actor.update({ "system.armorOverride": null });
  }

  /**
   * Rest restores HP (a DEPRIVED character cannot benefit from a rest). The
   * confirm reiterates the rule before committing.
   * @this {CairnActorSheet}
   */
  static async #onRest() {
    if (this.actor.system.deprived) return;
    if (!(await this._confirmAction("CAIRN.Rest", "CAIRN.RestTip", "CAIRN.RestConfirm"))) return;
    // abChangeLogAction names the button on the ledger card (whitelisted in
    // actor.js AUDIT_ACTIONS) — otherwise a Rest reads exactly like a hand
    // edit of HP.
    await this.actor.update(
      { "system.hp.value": this.actor.system.hp.max },
      { abChangeLogAction: "CAIRN.Rest" },
    );
  }

  /** @this {CairnActorSheet} */
  static async #onRestoreAbilities() {
    if (this.actor.system.deprived) return;
    if (!(await this._confirmAction("CAIRN.RestoreAbilities", "CAIRN.RestoreTip", "CAIRN.RestoreConfirm"))) return;
    // Restoring abilities to full also clears any Critical Damage: the wound
    // that status represents is healed once the attribute is back.
    await this.actor.update({
      "system.abilities.STR.value": this.actor.system.abilities.STR.max,
      "system.abilities.DEX.value": this.actor.system.abilities.DEX.max,
      "system.abilities.WIL.value": this.actor.system.abilities.WIL.max,
      "system.critical": false,
    }, { abChangeLogAction: "CAIRN.RestoreAbilities" });
  }

  /** @this {CairnActorSheet} */
  static async #onDieOfFate() {
    const roll = await evaluateFormula("1d6");
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: game.i18n.localize("CAIRN.DieOfFate"),
    });
  }

  /**
   * Double-click the Items tab to set this character's own equipment limit.
   * Bound in _onRender rather than declared as an action: the action system
   * covers clicks only, and a single click here belongs to the tab.
   * @private
   */
  async _onSetEquipmentLimit(event) {
    if (!game.settings.get(SETTINGS_NS, "character-inventory-limit")) return;
    event.preventDefault();
    await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("CAIRN.Settings.MaxEquipSlots.label") },
      position: { width: 150 },
      content: `<input name="slots" type="number" autofocus value="${this.actor.calcCurrentMaxSlots()}">`,
      ok: {
        label: game.i18n.localize("CAIRN.SetLimit"),
        // DialogV2 awaits a callback's return value, so awaiting here holds the
        // dialog's promise open until the write lands.
        callback: async (dialogEvent, button) => {
          await this.actor.update({ "system.slots": button.form.elements.slots.valueAsNumber });
        },
      },
      rejectClose: false,
    });
  }

  /* -------------------------------------------- */
  /*  Actions — description tab                   */
  /* -------------------------------------------- */

  /**
   * Re-roll the character's age into the age field, on the dice its BACKGROUND
   * names (`system.ageFormula`) — RAW `2d20 + 10` when the background says
   * nothing, and for anyone who has no background at all.
   * @this {CairnActorSheet}
   */
  static async #onRollAge(event) {
    event.preventDefault();
    // rollAge (not evaluateFormula) so the sheet re-roll reads the background's
    // formula exactly as generation does — the config value is only the
    // FALLBACK for a blank or invalid one. The background is resolved fresh
    // rather than read off the render context: a Warden may have edited the
    // formula since this sheet was drawn.
    const bg = await this._ageBackgroundDoc();
    const total = await rollAge(bg, CONFIG.Cairn?.characterGenerator2e?.biography?.age);
    await this.actor.update({ "system.age": String(total) });
  }

  /**
   * Roll the «Cumpleaños» table into the birthday field.
   *
   * roll(), not draw(), like every other pick-list read on this sheet: the
   * table's drawn state is never mutated, so a Warden's table cannot be
   * exhausted by a session of character creation. A missing table is reported
   * by `generatorTable` (once per session, via content-packs) rather than here
   * — this is a plain pick off a Generadores table, with none of the Omen die's
   * "you pressed this exact button" specificity to add.
   * @this {CairnActorSheet}
   */
  static async #onRollBirthday(event) {
    event.preventDefault();
    const table = await cachedGeneratorTable(TABLES.birthday);
    if (!table) return;
    const { results } = await table.roll();
    await this.actor.update({ "system.birthday": resultText(results?.[0]) });
  }

  /**
   * Roll the Omens table and drop the result into the omen field (enabled by its
   * checkbox). roll(), not draw(): the Omens table is read-only from here — the
   * drawn text is stored on the actor, nothing is automated.
   * @this {CairnActorSheet}
   */
  static async #onRollOmen(event) {
    event.preventDefault();
    if (!this.actor.system.omenEnabled) return;
    const omenTable = await cachedGeneratorTable(TABLES.omens, { quiet: true });
    if (!omenTable) {
      ui.notifications.warn(game.i18n.localize("CAIRN.OmenTableMissing"));
      return;
    }
    const { results } = await omenTable.roll();
    await this.actor.update({ "system.omen": resultText(results?.[0]) });
  }

  /**
   * Expand/collapse the trait pick-lists (+/-). Transient sheet state, so it
   * survives re-renders but is not stored on the actor. Defaults collapsed
   * (_prepareContext uses `?? true`), so read the effective value rather than
   * negating a maybe-undefined flag.
   * @this {CairnActorSheet}
   */
  static #onToggleTraits(event) {
    event.preventDefault();
    this._traitsCollapsed = !(this._traitsCollapsed ?? true);
    this.render(false);
  }

  /** @this {CairnActorSheet} */
  static #onToggleScars(event) {
    event.preventDefault();
    this._scarsCollapsed = !this._scarsCollapsed;
    this.render(false);
  }

  /** Collapse or expand the languages list. Mirrors #onToggleScars. */
  static #onToggleLanguages(event) {
    event.preventDefault();
    this._languagesCollapsed = !this._languagesCollapsed;
    this.render(false);
  }

  /* -------------------------------------------- */
  /*  Actions — background and failed career      */
  /* -------------------------------------------- */

  /**
   * Dice on the background line: swap to a random background. A PER-FIELD swap —
   * the character keeps its stats, name, traits, bonds and belongings; only the
   * background and what it granted change. Regenerating everything is the Roll
   * Character control's job.
   * @this {CairnActorSheet}
   */
  static async #onRollBackground(event) {
    event.preventDefault();
    await changeBackground(this.actor, null);
  }

  /**
   * Magnifier on the background line: open the picker for this character's own
   * content source, then swap to what was chosen. The picker never offers the
   * other edition's backgrounds — a character does not change edition.
   * @this {CairnActorSheet}
   */
  static async #onPickBackground(event) {
    event.preventDefault();
    if (!this._mayChangeBackground()) return;   // don't offer a list we can't act on
    const result = await promptBackground(
      this.actor.system.contentSource || "2e",
      this.actor.system.backgroundUuid
    );
    if (!result) return;                    // cancelled
    await changeBackground(this.actor, result.bg);
  }

  /** Dice on the "Failed career" line: roll a random one, avoiding the
   *  character's real background exactly as generation does. A new career brings
   *  a fresh keepsake item. @this {CairnActorSheet} */
  static async #onRollFailedCareer(event) {
    event.preventDefault();
    const name = await rollFailedCareerName(this.actor.system.background);
    if (!name) return;
    await this.actor.update({ "system.failedCareer": name });
    await this._grantFailedCareerItem(name);
  }

  /** Magnifier on the Barebones "Failed career" line: choose a different one.
   *  Stores the name, then swaps the ONE keepsake item for one drawn from the
   *  new career's gear (`_grantFailedCareerItem`) — that item, not a loadout,
   *  is all a failed career grants, so unlike the background swap there is no
   *  other gear to reconcile. @this {CairnActorSheet} */
  static async #onPickFailedCareer(event) {
    event.preventDefault();
    const result = await promptFailedCareer(this.actor.system.failedCareer);
    if (!result) return;                    // cancelled
    await this.actor.update({ "system.failedCareer": result.name });
    await this._grantFailedCareerItem(result.name);
  }

  /** Dice on the "Failed career item" line: re-roll WHICH of the current failed
   *  career's gear items the character kept, without changing the career.
   *  @this {CairnActorSheet} */
  static async #onRollFailedCareerItem(event) {
    event.preventDefault();
    await this._grantFailedCareerItem(this.actor.system.failedCareer);
  }

  /* -------------------------------------------- */
  /*  Actions — Trasfondo tab (obligations, questions)  */
  /* -------------------------------------------- */

  /**
   * Roll — or RE-roll — one obligation (by its stable id) from the Obligaciones
   * table, syncing its granted items and gold on the inventory, like a question
   * roll.
   *
   * ONE handler for both, since 2026-09-02: generation now leaves every
   * obligation as an empty slot, and filling one is exactly this operation with
   * nothing to swap out — the item swap is a no-op, the old gold is 0 and the
   * `avoid` list drops the blank descriptions on its own (drawBond filters
   * them). Only the control's TOOLTIP differs, chosen in the template by
   * `filled`; writing a second path was the alternative, and a second path is
   * how the two drift.
   * @this {CairnActorSheet}
   */
  static async #onRerollBond(event, target) {
    event.preventDefault();
    if (this._rerolling) return;   // guard the double-click delete/create race
    this._rerolling = true;
    try {
      const id = target.dataset.bondId;
      const bonds = this._effectiveBonds();
      const idx = bonds.findIndex((b) => b.id === id);
      if (idx < 0) return;
      // Avoid every bond held, INCLUDING the one being re-rolled: a re-roll that
      // hands back the same bond reads as a broken button, and a re-roll that
      // hands back a copy of the character's other bond is the duplicate this
      // guard exists to stop. Both are the same exclusion.
      const drawn = await drawBond(await this._bondsTableName(), {
        avoid: bonds.map((b) => b.description),
      });
      if (!drawn) return;
      const newItems = (drawn.items ?? []).map((it) => withGrantSource(it, `bond:${id}`));
      await this._replaceGrantedItems(`bond:${id}`, newItems);
      const gold = Math.max(0, (this.actor.system.gold ?? 0) - (bonds[idx].gold ?? 0) + drawn.gold);
      bonds[idx] = { id, description: drawn.description, gold: drawn.gold };
      // abNoStatusCard, as on every other bond/question write: the gold swing
      // is the die's, not the player's, and the ledger card read it as a manual
      // edit otherwise (review #18 — this was the one member of the family
      // without the flag).
      await this.actor.update({ "system.bonds": bonds, "system.gold": gold }, { abNoStatusCard: true });
    } finally {
      this._rerolling = false;
    }
  }

  /**
   * Add a bond: draw a new one and append it, granting its items and gold. Only
   * reachable below the bond entitlement (re-checked here so a stale link can't
   * push over the cap).
   * @this {CairnActorSheet}
   */
  static async #onAddBond(event) {
    event.preventDefault();
    // The same guard the two re-roll handlers carry, and for a worse race.
    // This reads `bonds`, AWAITS a table draw, then writes the array it read:
    // two clicks in quick succession both see one bond, both pass the
    // entitlement check, and the second write overwrites the first. One bond
    // is lost from `system.bonds` while BOTH sets of granted items were
    // created — and the survivors carry `bond:<id>` for an id no longer in the
    // array, so `#onRemoveBond` can never reach them and no code ever will.
    if (this._rerolling) return;
    this._rerolling = true;
    try {
      const bonds = this._effectiveBonds();
      if (bonds.length >= (await this._bondEntitlement())) return;
      const rec = bondRecordFrom(await drawBond(await this._bondsTableName(), {
        avoid: bonds.map((b) => b.description),
      }));
      if (!rec) return;
      bonds.push(rec.bond);
      if (rec.items.length) {
        // abNoStatusCard here and on the update below: a bond's grants are
        // machinery, same as _replaceGrantedItems.
        await this.actor.createEmbeddedDocuments("Item", rec.items, { render: false, abNoStatusCard: true });
      }
      const gold = (this.actor.system.gold ?? 0) + rec.bond.gold;
      await this.actor.update({ "system.bonds": bonds, "system.gold": gold }, { abNoStatusCard: true });
    } finally {
      this._rerolling = false;
    }
  }

  /**
   * Remove a bond (by id): drop it and delete its granted items, refunding its
   * gold grant back out (never below zero).
   * @this {CairnActorSheet}
   */
  static async #onRemoveBond(event, target) {
    event.preventDefault();
    // Guarded for the mirror of the race above: two removals in flight each
    // splice the array THEY read, so the second write resurrects the bond the
    // first removed — with its granted items already deleted and its gold
    // already refunded. Same flag, because these four handlers are all
    // read-modify-write over `system.bonds` and only one may be in flight.
    if (this._rerolling) return;
    this._rerolling = true;
    try {
      const id = target.dataset.bondId;
      const bonds = this._effectiveBonds();
      const idx = bonds.findIndex((b) => b.id === id);
      if (idx < 0) return;
      await this._replaceGrantedItems(`bond:${id}`, []);
      const gold = Math.max(0, (this.actor.system.gold ?? 0) - (bonds[idx].gold ?? 0));
      bonds.splice(idx, 1);
      // abNoStatusCard: the refund is grant machinery, like the grant was.
      await this.actor.update({ "system.bonds": bonds, "system.gold": gold }, { abNoStatusCard: true });
    } finally {
      this._rerolling = false;
    }
  }

  /**
   * Roll — or RE-roll — a single background question in isolation: throw that
   * table's own die (from the source background via `backgroundUuid`), replace
   * only that question's answer, and sync the items, gold and ability bonuses
   * it grants (options carry gear as references, resolved through resolveRefs
   * like generation does).
   *
   * THIS IS NOW THE ONLY PATH by which a question is ever answered (2026-09-02):
   * generation leaves every answer empty, so the FIRST click on a question's die
   * is this same swap with nothing to swap out — no items to delete, an old gold
   * of 0 and a zeroed old ability tally, so the arithmetic below simply adds the
   * new answer's grants. It is where the gold, the item and the ability bonuses
   * an answer carries actually arrive.
   *
   * `bgTableDie`, not the option count — the SAME rule applyChoiceTables rolls
   * on, so a question rolled here and one a dry-run preview rolls cannot land on
   * different dice.
   * @this {CairnActorSheet}
   */
  static async #onRerollQuestion(event, target) {
    event.preventDefault();
    if (this._rerolling) return;   // guard the double-click delete/create race
    this._rerolling = true;
    try {
      const idx = Number(target.dataset.index);
      // A question's option can grant a container (an Actor); bail before replacing
      // anything if this user can't manage those (see canRegenerateContainers).
      if (!canRegenerateContainers(this.actor, `question:${idx}`)) return;
      const bg = this.actor.system.backgroundUuid
        ? await fromUuid(this.actor.system.backgroundUuid)
        : null;
      const table = bg?.system?.tables?.[idx];
      const options = table?.options ?? [];
      if (!options.length) {
        ui.notifications.warn(game.i18n.localize("CAIRN.RerollQuestionUnavailable"));
        return;
      }
      const roll = await evaluateFormula(`1d${bgTableDie(table)}`);
      const opt = options[roll.total - 1] ?? options[0];

      const newItems = (await resolveRefs(opt.items)).map((it) => withGrantSource(it, `question:${idx}`));
      await this._replaceGrantedItems(`question:${idx}`, newItems);
      // An option may also grant a container (Outrider's horse breeds are one whole
      // question of them), which is an Actor — swap those the same way.
      await replaceGrantedContainers(this.actor, `question:${idx}`, opt.containers ?? []);
      const questions = foundry.utils.duplicate(this.actor.system.questions ?? []);
      const oldGold = questions[idx]?.gold ?? 0;
      const newGold = opt.bonusGold ?? 0;
      const gold = Math.max(0, (this.actor.system.gold ?? 0) - oldGold + newGold);
      // The ability bonuses swing exactly as the gold does: the old answer's
      // come off, the new answer's go on. The stored `abilities` on the question
      // record is what makes that reversible — same reason `gold` is stored.
      const newBonus = optionAbilityBonuses(opt);
      const abilityUpdate = abilityDeltaUpdate(this.actor, abilityBonusDelta(newBonus, questions[idx]?.abilities));
      questions[idx] = { question: table.question ?? "", answer: opt.description ?? "", gold: newGold, abilities: newBonus };
      // abNoStatusCard: a question re-roll's gold and ability swing is grant machinery.
      await this.actor.update({ "system.questions": questions, "system.gold": gold, ...abilityUpdate }, { abNoStatusCard: true });
    } finally {
      this._rerolling = false;
    }
  }

  /* -------------------------------------------- */
  /*  Portrait pickers                            */
  /* -------------------------------------------- */

  /**
   * Container art picker: a grayscale gallery of transport/container art
   * (CONTAINER_ART — game-icons.net glyphs, CC BY 3.0, per icons.js and
   * icons/CREDITS.md, NOT Foundry core icons), plus a Browse escape for anyone
   * with FILES_BROWSE. This is the container counterpart to _pickPortrait --
   * clicking a container's portrait opens THIS, not the character gallery.
   * The Kinds tab passes its own credit line so it carries attribution under
   * the grid, like every other gallery in the picker.
   * @private
   */
  async _pickContainerArt(event) {
    event.preventDefault();
    const current = this.actor.img;

    // Labelled by CLASS, not by filename. The old version derived a caption from
    // the image path ("donkey" for both the mule and the donkey, "stack" for the
    // item pile), which is the file's name rather than the thing's.
    // A stored class without a cell of its own (donkey — the gallery shows each
    // glyph once) highlights the cell wearing its art instead of nothing.
    const stored = this.actor.system.containerClass;
    const offered = new Set(CONTAINER_ART_CHOICES.map((c) => c.key));
    const cells = CONTAINER_ART_CHOICES.map(({ key, src, label }) => ({
      key,
      src,
      label: game.i18n.localize(label),
      selected: key === stored || (!offered.has(stored) && src === current),
    }));

    await pickArt({
      current,
      title: game.i18n.localize("CAIRN.ChooseContainerArt"),
      classes: { label: game.i18n.localize("CAIRN.ContainerArtTabKinds"), cells, credit: "CAIRN.GameIconsCredit" },
      // No Aspeheim here — a sack has no face. Custom, Game-Icons and Tlomdev
      // ride along so a Warden can dress a thing in their own art without
      // leaving for the FilePicker (tlomdev's beasts suit mounts). Every pick
      // is art only (2026-08-02) — the stored Kind survives them all.
      custom: true,
      gameIcons: true,
      tlomdev: true,
      browseStart: "icons/containers",
      onPick: (src) => this._setContainerArt(src),
    });
  }

  /**
   * Portrait picker — the actor counterpart to _pickContainerArt. Which
   * galleries appear is a ROLE question, not a type question:
   *
   *   Player Character   Aspeheim + Custom + Tlomdev
   *   NPC / Hireling     Aspeheim + Custom + Game-Icons + Tlomdev + Lydia
   *   Monster            Custom + Game-Icons + Tlomdev + Lydia
   *
   * Aspeheim's art is human faces, so a Monster is not offered it. Lydia's is
   * the mirror image — seventeen creatures drawn for this system, so a PLAYER
   * CHARACTER is not offered it; the two exclusions are the same rule read from
   * opposite ends, and between them every sheet keeps a gallery of faces and a
   * gallery of beasts. Nothing else is withheld anywhere, and the URL row and
   * Browse escape are on every sheet. Tlomdev's tokens are drawn for creatures
   * AND people (its "human npcs" and Kettlewright folders are faces), so unlike
   * either of those it appears everywhere. Thing roles (mount, transport,
   * container) never reach here — _onEditPortrait routes them to the container
   * gallery, which is not offered Lydia's art either: a mount wants a horse
   * glyph, and her beasts are monsters rather than livestock.
   *
   * Picking swaps the portrait AND its token via _setPortrait.
   * @private
   */
  async _pickPortrait(event) {
    event.preventDefault();
    const isMonster = this.actor.npcRole === "monster";
    await pickArt({
      current: this.actor.img,
      title: game.i18n.localize("CAIRN.ChoosePortrait"),
      shipped: !isMonster,
      custom: true,
      gameIcons: this.actor.type !== "character",
      tlomdev: true,
      lydia: this.actor.type !== "character",
      browseStart: (await getPortraitManifest())?.portraitDir ?? "systems/mondolme/art/jon-aspeheim/portraits",
      onPick: (src) => this._setPortrait(src),
    });
  }

  /* -------------------------------------------- */
  /*  Form submission                             */
  /* -------------------------------------------- */

  /**
   * Encumbrance and panic zero HP as DERIVED state (in _prepareCharacterData), but
   * a plain form submit would persist that 0 over the real stored value. Strip
   * system.hp.value from the submit while either condition holds, so the real
   * value reappears the moment the character is back under capacity / not panicked.
   * Real damage still persists — it goes through actor.update in damage.js.
   *
   * AppV1's hook was `_getSubmitData`; ApplicationV2's is `_processFormData`,
   * which returns the already-expanded object.
   * @override
   */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    // Strip system.hp.value from the submit EXACTLY when prepareData derives it
    // to 0, so a derived 0 never persists over the real stored value — and ONLY
    // then, or the strip becomes its own bug: a THING at capacity (a full
    // crate, which does not zero — that is a container's normal state, review
    // #5) would otherwise have every HP edit silently dropped, un-editable for
    // as long as it stayed full. Whoever lives by the player rules zeroes on
    // encumbrance — that is `livesByPlayerRules`, the SAME getter the derived
    // zero in _prepareCharacterData reads, so the two sites cannot drift
    // (drift is exactly review #5's un-editable-HP bug); re-keyed from type to
    // role 2026-08-01, when role-npc people joined the rule. Panic still
    // zeroes for every type — but only while the use-panic SETTING is on
    // (usePanic, derived from it in _prepareCharacterData), matching the
    // derived zero exactly. A bare `panicked` here was review #6's drift:
    // turn the setting off with someone panicked and prepareData stops
    // deriving the 0, but the strip kept dropping every HP edit — silently
    // un-editable, with the checkbox that clears panic no longer rendered.
    const derivedZero =
      (this.actor.livesByPlayerRules && this.actor.system.encumbered)
      || (this.actor.system.usePanic && this.actor.system.panicked);
    if (derivedZero) {
      foundry.utils.deleteProperty(data, "system.hp.value");
    }

    const kind = foundry.utils.getProperty(data, "system.containerClass");
    if (kind !== undefined && kind !== "" && !CONTAINER_CLASSES[kind]) {
      // Not already a key: accept the label in the ACTIVE language OR in
      // English. The comment here always promised "any language", but the
      // compare ran localize() alone — active language only — so a Warden
      // typing the English label in a Spanish world fell through to the
      // verbatim-custom branch and silently lost the class's art and capacity
      // (review #13; es.json also ships 14 of the 16 Class labels, so two
      // classes had no Spanish label to type at all). English comes from
      // game.i18n._fallback, the same read core's own fallback path uses
      // (helpers/localization.mjs:394,441) — empty on an English client,
      // where localize() already answers. No match still falls through to
      // the verbatim text: a Warden's own word is a legal Kind.
      const typed = String(kind).trim().toLowerCase();
      const english = (key) => foundry.utils.getProperty(game.i18n._fallback, key) ?? game.i18n.localize(key);
      for (const [key, cfg] of Object.entries(CONTAINER_CLASSES)) {
        if (typed === game.i18n.localize(cfg.label).toLowerCase()
          || typed === String(english(cfg.label)).toLowerCase()) {
          foundry.utils.setProperty(data, "system.containerClass", key);
          break;
        }
      }
    }
    return data;
  }

  /* -------------------------------------------- */
  /*  Drag and drop                               */
  /* -------------------------------------------- */

  /**
   * @override
   * @param {DragEvent} event
   * @param {CairnItem} originalItem  the dropped Item, already resolved by ActorSheetV2
   */
  async _onDropItem(event, originalItem) {
    if (!originalItem) return null;

    // The Actor the item currently belongs to; null for a world or compendium item.
    const originalActor = originalItem.actor;

    // A background ARRIVING here is not inventory. Dropping one CHANGES the
    // character's background — the same operation as the magnifier's picker — so it
    // is intercepted before any capacity check and before any create. Without this
    // it fell through to the transfer path below and became an owned item:
    // `BackgroundData` declares neither `weightless` nor `bulky`, so it cost a slot,
    // and on an encumbered character the refusal below rejected the drop outright,
    // so nothing happened at all.
    //
    // ARRIVING is the load-bearing word, and the `!== this.actor` term is what says
    // it. A background already in this inventory — the 0.1.7 artefact upgraded
    // worlds still carry — is a draggable row like any other, and dragging it to
    // REORDER it is a sort, not a swap. Without the term the sort never happened:
    // the drag raised the destructive prompt and, answered yes, renamed the
    // character's background to the item being dragged and deleted the gear the
    // real one granted. Note it cannot instead move below the same-actor branch and
    // rely on position — a background dragged off ANOTHER character's sheet is a
    // legitimate arrival route that must still be intercepted, and dev:bg-drop-guard
    // covers it.
    if (originalItem.type === "background" && originalActor !== this.actor) {
      return this._onDropBackground(originalItem);
    }

    // Same-actor drop: this is a reorder within our own inventory, not a
    // transfer. Always honoured — the `enable-inventory-reorder` gate that used
    // to sit here retired 2026-08-22 (drag-to-reorder is always on).
    if (this.actor === originalActor) {
      await this._onSortItem(event, originalItem);
      return originalItem;
    }

    // A transfer takes the item off ANOTHER actor's sheet, so it needs write
    // access to that source. Without it the old code added to the target and then
    // failed (or silently duplicated) on the source — refuse it up front. A drop
    // from a compendium has no owning actor and is a copy, so it skips this.
    if (originalActor && !originalItem.isOwner) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.DropNoSource"));
      return null;
    }

    // A HECHIZO NEVER CHANGES HANDS: it can be cast and it can be deleted, and
    // that is all. This is the AFFORDANCE half — the toast a player actually
    // sees — and its enforcement is `CairnItem._preCreate`, which refuses the
    // same create whatever UI produced it (two layers, the Fatigue precedent:
    // removing either alone must not look like a landed change).
    //
    // Placed AFTER the same-actor branch above, exactly where the bound-page
    // refusal it replaces sat: dragging a spell up and down its own owner's
    // inventory is a sort, not a transfer, and stays legal.
    if (originalItem.type === "spell") {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.SpellNoTransfer"));
      return null;
    }

    // Capacity rules differ by target. A CHARACTER with no free slot refuses:
    // a drop is ORDINARY ACQUISITION, and the rule only owes a character
    // overflow in two cases, neither of them this one — what generation and a
    // background grant hand them (those write with `createEmbeddedDocuments` and
    // never reach here), and Fatigue, which passes `ignoreCapacity` because a
    // full pack does not stop a spell being cast. A THING — role container or
    // transport — is strict for a different reason: it refuses anything that
    // won't fit, because a sack has no rule that punishes it for being overfull.
    // A MOUNT is not a thing and is deliberately lenient: it is a creature with
    // a stat block, and it follows the npc rule (over capacity does nothing).
    //
    // This comment used to say a character MAY go over here, directly above the
    // line that refuses. It was describing an intention nobody had implemented,
    // and a correct-sounding comment on contradicting code reads as verification
    // — it is why the disagreement survived two reviews. The rule was settled on
    // 2026-08-05 in the code's favour; see CLAUDE.md.
    // Fatigue never lands on a thing, by any route. Hiding the +/- header is an
    // affordance fix only: a Fatigue item can be DRAGGED off a character and
    // dropped on a sack, which is the same nonsense arriving by a door nobody
    // shut. Tested by NAME because that is Fatigue's identity everywhere else
    // here — it is stored in English (FATIGUE_NAME) precisely so it survives a
    // language change, and `system.isFatigue` is derived from the same test.
    if (this.actor.isThing && originalItem.name === FATIGUE_NAME) {
      ui.notifications.warn(game.i18n.format("CAIRN.Notify.NoFatigueOnThing", {
        name: this.actor.name,
      }));
      return null;
    }

    const s = originalItem.system ?? {};
    const need = s.bulky ? 2 : s.weightless ? 0 : 1;
    if (this.actor.isThing) {
      if ((this.actor.system.slotsUsed ?? 0) + need > (this.actor.system.slotsMax ?? 0)) {
        ui.notifications.warn(
          game.i18n.format("CAIRN.Notify.ContainerFull", { name: originalItem.name })
        );
        return null;
      }
    } else if (this.actor.isEncumbered()) {
      ui.notifications.warn(game.i18n.localize("CAIRN.Notify.MaxSlotsOccupied"));
      return null;
    }

    // Put the item on the target FIRST, and only move quantity off the source
    // once that has actually succeeded. The old order created-then-decremented
    // unconditionally: a refused create (typically a permissions wall) threw AND
    // still decremented the source, so the item vanished.
    const foundItem = this.actor.items.find(
      (it) => it.name === originalItem.name && it.type === originalItem.type
        // A stack is only a stack when the flag-shaped discriminators agree:
        // a Hechizo and its Pergamino share name AND type (gear.js stores a
        // scroll under the bare spell name), so the name+type test merged a
        // dropped spell into a scroll stack — the spell was never created, and
        // a cross-actor drop deleted the source scroll while bumping the
        // target's spell (review #9). Any future flag-style splitter joins this
        // test rather than growing a new merge.
        //
        // Unreachable for a spell today — the refusal above turns every
        // cross-actor spell drop away before this — and kept because the test
        // is about the FLAG, not about which type happens to carry it, and
        // because a stack that merges two different things is silent data loss.
        && !!it.system?.scroll === !!originalItem.system?.scroll
    );
    let created = foundItem ?? null;
    if (foundItem) {
      await foundItem.update({ "system.quantity": (foundItem.system.quantity ?? 1) + 1 });
    } else {
      created = await super._onDropItem(event, originalItem);
      if (!created) {
        ui.notifications.warn(game.i18n.localize("CAIRN.Notify.DropFailed"));
        return null;
      }
      // Items inside a thing are stowed, never equipped. A mount is excluded on
      // purpose — barding is equipped armor on a creature that has a stat block.
      const patch = { "system.quantity": 1 };
      if (this.actor.isThing) patch["system.equipped"] = false;
      // abNoStatusCard: this pin is drop machinery normalizing the fresh copy
      // (a cross-actor transfer moves ONE unit whatever the source stack held),
      // and the create above already posted the ledger's "Item added" line —
      // without the flag the update half would follow it with a "3 → 1"
      // quantity line recording a change nobody made.
      await created.update(patch, { abNoStatusCard: true });
    }

    // Target received it. Only a real transfer FROM another actor removes a unit
    // from the source. A drop from a compendium (no owning actor) is a COPY —
    // never write to the pack document, or the pool's master item gets its
    // quantity decremented and every future grant resolves from corrupted data.
    if (originalActor) {
      const osq = (originalItem.system.quantity ?? 1) - 1;
      if (osq > 0) {
        await originalItem.update({ "system.quantity": osq });
      } else {
        await originalActor.deleteEmbeddedDocuments("Item", [originalItem.id]);
      }
    }

    /* The PAGES-TRAVEL-WITH-THE-BOOK bundle stood here and is GONE. A Grimoire
       moving off an actor carried its own bound pages with it, re-stamped with
       the arriving book's key. A Libro's three spells are fields ON the book,
       so they travel inside its `system` with no help at all — which is what
       makes this the right shape rather than merely a smaller one. */

    return created;
  }

  /**
   * Reorder an item within this actor's own inventory by drag-and-drop (always
   * on — the "enable-inventory-reorder" gate retired 2026-08-22). Only real
   * embedded items take part:
   * dropping onto a gold-slot / worn-container row (no embedded item) is a no-op.
   * ActorSheetV2 ships its own version, but it assumes every sibling row carries a
   * real embedded item and throws on ours, which include gold-slot rows.
   * @param {DragEvent} event
   * @param {CairnItem} source  the dragged item
   * @override
   */
  async _onSortItem(event, source) {
    const dropTarget = event.target.closest("[data-item-id]");
    if (!dropTarget) return;
    const target = this.actor.items.get(dropTarget.dataset.itemId);
    if (!target || target.id === source.id) return;

    const siblings = [];
    for (const el of dropTarget.parentElement.children) {
      const sid = el.dataset?.itemId;
      if (!sid || sid === source.id) continue;
      const sib = this.actor.items.get(sid);
      if (sib) siblings.push(sib);
    }

    const updates = foundry.utils
      .performIntegerSort(source, { target, siblings })
      .map((u) => ({ _id: u.target.id, ...u.update }));
    if (updates.length) {
      await this.actor.updateEmbeddedDocuments("Item", updates);
    }
  }

  /**
   * @override
   * @param {DragEvent} event
   * @param {CairnActor} actor  the dropped Actor, already resolved by ActorSheetV2
   */
  async _onDropActor(event, actor) {
    // Parked UI (2026-08-09): drag-to-connect goes with the rest of the
    // Connections surfaces. Silent, matching every other invalid drop here.
    if (!connectionsUiEnabled()) return null;
    // Only WORLD actors can be attached. AppV1 expressed this by looking the
    // uuid up in `game.actors`, which a compendium or unlinked-token actor is
    // never in; ApplicationV2 hands us the resolved document, so say it directly.
    if (!actor || actor.pack || actor.isToken) return null;
    if (this.actor.uuid === actor.uuid) return null;

    // An npc-line drop is the drag spelling of Connect: one write, guarded
    // inside connectActor (both-ends ownership, keeping type, connectable
    // role, single-parent, the cap, cycle, permission). "character" left this
    // list with the flat graph — a PC can never be a child, connectActor
    // refuses one anyway, and accepting the drop only to bounce it would
    // toast a refusal at a gesture better ignored. Already-connected stays
    // refused — re-homing goes through unlink first, exactly as it always has.
    if (!["npc", "hireling"].includes(actor.type)) return null;
    if (actor.system.connectedTo) {
      ui.notifications.warn(game.i18n.localize("CAIRN.AlreadyConnected"));
      return null;
    }
    return (await this.actor.connectActor(actor)) ? actor : null;
  }

  /**
   * @override
   *
   * ActorSheetV2's version resolves a row to `actor.items.get(itemId)`, which is
   * wrong for our container rows: those carry an Actor UUID in `data-item-id`, so
   * the lookup misses and the drag silently carries nothing.
   */
  _onDragStart(event) {
    const li = event.currentTarget;
    if ("link" in event.target.dataset) return;

    let dragData;
    if (li.dataset.itemId) {
      const item = li.dataset.isContainer
        ? this.actor.getOwnedContainer(li.dataset.itemId)
        : this.actor.items.get(li.dataset.itemId);
      dragData = item?.toDragData();
    }
    // (The effectId branch that sat here was dead: no template renders an
    // effects list, so no row could carry the dataset — see _onDropActiveEffect.)
    if (!dragData) return;
    event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
  }

  /**
   * Refuse ActiveEffect drops (review #9). The system renders no effects UI on
   * any sheet and no data model consumes them — core's default accepted the
   * drop anyway, so a dropped effect silently modified system.* through the
   * normal preparation pass while being invisible on the sheet and
   * unremovable from it (only the token HUD or the console could reach it).
   * An invisible stat modifier is a trap, not a feature; if effects ever get
   * a surface, this override goes with it.
   * @override
   */
  async _onDropActiveEffect() {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.EffectsUnsupported"));
    return null;
  }
}
