/**
 * The one dialog that writes a bond: pick the other person, say what each is to
 * the other, and whether the table gets to see it.
 *
 * Separate from bonds.js so that file stays what it says it is — the graph and
 * its rules, with no window in it. This is the only place in the system that
 * asks a human for a bond, so the two labels get explained exactly once.
 */

import { setBond, deleteBond, bondBetween, isBondable, canEditBonds } from "./bonds.js";

const { DialogV2 } = foundry.applications.api;

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));

/**
 * Everyone this actor could be bonded to, grouped for the picker.
 *
 * PCs first because a bond between two of them is the one the user named as
 * needing its own row, and because a party is short and a bestiary is not.
 */
const candidates = (actor) => {
  const pool = game.actors.filter((a) => isBondable(a) && a.uuid !== actor.uuid);
  const byName = (x, y) => x.name.localeCompare(y.name, game.i18n?.lang ?? "es");
  return {
    characters: pool.filter((a) => a.type === "character").sort(byName),
    others: pool.filter((a) => a.type !== "character").sort(byName),
  };
};

const optionRows = (list, selected) => list.map((a) =>
  `<option value="${esc(a.uuid)}"${a.uuid === selected ? " selected" : ""}>${esc(a.name)}</option>`).join("");

/**
 * Open the editor.
 *
 * @param {Actor} actor       the sheet this was opened from — the "A" side
 * @param {Actor|null} other  the far end when EDITING; null when adding, and
 *                            then the dialog asks for it
 */
export const openBondEditor = async (actor, other = null) => {
  if (!canEditBonds() || !isBondable(actor)) return;

  const pool = candidates(actor);
  if (!other && !pool.characters.length && !pool.others.length) {
    ui.notifications?.warn(L("CAIRN.Bonds.Notify.NoOne"));
    return;
  }

  // What is already on file for this pair, read from THIS actor's side so the
  // two fields below are always "mine" then "theirs" whichever way the record
  // happens to be stored.
  const existing = other ? bondBetween(actor.uuid, other.uuid) : null;
  const flipped = existing ? existing.a === other.uuid : false;
  const mine = existing ? (flipped ? existing.bSays : existing.aSays) : "";
  const theirs = existing ? (flipped ? existing.aSays : existing.bSays) : "";

  const picker = other
    ? `<p class="bond-pair">${esc(actor.name)} <i class="fas fa-link"></i> <strong>${esc(other.name)}</strong></p>`
    : `<div class="bond-field">
         <label for="bond-other">${esc(L("CAIRN.Bonds.Other"))}</label>
         <select id="bond-other" name="other">
           ${pool.characters.length ? `<optgroup label="${esc(L("CAIRN.Bonds.GroupCharacters"))}">${optionRows(pool.characters)}</optgroup>` : ""}
           ${pool.others.length ? `<optgroup label="${esc(L("CAIRN.Bonds.GroupOthers"))}">${optionRows(pool.others)}</optgroup>` : ""}
         </select>
       </div>`;

  // The far end's name is only known up front when editing. Adding, the labels
  // have to be worded without it, so both spellings exist as separate keys
  // rather than one with an empty placeholder in it.
  const mineLabel = other
    ? L("CAIRN.Bonds.SaysNamed", { self: actor.name, other: other.name })
    : L("CAIRN.Bonds.Says", { self: actor.name });
  const theirsLabel = other
    ? L("CAIRN.Bonds.SaysBackNamed", { self: actor.name, other: other.name })
    : L("CAIRN.Bonds.SaysBack", { self: actor.name });

  const content = `
    <div class="bond-editor">
      ${picker}
      <div class="bond-field">
        <label for="bond-mine">${esc(mineLabel)}</label>
        <input type="text" id="bond-mine" name="mine" value="${esc(mine)}"
          placeholder="${esc(L("CAIRN.Bonds.SaysPlaceholder"))}">
      </div>
      <div class="bond-field">
        <label for="bond-theirs">${esc(theirsLabel)}</label>
        <input type="text" id="bond-theirs" name="theirs" value="${esc(theirs)}"
          placeholder="${esc(L("CAIRN.Bonds.SaysBackPlaceholder"))}">
        <p class="bond-hint">${esc(L("CAIRN.Bonds.MirrorHint"))}</p>
      </div>
      <label class="bond-secret">
        <input type="checkbox" name="secret"${existing?.secret ? " checked" : ""}>
        ${esc(L("CAIRN.Bonds.Secret"))}
      </label>
      <p class="bond-hint">${esc(L("CAIRN.Bonds.SecretHint"))}</p>
    </div>`;

  const buttons = [
    {
      action: "save",
      label: L("CAIRN.Bonds.Save"),
      default: true,
      // `false`, never `null`: DialogV2 resolves as `(await callback()) ?? action`,
      // so a null return comes back as the truthy string "save".
      callback: async (_event, _button, dialog) => {
        const root = dialog.element ?? dialog;
        const far = other ?? fromUuidSync(root.querySelector('[name="other"]')?.value ?? "");
        if (!far) return false;
        await setBond(actor, far, {
          aSays: String(root.querySelector('[name="mine"]')?.value ?? "").trim(),
          bSays: String(root.querySelector('[name="theirs"]')?.value ?? "").trim(),
          secret: !!root.querySelector('[name="secret"]')?.checked,
        });
        return false;
      },
    },
  ];

  if (existing) {
    buttons.push({
      action: "delete",
      label: L("CAIRN.Bonds.Delete"),
      icon: "fas fa-trash",
      callback: async () => { await deleteBond(existing.id); return false; },
    });
  }
  buttons.push({ action: "cancel", label: L("CAIRN.Cancel"), callback: () => false });

  await DialogV2.wait({
    id: "mondolme-bond-editor",
    classes: ["cairn"],
    window: {
      title: existing ? L("CAIRN.Bonds.EditTitle") : L("CAIRN.Bonds.AddTitle"),
      icon: "fas fa-link",
    },
    position: { width: 460 },
    content,
    buttons,
    rejectClose: false,
  });
};
