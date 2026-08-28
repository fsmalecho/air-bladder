/**
 * RETIRED — the content-translation overlay was removed from this system.
 *
 * Compendium content is authored in English and displayed as authored; there is
 * no display-time translation layer any more, so there is no translatable-field
 * taxonomy to declare and nothing to extract from a pack document.
 *
 * Kept as a no-op stub because other tooling still imports `stringsFromDoc`.
 * It yields nothing, so every consumer sees an empty extraction rather than a
 * missing-module crash.
 */

/**
 * @param {object} _doc   a pack document (ignored)
 * @param {string} _pack  the pack's name (ignored)
 * @yields nothing
 */
// eslint-disable-next-line require-yield
export function* stringsFromDoc(_doc, _pack) {
  return;
}
