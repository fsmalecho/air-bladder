import { SETTINGS_NS } from "../settings.js";
import { grantSourceLabel } from "../utils.js";
import { iconForItem } from "../icons.js";
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

/**
 * Every Pergamino is PETTY — it weighs nothing and costs no slot — and is never
 * equipped. The Warden's rule, and the sheet offers neither box, so this is
 * where it is true.
 *
 * `bulky: false` rides along because pinning one of the two exclusive flags
 * without the other would leave "bulky AND petty" reachable by API.
 *
 * `quantity` is DELIBERATELY ABSENT: a Pergamino stacks (2026-09-02, user
 * ruling), and its quantity is the count of copies — three scrolls of the same
 * spell are three castings, and `castScroll` spends one. Pinning it would be
 * pinning the ammunition to full.
 *
 * `uses` is absent for the same reason it no longer exists on the model: the
 * flagged version counted a single use there, which made a stack of scrolls
 * unrepresentable.
 */
const SCROLL_PINNED = { weightless: true, bulky: false, equipped: false };

/**
 * A plain Hechizo: exactly ONE slot and exactly ONE copy, always. Never bulky,
 * never petty, no uses counter, no quantity field on its sheet — a memorised
 * spell is in your head or it is not, so a stack of two was never a quantity of
 * anything (`quantity: 1` joined this pin 2026-09-02, user ask).
 *
 * Pinned rather than defaulted, the SCROLL_PINNED rule: a schema `initial` is a
 * value a Warden unticks, and "a spell costs one slot" is a statement about
 * every write.
 */
const SPELL_PINNED = { weightless: false, bulky: false, quantity: 1, "uses.max": 0, "uses.value": 0 };

/**
 * A Libro: ALWAYS bulky, two slots, and ALWAYS a single copy.
 *
 * Same shape and same reasoning as SCROLL_PINNED — a pinned value, not a schema
 * default the user can untick — and the sheet renders the Bulky box disabled so
 * the rule is visible rather than merely enforced. `weightless: false` is the
 * other half: the two flags are mutually exclusive everywhere else in this
 * system (the item sheet's `exclusive` pair), so pinning one without the other
 * would leave "bulky AND petty" reachable by API.
 *
 * `quantity: 1` joined them 2026-09-02 (user ask), and the Cantidad field came
 * off the sheet with it. A book is a specific object with specific words in it
 * — three pages somebody wrote — so "×3" was never a stack of anything, and the
 * slot arithmetic multiplied its two slots by it. Pinned rather than merely
 * hidden, because the drop path stacks by name+type: dropping a second copy of
 * the same book used to bump the quantity, and now it lands as its own row.
 */
const BOOK_PINNED = { bulky: true, weightless: false, quantity: 1 };

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
    // The scroll branch that stood here is GONE with the flag it read: `scroll`
    // is a TYPE now, so `iconForItem` answers for it like every other one.
    return { img: iconForItem(type, itemData?.name ?? "") };
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
   * Hold each type to its invariant at write time — whichever path wrote it:
   * the sheet, generation, a drag-and-drop copy, an importer, or
   * `Actor#createOwnedItem` (which rebuilds `system.weightless` from a
   * top-level field, so it would hand back an un-petty scroll on its own).
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
      this.updateSource({ img: iconForItem(this.type, this.name) });
    }

    // A LIBRO IS BULKY, from its first write. No transition to catch here the
    // way the scroll flag has one: there is no un-bulky state a book can arrive
    // in that this should preserve.
    if (this.type === "book") {
      this.updateSource({ system: { ...BOOK_PINNED } });
      return;
    }
    // A PERGAMINO is petty and never equipped. Its `quantity` is left alone —
    // it is the count of copies, and a stack of three is three castings.
    if (this.type === "scroll") {
      this.updateSource({ system: { ...SCROLL_PINNED } });
      return;
    }
    // A HECHIZO is one slot, one copy: neither bulky nor petty, no uses
    // counter. There is no scroll branch here since 2026-09-02 — a scroll is
    // its own type above, so nothing has to be told apart.
    if (this.type === "spell") this.updateSource({ system: { ...SPELL_PINNED } });
  }

  /**
   * The same invariants on edit.
   *
   * NO TRANSITIONS LEFT (2026-09-02). This method used to carry the whole
   * becoming-a-scroll dance — normalizing a ForcedDeletion on the flag,
   * telling a real tick from a payload that merely carried it, re-pinning the
   * one use, swapping the art — because a Pergamino was a `spell` with a
   * checkbox and the checkbox could be flipped. It is its own TYPE now, and a
   * document's type is immutable, so there is no flip to catch: each type
   * simply holds its own invariant through every edit.
   *
   * Held rather than refused, the long-standing rule here: an API write that
   * tries to un-petty a scroll or un-bulk a book lands with that part silently
   * stripped, and the rest of the edit goes through. Neither sheet offers the
   * boxes, so only an API write can even try.
   * @override
   */
  async _preUpdate(changed, options, user) {
    const allowed = await super._preUpdate(changed, options, user);
    if (allowed === false) return false;

    const pinned = { book: BOOK_PINNED, scroll: SCROLL_PINNED, spell: SPELL_PINNED }[this.type];
    if (pinned) foundry.utils.mergeObject(changed, { system: { ...pinned } });
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

    // Grant-source chip (Background / Question) shown beside the item's
    // other tags, so the three sources are distinguishable. Starting gear and
    // bought items get none. The source rides on the item as
    // flags.mondolme.grantSource ("background" / "question:<i>"),
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
          this.system.icon = "hat-wizard";
          break;
        case "scroll":
          this.system.icon = "scroll";
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
