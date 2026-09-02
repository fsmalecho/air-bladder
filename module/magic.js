/**
 * The cast flow — a DialogV2 raised from a carried Libro or from a Hechizo, a
 * resolved spell text, a public card and a private whisper (rulings
 * 2026-08-09).
 *
 * THESE ARE THE MAGIC RULES OF THIS SYSTEM, not a variant of them. There is no
 * setting to consult and no second mode to convert to or from: Magic Dice are
 * the caster's FREE INVENTORY SLOTS, read at the moment of asking and never
 * stored — fill a slot and the next cast's pool shrinks by itself, so the
 * feedback loop falls out of the slot math with no bookkeeping to drift. The
 * dice cap at 4, the Roll is a real Foundry Roll (DSN animates it) SPOKEN BY
 * THE CHARACTER, and nothing mechanical is automated past the report: the
 * whisper offers ONE button — Add N Fatigue, never refused (`ignoreCapacity`)
 * — and on doubles it carries the drawn Mishap. The Mishaps table resolves
 * WORLD-FIRST, the Faction-die precedent, so a Warden customizes it by
 * importing a world copy.
 *
 * THREE WAYS TO CAST, one back half (`reportCast`):
 *   - from a Libro: pick one of the book's non-empty pages (`castFromBook`);
 *   - a Hechizo: the spell item casts itself (`castSpell`);
 *   - a Pergamino: a Hechizo with `scroll` ticked — confirmed first, because
 *     the cast destroys the paper, and deleted after the card (`castSpell`).
 */
import { FATIGUE_NAME, bookPages } from "./item/item.js";
import { findTableByName } from "./compendium.js";
import { TABLES } from "./content-packs.js";
import { formatCount } from "./utils.js";

/**
 * The Mishaps table, by NAME — the Warden's own copy first (findTableByName is
 * world-first), then their Generadores compendium. Re-exported rather than read
 * inline because the card names the table it could not find, and the message
 * and the lookup must never disagree about which name that is.
 */
export const MISHAPS_TABLE_NAME = TABLES.mishaps;

/**
 * Every GRIMORIO `actor` holds — a Libro with `system.grimoire` ticked.
 *
 * BOTH tests since 2026-09-02 (user ask). `book` is the TYPE and nothing limits
 * a character to one of them — which is why every caller below either takes the
 * book it was pointed at or offers ALL of them, and none reaches for `[0]`. The
 * FLAG is what says those three pages are spells: a Libro without it is a book,
 * readable and writable exactly as before, and simply not a thing anyone casts
 * from.
 *
 * The filter lives HERE, in the one helper every magic path starts from, rather
 * than at each of the three call sites: the sheet's per-row affordance, the
 * whole-inventory picker and `castFromBook`'s own re-derivation all ask this
 * function what a caster has to work with.
 * @param {CairnActor|null} actor
 * @returns {CairnItem[]}
 */
export const booksOn = (actor) =>
  actor ? actor.items.filter((i) => i.type === "book" && i.system?.grimoire) : [];

/**
 * THE LANGUAGE GATE. A Libro is written in one language (`system.language`,
 * chosen on its sheet from the Warden's configured list); a person knows a
 * list of them (`system.languages`). Someone who does not know a book's
 * language cannot reach its pages — not on the sheet, not in a cast.
 *
 * Two deliberate exemptions, each an answer to "who is being kept out":
 *
 *   - A book with NO language set is readable by everyone. An unset field is a
 *     book nobody has decided about, not a locked one, and every book authored
 *     before the Warden filled the setting in would otherwise be unreadable by
 *     the entire table.
 *   - A book owned by NO actor — sitting in a compendium, the sidebar, or a
 *     drop preview — shows everything. There is nobody to test against; the
 *     gate is a fact about a reader, and without one there is no question to
 *     answer. This is also where the Warden authors and edits a book: open the
 *     one in the compendium, not the copy in a character's pack.
 *
 * THE WARDEN EXEMPTION IS GONE (2026-09-02, user report: "si el personaje porta
 * un libro cuyo idioma no conoce, sigue viendo el contenido de Descripción, 1, 2
 * y 3. Quiero que solo vea la descripción"). It read `game.user.isGM` and so
 * answered about WHO WAS LOOKING rather than about the character holding the
 * book — which made the feature untestable from the only seat that can test it,
 * and made a GM-run character able to read anything. The gate now asks one
 * question, the same one for everybody: does the actor carrying this book know
 * its language?
 *
 * @param {CairnItem} book         a `book` item
 * @param {CairnActor|null} [actor] the reader; defaults to the book's owner
 * @returns {boolean}
 */
export const canReadBook = (book, actor = book?.parent ?? null) => {
  const language = String(book?.system?.language ?? "").trim();
  if (!language) return true;
  if (actor?.documentName !== "Actor") return true;
  return (actor.system?.languages ?? [])
    .some((known) => String(known).trim() === language);
};

/* `pagesOfGrimoire`, `groupPagesUnderBooks` and `ensureGrimoireKey` stood here
   and are GONE with the bound-page machinery.

   A page used to be a `spellbook` DOCUMENT with `bound` set, naming its book by
   `boundTo` / `grimoireKey`; the three functions found a book's pages, filed
   them under it in a display list, and minted the book's identity. A Libro
   carries its three pages INLINE now (`system.pages`), so a page has no
   document, no id, no owner to resolve and no order to restore — `bookPages`
   in item/item.js is the whole of what is left, and it is a field read. */

/**
 * Resolve a spell's DISPLAYED text against the dice just rolled.
 *
 * The shape — per-power blocks and bracketed expressions — is adopted from
 * fsmalecho's cast macro (credit where the design was proven: he built the
 * resolved-text idea against the canon pack, Spanish `[dado]` markers
 * included, before this module existed):
 *
 * - `[1] … [2] …` blocks: when bare-digit markers are present, the block
 *   matching the invested dice replaces them (the text before the first
 *   marker is kept as preamble). No block for this power — or no markers at
 *   all — leaves the whole text standing: harmless when absent.
 * - `[sum]`, `[dice]` (and Malecho's Spanish `[dado]`) substitute the rolled
 *   values, and arithmetic like `[sum*10]` EVALUATES — but only when, after
 *   substitution, nothing but digits and arithmetic remains. Anything else
 *   (`[8 HP, 3 STR…]` stat blocks, the odd stray bracket the verbatim
 *   transcription preserves) is left exactly as written. A value that DID
 *   resolve is wrapped `<span class="grimoire-resolved" data-tooltip="[expr]">`
 *   so the card marks it as dice-made rather than authored prose, the original
 *   expression a hover away.
 *
 * Runs on whatever text it is handed.
 *
 * @param {string} text   the spell description, HTML
 * @param {number} dice   Magic Dice invested
 * @param {number} sum    their total
 * @returns {string}
 */
export const resolveSpellText = (text, dice, sum) => {
  let out = String(text ?? "");

  // Per-power blocks. Split keeps the captured digit at odd indices:
  // [preamble, "1", block1, "2", block2, …].
  if (/\[([1-4])\]/.test(out)) {
    const parts = out.split(/\[([1-4])\]/);
    for (let i = 1; i < parts.length; i += 2) {
      if (Number(parts[i]) === dice) {
        out = parts[0] + parts[i + 1];
        break;
      }
    }
  }

  // Bracketed expressions. Substitute the variables, then evaluate ONLY a
  // purely numeric residue — `Function` is safe here precisely because the
  // whitelist admits nothing but digits, arithmetic operators and parens.
  return out.replace(/\[([^\][]+)\]/g, (match, expr) => {
    // A bare digit 1-4 is a BLOCK MARKER, never arithmetic: when no block
    // matched the power above (or the markers were malformed), the markers
    // stay visible rather than collapsing into stray numbers.
    if (/^\s*[1-4]\s*$/.test(expr)) return match;
    const sub = expr
      .replace(/\bsum\b/gi, String(sum))
      .replace(/\bdice\b/gi, String(dice))
      .replace(/\bdado\b/gi, String(dice))
      .replace(/[×]/g, "*");
    if (!/^[\d+\-*/().\s]+$/.test(sub) || !/\d/.test(sub)) return match;
    try {
      const v = Function(`"use strict"; return (${sub});`)();
      // A resolved value comes back MARKED, at the one moment its provenance
      // is known: the card shows which number the dice made, and the tooltip
      // holds the authored expression behind it (ruling 2026-08-10). esc on
      // the attribute — the expression is pack/Warden-authored text.
      return Number.isFinite(v)
        ? `<span class="grimoire-resolved" data-tooltip="${esc(match)}">${v}</span>`
        : match;
    } catch {
      return match;
    }
  });
};

/** Document names go into dialog/card HTML; a name is user-authored text. */
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * Magic Dice available to `actor` right now: min(4, free inventory slots).
 * Read at the moment of asking, never stored — see the module docblock.
 */
const magicDice = (actor) =>
  Math.min(4, Math.max(0, (actor.system.slotsMax ?? 0) - (actor.system.slotsUsed ?? 0)));

/**
 * Where the public cast card records its source name/description and the dice
 * that produced it, alongside the rendered HTML.
 */
const CAST_FLAG = "cast";

/**
 * Both tiles identify themselves as spellcasting in the flavor line — the
 * speaker name alone reads as ordinary chat (user wording, 2026-08-10:
 * "Salina's Spell" / "Salina's spell triggered a magical mishap!").
 *
 * The NAME is whatever the caller resolved — the speaker alias.
 */
const castFlavor = (key, name) =>
  game.i18n.format(key, { name: esc(name) });

/**
 * The public card's body, from a name and description.
 */
const castBody = (name, desc, dice, sum) => [
  `<div class="grimoire-cast-card">`,
  `<h3>${esc(name)}</h3>`,
  `<div class="grimoire-cast-effect">${resolveSpellText(desc, dice, sum)}</div>`,
  `</div>`,
].join("\n");

/**
 * The shared back half of every cast: roll the invested dice and report —
 * the resolved effect publicly, the mechanics privately. One function on
 * purpose: a scroll works exactly the same as a spell written on a Libro's
 * page, so a second copy of the fatigue/mishap machinery would be a place for
 * the three casting paths to drift apart.
 * @param {CairnActor} actor
 * @param {{name: string, system: {description: string}}} spell
 *        a Hechizo document, or one of a Libro's pages wearing that shape
 * @param {number} dice       Magic Dice invested (1..4)
 * @returns {Promise<ChatMessage>} the public card
 */
const reportCast = async (actor, spell, dice) => {
  const L = (k) => game.i18n.localize(k);
  const roll = new Roll(`${dice}d6`);
  await roll.evaluate();
  const faces = roll.dice[0].results.map((r) => r.result);
  const sum = faces.reduce((a, b) => a + b, 0);
  const fatigue = faces.filter((v) => v >= 4).length;
  const doubles = new Set(faces).size < faces.length;

  // THE PUBLIC CARD: the spell's effect with real numbers — what the table
  // sees happen. The description is pack/Warden-authored HTML and renders as
  // HTML the same way the inventory's description dropdowns render it.
  //
  // The flag carries the source name/description plus the dice — everything
  // needed to reconstruct what the card reported.
  const speaker = ChatMessage.getSpeaker({ actor });
  const alias = speaker.alias ?? actor.name;
  const publicCard = await ChatMessage.create({
    speaker,
    flavor: castFlavor("CAIRN.GrimoireCastFlavor", alias),
    rolls: [roll],
    content: castBody(spell.name, spell.system.description ?? "", dice, sum),
    flags: { "mondolme": { [CAST_FLAG]: {
      name: spell.name,
      desc: spell.system.description ?? "",
      alias,
      dice,
      sum,
    } } },
  });

  // THE PRIVATE WHISPER: the mechanics — dice, sum, the Fatigue the caster
  // owes (with the one button, never refused), and on doubles the Mishap,
  // drawn here from the world-first table so the caster reads their fate
  // without the table's own card announcing it to the room.
  const lines = [
    `<div class="grimoire-cast-whisper">`,
    // "Rolled 2 magic dice, result is 4, 4 (8)" — or "Rolled 1 magic die,
    // result is 1" (user wording, 2026-08-10, refined live): the left side
    // names what was invested, the right lists what the dice made with the
    // sum in parentheses — one die IS its sum, so the singular skips it.
    // _one form via formatCount, the fatigue line's mechanism.
    `<p>${formatCount("CAIRN.GrimoireWhisperDice", dice, {
      count: dice,
      faces: dice === 1 ? String(faces[0]) : `${faces.join(", ")} (${sum})`,
    })}</p>`,
  ];
  if (fatigue > 0) {
    lines.push(`<p>${formatCount("CAIRN.GrimoireFatigueLine", fatigue, { count: fatigue })}</p>`);
    lines.push(`<button type="button" class="grimoire-add-fatigue"`
      + ` data-actor-uuid="${esc(actor.uuid)}" data-count="${fatigue}">`
      // weight-hanging, NOT a battery: the same icon Fatigue wears in the
      // inventory (item.js stamps it on the Fatigue item), so the button
      // shows the thing it mints (user ask, 2026-08-10).
      + `<i class="fas fa-weight-hanging"></i> `
      + `${game.i18n.format("CAIRN.GrimoireAddFatigue", { count: fatigue })}</button>`);
  }
  if (doubles) {
    lines.push(`<p class="grimoire-mishap"><strong>${L("CAIRN.GrimoireMishapLine")}</strong></p>`);
    const table = await findTableByName(MISHAPS_TABLE_NAME);
    if (table) {
      // roll(), not draw(): draw posts its own PUBLIC card (and never forwards
      // messageData — the recorded speaker trap), and a mishap belongs in this
      // whisper. `replacement: true` tables never mark rows drawn, so reading
      // a locked pack copy is safe.
      const { results } = await table.roll();
      for (const r of results) {
        lines.push(`<div class="grimoire-mishap-text">${r.description ?? ""}</div>`);
      }
    } else {
      lines.push(`<p>${game.i18n.format("CAIRN.GrimoireMishapNoTable",
        { name: MISHAPS_TABLE_NAME })}</p>`);
    }
  } else if (dice > 1) {
    // Silence reads as an unfinished card — the whisper SAYS no mishap
    // happened (user ask, 2026-08-10). But only where a mishap was POSSIBLE:
    // one die cannot double, so on a single-die cast the sentence is noise
    // (same day's ruling).
    lines.push(`<p>${L("CAIRN.GrimoireNoMishapLine")}</p>`);
  }
  lines.push(`</div>`);
  // The whisper needs none of that. `ChatMessage#visible` returns true for a
  // whispered NON-roll message only to its author and its recipients
  // (`documents/chat-message.mjs:101-107`, read rather than assumed), and this
  // one whispers to its own author — so it has exactly ONE reader and the
  // language it was composed in is that reader's. The rolls ride the public
  // card, so `isRoll` is false and the wider branch above never applies.
  await ChatMessage.create({
    speaker,
    flavor: castFlavor(
      doubles ? "CAIRN.GrimoireMishapFlavor" : "CAIRN.GrimoireCastFlavor", alias),
    whisper: [game.user.id],
    content: lines.join("\n"),
  });

  return publicCard;
};

/**
 * What the pickers and the card call a page whose spell has TEXT but no NAME.
 * `bookPages` counts such a page as present (blankness in BOTH fields is the
 * only "unused" marker), so something has to label it, and a bare empty option
 * is unpickable.
 */
const pageLabel = (page) =>
  page.name.trim() || game.i18n.format("CAIRN.BookPageUnnamed", { n: page.n });

/**
 * Ask for the Magic Dice to invest, 1..max. Shared by both cast entry points so
 * the two dialogs cannot drift in wording or in cancel behaviour.
 * @param {number} maxDice
 * @param {{title: string, before?: string}} opts  `before` is extra form HTML
 *        rendered ABOVE the dice row (the book/page picker)
 * @returns {Promise<{dice: number, page: string}|null>} null on cancel or ✕
 */
const askCast = async (maxDice, { title, before = "" }) => {
  const L = (k) => game.i18n.localize(k);
  const powerOptions = Array.from({ length: maxDice }, (_, i) =>
    `<option value="${i + 1}">${i + 1}</option>`).join("");
  return foundry.applications.api.DialogV2.wait({
    window: { title, icon: "fas fa-hand-sparkles" },
    position: { width: 400 },
    content: `
      ${before}
      <div class="form-group">
        <label>${game.i18n.format("CAIRN.GrimoireCastPick", { max: maxDice })}</label>
        <select name="dice">${powerOptions}</select>
      </div>`,
    buttons: [
      {
        action: "cast", label: L("CAIRN.GrimoireCast"), icon: "fas fa-hand-sparkles", default: true,
        callback: (_ev, button) => ({
          page: String(button.form?.elements?.page?.value ?? ""),
          dice: Number(button.form?.elements?.dice?.value) || 1,
        }),
      },
      // `false`, never `null`: DialogV2 resolves a button as
      // `(await callback(...)) ?? button.action` (dialog.mjs:273), so `null` is
      // indistinguishable from NO callback and falls through to the string
      // "cancel" — truthy at every call site. The kettlewright-import options
      // dialog was fixed for this in review #9 and the same line was written
      // three more times afterwards; `false` survives the `??` and reads as the
      // refusal it is. In the scroll cast it was not merely masked: the result
      // was read as a bare dice count, so Cancel reached `new Roll("canceld6")`
      // and threw `Unresolved StringTerm` into a handler core never awaits.
      { action: "cancel", label: L("CAIRN.Cancel"), callback: () => false },
    ],
    rejectClose: false,
  });
};

/**
 * Cast from a Libro: pick a page and a power (1..min(4, free slots)), roll, and
 * report — the resolved effect publicly, the mechanics privately.
 *
 * WHICH BOOK. Nothing limits a character to one Libro, so `book` is passed in
 * by the inventory row that was clicked and the question never arises. Called
 * WITHOUT one (a macro, a keybinding), every readable book's pages are offered
 * in ONE picker, grouped under the book they are written in — the caster
 * chooses the book and the page in a single gesture, and no path anywhere
 * silently reaches for the first book on the sheet.
 *
 * Returns the public ChatMessage, or null when the cast could not happen (no
 * book, no readable book, no pages, no dice, dialog dismissed).
 * @param {CairnActor} actor
 * @param {CairnItem|null} [book]  the one book to cast from, or null for all
 * @returns {Promise<ChatMessage|null>}
 */
export const castFromBook = async (actor, book = null) => {
  if (actor?.type !== "character") return null;
  // A named book is re-checked, not trusted: the row's cast control is drawn
  // from the same flag, but a sheet rendered before the Warden unticked
  // Grimorio must not be a way in — the affordance/enforcement split this repo
  // keeps everywhere else.
  if (book && !book.system?.grimoire) {
    ui.notifications.warn(game.i18n.format("CAIRN.Notify.NotAGrimoire", { name: book.name }));
    return null;
  }
  const all = book ? [book] : booksOn(actor);
  if (!all.length) return null;

  // THE LANGUAGE GATE, re-derived here rather than trusted from the row: a
  // sheet rendered before the caster forgot a language must not be a way in.
  const readable = all.filter((b) => canReadBook(b, actor));
  if (!readable.length) {
    // Named when there is exactly one book to name; otherwise the caster is
    // told the general fact rather than a guess about which book they meant.
    ui.notifications.warn(all.length === 1
      ? game.i18n.format("CAIRN.Notify.BookLanguageUnknown",
        { name: all[0].name, language: all[0].system.language })
      : game.i18n.localize("CAIRN.Notify.BooksLanguageUnknown"));
    return null;
  }

  // Every readable book's non-empty pages, each remembering its book. A page
  // whose name AND text are both blank is skipped silently by `bookPages` —
  // that is what "a book with fewer than three spells" looks like.
  const entries = [];
  for (const b of readable) {
    for (const page of bookPages(b)) entries.push({ book: b, page });
  }
  if (!entries.length) {
    ui.notifications.warn(readable.length === 1
      ? game.i18n.format("CAIRN.Notify.GrimoireNoPages", { name: readable[0].name })
      : game.i18n.localize("CAIRN.Notify.BooksNoPages"));
    return null;
  }

  const maxDice = magicDice(actor);
  if (maxDice < 1) {
    ui.notifications.warn(game.i18n.format("CAIRN.Notify.GrimoireNoDice", { name: actor.name }));
    return null;
  }

  // The VALUE is "<book id>:<page key>" — a page has no id of its own (it is
  // two fields on the book), and an item id is alphanumeric, so the colon can
  // never appear inside either half.
  const option = ({ book: b, page }) =>
    `<option value="${esc(`${b.id}:${page.key}`)}">${esc(pageLabel(page))}</option>`;
  // ONE book: a flat list, and the window title says which book it is. SEVERAL:
  // the same list grouped under each book's name, so choosing the book and
  // choosing the page are the same choice.
  const pageOptions = readable.length === 1
    ? entries.map(option).join("")
    : readable.map((b) => {
      const opts = entries.filter((e) => e.book === b).map(option).join("");
      return opts ? `<optgroup label="${esc(b.name)}">${opts}</optgroup>` : "";
    }).join("");

  const picked = await askCast(maxDice, {
    title: readable.length === 1
      ? game.i18n.format("CAIRN.GrimoireCastFrom", { book: readable[0].name })
      : game.i18n.localize("CAIRN.GrimoireCastFromBooks"),
    before: `
      <div class="form-group">
        <label>${game.i18n.localize("CAIRN.GrimoireCastSpell")}</label>
        <select name="page">${pageOptions}</select>
      </div>`,
  });
  if (!picked) return null;

  const [bookId, pageKey] = String(picked.page).split(":");
  const chosen = entries.find((e) => e.book.id === bookId && e.page.key === pageKey);
  if (!chosen) return null;

  // A page wears the {name, system.description} shape `reportCast` reads. It is
  // not a document and never was one on this type: the two fields ARE the page.
  return reportCast(actor, {
    name: pageLabel(chosen.page),
    system: { description: chosen.page.text },
  }, picked.dice);
};

/**
 * "The magic undoes the paper" — ONE format-free localization key, never
 * `localize("…") + name + "?"`. Spanish OPENS the question with «¿», which no
 * amount of concatenating a trailing "?" can produce; the sentence has to be
 * the translator's to write, whole. Same shape as `confirmDelete` in actor.js.
 */
const confirmScrollCast = () =>
  foundry.applications.api.DialogV2.confirm({
    content: game.i18n.localize("CAIRN.Notify.ConfirmCastScroll"),
    rejectClose: false,
    modal: true,
  });

/**
 * Cast a HECHIZO — and, with `scroll` ticked, a PERGAMINO.
 *
 * A spell casts ITSELF: its name is the spell's name and `system.description`
 * is the text, so there is no page picker, only the dice.
 *
 * A Pergamino is the same cast with a beginning and an end. BEFORE anything is
 * rolled it asks, because the paper does not survive being read; AFTER the card
 * is posted the item is DELETED from the actor — that ordering is deliberate,
 * so a card that fails to post can never eat the scroll. Dismissing the
 * confirmation spends nothing and rolls nothing.
 *
 * @param {CairnActor} actor
 * @param {CairnItem} spell   a `spell` item, scroll or not
 * @returns {Promise<ChatMessage|null>}
 */
export const castSpell = async (actor, spell) => {
  if (actor?.type !== "character") return null;
  if (spell?.type !== "spell") return null;
  const isScroll = !!spell.system.scroll;
  // A scroll generated already-spent (gear.js hands out those) has nothing left
  // to read. Every other scroll carries its one use from `_preCreate`.
  if (isScroll && (spell.system.uses?.value ?? 0) < 1) {
    ui.notifications.warn(game.i18n.localize("CAIRN.Notify.ScrollSpent"));
    return null;
  }
  // The dice check comes BEFORE the confirmation, deliberately: there is no
  // point asking somebody to burn a scroll for a cast their inventory cannot
  // pay for. It is still "before anything is rolled" either way — the roll is
  // three statements below, after the picker.
  const maxDice = magicDice(actor);
  if (maxDice < 1) {
    ui.notifications.warn(game.i18n.format("CAIRN.Notify.GrimoireNoDice", { name: actor.name }));
    return null;
  }
  if (isScroll && !(await confirmScrollCast())) return null;

  const picked = await askCast(maxDice, {
    title: game.i18n.format("CAIRN.GrimoireCastTitle", { spell: spell.name }),
  });
  if (!picked) return null;

  const card = await reportCast(actor, spell, picked.dice);
  // The paper goes AFTER the report, so a failed card never destroys a scroll.
  // Deleted rather than marked spent: `delete()` straight on the document, not
  // `deleteOwnedItem`, which raises its own "Delete X?" confirmation — the
  // caster has already answered that question above and must not be asked twice.
  if (isScroll) await spell.delete();
  return card;
};

/**
 * Wire the whisper's Add-N-Fatigue button on a rendered chat message. Called
 * from the renderChatMessageHTML hook in cairn.js. The whisper is only ever
 * visible to its author, but the OWNERSHIP test is still the gate (not
 * authorship): the enforcement must hold even if the message reaches another
 * client by some future route. Spent is recorded on the MESSAGE
 * (`flags.mondolme.fatigueApplied`) — the damage-card precedent: the
 * disabled button is the affordance, the flag check here is the enforcement,
 * and a card scrolled back to hours later is still spent.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export const bindGrimoireFatigueButton = (message, html) => {
  const btn = html.querySelector(".grimoire-add-fatigue");
  if (!btn) return;
  if (message.getFlag("mondolme", "fatigueApplied")) {
    btn.setAttribute("disabled", "disabled");
    return;
  }
  btn.onclick = async () => {
    if (message.getFlag("mondolme", "fatigueApplied")) return;
    const actor = fromUuidSync(btn.dataset.actorUuid);
    if (!actor?.isOwner) return;
    const count = Math.max(1, Number(btn.dataset.count) || 1);
    // Fatigue is a COST, never refused — the one thing ignoreCapacity is for.
    // ONE batched create for all N (createOwnedItem's count), not N awaits that
    // each wrote a document and re-rendered the sheet.
    await actor.createOwnedItem({ name: FATIGUE_NAME, type: "item" }, { ignoreCapacity: true, count });
    await message.setFlag("mondolme", "fatigueApplied", true);
  };
};
