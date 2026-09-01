import { SETTINGS_NS } from "../settings.js";
import { grantSourceLabel } from "../utils.js";
import { iconForItem, SPELLBOOK_ICON, SPELLSCROLL_ICON } from "../icons.js";
import { BOOK_PAGE_KEYS } from "../data-models.js";

/**
 * The stored name of a Fatigue item. ENGLISH, always — Foundry's language setting
 * is per-client, so an item created under the translated name was invisible to
 * every other language: a Spanish player's "Fatiga" did not match the English GM's
 * remove filter, and the − button silently did nothing for them both ways round.
 *
 * The sheet localizes the label it shows from a UI key, so nobody actually
 * reads this string.
 */
export const FATIGUE_NAME = "Fatigue";

/* `SPELLSCROLL_NAME` stood here and is GONE with the `abSpellscrollTypeOption`
   hook that was its only reader. That hook injected a second "Spellscroll" option
   into the Create Item dialog, keyed on `option[value="spellbook"]`; there is no
   such type any more, and a scroll is now a `spell` with its own checkbox. The
   English-storage rule the constant existed to keep is unchanged for FATIGUE_NAME
   above, which is the only stored name the code still matches on. */

/**
 * Every Pergamino is petty and single-use — the Warden's rule, and the one thing
 * that separates a scroll from the spell it holds. So it is derived from the
 * `scroll` flag rather than typed in: the spell sheet offers no Petty box and no
 * Max uses field, and these values are written whenever the flag is.
 *
 * `bulky: false` rides along because a spell is never bulky either way (see
 * SPELL_PINNED) and a scroll least of all — pinning it in both directions means
 * no path can leave a two-slot scroll behind.
 *
 * `uses.value` is deliberately absent: it is set once, on the transition to
 * `scroll: true` (a fresh scroll has its use), and left alone afterwards so
 * marking one spent survives the next save. Forcing it here would silently refill
 * every scroll on every edit.
 */
const SCROLL_PINNED = { weightless: true, bulky: false, equipped: false, "uses.max": 1 };

/**
 * A plain Hechizo: exactly ONE slot, always. Never bulky, never petty — the two
 * checkboxes the spell sheet therefore does not offer — and no uses counter,
 * which is what ticking `scroll` off restores.
 *
 * Pinned rather than defaulted, the SCROLL_PINNED rule: a schema `initial` is a
 * value a Warden unticks, and "a spell costs one slot" is a statement about
 * every write.
 */
const SPELL_PINNED = { weightless: false, bulky: false, "uses.max": 0, "uses.value": 0 };

/**
 * A Libro: ALWAYS bulky, two slots, whatever wrote it.
 *
 * Same shape and same reasoning as SCROLL_PINNED — a pinned value, not a schema
 * default the user can untick — and the sheet renders the Bulky box disabled so
 * the rule is visible rather than merely enforced. `weightless: false` is the
 * other half: the two flags are mutually exclusive everywhere else in this
 * system (the item sheet's `exclusive` pair), so pinning one without the other
 * would leave "bulky AND petty" reachable by API.
 */
const BOOK_PINNED = { bulky: true, weightless: false };

/**
 * A Libro's non-empty pages, in tab order, ready to render or to cast from.
 *
 * ONE reader for three surfaces — the sheet's tabs, the inventory row's
 * "1. Nombre: texto" lines and the cast picker — so "which pages does this book
 * actually have" is answered in one place. A page counts as present when it has
 * a name or a text; blankness is the only marker a page is unused.
 * @param {CairnItem|Object} book  a book document, or a display copy of one
 * @returns {{n: number, key: string, name: string, text: string}[]}
 */
export const bookPages = (book) => {
  const pages = book?.system?.pages ?? {};
  return BOOK_PAGE_KEYS
    .map((key, i) => ({
      n: i + 1,
      key,
      name: pages[key]?.name ?? "",
      text: pages[key]?.text ?? "",
    }))
    .filter((p) => p.name.trim() !== "" || p.text.trim() !== "");
};

/* `isClearing` stood here and is GONE with its only two readers, the
   `grimoireKey` and `boundTo` guards. It answered "is this update trying to
   BLANK a string field", which mattered for two identities that had to be
   permanent; no string field on the new types is. If one ever is again, the
   three spellings it had to catch were `""`, `null`, and v14's `ForcedDeletion`
   operator (common/data/operators.mjs:81) — a guard testing only `=== ""` is
   walked past by the spelling the platform itself now recommends. */

/**
 * Extend the basic Item with some very simple modifications.
 * @extends {Item}
 */
export class CairnItem extends Item {
  /**
   * The schema-level art seam: `img`'s field initial consults this
   * (common/documents/item.mjs:50-52) for EVERY route that creates an item
   * without art — including items riding inside an Actor's creation payload,
   * which never reach `_preCreate` (the client preCreates only the
   * operation's top-level documents, client-backend.mjs:103). That gap
   * shipped generated monsters whose attack and armor items wore core's grey
   * item-bag while Regenerate — whose re-roll path goes through
   * createEmbeddedDocuments — stamped the system glyph on the same items
   * (review #9). The _preCreate stamp below remains for what it adds on its
   * routes (the DEFAULT_ICON re-stamp for dialog-created items).
   */
  static getDefaultArtwork(itemData) {
    const type = itemData?.type ?? "item";
    const img = type === "spell" && itemData?.system?.scroll
      ? SPELLSCROLL_ICON
      : iconForItem(type, itemData?.name ?? "");
    return { img };
  }

  /**
   * Where a new row LANDS — see `#appendSort` below. It needs the BATCH rather
   * than the document, which is why it sits at this seam.
   *
   * The one-book wall stood here too and is GONE with the Grimoire flag it
   * policed ("a character carries at most one Grimoire"). A `book` is an
   * ordinary type now, with no shared page pool for two of them to fight over,
   * so there is nothing left to enforce; `#enforceOneBook` went with it.
   * @override
   */
  static async _preCreateOperation(documents, operation, user) {
    const allowed = await super._preCreateOperation(documents, operation, user);
    if (allowed === false) return false;

    CairnItem.#appendSort(documents, operation?.parent);
  }

  /**
   * Give an arriving item a place at the END of the list rather than the top.
   *
   * A generated loadout arrives ARRANGED — weapons, armor, everything else,
   * light, Rations (gear.js `orderGrantedItems`) — and those payloads carry
   * explicit non-zero sorts, which this leaves alone. Everything ELSE created on
   * an actor arrives at `sort: 0`, the field's initial
   * (common/data/fields.mjs:3974-3983), and 0 is ABOVE every numbered row: with
   * nothing here, buying one thing at the marketplace put it at the top of the
   * pack, over the sword.
   *
   * That was already true before any of the ordering work, which is why this is
   * a fix and not merely its support: the first drag renormalises every sibling
   * to positive values (`performIntegerSort`), and the next new item landed
   * above all of them.
   *
   * `sort` being 0 IS the discriminator. An item deliberately created at 0 is
   * indistinguishable from one that stated nothing, and appending it is harmless.
   *
   * Ungated by any setting. It used to be "ungated by `enable-inventory-reorder`"
   * — that toggle decided whether the sheet READ `sort`, and writing a
   * meaningful one into a world that ignored it cost nothing. The toggle was
   * retired 2026-08-22 (manual order is always on), so the sheet always reads
   * what this writes.
   *
   * Actors only — a world or compendium item has no actor parent, and the
   * sidebar does its own ordering.
   * @param {CairnItem[]} documents  temporary instances, mutated via updateSource
   * @param {Document|null} parent
   */
  static #appendSort(documents, parent) {
    if (parent?.documentName !== "Actor") return;
    let next = parent.items.reduce((max, i) => Math.max(max, i.sort ?? 0), 0);
    for (const doc of documents) {
      if (doc.sort) continue;
      next += CONST.SORT_INTEGER_DENSITY;
      doc.updateSource({ sort: next });
    }
  }

  /**
   * Hold a spell to the scroll invariant, and a book to the bulky one, at write
   * time — whichever path wrote it: the sheet's Pergamino box, generation, a
   * drag-and-drop copy, an importer, or `Actor#createOwnedItem` (which rebuilds
   * `system.weightless` from a top-level field, so it would hand back an
   * un-petty scroll on its own).
   *
   * Written to the document rather than derived in `prepareData`, so the stored
   * data is true — a derived-only petty flag would be a lie to anything reading the
   * document instead of the prepared model, and re-deriving a value that a form
   * also binds is how the HP clobber bug worked.
   * @override
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;

    // A HECHIZO NEVER CHANGES HANDS — the ENFORCEMENT half of the wall whose
    // affordance is `CairnActorSheet._onDropItem`'s refusal. Two layers, the
    // house rule: removing either alone must not look like a landed change, so
    // a stale sheet, a macro or a module write all meet this whatever the UI
    // showed.
    //
    // A TRANSFER is the one create that names an item ANOTHER actor is still
    // holding. Core's drop path hands `item.toObject()` to
    // `createEmbeddedDocuments` — `_id` and all — and deletes the source only
    // afterwards, so at this moment both ends exist. A compendium or sidebar
    // drop carries an `_id` too, which is why the id alone decides nothing: the
    // source having an ACTOR is the whole test. Generation, the marketplace and
    // the Create Item dialog name no `_id` at all and never reach the scan.
    if (this.type === "spell" && this.parent?.documentName === "Actor" && data?._id) {
      const from = game.actors?.find((a) => a !== this.parent && a.items.has(data._id));
      if (from) {
        ui.notifications.warn(game.i18n.localize("CAIRN.Notify.SpellNoTransfer"));
        return false;
      }
    }

    /* A CONVERSION SEAM stood here and is GONE with the module that drove it.
       It caught every arriving non-scroll spell — a compendium drag, the Create
       Item dialog, an importer, a macro — and rewrote it into a spellscroll
       carrying a second, re-worded copy of the same spell's text, because a
       rules setting said the world was in the other of two magic modes. There
       is one set of magic rules now and nothing to convert between: a spell
       arrives exactly as its author wrote it, scroll or not. Do not re-add it. */

    // Class art for anything created WITHOUT its own image. Foundry's Item schema
    // initialises `img` to `icons/svg/item-bag.svg`, so every item made through the
    // Create Item dialog kept the generic bag: a hand-made weapon, armor, book
    // or scroll looked nothing like the shipped ones. `Actor#createOwnedItem` has
    // always done this for items it mints; the world/dialog path never did.
    //
    // It also unblocked the scroll art. `_preUpdate` only re-arts an item whose
    // image is still ours to change, and a bag was not — so ticking Pergamino on
    // a dialog-created spell silently left the bag in place.
    if (!this.img || this.img === this.constructor.DEFAULT_ICON) {
      const art = this.type === "spell" && this.system.scroll
        ? SPELLSCROLL_ICON
        : iconForItem(this.type, this.name);
      this.updateSource({ img: art });
    }

    // A LIBRO IS BULKY, from its first write. No transition to catch here the
    // way the scroll flag has one: there is no un-bulky state a book can arrive
    // in that this should preserve.
    if (this.type === "book") {
      this.updateSource({ system: { ...BOOK_PINNED } });
      return;
    }

    if (this.type !== "spell") return;
    // A plain spell is one slot: neither bulky nor petty, no uses counter. The
    // scroll case takes over below.
    if (!this.system.scroll) {
      this.updateSource({ system: { ...SPELL_PINNED } });
      return;
    }
    const pinned = { ...SCROLL_PINNED };
    // A scroll created straight from the flag arrives UNSPENT — pinning only `max`
    // left `value` at the schema default of 0, so a new scroll rendered as already
    // used up. One created with an explicit count keeps it, which is what lets a
    // generated spent scroll be copied across without refilling it.
    if (foundry.utils.getProperty(data ?? {}, "system.uses.value") === undefined) {
      pinned["uses.value"] = 1;
    }
    this.updateSource({ system: pinned });
  }

  /**
   * The same invariants on edit, plus the Pergamino transition. Ticking it makes
   * a fresh scroll (its one use unspent) and unticking restores a plain
   * one-slot Hechizo; while the flag merely stays on, `uses.value` is left alone
   * so a spent scroll stays spent. A Libro has no transition at all — it is
   * bulky before and after.
   *
   * The art follows the flag only when it is still ours to change — a Warden who
   * picked their own image keeps it.
   * @override
   */
  async _preUpdate(changed, options, user) {
    const allowed = await super._preUpdate(changed, options, user);
    if (allowed === false) return false;

    // A Libro stays bulky through every edit, including one that names Bulky
    // itself. The sheet's box is disabled, so only an API write can even try —
    // and it is stripped rather than refused, the scroll-pin precedent: the
    // rest of the edit lands, the un-bulking silently does not.
    if (this.type === "book") {
      foundry.utils.mergeObject(changed, { system: { ...BOOK_PINNED } });
      return;
    }

    if (this.type !== "spell") return;

    // The OPERATOR spelling, normalized before any guard reads it (review
    // #17): a ForcedDeletion resets a field to its schema initial — false,
    // for this required boolean — and is a truthy OBJECT, so it walked
    // straight past every equality and truthiness test below: a scroll reset
    // that took the BECOMING-scroll branch and pinned scroll uses onto a
    // non-scroll. On a required boolean the operator IS a plain `false` write
    // (and passing it through to the schema draws a "may not be undefined"
    // validation complaint on its way to the same end state), so it is
    // rewritten to one here and the guards below reason about booleans only.
    if (changed.system?.scroll instanceof foundry.data.operators.ForcedDeletion) {
      changed.system.scroll = false;
    }

    // A TRANSITION, not a presence. `_preUpdate` is handed the FULL cleaned
    // payload, not the diff (client-backend.mjs:229-238), and the spell sheet
    // submits the Pergamino checkbox with every `submitOnChange` — so
    // `!== undefined` alone was true for EVERY edit of a scroll's sheet, each
    // one re-entered the becoming-scroll branch below and re-pinned
    // `uses.value: 1`: a spent scroll refilled on a Cost edit, and the Uses
    // field could never store 0 (review #18). Compared to the STORED flag,
    // only a real tick or untick is a transition; a payload merely carrying the
    // flag falls through to the hold branch, which leaves `uses.value` alone.
    const scrollChanged = changed.system?.scroll !== undefined
      && !!changed.system.scroll !== !!this.system.scroll;
    if (scrollChanged) {
      // Safe to read as truthiness only because the normalization above has
      // already rewritten a ForcedDeletion to plain `false` — un-normalized,
      // the truthy operator took this branch while resetting the flag.
      const becomingScroll = !!changed.system.scroll;
      foundry.utils.mergeObject(changed, {
        system: becomingScroll ? { ...SCROLL_PINNED, "uses.value": 1 } : SPELL_PINNED,
      });
      // Re-art only while the image is still ours to change — a Warden who picked
      // their own keeps it. The default bag counts as ours: items created before
      // the class-art fill above still carry it, and leaving those on a bag was
      // the whole reported defect.
      const was = becomingScroll ? SPELLBOOK_ICON : SPELLSCROLL_ICON;
      if (this.img === was || this.img === this.constructor.DEFAULT_ICON) {
        changed.img = becomingScroll ? SPELLSCROLL_ICON : SPELLBOOK_ICON;
      }
      return;
    }
    // No transition: hold whichever invariant is in force for a spell being
    // edited. Both are held, not just the scroll's — a plain spell is one slot
    // by the same rule a scroll is petty, and the sheet offers neither box.
    foundry.utils.mergeObject(changed, {
      system: this.system.scroll ? { ...SCROLL_PINNED } : { ...SPELL_PINNED },
    });
  }

  /**
   * Augment the basic item data with additional dynamic data.
   */
  prepareData() {
    super.prepareData();
    // Items inside a THING are cargo, never equipped (the drop handler
    // un-equips on the way in; this is what keeps them that way). The test was
    // `actor.type != "container"` until 2026-08-04 — that TYPE was retired
    // 2026-07-31, so the clause compared against a value no actor can hold and
    // was always true: a Warden could re-tick Equipped on armor sitting in a
    // crate and calcArmor counted it. `isThing` is the live rule (role
    // container/transport), the same test every other site migrated to.
    // WEAPONS AND ARMOR ONLY. It used to include `spellbook`, minus scrolls and
    // bound pages — the two spellbooks that could not be held ready. Neither of
    // the types that replaced it is equippable at all: a Libro is read, not
    // wielded, and a Hechizo is cast, so the boxes are gone from both sheets and
    // the two exceptions have nothing left to except.
    this.system.isEquipable =
      ["weapon", "armor"].includes(this.type) && !this.actor?.isThing;
    this.system.hasPlusMinus = (this.system.uses?.max ?? 0) > 0;
    // AMMUNITION READS AS A NUMBER PAIR ("15/20"), not as a row of circles: a
    // quiver of twenty is twenty icons, which is a smear rather than a count.
    // DERIVED, never declared — a schema field would be a second, storable
    // answer to a question `ranged` already settles, and the two could disagree.
    // Consumed by items-list.html, which branches on this alone.
    this.system.usesAsNumbers = this.type === "weapon" && this.system.ranged === true;
    if (this.system.uses) {
      if (this.system.uses.value > this.system.uses.max)
        this.system.uses.value = this.system.uses.max;
    }
    this.system.isFatigue = this.name === FATIGUE_NAME;

    // Grant-source chip (Background / Bond / Question) shown beside the item's
    // other tags, so the three sources are distinguishable. Starting gear and
    // bought items get none. The source rides on the item as
    // flags.mondolme.grantSource ("background" / "bond:<id>" / "question:<i>"),
    // set at generation; the re-roll/replacement machinery keys off it, so the
    // display-only "show-grant-tags" setting never affects the flag itself.
    // A container that a background/question rolled, but recorded as a plain
    // (weightless) inventory item because the Containers tab is off. It keeps its
    // grantSource for the re-roll machinery, so the "Container" tag rides on a
    // separate flag and takes precedence over the source label. That flag also
    // suppresses the "Petty" (weightless) chip in the inventory row — a cart isn't
    // a petty item, it just isn't tracked as cargo when the feature is off.
    const grantSource = this.getFlag("mondolme", "grantSource");
    const isContainerItem = !!this.getFlag("mondolme", "containerItem");
    this.system.isContainerItem = isContainerItem;
    // The UNGATED label first — the mapping alone, no setting. The printed
    // sheet shows the tag under its OWN switch (show-grant-tags-print), so
    // it reads this raw value; the sheet's display gate is applied one
    // statement below. Fold the two back together and the print silently
    // couples to the inventory switch (the probe's inv-off leg is the
    // witness).
    this.system.grantLabelRaw = isContainerItem
      ? game.i18n.localize("CAIRN.GrantContainer")
      : grantSourceLabel(grantSource);
    this.system.grantLabel = game.settings.get(SETTINGS_NS, "show-grant-tags")
      ? this.system.grantLabelRaw : "";

    this.system.useItemIcons = game.settings.get(SETTINGS_NS, "use-item-icons");
    if (this.system.useItemIcons) {
      this.system.icon = "";
      switch (this.type) {
        case "book":
          this.system.icon = "book";
          break;
        case "spell":
          this.system.icon = this.system.scroll ? "scroll" : "hat-wizard";
          break;
        case "weapon":
          this.system.icon = "sword";
          break;
        case "armor":
          this.system.icon = "shield";
          break;
        case "item":
          if (this.name === FATIGUE_NAME) {
            this.system.icon = "weight-hanging";
          }
          break;
      }
    }
    // Quantity fallback
    if (this.system.quantity == undefined) {
      this.system.quantity = 1;
    }
  }
}
