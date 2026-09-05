/**
 * THE CALENDAR, in the macro bar: the date, the season, the moon and the hour,
 * with the Warden's controls for pushing time along.
 *
 * TWO PIECES, IN TWO PLACES, and that is what makes it look built in rather
 * than dropped on top:
 *
 *   - THE ORB is a day-and-night dial: one disc turning once every twenty-four
 *     hours, showing core's sun by day and its moon by night, with the two
 *     crossfading through dawn and dusk. It is an `<li>` inserted into the MIDDLE of
 *     `#action-bar` — a real child of the macro list, so core's own flexbox
 *     sizes it to the slot height, sets it between slots five and six, and
 *     carries it along when the sidebar collapses or the window resizes.
 *     Neither half is a shipped image: both are core's art on their own
 *     grounds. It is not a `.slot` and has no
 *     `data-slot`, which is how core decides where a dragged macro landed — so
 *     nothing can be dropped on it.
 *   - THE BAR is a sibling of `#hotbar` inside `#ui-bottom`, nudged sideways
 *     until its centre is the macro list's centre. Those are two different
 *     points: the page controls sit on one side of the hotbar only.
 *
 * ITS PALETTE IS NOT THE SHEET'S. Everything else in this system follows the
 * character sheet's scheme; this does not, because it sits on the canvas over
 * Foundry's own dark chrome whatever the sheets are wearing. Taking the
 * parchment tokens is exactly how the first cut rendered pale on black and
 * could not be read at all.
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
  seasonOf, seasonName, moonPhase, moonName, isDaylight, dayness,
  daysInMonth, daysFromCivil, weekdayIndex, weekdayName, weekdayShort, monthName,
  formatDate, formatTime, parseDate, noteKey,
} from "./calendar-core.js";

const { DialogV2 } = foundry.applications.api;

const NS = () => game.system?.id ?? "mondolme";
const WIDGET_ID = "mondolme-calendar";
const ORB_ID = "mondolme-calendar-orb";

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

/** The weather table for each season, by the season key `seasonOf` returns. */
const WEATHER_TABLES = {
  spring: "calendar-table-spring",
  summer: "calendar-table-summer",
  autumn: "calendar-table-autumn",
  winter: "calendar-table-winter",
};

/**
 * Draw from one of the configured tables and post the result.
 *
 * Quiet on every miss: no table named, no table found, an empty table. The
 * buttons exist to move time, and a Warden who has not set a table up is not
 * making a mistake — they simply do not want one. `findTableByName` is
 * world-first, so a Warden's own copy of a table beats the compendium's.
 *
 * @param {String} settingKey  which of the six table settings to read
 * @param {String} rollMode    `gmroll` whispers to the Wardens; `publicroll`
 *                             puts it in front of the table
 */
const rollCalendarTable = async (settingKey, rollMode = "gmroll") => {
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
    await table.toMessage(draw.results, {
      roll: draw.roll,
      messageOptions: { rollMode },
    });
  } catch (err) {
    console.error(`Mondolme | the "${name}" calendar draw failed:`, err);
  }
};

/**
 * Move the clock, then draw what the passing time turned up.
 *
 * THE NEW DAY IS WORKED OUT BEFORE THE CLOCK MOVES, from the seconds about to
 * be added, rather than read back afterwards. `game.time.advance` is a round
 * trip to the server, and whether `game.time.worldTime` has caught up by the
 * time the await returns is not something to build on.
 *
 * THE WEATHER IS PUBLIC, unlike the other two. An encounter check the table can
 * see is not a check; weather is the first thing anyone in the fiction would
 * notice on stepping outside, and a Warden who wants to sit on it can always
 * roll it on the table sheet instead. Say the word and it becomes a whisper.
 *
 * @param {Number} seconds   how far to push the clock
 * @param {String} tableKey  the table for the period just travelled
 */
const advanceTime = async (seconds, tableKey) => {
  if (!game.user.isGM) return;
  const now = Number(game.time.worldTime) || 0;
  const before = worldToDate(now);
  const after = worldToDate(now + seconds);

  await game.time.advance(seconds);
  await rollCalendarTable(tableKey);

  // A new day began somewhere in there: what is the weather like?
  if (after.dayNumber !== before.dayNumber) {
    await rollCalendarTable(WEATHER_TABLES[seasonOf(after.month, after.day)], "publicroll");
  }
};

/** Ten minutes: one dungeon turn, and the dungeon table if there is one. */
const advanceTurn = () => advanceTime(TURN_SECONDS, "calendar-table-turn");

/**
 * Jump to the next Mañana / Mediodía / Tarde / Medianoche, and roll the travel
 * table. ALWAYS FORWARD — see `secondsUntilHour`, which is where that rule lives.
 */
const advanceToMark = (hour) =>
  advanceTime(secondsUntilHour(hour), "calendar-table-travel");

/* -------------------------------------------------------------------------- */
/*  The orb, and the bar                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The moon, drawn rather than fetched: two circles, the top one shifted across
 * the bottom one by the phase. Eight images would be eight files to ship and to
 * theme; this is six lines of SVG.
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

/**
 * The orb: ONE disc, showing the sun by day and the moon by night, turning once
 * every twenty-four hours.
 *
 * ONE BODY AT A TIME, which is a thing the geometry cannot give on its own. Sun
 * and moon sit at opposite ends of a diameter, and a circular window centred on
 * that diameter's midpoint is symmetric under half a turn: whatever it shows of
 * the one, it shows of the other. So the swap is done with LIGHT rather than
 * position — the day sky and the sun fade up over the night sky and the moon,
 * on `dayness`, which is 1 at midday and 0 at midnight. At midday the moon and
 * the night sky are at zero and the disc is a sun in a warm sky; at midnight it
 * is the reverse; and for the hour and a half around sunrise and sunset both
 * are part-lit low on opposite sides, which is what dawn actually looks like.
 *
 * WHICH WAY IT TURNS. The sun is drawn at the top of the wheel, so noon must be
 * the wheel's zero — hence the +180, which puts the moon on top at midnight.
 * Between them the sun climbs from the left at dawn and sets to the right.
 *
 * WHY THE DAY NUMBER IS IN THE ANGLE. If the angle were only the hour, it would
 * run 180°…540° and then snap back to 180° at midnight — and CSS, told to move
 * from 540 to 180, animates the short way round: a full backwards spin, once a
 * night. Adding a turn per elapsed day makes the number monotonic, so the disc
 * only ever turns the way time is going. Advancing a whole day is then a single
 * clean revolution, which is a nicer thing to watch than a jump.
 *
 * No images are shipped for this: both bodies are core's own art.
 *
 * @param {String} extra  a class for the fallback copy that lives in the bar
 */
const orbHtml = (extra = "") => {
  const date = worldToDate();
  const lit = dayness(date);
  const day = lit.toFixed(3);
  const night = (1 - lit).toFixed(3);
  const angle = (date.dayNumber + (date.hour + date.minute / 60) / 24) * 360 + 180;
  return `
    <div class="cal-orb ${lit >= 0.5 ? "is-day" : "is-night"} ${extra}"
      data-tooltip="${esc(isDaylight(date) ? L("CAIRN.Cal.Daytime") : L("CAIRN.Cal.Nighttime"))}">
      <div class="cal-orb-sky is-night-sky"></div>
      <div class="cal-orb-sky is-day-sky" style="opacity: ${day}"></div>
      <div class="cal-orb-wheel" style="transform: rotate(${angle.toFixed(2)}deg)">
        <div class="cal-orb-body is-sun" style="opacity: ${day}"><img src="${SUN_ICON}" alt=""></div>
        <div class="cal-orb-body is-moon" style="opacity: ${night}"><img src="${MOON_ICON}" alt=""></div>
      </div>
      <span class="cal-orb-pip" aria-hidden="true"></span>
    </div>`;
};

/**
 * The bar: one line of text and, for a Warden, the controls that pop above it.
 *
 * The controls are HIDDEN until the pointer is on the widget or the orb. They
 * are five buttons a Warden presses a few times an evening, and a strip of them
 * parked permanently over the macro bar is five buttons of clutter for everyone
 * else the rest of the time.
 *
 * @param {Boolean} inlineOrb  true when the hotbar could not take the orb, so
 *                             the bar carries it instead
 */
const renderBar = (inlineOrb = false) => {
  const date = worldToDate();
  const season = seasonOf(date.month, date.day);
  const phase = moonPhase(date);

  const tools = game.user.isGM ? `
    <div class="cal-tools">
      <button type="button" class="cal-btn" data-turn="1"
        data-tooltip="${esc(L("CAIRN.Cal.AdvanceTurnHint"))}">${esc(L("CAIRN.Cal.AdvanceTurn"))}</button>
      ${DAY_MARKS.map((m) => `
        <button type="button" class="cal-btn" data-hour="${m.hour}"
          data-tooltip="${esc(L(`CAIRN.Cal.Marks.${m.key}Hint`))}">${esc(L(`CAIRN.Cal.Marks.${m.key}`))}</button>`).join("")}
    </div>` : "";

  return `
    ${tools}
    ${inlineOrb ? orbHtml("is-inline") : ""}
    <button type="button" class="cal-face" data-open="1"
      data-tooltip="${esc(L("CAIRN.Cal.OpenHint"))}">
      <span class="cal-date">${esc(formatDate(date))}</span>
      <span class="cal-sep" aria-hidden="true"></span>
      <span class="cal-season">${esc(seasonName(season))}</span>
      <span class="cal-sep" aria-hidden="true"></span>
      <span class="cal-moon-wrap" data-tooltip="${esc(moonName(phase.key))}">${moonSvg(phase)}</span>
      <span class="cal-sep" aria-hidden="true"></span>
      <span class="cal-clock">${formatTime(date)}</span>
    </button>`;
};

/* ---- putting the two pieces where they belong ---------------------------- */

/**
 * The macro bar's own list. Named defensively: this is core's DOM and not ours,
 * and every caller treats "not found" as an ordinary answer rather than a fault.
 */
const findActionBar = () => {
  const hotbar = document.getElementById("hotbar");
  if (!hotbar) return null;
  return hotbar.querySelector("#action-bar") ?? hotbar.querySelector("ol, menu") ?? null;
};

/**
 * Put the orb IN the macro bar, as one more item in the middle of the row, and
 * hand the item back so the bar can hang off it.
 *
 * This is the whole of "integrado en el hotbar". Because the orb is a real
 * child of the macro list, the hotbar's own flexbox sizes it to the slot
 * height, spaces it between slots five and six, and carries it along when the
 * sidebar collapses or the window resizes — none of which is code here. The
 * item is deliberately NOT `.slot` and carries no `data-slot`, which is how
 * core decides where a dragged macro landed: it cannot be dropped on.
 *
 * The orb goes in a MOUNT rather than straight into the item, because the bar
 * lives in the item too and repainting the orb must not wipe it.
 *
 * @returns {HTMLElement|null}  null if there was no macro list to put it in
 */
const injectOrb = () => {
  const bar = findActionBar();
  if (!bar) return null;
  const slots = [...bar.children].filter((el) => el.tagName === "LI" && el.id !== ORB_ID);
  if (!slots.length) return null;

  let li = document.getElementById(ORB_ID);
  // A hotbar re-render wipes our item with the rest of its children, so the
  // parent check matters as much as the existence one.
  if (!li || li.parentElement !== bar) {
    li?.remove();
    li = document.createElement("li");
    li.id = ORB_ID;
    li.innerHTML = `<div class="cal-orb-mount"></div>`;
    li.addEventListener("click", (event) => {
      // The bar hangs off this item, so ITS clicks bubble through here too.
      // Without this line every press of "Mañana" would also open the month
      // view behind it.
      if (event.target.closest(`#${WIDGET_ID}`)) return;
      event.preventDefault();
      openCalendarDialog();
    });
    li.addEventListener("mouseenter", () => setToolsOpen(true));
    li.addEventListener("mouseleave", () => setToolsOpen(false));
    bar.insertBefore(li, slots[Math.floor(slots.length / 2)]);
  }
  li.querySelector(".cal-orb-mount").innerHTML = orbHtml();
  return li;
};

/** Hold the pop-up open while the pointer moves between the orb and the bar. */
let toolsTimer = null;
const setToolsOpen = (open) => {
  const el = document.getElementById(WIDGET_ID);
  if (!el) return;
  if (toolsTimer) { clearTimeout(toolsTimer); toolsTimer = null; }
  if (open) return void el.classList.add("is-open");
  // A grace period, not a whim: the pointer crosses a gap on its way from the
  // orb up to the buttons.
  toolsTimer = setTimeout(() => el.classList.remove("is-open"), 220);
};

/**
 * Make or repaint both pieces. Idempotent: nothing tracks whether they exist.
 *
 * THE BAR HANGS OFF THE ORB, as a child of the orb's list item, pinned above it
 * by `left: 50%` and half its own width back.
 *
 * That is the fix for a bar that drifted out of line whenever the sidebar
 * opened. The first cut MEASURED the macro list and slid the bar to match, and
 * a measurement is a photograph: right when it is taken and wrong the moment
 * anything moves. Foundry animates the sidebar over a quarter of a second, so
 * the measurement taken when the hook fired described a layout that had not
 * happened yet — and nothing measured it again once it had. Answering that with
 * more listeners is chasing the symptom.
 *
 * Hung off the orb, the bar has no position of its own to be wrong: it is
 * centred on the orb, the orb is centred in the macro row, and the browser
 * recomputes both on every frame of every layout change there will ever be —
 * sidebar, resize, fullscreen, a hotbar page, a different slot size. There is
 * nothing left here to keep in sync.
 *
 * The old flow position under #ui-bottom survives as the fallback for a Foundry
 * with no macro list to hang off, and that one needs no measuring either: it is
 * a block with `margin: 0 auto`.
 */
const injectBar = () => {
  const li = injectOrb();
  const bottom = document.getElementById("ui-bottom");
  const hotbar = document.getElementById("hotbar");
  const host = li ?? (bottom && hotbar?.parentElement === bottom ? bottom : document.body);

  let el = document.getElementById(WIDGET_ID);
  // The macro list came or went (a hotbar that had not rendered yet, a Foundry
  // that renamed it): move the bar rather than leave it orphaned in the old place.
  if (el && el.parentElement !== host) { el.remove(); el = null; }

  if (!el) {
    el = document.createElement("div");
    el.id = WIDGET_ID;
    if (host === li) el.classList.add("is-anchored");
    else if (host === document.body) el.classList.add("is-floating");
    el.addEventListener("click", onBarClick);
    el.addEventListener("mouseenter", () => setToolsOpen(true));
    el.addEventListener("mouseleave", () => setToolsOpen(false));
    if (host === bottom) bottom.insertBefore(el, hotbar);
    else host.appendChild(el);
  }
  el.innerHTML = renderBar(!li);
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

const removeBar = () => {
  document.getElementById(WIDGET_ID)?.remove();
  document.getElementById(ORB_ID)?.remove();
};

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

  // The hotbar re-rendered (a macro added, a page turned, the bar unlocked).
  // This one is not optional any more: that render replaces the macro list's
  // children, and the orb is one of them.
  Hooks.on("renderHotbar", () => { if (on()) injectBar(); });

  // Nothing here listens for the sidebar, a resize or a fullscreen toggle. The
  // bar hangs off the orb and the orb is in the macro row, so the browser's own
  // layout carries both — see `injectBar`.

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
