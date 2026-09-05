/**
 * THE CALENDAR BAR: a strip above the macro hotbar showing the date, the season,
 * the moon and the hour, with the Warden's controls for pushing time along.
 *
 * WHERE IT LIVES. It is inserted into `#ui-bottom` immediately before `#hotbar`,
 * not fixed-positioned over the screen. That one decision removes a whole class
 * of work the widget this is modelled on had to do by hand: it sits above the
 * macro bar because it is above it in the DOM, it re-centres itself when the
 * sidebar collapses, and it follows a window resize or a fullscreen toggle —
 * all because the layout that already moves the hotbar moves this too. The
 * floating fallback exists only for a future Foundry that renames those two ids.
 *
 * WHAT IT IS NOT. There is no ApplicationV2 here. The bar is one small block of
 * HTML rebuilt whole on every clock change; a sheet framework buys nothing at
 * this size and would put a window frame around a thing that must not have one.
 * The MONTH VIEW is a dialog, and that one is a DialogV2 like every other dialog
 * in this system.
 *
 * WHO MAY DO WHAT (2026-09-02, user rulings):
 *   - Time is the WARDEN's. Only a GM sees the advance buttons, and only a GM
 *     could use them anyway — `game.time.advance` and a world setting are both
 *     GM-only writes, so the hiding is affordance and Foundry is the wall.
 *   - Notes are the Warden's to write and everyone's to read, except the ones
 *     marked secret. No socket relay: nothing a player does here writes.
 *   - The tables rolled by the advance buttons are WHISPERED to the Wardens. A
 *     wandering-monster check the table can see is not a check.
 */

import { findTableByName } from "../compendium.js";
import {
  TURN_SECONDS, DAY_MARKS,
  worldToDate, epochForDate, secondsUntilHour,
  seasonOf, seasonName, moonPhase, moonName, isDaylight,
  daysInMonth, daysFromCivil, weekdayIndex, weekdayName, weekdayShort, monthName,
  formatDate, formatTime, parseDate, noteKey,
} from "./calendar-core.js";

const { DialogV2 } = foundry.applications.api;

const NS = () => game.system?.id ?? "mondolme";
const WIDGET_ID = "mondolme-calendar";

/** Core's own art, so the bar ships no images of its own. */
const SUN_ICON = "icons/magic/nature/symbol-sun-yellow.webp";
const MOON_ICON = "icons/magic/nature/symbol-moon-stars-white.webp";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const L = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));

/* -------------------------------------------------------------------------- */
/*  Notes                                                                       */
/* -------------------------------------------------------------------------- */

/** Every note in the world, keyed by day. A plain object in one world setting:
 *  a campaign's worth of these is a few kilobytes, and a Journal entry per day
 *  would be a folder nobody asked for. */
const allNotes = () => {
  try {
    return game.settings.get(NS(), "calendar-notes") ?? {};
  } catch {
    return {};
  }
};

/** One day's notes, filtered for who is looking. A secret note is the Warden's
 *  own reminder; it rides in the same world setting (a player's client HAS the
 *  string) and is hidden at render, which is honest about what this is: tidiness,
 *  not secrecy against a determined reader. */
const notesForDay = (key) => {
  const list = allNotes()[key] ?? [];
  return game.user.isGM ? list : list.filter((n) => !n.secret);
};

/** Does this day carry anything the current user can see? Drives the grid's dot. */
const dayHasNotes = (key) => notesForDay(key).length > 0;

const writeNotes = async (mutate) => {
  if (!game.user.isGM) return;
  const notes = foundry.utils.deepClone(allNotes());
  mutate(notes);
  await game.settings.set(NS(), "calendar-notes", notes);
};

const addNote = (key, text, secret) => writeNotes((notes) => {
  if (!notes[key]) notes[key] = [];
  notes[key].push({ id: foundry.utils.randomID(), text, secret: !!secret });
});

const deleteNote = (key, id) => writeNotes((notes) => {
  if (!notes[key]) return;
  notes[key] = notes[key].filter((n) => n.id !== id);
  // Drop the day entirely rather than leaving an empty array: the stored object
  // is also what a Warden reads when they go looking, and a diary of empty days
  // is noise.
  if (!notes[key].length) delete notes[key];
});

/* -------------------------------------------------------------------------- */
/*  Advancing time                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Draw from one of the two configured tables and whisper it to the Wardens.
 *
 * Quiet on every miss: no table named, no table found, an empty table. The
 * buttons exist to move time, and a Warden who has not set a table up is not
 * making a mistake — they simply do not want one. `findTableByName` is
 * world-first, so a Warden's own copy of a table beats the compendium's.
 *
 * @param {String} settingKey  `calendar-table-turn` or `calendar-table-travel`
 */
const rollCalendarTable = async (settingKey) => {
  if (!game.user.isGM) return;
  const name = String(game.settings.get(NS(), settingKey) ?? "").trim();
  if (!name) return;
  const table = await findTableByName(name);
  if (!table) {
    ui.notifications?.warn(L("CAIRN.Cal.Notify.NoTable", { name }));
    return;
  }
  try {
    const draw = await table.draw({ displayChat: false });
    if (!draw.results?.length) return;
    // `gmroll` whispers to every GM. The user's ruling: only the Warden sees
    // what the passing time turned up.
    await table.toMessage(draw.results, {
      roll: draw.roll,
      messageOptions: { rollMode: "gmroll" },
    });
  } catch (err) {
    console.error(`Mondolme | the "${name}" calendar draw failed:`, err);
  }
};

/** Ten minutes: one dungeon turn, and the dungeon table if there is one. */
const advanceTurn = async () => {
  if (!game.user.isGM) return;
  await game.time.advance(TURN_SECONDS);
  await rollCalendarTable("calendar-table-turn");
};

/**
 * Jump to the next Mañana / Mediodía / Tarde / Medianoche, and roll the travel
 * table. ALWAYS FORWARD — see `secondsUntilHour`, which is where that rule lives.
 */
const advanceToMark = async (hour) => {
  if (!game.user.isGM) return;
  await game.time.advance(secondsUntilHour(hour));
  await rollCalendarTable("calendar-table-travel");
};

/* -------------------------------------------------------------------------- */
/*  The bar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The moon, drawn rather than fetched: two circles, the top one shifted across
 * the bottom one by the phase. Eight images would be eight files to ship and to
 * theme; this is six lines of SVG that take their colours from the sheet's own
 * tokens and read on either theme.
 */
const moonSvg = (phase) => {
  // WAXING is lit on the RIGHT, so its shadow slides off to the left; waning is
  // the mirror. `index` 1-3 is the waxing half of the eight (see MOON_PHASES) —
  // new and full are neither, and at both of those the offset below lands on an
  // extreme where the direction cannot matter.
  const waxing = phase.index > 0 && phase.index < 4;
  // How far the shadow disc sits off centre, in disc radii: NONE at new (it is
  // centred, and covers the moon), ALL at full (it is clear of the disc).
  // Getting this the other way round paints every full moon black.
  const offset = phase.illum * (waxing ? -1 : 1);
  return `
    <svg class="cal-moon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" class="cal-moon-lit"/>
      <circle cx="${10 + offset * 18}" cy="10" r="9" class="cal-moon-dark"/>
    </svg>`;
};

/** The bar's inner HTML for the clock as it stands now. */
const renderBar = () => {
  const date = worldToDate();
  const season = seasonOf(date.month, date.day);
  const phase = moonPhase(date);
  const day = isDaylight(date);

  // A full day is a full turn. Midnight points the orb up; noon points it down,
  // which is the whole of "gira con el paso del tiempo".
  const angle = ((date.hour + date.minute / 60) / 24) * 360;

  const controls = game.user.isGM ? `
    <div class="cal-controls">
      <button type="button" class="cal-btn" data-turn="1"
        data-tooltip="${esc(L("CAIRN.Cal.AdvanceTurnHint"))}">${esc(L("CAIRN.Cal.AdvanceTurn"))}</button>
      ${DAY_MARKS.map((m) => `
        <button type="button" class="cal-btn" data-hour="${m.hour}"
          data-tooltip="${esc(L(`CAIRN.Cal.Marks.${m.key}Hint`))}">${esc(L(`CAIRN.Cal.Marks.${m.key}`))}</button>`).join("")}
    </div>` : "";

  return `
    <div class="cal-orb ${day ? "is-day" : "is-night"}"
      data-tooltip="${esc(day ? L("CAIRN.Cal.Daytime") : L("CAIRN.Cal.Nighttime"))}">
      <img src="${day ? SUN_ICON : MOON_ICON}" alt="" style="transform: rotate(${angle.toFixed(1)}deg)">
    </div>
    <button type="button" class="cal-date" data-open="1"
      data-tooltip="${esc(L("CAIRN.Cal.OpenHint"))}">
      <span class="cal-date-main">${esc(formatDate(date))}</span>
      <span class="cal-date-sub">
        <span>${esc(seasonName(season))}</span>
        <span class="cal-moon-wrap">${moonSvg(phase)}${esc(moonName(phase.key))}</span>
        <span class="cal-clock">${formatTime(date)}</span>
      </span>
    </button>
    ${controls}`;
};

/** Put the bar where it belongs, or make it if it is not there yet. */
const injectBar = () => {
  let el = document.getElementById(WIDGET_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = WIDGET_ID;
    el.classList.add("cairn");            // the system's own CSS scope
    const bottom = document.getElementById("ui-bottom");
    const hotbar = document.getElementById("hotbar");
    if (bottom && hotbar?.parentElement === bottom) {
      bottom.insertBefore(el, hotbar);
    } else {
      // A Foundry that moved or renamed those two: float it instead of losing
      // it. Everything else about the bar is identical.
      el.classList.add("is-floating");
      document.body.appendChild(el);
    }
    el.addEventListener("click", onBarClick);
  }
  el.innerHTML = renderBar();
};

/** ONE delegated listener, bound when the element is made and never rebound —
 *  the innerHTML is replaced on every clock tick, and per-button listeners
 *  would have to be re-attached each time (and leak if they were not). */
const onBarClick = (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  event.preventDefault();
  if (btn.dataset.open) return void openCalendarDialog();
  if (btn.dataset.turn) return void advanceTurn();
  if (btn.dataset.hour !== undefined) return void advanceToMark(Number(btn.dataset.hour));
};

const removeBar = () => document.getElementById(WIDGET_ID)?.remove();

/** The setting's onChange, and the ready-time switch. */
export const toggleCalendar = (visible) => {
  if (visible) injectBar();
  else removeBar();
};

/* -------------------------------------------------------------------------- */
/*  The month view                                                              */
/* -------------------------------------------------------------------------- */

/** Which month the open dialog is looking at, and which day is selected.
 *  Module-level because the dialog redraws itself in place. */
let view = null;

/** The month grid, the selected day's notes, and (for a Warden) the two writes.
 *  Rebuilt whole on every change; the dialog is small and this keeps one
 *  description of what it looks like rather than one per mutation. */
const renderDialog = () => {
  const today = worldToDate();
  const { year, month, day } = view;
  const first = daysFromCivil(year, month, 1);
  const lead = weekdayIndex(first);          // blank cells before the 1st
  const total = daysInMonth(year, month);

  let cells = "";
  for (let i = 0; i < lead; i++) cells += `<div class="cal-cell is-blank"></div>`;
  for (let d = 1; d <= total; d++) {
    const key = noteKey(year, month, d);
    const isToday = year === today.year && month === today.month && d === today.day;
    const classes = ["cal-cell"];
    if (isToday) classes.push("is-today");
    if (d === day) classes.push("is-selected");
    cells += `
      <button type="button" class="${classes.join(" ")}" data-day="${d}">
        <span class="cal-cell-num">${d}</span>
        ${dayHasNotes(key) ? `<span class="cal-cell-dot" aria-hidden="true"></span>` : ""}
      </button>`;
  }

  const selKey = noteKey(year, month, day);
  const notes = notesForDay(selKey);
  const noteRows = notes.length
    ? notes.map((n) => `
        <li class="cal-note${n.secret ? " is-secret" : ""}">
          ${n.secret ? `<i class="fas fa-eye-slash" data-tooltip="${esc(L("CAIRN.Cal.SecretNote"))}"></i>` : ""}
          <span>${esc(n.text)}</span>
          ${game.user.isGM ? `<button type="button" class="cal-note-del" data-del="${esc(n.id)}"
            data-tooltip="${esc(L("CAIRN.Cal.DeleteNote"))}"><i class="fas fa-xmark"></i></button>` : ""}
        </li>`).join("")
    : `<li class="cal-note is-empty">${esc(L("CAIRN.Cal.NoNotes"))}</li>`;

  const writer = game.user.isGM ? `
    <div class="cal-note-add">
      <textarea name="noteText" rows="2" placeholder="${esc(L("CAIRN.Cal.NotePlaceholder"))}"></textarea>
      <div class="cal-note-add-row">
        <label class="cal-secret">
          <input type="checkbox" name="noteSecret"> ${esc(L("CAIRN.Cal.SecretNote"))}
        </label>
        <button type="button" data-add="1">${esc(L("CAIRN.Cal.AddNote"))}</button>
      </div>
    </div>` : "";

  const setter = game.user.isGM ? `
    <div class="cal-setdate">
      <label for="cal-setdate-input">${esc(L("CAIRN.Cal.SetDate"))}</label>
      <div class="cal-setdate-row">
        <input type="text" id="cal-setdate-input" name="setDate"
          value="${esc(formatDate(today))}" placeholder="${esc(L("CAIRN.Cal.SetDatePlaceholder"))}">
        <button type="button" data-setdate="1">${esc(L("CAIRN.Cal.Apply"))}</button>
      </div>
      <p class="cal-hint">${esc(L("CAIRN.Cal.SetDateHint"))}</p>
    </div>` : "";

  const selected = { year, month, day, dayNumber: daysFromCivil(year, month, day) };

  return `
    <div class="cal-dialog">
      <div class="cal-nav">
        <button type="button" data-move="-1" data-tooltip="${esc(L("CAIRN.Cal.PrevMonth"))}"><i class="fas fa-chevron-left"></i></button>
        <span class="cal-nav-label">${esc(monthName(month))} ${year}</span>
        <button type="button" data-move="1" data-tooltip="${esc(L("CAIRN.Cal.NextMonth"))}"><i class="fas fa-chevron-right"></i></button>
        <button type="button" class="cal-today" data-today="1">${esc(L("CAIRN.Cal.Today"))}</button>
      </div>
      <div class="cal-weekdays">
        ${Array.from({ length: 7 }, (_, i) =>
          `<span data-tooltip="${esc(weekdayName(i))}">${esc(weekdayShort(i))}</span>`).join("")}
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-selected">
        <h4>${esc(formatDate(selected))}</h4>
        <span class="cal-selected-sub">${esc(weekdayName(weekdayIndex(selected.dayNumber)))} · ${esc(seasonName(seasonOf(month, day)))}</span>
      </div>
      <ul class="cal-notes">${noteRows}</ul>
      ${writer}
      ${setter}
    </div>`;
};

/** Open the month view. One dialog at a time; a second click focuses the first. */
export const openCalendarDialog = async () => {
  // `foundry.applications.instances`, not `ui.windows`: that one is the AppV1
  // registry, and a DialogV2 never appears in it — the check would have found
  // nothing and every click opened another calendar.
  const existing = foundry.applications.instances.get("mondolme-calendar-dialog");
  if (existing?.rendered) return void existing.bringToFront?.();

  const today = worldToDate();
  view = { year: today.year, month: today.month, day: today.day };

  const dialog = new DialogV2({
    id: "mondolme-calendar-dialog",
    classes: ["cairn"],
    window: { title: L("CAIRN.Cal.Title"), icon: "fas fa-calendar-days" },
    position: { width: 420 },
    content: renderDialog(),
    buttons: [{ action: "close", label: L("CAIRN.Close"), default: true }],
    rejectClose: false,
  });
  await dialog.render({ force: true });

  // Delegated, for the same reason the bar's listener is: the body is replaced
  // whole on every navigation, note and date change.
  dialog.element.addEventListener("click", async (event) => {
    const btn = event.target.closest("button");
    if (!btn || !view) return;
    const redraw = () => {
      const body = dialog.element.querySelector(".cal-dialog");
      if (body) body.outerHTML = renderDialog();
    };

    if (btn.dataset.move) {
      event.preventDefault();
      const delta = Number(btn.dataset.move);
      let { year, month } = view;
      month += delta;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      // Clamp the selected day into the new month — stepping from 31 March to
      // February must not select a day that does not exist.
      view = { year, month, day: Math.min(view.day, daysInMonth(year, month)) };
      return redraw();
    }

    if (btn.dataset.today) {
      event.preventDefault();
      const now = worldToDate();
      view = { year: now.year, month: now.month, day: now.day };
      return redraw();
    }

    if (btn.dataset.day) {
      event.preventDefault();
      view = { ...view, day: Number(btn.dataset.day) };
      return redraw();
    }

    if (btn.dataset.del) {
      event.preventDefault();
      await deleteNote(noteKey(view.year, view.month, view.day), btn.dataset.del);
      return redraw();
    }

    if (btn.dataset.add) {
      event.preventDefault();
      const box = dialog.element.querySelector('[name="noteText"]');
      const secret = dialog.element.querySelector('[name="noteSecret"]')?.checked;
      const text = String(box?.value ?? "").trim();
      if (!text) return;
      await addNote(noteKey(view.year, view.month, view.day), text, secret);
      return redraw();
    }

    if (btn.dataset.setdate) {
      event.preventDefault();
      const input = dialog.element.querySelector('[name="setDate"]');
      const parsed = parseDate(input?.value);
      if (!parsed) {
        // Named, not a bare "invalid": the Warden is being told the format, and
        // the field keeps what they typed so they can fix it rather than retype.
        ui.notifications?.warn(L("CAIRN.Cal.Notify.BadDate", { text: String(input?.value ?? "") }));
        return;
      }
      // The OFFSET moves, not the clock — see calendar-core.js. The hour the
      // world is at stays exactly where it was.
      await game.settings.set(NS(), "calendar-epoch",
        epochForDate(parsed.year, parsed.month, parsed.day));
      const now = worldToDate();
      view = { year: now.year, month: now.month, day: now.day };
      ui.notifications?.info(L("CAIRN.Cal.Notify.DateSet", { date: formatDate(now) }));
      return redraw();
    }
  });
};

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Called once from the ready hook. Every listener here is idempotent about the
 * element: `injectBar` makes it if it is missing and repaints it if it is not,
 * so nothing has to track whether the bar exists.
 */
export const initCalendar = () => {
  const on = () => {
    try {
      return !!game.settings.get(NS(), "show-calendar");
    } catch {
      return false;
    }
  };
  if (on()) injectBar();

  // The clock moved: whoever moved it, on every client.
  Hooks.on("updateWorldTime", () => { if (on()) injectBar(); });

  // The hotbar re-rendered (a macro added, the bar unlocked). Cheap to re-run,
  // and it puts the bar back if that render replaced its neighbours.
  Hooks.on("renderHotbar", () => { if (on()) injectBar(); });

  // The Warden set a date or wrote a note. `createSetting` as well as
  // `updateSetting`: the FIRST write to a setting in a new world creates it,
  // and only the create hook fires for that one.
  const onSetting = (setting) => {
    const key = String(setting?.key ?? "");
    if (key.endsWith(".calendar-epoch") || key.endsWith(".calendar-notes")) {
      if (on()) injectBar();
    }
  };
  Hooks.on("createSetting", onSetting);
  Hooks.on("updateSetting", onSetting);
};
