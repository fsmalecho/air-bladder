import { resolveGearItem } from "../gear.js";
import { previewBackground } from "../character-generator.js";
import { languages } from "../content-packs.js";
import { canReadBook } from "../magic.js";
import {
  BOOK_PAGE_KEYS, BG_ABILITY_KEYS, BG_TABLE_DICE, BG_DEFAULT_DIE, BG_MAX_TABLES, bgTableDie,
} from "../data-models.js";
import { bindEditorClickAwaySave, cleanDescription, formatCount } from "../utils.js";
import { pickArt } from "../art-picker.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

/** The i18n key labelling each of the four starting abilities. FUE/DES/VOL are
 *  the bare ability keys the whole system uses; PG is Hit Protection. */
const ABILITY_LABELS = { str: "STR", dex: "DEX", wil: "WIL", hp: "CAIRN.HitProtection" };

/** HTML-escape for report text built by hand (not through Handlebars). */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Badge markup for a resolved/unresolved gear reference kind. */
const kindBadge = (kind) => {
  const map = {
    snapshot: ["fa-camera", "ok", "CAIRN.BgAuthor.KindSnapshot"],
    name: ["fa-check", "ok", "CAIRN.BgAuthor.KindName"],
    rolled: ["fa-dice", "ok", "CAIRN.BgAuthor.KindRolled"],
    missing: ["fa-triangle-exclamation", "bad", "CAIRN.BgAuthor.KindMissing"],
    empty: ["fa-minus", "warn", "CAIRN.BgAuthor.KindEmpty"],
  };
  const [icon, cls, label] = map[kind] ?? map.empty;
  return `<span class="bg-kind ${cls}" title="${esc(game.i18n.localize(label))}"><i class="fas ${icon}"></i></span>`;
};

/** A signed bonus, as it reads on a report line: "+2", "-1", nothing at 0. */
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** "FUE +2 · PG -1" for a {str,dex,wil,hp} record, or "" when it is all zeroes. */
const abilityChipText = (a = {}) => BG_ABILITY_KEYS
  .filter((k) => (a[k] ?? 0) !== 0)
  .map((k) => `${game.i18n.localize(ABILITY_LABELS[k])} ${signed(a[k])}`)
  .join(" · ");

/**
 * Render a previewBackground() report to HTML for the Test-×10 dialog: a problems
 * banner (errors then warnings, or a green all-clear), what the character starts
 * on (the background's own four numbers, or the dice) with its age formula and
 * granted languages, the starting gear with resolution badges, and each table —
 * headed by its own die — with how often each option fired across the sample,
 * the bonuses each carries, and the gold and ability spreads.
 */
const renderPreviewReport = (r) => {
  const L = (k) => esc(game.i18n.localize(k));
  const parts = [];
  if (!r.problems.length) {
    parts.push(`<p class="bg-preview-ok"><i class="fas fa-check-circle"></i> ${L("CAIRN.BgAuthor.LintClean")}</p>`);
  } else {
    const row = (p) => `<li class="bg-preview-${p.level}"><i class="fas ${p.level === "error" ? "fa-circle-xmark" : "fa-circle-exclamation"}"></i> ${esc(p.msg)}</li>`;
    const errs = r.problems.filter((p) => p.level === "error");
    const warns = r.problems.filter((p) => p.level === "warn");
    parts.push(`<ul class="bg-preview-problems">${errs.map(row).join("")}${warns.map(row).join("")}</ul>`);
  }

  // What a character built on this background STARTS on, before any table
  // bonus: the four fixed numbers, or a statement that the dice decide.
  parts.push(`<h4>${L("CAIRN.BgAuthor.StartingAbilities")}</h4>`);
  const sa = r.startingAbilities ?? {};
  parts.push(sa.enabled
    ? `<p class="bg-preview-start">${BG_ABILITY_KEYS.map((k) => `${L(ABILITY_LABELS[k])} <strong>${Number(sa[k]) || 0}</strong>`).join(" · ")}</p>`
    : `<p class="bg-preview-start bg-preview-rolled">${L("CAIRN.BgAuthor.StartingAbilitiesRolled")}</p>`);
  parts.push(`<p class="bg-preview-start">${esc(game.i18n.format("CAIRN.BgAuthor.PreviewAge", { formula: r.ageFormula ?? "" }))}</p>`);
  parts.push(`<p class="bg-preview-start">${esc(game.i18n.format("CAIRN.BgAuthor.PreviewGold", { formula: r.goldFormula ?? "" }))}</p>`);
  parts.push(`<p class="bg-preview-start">${esc(game.i18n.format("CAIRN.BgAuthor.PreviewLanguages", {
    list: r.languages?.length ? r.languages.join(", ") : game.i18n.localize("CAIRN.LanguagesNone"),
  }))}</p>`);

  if (r.gear.length) {
    parts.push(`<h4>${L("CAIRN.BackgroundStartingGear")}</h4>`);
    parts.push(`<ul class="bg-preview-gear">${r.gear.map((g) => `<li>${kindBadge(g.kind)} ${esc(g.name) || `<em>${L("CAIRN.BgAuthor.Unnamed")}</em>`}</li>`).join("")}</ul>`);
  }

  r.tables.forEach((t) => {
    const title = esc(t.question) || `<em>${L("CAIRN.BgAuthor.Unnamed")}</em>`;
    parts.push(`<h4>${title} <span class="bg-preview-die">d${t.die}</span></h4>`);
    const rows = t.options.map((o, i) => {
      const items = o.items.map((it) => `${kindBadge(it.kind)} ${esc(it.name)}`).join(", ");
      const gold = o.bonusGold ? ` <span class="bg-preview-gold">+${o.bonusGold}g</span>` : "";
      const chip = abilityChipText(o.abilities);
      const bonus = chip ? ` <span class="bg-preview-bonus">${esc(chip)}</span>` : "";
      const fired = `<span class="bg-preview-fired">${t.fired[i]}/${r.sampling.n}</span>`;
      const desc = esc(o.description) || `<em class="bg-preview-blank">${L("CAIRN.BgAuthor.EmptyOption")}</em>`;
      return `<li>${fired} ${desc}${gold}${bonus}${items ? `<div class="bg-preview-items">${items}</div>` : ""}</li>`;
    });
    parts.push(`<ol class="bg-preview-options">${rows.join("")}</ol>`);
  });

  parts.push(`<p class="bg-preview-sample">${esc(game.i18n.format("CAIRN.BgAuthor.GoldSpread", { avg: r.sampling.goldAvg, min: r.sampling.goldMin, max: r.sampling.goldMax }))}</p>`);
  // The ability spread the tables produce across the sample. Printed only when
  // some option actually moves a number — on a background with no bonuses the
  // line would be four zeroes saying nothing.
  const spread = BG_ABILITY_KEYS
    .filter((k) => r.sampling.abilities?.[k] && (r.sampling.abilities[k].min !== 0 || r.sampling.abilities[k].max !== 0))
    .map((k) => {
      const s = r.sampling.abilities[k];
      return `${game.i18n.localize(ABILITY_LABELS[k])} ${signed(s.min)}…${signed(s.max)}`;
    })
    .join(" · ");
  if (spread) {
    parts.push(`<p class="bg-preview-sample">${esc(game.i18n.format("CAIRN.BgAuthor.AbilitySpread", { spread }))}</p>`);
  }
  return `<div class="bg-preview">${parts.join("")}</div>`;
};

/** {key, label, value} rows for the four ability boxes, off any {str,dex,wil,hp}
 *  record. One builder for the starting-abilities block and every option row. */
const abilityRows = (src = {}) => BG_ABILITY_KEYS.map((key) => ({
  key,
  label: ABILITY_LABELS[key],
  value: Number(src[key]) || 0,
}));

/** A table option in its stored shape, with every field present and the four
 *  ability bonuses coerced to whole numbers (negatives kept). Snapshots inside
 *  `items` and any `containers` ride through untouched — the DOM cannot carry
 *  them, so a handler that rebuilt them from the form would lose them. */
const normalizedOption = (so = {}) => ({
  description: so.description ?? "",
  bonusGold: so.bonusGold ?? 0,
  items: so.items ?? [],
  containers: so.containers ?? [],
  ...Object.fromEntries(BG_ABILITY_KEYS.map((k) => [k, Number(so[k]) || 0])),
});

/**
 * Does this option hold anything a Warden would miss? The test behind the
 * shrink warning: text, gold, an item, a container or an ability bonus. An
 * all-zero, all-blank row is scaffolding and is dropped without asking.
 */
const optionHasContent = (o = {}) =>
  !!String(o.description ?? "").trim()
  || (Number(o.bonusGold) || 0) !== 0
  || (o.items ?? []).length > 0
  || (o.containers ?? []).length > 0
  || BG_ABILITY_KEYS.some((k) => (Number(o[k]) || 0) !== 0);

/** Ask before throwing authored rows away. Resolves false on ✕, which reads as
 *  "no" the way every other destructive dialog in the system does. */
const confirmDataLoss = async (title, message) =>
  foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize(title), icon: "fas fa-triangle-exclamation" },
    content: `<p>${message}</p>`,
    rejectClose: false,
  });

/**
 * The extra tabs each item type carries beyond Description, in the order they
 * are shown. A LIST per type since the Libro joined with three of them.
 */
const EXTRA_TABS = {
  item: [{ id: "crit-dmg", label: "CAIRN.CriticalDamage" }],
  weapon: [{ id: "crit-dmg", label: "CAIRN.CriticalDamage" }],
  background: [{ id: "details", label: "CAIRN.BackgroundDetails" }],
  // One tab per page, labelled with its number and nothing else — the page IS
  // the number on a three-page book. `page1`/`page2`/`page3` rather than
  // "1"/"2"/"3" as ids, because a tab id lands in a `data-tab` attribute and a
  // Handlebars path (`tabs.[1].cssClass`), neither of which wants a bare digit.
  book: BOOK_PAGE_KEYS.map((_key, i) => ({ id: `page${i + 1}`, label: `CAIRN.BookPage${i + 1}` })),
};

/**
 * Recharge, for relics. Keyed on the DOCUMENT rather than the type — which is the
 * whole point of `relic` being a flag: a relic is equally an item, a weapon or
 * an armor, so no entry in EXTRA_TABS above could express it.
 */
const RELIC_TAB = { id: "recharge", label: "CAIRN.Recharge" };

/**
 * Derive the display tags (Armor / Damage / bulky / petty / uses) for a gear row
 * from an item's system data. Works for both a resolved pack document and a
 * snapshot's frozen system copy, so an authored one-off reads the same way a
 * shipped item does.
 */
const gearTags = (s = {}, usesOverride) => {
  const tags = [];
  // Format keys, not "<number> <noun>" — and the same two the marketplace chips
  // use, which had drifted to the opposite word order ("Armor 1" there, "1 Armor"
  // here) for the identical fact.
  if (s.armor) tags.push(game.i18n.format("CAIRN.NArmor", { n: s.armor }));
  if (s.damageFormula) tags.push(game.i18n.format("CAIRN.NDamage", { n: s.damageFormula }));
  if (s.bulky) tags.push(game.i18n.localize("CAIRN.Bulky"));
  if (s.weightless) tags.push(game.i18n.localize("CAIRN.Weightless"));
  const uses = usesOverride ?? s.uses?.max ?? 0;
  // formatCount, not format: a single-use scroll read "1 uses".
  if (uses) tags.push(formatCount("CAIRN.NUses", uses));
  return tags;
};

/**
 * A frozen, portable copy of a dropped item — enough to rebuild an owned item at
 * generation, nothing document-specific (no _id / ownership / effects). This is
 * the "snapshot on drop" that makes a custom background self-contained and
 * shareable (docs/custom-backgrounds-plan.md §6 Fork A).
 */
const snapshotItem = (item) => {
  const o = item.toObject();
  return { name: o.name, type: o.type, img: o.img, system: o.system };
};

/**
 * The item sheet, on ApplicationV2.
 *
 * One class serves all six item types; the template and the tab set are chosen
 * per render from `item.type` (see _configureRenderParts / _getTabsConfig).
 *
 * Two AppV1 behaviours are re-declared here rather than inherited, because
 * DocumentSheetV2 defaults them the other way and the sheet silently stops
 * working without them:
 *
 *  - `form.submitOnChange` — the whole UX is "edit a field and it sticks".
 *    AppV1's ItemSheet set this; DocumentSheetV2 defaults it to false.
 *  - `window.resizable` — AppV1's ItemSheet set it; ApplicationV2 defaults false.
 *
 * There is no `submitOnClose` in ApplicationV2 at all, so a field edited and left
 * un-blurred is no longer saved by closing the window. That is a deliberate
 * behaviour change, not an oversight: `submitOnChange` covers every normal edit.
 *
 * @extends {ItemSheetV2}
 */
export class CairnItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cairn", "sheet", "item"],
    position: { width: 480, height: 480 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      // OVERRIDES core's `editImage`, which opens a bare FilePicker. Every item
      // template's portrait carries data-action="editImage", so declaring it
      // here routes all six of them — gear, weapons, armor, backgrounds, books
      // and spells — through the system's art picker instead, which is where
      // the Game-Icons gallery lives.
      editImage: CairnItemSheet.#onEditImage,
      testBackground: CairnItemSheet.#onTestBackground,
      addName: CairnItemSheet.#onAddName,
      removeName: CairnItemSheet.#onRemoveName,
      addGear: CairnItemSheet.#onAddGear,
      removeGear: CairnItemSheet.#onRemoveGear,
      removeOptionItem: CairnItemSheet.#onRemoveOptionItem,
      addTable: CairnItemSheet.#onAddTable,
      removeTable: CairnItemSheet.#onRemoveTable,
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
      tabs: [{ id: "description", label: "CAIRN.Description" }],
      initial: "description",
    },
  };

  /* -------------------------------------------- */

  /**
   * The background authoring form is a tall, multi-section editor; give it room.
   * Done here rather than in the constructor because `position` is derived from
   * the options during initialization.
   * @override
   */
  _initializeApplicationOptions(options) {
    const applied = super._initializeApplicationOptions(options);
    if (options.document?.type === "background") applied.position.height = 640;
    return applied;
  }

  /**
   * One template per item type, chosen at render. `static PARTS` cannot vary by
   * document, so this is the hook for it.
   * @override
   */
  _configureRenderParts(_options) {
    return {
      form: {
        template: `systems/mondolme/templates/item/${this.item.type}-sheet.html`,
        templates: [],
        // AppV2 restores scroll only for the selectors named here — a part with
        // no `scrollable` is replaced wholesale and the pane jumps to the top
        // (handlebars-application.mjs `_preSyncPartState`, which walks
        // `part.scrollable || []`). The authoring form is a real scroll box, so
        // a Warden editing table 2 / option 6 was thrown back to the top on
        // every render. The empty string means the part element ITSELF, which
        // is what core's own forked combat-tracker part uses.
        scrollable: [".background-editor", ""],
      },
    };
  }

  /**
   * Description is universal; item/weapon add Critical Damage and a background
   * adds Details.
   * @override
   */
  _getTabsConfig(group) {
    const config = foundry.utils.deepClone(super._getTabsConfig(group));
    if (!config) return config;
    // THE LANGUAGE GATE (module/magic.js `canReadBook`): a Libro whose language
    // its holder does not know keeps its numbered page tabs to itself, and the
    // sheet is the Descripción tab alone. Not merely hidden — `_prepareBook`
    // hands the template no pages either, so the spell texts are absent from
    // the DOM rather than one inspector away.
    const locked = this.item.type === "book" && !canReadBook(this.item);
    const extra = locked ? null : EXTRA_TABS[this.item.type];
    if (extra) config.tabs.push(...extra);
    if (this.item.system?.relic) config.tabs.push(RELIC_TAB);
    // Unticking Relic removes the tab you are standing on — and so does losing
    // a language while standing on page 2. Exactly the failure the
    // actor sheet's Containers tab has, and it carries the same guard with the same
    // comment: `_prepareTabs` only defaults the group when it is UNSET (`??=`), so
    // without this the group keeps pointing at "recharge", nothing matches, no panel
    // gets `.active`, and core's `.tab[data-tab]:not(.active){display:none}` hides the
    // entire sheet body with no error. `submitOnChange` re-renders on the untick, so
    // it is immediate. Add a guard here alongside any future document-dependent tab.
    if (!config.tabs.some((t) => t.id === this.tabGroups[group])) this.tabGroups[group] = config.initial;
    return config;
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.item = this.item;
    // Live model, not `toObject(false)`: a TypeDataModel resolves that against the
    // SCHEMA, so prepareData's derived values (isEquipable, hasPlusMinus, isFatigue,
    // grantLabel, icon, useItemIcons) never reach the template. Spreading the live
    // model restores stored + derived together.
    context.system = { ...this.item.system };
    // Per-window id prefix for label[for]/input[id] pairs. With two item sheets
    // open, clicking "Bulky" on the second toggled the FIRST item's checkbox and
    // submitOnChange saved it. DocumentSheetV2 already computes a unique id per
    // window as `rootId`, so this is now an alias rather than a hand-rolled one.
    context.idp = context.rootId;

    context.nameDisplay = this.item.name;
    const descSrc = this.item.system.description;
    // Every enriched field on this sheet reaches innerHTML via {{{ }}}, so it
    // goes through cleanDescription first — the sheet-XSS sink (cleanDescription
    // in utils.js): a player owns the browser that writes system.description, so
    // an injected data-action/name/on* would otherwise ride the enriched output
    // into the viewer's sheet. Baked into the local enrich so no field skips it;
    // enricher output (content-link/inline-roll) carries no data-action, safe.
    const enrich = async (html) =>
      cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        html ?? "", { relativeTo: this.item }));
    context.enrichedDescription = await enrich(descSrc);
    context.enrichedCriticalDamage = await enrich(this.item.system.criticalDamage);
    context.enrichedRecharge = await enrich(this.item.system.recharge);

    // "Charges" and "Uses" are ONE counter. Across all 46 shipped relics the
    // distinction is exactly this: a relic that states a recharge condition has
    // charges, one that does not has uses, and none has both. So the label follows
    // `recharge` rather than a second field or a mode flag — nothing to keep in
    // step, and a relic that can never be recharged just reads "uses".
    const recharges = !!foundry.utils.getProperty(this.item, "system.recharge");
    context.usesLabel = recharges ? "CAIRN.Charges" : "CAIRN.Uses";
    context.maxUsesLabel = recharges ? "CAIRN.MaxCharges" : "CAIRN.MaxUses";

    if (this.item.type === "book") await this._prepareBook(context);
    if (this.item.type === "background") {
      // No `isGM` here any more: it gated the Duplicate button on both branches,
      // and the button is gone. Nothing else on this sheet asks who is looking.
      if (this.isEditable) await this._prepareBackgroundEditor(context);
      // Only reachable when the sheet is NOT editable, so the flag was always true.
      else await this._prepareBackgroundReadOnly(context);
    }
    return context;
  }

  /**
   * The Libro's three pages, and the Warden's language list.
   *
   * The pages are handed over as a LIST in tab order rather than left to the
   * template to address one by one, so the numbered tabs, their name inputs and
   * their editors all come off the same three entries — a fourth tab would need
   * a fourth page here, which is exactly the coupling wanted.
   *
   * `languages()` is the ONE source for what a language may be (content-packs.js
   * splits the Warden's comma-separated setting). The stored value rides along
   * even when it is not in that list: a Warden who re-words the setting must not
   * silently blank the language off every book already written, so the select
   * carries the orphan as its own option and shows it selected.
   *
   * THE LANGUAGE GATE decides whether the pages are built at all. A holder who
   * does not know the book's language gets an EMPTY list, not a hidden one:
   * `_getTabsConfig` has already dropped the numbered tabs, and handing the
   * template three panels it cannot show would put every spell's text in the
   * DOM for anyone who opened an inspector. The language SELECT stays visible
   * on purpose — reading which language you are locked out of is the point.
   * @private
   */
  async _prepareBook(context) {
    const stored = this.item.system.language ?? "";
    const configured = languages();
    context.bookLanguages = (!stored || configured.includes(stored))
      ? configured : [stored, ...configured];
    context.bookReadable = canReadBook(this.item);
    if (!context.bookReadable) {
      context.bookPages = [];
      return;
    }
    // The same enrich-then-clean pipeline `_prepareContext` uses for
    // `description`, for the same reason: every enriched field on this sheet
    // reaches innerHTML through {{{ }}}.
    const enrich = async (html) =>
      cleanDescription(await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        html ?? "", { relativeTo: this.item }));
    context.bookPages = await Promise.all(BOOK_PAGE_KEYS.map(async (key, i) => {
      const page = this.item.system.pages?.[key] ?? {};
      return {
        n: i + 1,
        key,
        tab: `page${i + 1}`,
        name: page.name ?? "",
        text: page.text ?? "",
        enrichedText: await enrich(page.text),
      };
    }));
  }

  /**
   * Read-only background view (locked shipped packs): resolve each gear name to
   * its pool document and derive the display tags, so the sheet reads "Chainmail
   * (2 Armor, bulky)" rather than a bare list. A snapshot row derives its tags
   * from the frozen copy it carries. Unresolvable names still list, tagless.
   * @private
   */
  async _prepareBackgroundReadOnly(context) {
    context.startingGearRows = await Promise.all(
      (this.item.system.startingGear ?? []).map(async (g) => {
        if (g.itemData) {
          return { name: g.name, tags: gearTags(g.itemData.system, g.uses) };
        }
        const doc = await resolveGearItem(g.name, { uses: g.uses });
        const tags = doc ? gearTags(doc.system, g.uses) : [];
        return { name: g.name, tags };
      })
    );
    // The Details tab's questions and options. Display copies only; the editor
    // branch keeps its raw inputs. The die is shown beside the question because
    // it is now the table's own — a reader cannot infer it from the row count on
    // a document nobody can open the editor for.
    context.backgroundTables = (this.item.system.tables ?? []).map((tbl) => ({
      heading: tbl.heading ?? "",
      question: tbl.question ?? "",
      die: bgTableDie(tbl),
      options: (tbl.options ?? []).map((o) => ({ description: o.description ?? "" })),
    }));
    // The four starting numbers, but ONLY when this background states them —
    // otherwise there is nothing to show and the dice speak for themselves.
    const sa = this.item.system.startingAbilities ?? {};
    context.readOnlyAbilities = sa.enabled ? abilityRows(sa) : null;
  }

  /**
   * Editable authoring form: pick-lists, the starting-ability boxes, the current
   * names, gear rows (with resolved/derived tags and a snapshot marker), the
   * language ticks, the age formula, and the question tables padded to each
   * table's own die. Nothing here is persisted — the padded shape only reaches
   * the document when the GM edits a field (handlers write a normalized array
   * via _normalizedTables).
   * @private
   */
  async _prepareBackgroundEditor(context) {
    context.isBackgroundEditor = true;
    // Keyed by the STORED English identity (that is what goes on the document);
    // only the label is localized. CAIRN.Archetype.* already existed for the
    // background picker — this dropdown was the one place still showing English.
    context.archetypeChoices = Object.fromEntries(
      ["Wizard", "Fighter", "Thief"].map((a) => [a, game.i18n.localize(`CAIRN.Archetype.${a}`)])
    );
    /* `context.sourceLabel` was set here and on the read-only branch above, and
       is GONE with `BackgroundData.source` (2026-09-02). It named the edition a
       background belonged to, back when there were two. */
    context.editNames = [...(this.item.system.names ?? [])];
    context.editGear = await Promise.all(
      (this.item.system.startingGear ?? []).map(async (g) => {
        if (g.itemData) {
          return { name: g.name, uses: g.uses ?? "", isSnapshot: true, tags: gearTags(g.itemData.system, g.uses) };
        }
        const doc = await resolveGearItem(g.name, { uses: g.uses });
        return { name: g.name, uses: g.uses ?? "", isSnapshot: false, tags: doc ? gearTags(doc.system, g.uses) : [], missing: !doc && !!g.name };
      })
    );
    // The four starting numbers. Always rendered; the enable checkbox decides
    // whether the inputs are live, so an author can see what is waiting behind
    // the switch instead of a section that appears out of nowhere.
    context.startingAbilityRows = abilityRows(this.item.system.startingAbilities ?? {});

    // The languages this background grants, off the Warden's own list — the SAME
    // source and the same markup as the actor sheet's picker. A language ticked
    // before the Warden edited the setting still shows, rather than vanishing
    // from the form with the background still granting it (the actor sheet's
    // orphan rule, and for the same reason).
    const granted = this.item.system.languages ?? [];
    const worldLanguages = languages();
    context.languageOptions = worldLanguages.map((name) => ({ name, selected: granted.includes(name) }));
    for (const name of granted) {
      if (!worldLanguages.includes(name)) context.languageOptions.push({ name, selected: true, orphan: true });
    }

    // The age formula's placeholder and hint both name the system default, so
    // "leave it blank" is a statement rather than a guess. Off the config's one
    // copy, which is what rollAge falls back to.
    context.defaultAgeFormula = CONFIG.Cairn?.characterGenerator2e?.biography?.age ?? "";
    // Same for the coin dice, off the same one copy in the config.
    context.defaultGoldFormula = CONFIG.Cairn?.characterGenerator2e?.gold ?? "";

    context.maxTables = BG_MAX_TABLES;
    const tables = this.item.system.tables ?? [];
    context.canAddTable = tables.length < BG_MAX_TABLES;
    context.editTables = tables.map((st) => {
      const die = bgTableDie(st);
      return {
        heading: st.heading ?? "",
        question: st.question ?? "",
        die,
        dieChoices: BG_TABLE_DICE.map((v) => ({ value: v, label: `d${v}`, selected: v === die })),
        // As many rows as the die has faces — padded for display when the stored
        // array is short, so a table always LOOKS like the die it rolls on.
        options: Array.from({ length: die }, (_, oi) => {
          const so = st.options?.[oi] ?? {};
          return {
            description: so.description ?? "",
            bonusGold: so.bonusGold ?? 0,
            items: (so.items ?? []).map((it) => ({ name: it.name, isSnapshot: !!it.itemData })),
            abilityRows: abilityRows(so),
          };
        }),
      };
    });
  }

  /**
   * A deep clone of the background's tables in their canonical shape: every
   * table padded to its OWN die's face count, every option carrying all its
   * fields (including the four ability bonuses), and each option's real items —
   * with their `itemData` snapshots — and containers preserved. Handlers mutate
   * this and write it back, so editing one field on a blank table materializes
   * the full structure without dropping any data.
   *
   * NOT truncated to BG_MAX_TABLES: the cap belongs on the ADD action, and
   * enforcing it here would silently delete an eighth table because someone
   * typed in the first one's question.
   * @private
   */
  _normalizedTables() {
    const src = foundry.utils.deepClone(this.item.system.tables ?? []);
    return src.map((st) => {
      const die = bgTableDie(st);
      return {
        // The optional group heading printed above this question on the
        // character sheet. Normalized here like every other stored key,
        // because this function REBUILDS the array that gets written — a key
        // it does not carry is a key the next edit silently deletes.
        heading: st.heading ?? "",
        question: st.question ?? "",
        die,
        options: Array.from({ length: die }, (_, oi) => normalizedOption(st.options?.[oi] ?? {})),
      };
    });
  }

  /* -------------------------------------------- */

  /**
   * Non-click listeners only. Clicks are declared as `actions` in DEFAULT_OPTIONS
   * and wired by ApplicationV2; everything here is a `change` handler, which the
   * action system does not cover.
   * @override
   */
  /**
   * Frame-level listeners, bound once. The frame survives re-render, so binding
   * these in `_onRender` would stack a duplicate on every redraw.
   *
   * NOTE there is deliberately no `_preClose` editor save here. The item templates
   * use `<prose-mirror toggled>`, and a toggled editor commits only through its own
   * save button — which looks like it should mean "type a description, hit ✕, lose
   * it". Measured (`npm run dev:notes-editor`), it does not: on close the element's
   * `disconnectedCallback` calls `save()` (prosemirror-editor.mjs:130-138), the
   * resulting `change` still bubbles to the form inside the detached subtree, and
   * ApplicationV2 accepts a submit while the application is CLOSING
   * (application.mjs:2159-2161). Adding a `_preClose` save changed nothing, so it
   * was removed rather than shipped as insurance against a bug that isn't there.
   * @override
   */
  async _onFirstRender(context, options) {
    // Await the async super — same reason as the actor sheet's override.
    await super._onFirstRender(context, options);
    bindEditorClickAwaySave(this.element);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this.isEditable) return;
    const el = this.element;

    // If it's bulky it cannot be weightless too. These fire on the input during
    // the target phase, before the change bubbles to the form and submitOnChange
    // serializes it — so unchecking the sibling here is what gets saved.
    const exclusive = (a, b) => {
      el.querySelector(`[name='system.${a}']`)?.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        const other = el.querySelector(`[name='system.${b}']`);
        if (other) other.checked = false;
      });
    };
    exclusive("bulky", "weightless");
    exclusive("weightless", "bulky");

    if (this.item.type === "background") this._activateBackgroundListeners(el);
  }

  /**
   * Wire the authoring form's `change` handlers. Names, gear and table fields are
   * class-managed (no form `name=`), so they never round-trip through Foundry's
   * form serialization — each edit surgically updates one array element and
   * preserves the snapshots the DOM can't carry. Archetype/source are native
   * `name=` selects (Foundry saves those).
   * @private
   */
  _activateBackgroundListeners(el) {
    const item = this.item;
    const on = (selector, handler) =>
      el.querySelectorAll(selector).forEach((node) => node.addEventListener("change", handler));

    // THESE COMMITS MUST NOT RE-RENDER, and the reason is data loss rather than
    // flicker. A bare `item.update()` re-renders, AppV2 replaces the whole part
    // (handlebars-application.mjs `_replaceHTML`), and the replacement is built
    // from STORED data — so whatever the Warden has typed into the NEXT field
    // since tabbing into it, and not yet committed, is silently discarded. Tab
    // and keep typing and the characters vanish as the previous field lands.
    //
    // `render: false` is the fix, not an `id` on each input. `_syncPartState`
    // restores focus, scroll positions and `<details>` state — it does NOT
    // restore input VALUES, so an id would put the cursor back in a field that
    // had just been reset to its stored text. Skipping the render is also
    // simply correct here: the DOM already holds exactly what the author typed,
    // so there is nothing for a re-render to tell it. Same reasoning, and the
    // same one-word fix, as the `.scar-check` handler on the actor sheet.
    const commit = (data, render = false) => item.update(data, { render });

    // --- Example names ---------------------------------------------------------
    on(".bg-name-input", async (ev) => {
      const names = [...(item.system.names ?? [])];
      names[Number(ev.currentTarget.dataset.i)] = ev.currentTarget.value;
      await commit({ "system.names": names });
    });

    // --- Starting gear ---------------------------------------------------------
    on(".bg-gear-name", async (ev) => {
      const gear = foundry.utils.deepClone(item.system.startingGear ?? []);
      const i = Number(ev.currentTarget.dataset.i);
      gear[i].name = ev.currentTarget.value;
      // Typing a name over a snapshot converts the row back to a by-name pointer.
      // That flips `isSnapshot`, which draws the camera badge beside this input,
      // so THIS commit — alone among the six — has something on screen to
      // correct and must render. Only on the conversion itself: once the
      // snapshot is gone, further typing in the same field renders nothing, so
      // the ordinary case still cannot eat a neighbouring field's keystrokes.
      const wasSnapshot = !!gear[i].itemData;
      delete gear[i].itemData;
      await commit({ "system.startingGear": gear }, wasSnapshot);
    });
    on(".bg-gear-uses", async (ev) => {
      const gear = foundry.utils.deepClone(item.system.startingGear ?? []);
      const i = Number(ev.currentTarget.dataset.i);
      const v = parseInt(ev.currentTarget.value, 10);
      if (Number.isNaN(v) || v <= 0) delete gear[i].uses;
      else gear[i].uses = v;
      await commit({ "system.startingGear": gear });
    });

    // --- Granted languages -----------------------------------------------------
    // The whole checked set, every time, exactly as the actor sheet's picker
    // does it: managed here rather than through form serialization so unticking
    // the LAST one reliably stores an empty array instead of dropping the key.
    on(".language-check", async () => {
      const langs = [...el.querySelectorAll(".language-check:checked")].map((o) => o.value);
      await commit({ "system.languages": langs });
    });

    // --- The question tables ---------------------------------------------------
    on(".bg-table-heading", async (ev) => {
      const tables = this._normalizedTables();
      tables[Number(ev.currentTarget.dataset.t)].heading = ev.currentTarget.value;
      await commit({ "system.tables": tables });
    });
    on(".bg-table-question", async (ev) => {
      const tables = this._normalizedTables();
      tables[Number(ev.currentTarget.dataset.t)].question = ev.currentTarget.value;
      await commit({ "system.tables": tables });
    });
    // Changing the die RESIZES the table: growing appends blank rows, shrinking
    // drops the tail. Shrinking is destructive, so a row that holds anything
    // (text, gold, an item, a container or an ability bonus) is confirmed first
    // — there is no undo on an item document, and the rows go the moment the
    // update lands. Declining puts the select back by re-rendering from stored
    // data. This is the ONE commit here that must render: the row count on
    // screen has changed.
    on(".bg-table-die", async (ev) => {
      const ti = Number(ev.currentTarget.dataset.t);
      const die = Number(ev.currentTarget.value);
      const tables = this._normalizedTables();
      const table = tables[ti];
      if (!table || !BG_TABLE_DICE.includes(die) || table.die === die) return;
      const doomed = table.options.slice(die).filter(optionHasContent);
      if (doomed.length) {
        const ok = await confirmDataLoss(
          "CAIRN.BgAuthor.ShrinkTitle",
          game.i18n.format("CAIRN.BgAuthor.ShrinkWarn", { n: doomed.length, die: `d${die}` })
        );
        // Declining puts the select back the only way it can be put back: a
        // re-render from stored data. Guarded on `rendered` because the dialog
        // is awaited and the sheet may have been closed behind it — rendering a
        // closed application would reopen it.
        if (!ok) { if (this.rendered) this.render(); return; }
      }
      table.die = die;
      table.options = Array.from({ length: die }, (_, oi) => normalizedOption(table.options[oi] ?? {}));
      await commit({ "system.tables": tables }, true);
    });
    on(".bg-option-desc", async (ev) => {
      const tables = this._normalizedTables();
      tables[Number(ev.currentTarget.dataset.t)].options[Number(ev.currentTarget.dataset.o)].description = ev.currentTarget.value;
      await commit({ "system.tables": tables });
    });
    on(".bg-option-gold", async (ev) => {
      const tables = this._normalizedTables();
      const v = parseInt(ev.currentTarget.value, 10);
      tables[Number(ev.currentTarget.dataset.t)].options[Number(ev.currentTarget.dataset.o)].bonusGold = Number.isNaN(v) ? 0 : Math.max(0, v);
      await commit({ "system.tables": tables });
    });
    // The four ability bonuses on one option row. NO Math.max here, unlike gold:
    // a negative bonus is the point of the field — a background may cost a
    // character strength as readily as give it. The clamp that matters is at
    // GENERATION (withAbilityBonuses), where the sum meets a real character and
    // cannot take an ability below zero.
    on(".bg-option-ability-input", async (ev) => {
      const { t, o, k } = ev.currentTarget.dataset;
      const tables = this._normalizedTables();
      const v = parseInt(ev.currentTarget.value, 10);
      tables[Number(t)].options[Number(o)][k] = Number.isNaN(v) ? 0 : v;
      await commit({ "system.tables": tables });
    });
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * "Test ×10": a dry-run report on this draft — resolution lint plus a sampled
   * option/gold spread — shown in a dialog. Reuses the real generator logic
   * (previewBackground), so it doubles as the pre-share self-contained linter.
   * @this {CairnItemSheet}
   */
  static async #onTestBackground(event) {
    event.preventDefault();
    const report = await previewBackground(this.item, 10);
    new foundry.applications.api.DialogV2({
      window: { title: game.i18n.format("CAIRN.BgAuthor.TestTitle", { name: this.item.name }), icon: "fas fa-flask" },
      position: { width: 560 },
      content: renderPreviewReport(report),
      buttons: [{ action: "close", label: game.i18n.localize("CAIRN.Close"), default: true }],
    }).render(true);
  }

  /**
   * The item art picker, in place of core's bare FilePicker.
   *
   * Two galleries: the Warden's custom folder and Game-Icons. No Aspeheim —
   * those are character portraits, and a longsword has no face. The URL row and
   * the Browse escape are still there, so nothing a Warden could do before is
   * taken away; core's FilePicker was only ever the Browse half of this.
   *
   * Items carry no token, so this writes `img` alone — the actor pickers pair a
   * token with it, and copying that here would put a texture on a document that
   * has nowhere to keep one.
   * @this {CairnItemSheet}
   */
  static async #onEditImage(event) {
    event.preventDefault();
    await pickArt({
      current: this.item.img,
      title: game.i18n.localize("CAIRN.ChooseItemArt"),
      custom: true,
      gameIcons: true,
      browseStart: this.item.img,
      onPick: (src) => this.item.update({ img: src }),
    });
  }

  /** @this {CairnItemSheet} */
  static async #onAddName() {
    await this.item.update({ "system.names": [...(this.item.system.names ?? []), ""] });
  }

  /** @this {CairnItemSheet} */
  static async #onRemoveName(event, target) {
    const names = [...(this.item.system.names ?? [])];
    names.splice(Number(target.dataset.i), 1);
    await this.item.update({ "system.names": names });
  }

  /** @this {CairnItemSheet} */
  static async #onAddGear() {
    await this.item.update({ "system.startingGear": [...(this.item.system.startingGear ?? []), { name: "" }] });
  }

  /** @this {CairnItemSheet} */
  static async #onRemoveGear(event, target) {
    const gear = foundry.utils.deepClone(this.item.system.startingGear ?? []);
    gear.splice(Number(target.dataset.i), 1);
    await this.item.update({ "system.startingGear": gear });
  }

  /** @this {CairnItemSheet} */
  static async #onRemoveOptionItem(event, target) {
    const { t: ti, o, i } = target.dataset;
    const tables = this._normalizedTables();
    tables[Number(ti)].options[Number(o)].items.splice(Number(i), 1);
    await this.item.update({ "system.tables": tables });
  }

  /**
   * Add a question table: a d6 with six blank rows, the shape most 2e questions
   * take. The cap is enforced HERE — `_normalizedTables` deliberately does not,
   * so an over-full document is never trimmed as a side effect of an unrelated
   * edit — and a refusal SAYS so, because the add link is hidden at the cap and
   * a click that arrives anyway (a stale render) must not do nothing in silence.
   * @this {CairnItemSheet}
   */
  static async #onAddTable() {
    const tables = this._normalizedTables();
    if (tables.length >= BG_MAX_TABLES) {
      ui.notifications.warn(game.i18n.format("CAIRN.BgAuthor.TablesFull", { max: BG_MAX_TABLES }));
      return;
    }
    tables.push({
      question: "",
      die: BG_DEFAULT_DIE,
      options: Array.from({ length: BG_DEFAULT_DIE }, () => normalizedOption()),
    });
    await this.item.update({ "system.tables": tables });
  }

  /**
   * Remove a question table. Confirmed whenever it holds anything — the same
   * rule, and the same test, as shrinking one: a whole table going without a
   * word would be stranger than a single row asking.
   * @this {CairnItemSheet}
   */
  static async #onRemoveTable(event, target) {
    const ti = Number(target.dataset.t);
    const tables = this._normalizedTables();
    const table = tables[ti];
    if (!table) return;
    const hasContent = !!String(table.question ?? "").trim() || table.options.some(optionHasContent);
    if (hasContent) {
      const ok = await confirmDataLoss(
        "CAIRN.BgAuthor.RemoveTableTitle",
        game.i18n.format("CAIRN.BgAuthor.RemoveTableWarn", { n: ti + 1 })
      );
      if (!ok) return;
    }
    tables.splice(ti, 1);
    await this.item.update({ "system.tables": tables });
  }

  /* -------------------------------------------- */

  /**
   * Snapshot a dragged Item onto the authoring form. The drop zone under the
   * cursor decides where it lands: a table option (`data-drop="option"`) or, by
   * default, starting gear.
   *
   * Only backgrounds react to Item drops. Everything else falls through to
   * ItemSheetV2 — whose _onDrop routes ActiveEffect drops to _onDropActiveEffect,
   * which this sheet OVERRIDES to refuse (below), matching the actor sheet.
   * Core's default would create an invisible, unremovable effect on the item;
   * nothing here renders or consumes one.
   * @override
   */
  async _onDrop(event) {
    if (this.item.type !== "background" || !this.isEditable) return super._onDrop(event);
    let data;
    try {
      data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    } catch (_e) {
      return;
    }
    if (data?.type !== "Item") return super._onDrop(event);
    // Core fires this hook before handling any sheet drop and honours a false
    // veto (item-sheet.mjs:129-130). Every delegated path above gets it from
    // super._onDrop; this branch takes the drop itself, so it owes the same
    // call — a module vetoing drops heard about every item type but
    // backgrounds (review #6). Exactly once per drop on every path.
    if (Hooks.call("dropItemSheetData", this.item, this, data) === false) return;
    const dropped = await Item.implementation.fromDropData(data);
    if (!dropped) return;
    if (dropped.type === "background") {
      ui.notifications.warn(game.i18n.localize("CAIRN.BgAuthor.NoBackgroundDrop"));
      return;
    }
    const snap = snapshotItem(dropped);
    const zone = event.target.closest("[data-drop]");
    if (zone?.dataset.drop === "option") {
      const tables = this._normalizedTables();
      tables[Number(zone.dataset.t)].options[Number(zone.dataset.o)].items.push({ name: snap.name, itemData: snap });
      await this.item.update({ "system.tables": tables });
    } else {
      const gear = foundry.utils.deepClone(this.item.system.startingGear ?? []);
      gear.push({ name: snap.name, itemData: snap });
      await this.item.update({ "system.startingGear": gear });
    }
  }

  /**
   * Refuse ActiveEffect drops, mirroring the actor sheet (review #9). No sheet
   * here renders an effects list and no data model consumes one, so core's
   * default — creating the effect on the item — would leave an invisible
   * modifier that transfers to the owning actor on the normal preparation pass,
   * unremovable except via the console. If effects ever get a surface, this
   * override goes with it.
   * @override
   */
  async _onDropActiveEffect() {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.EffectsUnsupported"));
    return null;
  }
}
