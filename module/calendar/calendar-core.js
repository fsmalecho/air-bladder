/**
 * THE CALENDAR'S ARITHMETIC. No DOM, no dialogs, no Foundry documents — just
 * the conversions the widget and its month view both need, so the two can never
 * disagree about what day it is.
 *
 * A GREGORIAN calendar (2026-09-02, user ruling), leap years and all. The names
 * of its months, weekdays and seasons are LOCALIZATION KEYS, never literals:
 * re-wording `CAIRN.Cal.Months.*` in lang/es.json renames every month in the
 * game and touches no code, which is the seam the ruling asked for ("más
 * adelante se podrían cambiar los nombres de los meses y días o estaciones").
 *
 * WHERE THE DATE COMES FROM. Foundry already keeps one clock — `game.time.worldTime`,
 * a count of SECONDS the whole table shares — and this file does not keep a second
 * one. A date is that number read through an OFFSET (`calendar-epoch`, the civil
 * day number that worldTime 0 lands on), so:
 *
 *   - advancing time writes worldTime and the date follows;
 *   - setting the campaign's start date writes the OFFSET and the clock does not
 *     move. That matters: worldTime is what every other time-aware thing in a
 *     world counts from, and "my campaign starts in 1503" must not silently
 *     shunt it by half a millennium.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_HOUR = 3600;

/** One dungeon turn. Ten minutes is the OSR standard and the reason the button exists. */
export const TURN_SECONDS = 600;

/** The four times of day the travel buttons jump to, in the order they are shown. */
export const DAY_MARKS = [
  { key: "morning", hour: 6 },
  { key: "midday", hour: 12 },
  { key: "evening", hour: 18 },
  { key: "midnight", hour: 0 },
];

/** Month lengths, January first. February is corrected by `isLeap` at the two
 *  places that count days; it is 28 here so the table reads as the common year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The eight moon phases, new moon first — the order `moonPhase` indexes into. */
export const MOON_PHASES = [
  "new", "waxingCrescent", "firstQuarter", "waxingGibbous",
  "full", "waningGibbous", "lastQuarter", "waningCrescent",
];

/**
 * The season boundaries, as [month, day] of the day the season STARTS.
 * Astronomical dates for the northern hemisphere, fixed rather than computed:
 * a solstice wanders by a day either way and nobody at a table has ever needed
 * that. Ordered by date so `seasonOf` can walk backwards through them.
 */
const SEASON_STARTS = [
  { key: "spring", month: 3, day: 21 },
  { key: "summer", month: 6, day: 21 },
  { key: "autumn", month: 9, day: 23 },
  { key: "winter", month: 12, day: 21 },
];

/** The synodic month: new moon to new moon, in days. */
const LUNATION = 29.530588853;

/**
 * A known new moon, as a civil day number plus the fraction of that day —
 * 6 January 2000, 18:14 UTC. Every phase in the calendar is counted from here,
 * forwards or backwards, so one constant fixes the whole moon.
 */
const NEW_MOON_EPOCH_DAY = 10962 + 0.76;

/* -------------------------------------------------------------------------- */
/*  Civil date <-> day number                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The civil day number for a proleptic Gregorian date. Day 0 is 1 January 1970,
 * which is only a convention — nothing here cares where zero sits.
 *
 * Howard Hinnant's `days_from_civil`, the standard exact algorithm, with
 * `Math.floor` in place of C++'s integer division so it stays correct for years
 * before the era boundary. Written out rather than reached for through `Date`
 * because `Date` is a wall clock in a timezone, and a game calendar is neither.
 *
 * @param {Number} y  full year @param {Number} m  1-12 @param {Number} d  1-31
 * @returns {Number} whole days
 */
export const daysFromCivil = (y, m, d) => {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;                                          // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

/** The inverse of `daysFromCivil`. @param {Number} z @returns {{year,month,day}} */
export const civilFromDays = (z) => {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;                                       // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
};

/** Gregorian leap year. */
export const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** How many days a month has, February corrected. */
export const daysInMonth = (year, month) =>
  (month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1]);

/**
 * The weekday index of a civil day number, MONDAY FIRST (0 = lunes).
 *
 * Day 0 is a Thursday, so +3 rotates Monday to zero; the double modulo keeps a
 * negative day number (a campaign set before 1970) on the right day rather than
 * on a negative index.
 */
export const weekdayIndex = (dayNumber) => (((dayNumber + 3) % 7) + 7) % 7;

/** 1 for 1 January, 365 or 366 for 31 December. */
export const dayOfYear = (year, month, day) =>
  daysFromCivil(year, month, day) - daysFromCivil(year, 1, 1) + 1;

/* -------------------------------------------------------------------------- */
/*  World time <-> date                                                         */
/* -------------------------------------------------------------------------- */

const NS = () => game.system?.id ?? "mondolme";

/** The civil day number worldTime 0 lands on. Read through a function because
 *  a setting read before `registerSettings` throws, and a hook can fire early. */
export const epochDay = () => {
  try {
    return Number(game.settings.get(NS(), "calendar-epoch")) || 0;
  } catch {
    return 0;
  }
};

/**
 * The date and time a world clock reading shows.
 *
 * `Math.floor` on the day split, not a truncation: at a NEGATIVE worldTime
 * (a Warden who rewound past the start) truncation rounds toward zero and the
 * date jumps a day forwards at midnight, which reads as the clock running
 * backwards over the boundary.
 *
 * @param {Number} [worldTime] defaults to the live clock
 * @returns {{year,month,day,hour,minute,dayNumber,dayOfYear,weekday}}
 */
export const worldToDate = (worldTime = game.time.worldTime) => {
  const t = Number(worldTime) || 0;
  const dayNumber = epochDay() + Math.floor(t / SECONDS_PER_DAY);
  const intoDay = ((t % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const { year, month, day } = civilFromDays(dayNumber);
  return {
    year, month, day, dayNumber,
    hour: Math.floor(intoDay / SECONDS_PER_HOUR),
    minute: Math.floor((intoDay % SECONDS_PER_HOUR) / 60),
    dayOfYear: dayOfYear(year, month, day),
    weekday: weekdayIndex(dayNumber),
  };
};

/**
 * The epoch offset that would make TODAY read as the given date, leaving the
 * clock exactly where it is.
 *
 * The caller writes the answer to `calendar-epoch`; this only computes it, so
 * the arithmetic can be reasoned about (and tested) without a world.
 * @returns {Number}
 */
export const epochForDate = (year, month, day, worldTime = game.time.worldTime) =>
  daysFromCivil(year, month, day) - Math.floor((Number(worldTime) || 0) / SECONDS_PER_DAY);

/**
 * Seconds from now to the NEXT time the clock reads `hour`:00 — always forward,
 * never zero.
 *
 * "Always forward" is the whole rule, and it is what makes «Medianoche» mean
 * what it says: at 23:00 the next midnight is an hour away, at 00:30 it is
 * tomorrow's, and pressing «Mediodía» AT noon moves a full day rather than
 * doing nothing. These are advance buttons; an advance that stands still is a
 * button that looks broken.
 * @param {Number} hour  0-23 @returns {Number} seconds, > 0
 */
export const secondsUntilHour = (hour, worldTime = game.time.worldTime) => {
  const now = Number(worldTime) || 0;
  const dayStart = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  let target = dayStart + hour * SECONDS_PER_HOUR;
  while (target <= now) target += SECONDS_PER_DAY;
  return target - now;
};

/* -------------------------------------------------------------------------- */
/*  Seasons, daylight, moon                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The season a date falls in. Walked BACKWARDS through the boundaries so the
 * stretch between 21 December and 21 March needs no special case: nothing
 * matches, and winter is the answer that falls out.
 * @returns {String} a key of SEASON_STARTS
 */
export const seasonOf = (month, day) => {
  for (let i = SEASON_STARTS.length - 1; i >= 0; i--) {
    const s = SEASON_STARTS[i];
    if (month > s.month || (month === s.month && day >= s.day)) return s.key;
  }
  return "winter";
};

/**
 * Sunrise and sunset, as decimal hours.
 *
 * A sinusoid rather than a table: daylight runs from about ten hours at the
 * winter solstice to about fourteen at the summer one, crossing twelve at the
 * equinoxes. It exists to decide ONE thing — whether the orb shows the sun or
 * the moon — so a temperate-latitude curve is the whole of the accuracy needed.
 * Day 80 is 21 March, which is where the sine is zero.
 * @returns {{sunrise: Number, sunset: Number}}
 */
export const daylightHours = (doy) => {
  const length = 12 + 2 * Math.sin((2 * Math.PI * (doy - 80)) / 365.25);
  return { sunrise: 12 - length / 2, sunset: 12 + length / 2 };
};

/** Is the sun up at this moment? */
export const isDaylight = (date) => {
  const { sunrise, sunset } = daylightHours(date.dayOfYear);
  const h = date.hour + date.minute / 60;
  return h >= sunrise && h < sunset;
};

/**
 * The moon on a given day: which of the eight phases, and how far through the
 * lunation it is.
 *
 * Counted from one known new moon by the mean synodic month. That is the
 * almanac's own approximation — it drifts a few hours over a year against the
 * true moon, and a table has never once cared.
 * @returns {{index: Number, key: String, age: Number, illum: Number}}
 */
export const moonPhase = (date) => {
  const exact = date.dayNumber + (date.hour + date.minute / 60) / 24;
  const age = (((exact - NEW_MOON_EPOCH_DAY) % LUNATION) + LUNATION) % LUNATION;
  const index = Math.floor((age / LUNATION) * 8 + 0.5) % 8;
  return {
    index,
    key: MOON_PHASES[index],
    age,
    // 0 at new, 1 at full — what the little moon drawing is scaled by.
    illum: (1 - Math.cos((2 * Math.PI * age) / LUNATION)) / 2,
  };
};

/* -------------------------------------------------------------------------- */
/*  Reading and writing a date as words                                         */
/* -------------------------------------------------------------------------- */

/** A month's name, from the language file. Months are 1-12. */
export const monthName = (month) =>
  game.i18n.localize(`CAIRN.Cal.Months.${month}`);

/** A weekday's name, 0 = Monday. */
export const weekdayName = (index) =>
  game.i18n.localize(`CAIRN.Cal.Weekdays.${index}`);

/** The one-letter head of a weekday column. Its OWN key, not the first letter
 *  of the name: Spanish writes L M X J V S D precisely because martes and
 *  miércoles both begin with an M, and slicing would print two of them. */
export const weekdayShort = (index) =>
  game.i18n.localize(`CAIRN.Cal.WeekdaysShort.${index}`);

/** A season's name. */
export const seasonName = (key) => game.i18n.localize(`CAIRN.Cal.Seasons.${key}`);

/** A moon phase's name. */
export const moonName = (key) => game.i18n.localize(`CAIRN.Cal.Moons.${key}`);

/**
 * The date as the Warden writes it: «24 de Diciembre de 1503».
 *
 * ONE whole-sentence key with three named slots, never three fragments joined
 * with " de " — the same rule the biography sentence follows. A language that
 * orders a date differently, or drops the preposition, rewrites the key and
 * nothing else.
 */
export const formatDate = (date) => game.i18n.format("CAIRN.Cal.DateFormat", {
  day: date.day,
  month: monthName(date.month),
  year: date.year,
});

/** "14:30". Padded, so the widget's width does not jitter minute to minute. */
export const formatTime = (date) =>
  `${String(date.hour).padStart(2, "0")}:${String(date.minute).padStart(2, "0")}`;

/**
 * Read a date the Warden typed. Accepts what they are told to type —
 * «24 de Diciembre de 1503» — and, because somebody always tries it, the same
 * date as 24/12/1503 or 24-12-1503.
 *
 * The month is matched against the LOCALIZED names, accent- and case-folded,
 * so «diciembre» and «Diciembre» both land and a re-worded month name keeps
 * working the day it is re-worded. A bare number in the month slot is taken as
 * a month number.
 *
 * Returns null on anything it cannot read — the caller says so; this does not
 * guess a date nobody asked for.
 * @param {String} text @returns {{year,month,day}|null}
 */
export const parseDate = (text) => {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const fold = (s) => String(s).toLowerCase()
    // Strip accents by decomposing and dropping the combining marks, so
    // «diciembre» matches «Diciembre» and a month re-worded with an accent
    // still matches what the Warden types without one.
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();

  // 24/12/1503 · 24-12-1503 · 24.12.1503
  const numeric = raw.match(/^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(-?\d{1,6})$/);
  if (numeric) {
    return validated(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  }

  // 24 de Diciembre de 1503 — the connectives are read loosely (any run of
  // letters between the numbers), so "24 de diciembre del 1503" also lands.
  const written = raw.match(/^(\d{1,2})\s+[a-zA-Záéíóúñ]+\s+(.+?)\s+[a-zA-Záéíóúñ]+\s+(-?\d{1,6})$/i);
  if (!written) return null;

  const wanted = fold(written[2]);
  let month = Number(wanted);
  if (!month) {
    for (let m = 1; m <= 12; m++) {
      if (fold(monthName(m)) === wanted) { month = m; break; }
    }
  }
  return validated(Number(written[3]), month, Number(written[1]));
};

/** Refuse a date that does not exist — 31 February, month 13, day 0. */
const validated = (year, month, day) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
};

/* -------------------------------------------------------------------------- */
/*  Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The key a day's notes are stored under: "1503-12-24", zero-padded so the keys
 * sort as dates and a glance at the stored object reads as a diary.
 */
export const noteKey = (year, month, day) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
