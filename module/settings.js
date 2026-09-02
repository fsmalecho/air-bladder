import { registerSettingMenus } from "./settings-menus.js";
import { clearPackWarnings } from "./content-packs.js";

/**
 * The namespace every game setting is registered under.
 *
 * It MUST be the package id. Foundry groups the settings sheet by package, so a
 * namespace that names no installed package cannot be rendered under a heading —
 * every setting lands in a bucket literally labelled "Unmapped", and a Warden has
 * no way to reach any of them. This system was still registering under "cairn",
 * inherited from the system it descends from, so all 16 settings were invisible.
 *
 * Do not "tidy" this back to a friendlier string. It is not a label; it is a key.
 */
export const SETTINGS_NS = "mondolme";

/**
 * Every key registered below, kept in registration order.
 *
 * The order is a maintenance convention so this list mirrors registerSettings()
 * and a missing key is easy to spot -- it is NOT load-bearing. The migration
 * iterates it as an unordered set (each key is copied independently), and the dev
 * probes only filter and count it. Nor is registration order load-bearing any
 * more (2026-08-22): the Warden sees each setting inside its SETTING_GROUPS
 * submenu, in that group's `keys` order — the positional headers that once made
 * the `register()` order matter went with the flat list.
 */
export const SETTING_KEYS = [
  // General
  // The four content compendiums. This system ships no packs of its own, so
  // these name where every table, background and item comes from — see
  // content-packs.js, which is the only file allowed to resolve them.
  "pack-generators", "pack-market", "pack-backgrounds", "pack-npc-backgrounds",
  "pack-items", "languages",
  "use-panic", "use-cairn-dice-notation", "use-item-icons", "show-grant-tags",
  "show-grant-tags-print", "show-omens",
  "use-warden-title", "change-log", "auto-record-scars",
  // Character Generation
  "show-generate-header",
  "allow-player-generate", "allow-player-randomization", "show-generation-rolls",
  // disabled-backgrounds is Warden CONFIGURATION (which 2e backgrounds are
  // switched off), not a migration marker — it must ride the namespace
  // migration like custom-portrait-list does. It was registered without being
  // listed here (review #9); the five completion markers (roles-restamped,
  // companion-restamped, hireling-split, connections-migrated,
  // art-migration-generation) stay unlisted on purpose.
  // Every one of them dates
  // from AFTER the namespace move, so there is no "cairn.<key>" value for this
  // list to carry across — listing them would iterate keys that cannot exist.
  //
  // The old wording here said the reason was that losing a marker only re-runs
  // an idempotent migration. True of most of them, and NOT true of
  // `hireling-split`, which selects on a stored `role: "npc"` that a real NPC
  // also carries once it has run. Do not reason about any new marker from that
  // sentence; reason about the migration.
  "custom-portrait-folder", "custom-portrait-list",
  "disabled-backgrounds",
  // Internal but CONFIGURATION, not a marker: the parked-Connections flag
  // (2026-08-09) must ride the namespace migration — losing it would re-park
  // a world the user had unparked.
  "connections-ui-enabled",
  // Inventory & Encumbrance
  "max-equip-slots", "character-inventory-limit", "allow-player-marketplace",
  "use-gold-threshold",
];

/**
 * Carry a Warden's existing configuration across from the old "cairn" namespace.
 *
 * Settings are stored per-world as documents keyed "<namespace>.<key>", so simply
 * fixing the namespace would strand every value a Warden had already chosen and
 * silently revert their world to defaults. This copies each one over the first
 * time a GM loads the world, and only where the new namespace has no value yet,
 * so it cannot clobber a deliberate change. The old documents are left in place —
 * they are inert once unregistered, and keeping them means a mis-migration is
 * recoverable.
 *
 * Single-writer, like the two `ready` migrations in cairn.js. `isGM` alone is not
 * enough: with two GMs connected, both pass it and both run this concurrently, and
 * each `has()` check reads a store that the other's write has not reached yet. Two
 * Setting DOCUMENTS then exist for one key — Foundry keeps the first it indexes, so
 * the second is permanently shadowed and the losing GM's value is silently gone.
 */
export const migrateSettingsNamespace = async () => {
  if (!game.user?.isGM) return;
  if (game.users.activeGM && game.users.activeGM !== game.user) return;
  const store = game.settings.storage.get("world");
  const has = (key) => !!store.find((s) => s.key === key);
  const moved = [];
  for (const key of SETTING_KEYS) {
    const old = store.find((s) => s.key === `cairn.${key}`);
    if (!old || has(`${SETTINGS_NS}.${key}`)) continue;
    try {
      await game.settings.set(SETTINGS_NS, key, JSON.parse(old.value));
      moved.push(key);
    } catch (e) {
      console.warn(`Mondolme | could not migrate setting "${key}":`, e);
    }
  }
  if (moved.length) {
    console.log(`Mondolme | migrated ${moved.length} setting(s) from the "cairn" namespace: ${moved.join(", ")}`);
  }
};

/**
 * Re-render every open actor sheet on this client.
 *
 * The onChange body shared by every no-reload toggle whose value a sheet reads
 * in `_prepareContext`: the read is live, but "live" only means the NEXT
 * render — without this fan an open sheet keeps its stale surface until
 * something unrelated redraws it (review #13). onChange fires on every
 * client, so each client sweeps its own windows. One helper, not five copies
 * of the loop — the fifth copy is where the drift starts.
 */
const rerenderActorSheets = () => {
  for (const app of foundry.applications.instances.values()) {
    if (app.document instanceof Actor && app.rendered) app.render();
  }
};

/**
 * Internal CONFIGURATION keys: in SETTING_KEYS because they must ride the
 * namespace migration, but Warden-invisible by design — caches and flags no
 * settings UI ever shows. Everything else in SETTING_KEYS is Warden-facing and
 * must belong to exactly one group below, which `npm run dev:settings` gates:
 * a setting in neither list is registered, migrated, and unreachable.
 */
export const INTERNAL_SETTING_KEYS = [
  "custom-portrait-list", "disabled-backgrounds", "connections-ui-enabled",
];

/**
 * The Warden's settings, as SUBMENUS (2026-08-22, user ruling: "one submenu
 * per group" — four of them, once the rule-hacks menu was asked for the same
 * day): the main Configure Settings window shows one button per group under
 * Mondolme and nothing else, and each opens a small application holding
 * that group's rows — see `settings-menus.js`. Every key listed here is
 * registered `config: false`, which is what keeps it off the flat list.
 *
 * This is the ONE declaration of the grouping. `settings-menus.js` registers
 * a menu per entry and renders its `keys` in this order; `dev:settings`,
 * `dev:ui-parity` and `dev:age-override` read it to assert membership and
 * order on the rendered apps. Until 2026-08-22 the grouping was three
 * positional `<h3>` headers inserted into the flat list (cairn.js
 * `renderSettingsConfig`), which made REGISTRATION ORDER load-bearing — a
 * moved `register()` call silently re-filed a setting under another heading,
 * the order needed its own gate (review #16), and the compact rows that went
 * with it hid every hint for a year. None of that is true any more: the order
 * of `register()` calls below is readability only, and the order a Warden
 * sees is `keys`.
 *
 * Per-group decorations are declared here too, so the app stays generic:
 * `subOptions` greys rows out while a master checkbox is off, `boldPhrases`
 * bolds a localized phrase inside a label.
 */
export const SETTING_GROUPS = [
  {
    id: "general",
    title: "CAIRN.Settings.GroupGeneral",
    // `button` is the text ON the button, naming what it opens (user ruling
    // 2026-08-22, after Dice So Nice's per-menu buttons; a shared "Configure"
    // said nothing four times). `title` is the row label beside it.
    button: "CAIRN.Settings.GroupGeneralButton",
    hint: "CAIRN.Settings.GroupGeneralHint",
    icon: "fa-solid fa-gears",
    keys: [
      "pack-generators", "pack-market", "pack-backgrounds", "pack-npc-backgrounds",
      "pack-items", "languages",
      "use-panic", "use-cairn-dice-notation", "use-item-icons", "show-grant-tags",
      "show-grant-tags-print", "show-omens", "use-warden-title", "change-log",
      "auto-record-scars",
    ],
  },
  {
    id: "generation",
    title: "CAIRN.Settings.GroupGeneration",
    button: "CAIRN.Settings.GroupGenerationButton",
    hint: "CAIRN.Settings.GroupGenerationHint",
    icon: "fa-solid fa-user-plus",
    keys: [
      "show-generate-header", "allow-player-generate",
      "allow-player-randomization", "show-generation-rolls",
      "custom-portrait-folder",
    ],
    // `boldPhrases` is EMPTY since 2026-09-02: its one carrier was the Barebones
    // source checkbox, and there is ONE generator now. The key stays declared so
    // settings-menus.js keeps reading the group shape it recognises.
    boldPhrases: {},
  },
  {
    id: "inventory",
    title: "CAIRN.Settings.GroupInventory",
    button: "CAIRN.Settings.GroupInventoryButton",
    hint: "CAIRN.Settings.GroupInventoryHint",
    icon: "fa-solid fa-weight-hanging",
    keys: [
      "max-equip-slots", "character-inventory-limit", "allow-player-marketplace",
      "use-gold-threshold",
    ],
  },
  /* The "Hacks" group stood here and is GONE (2026-09-02). Its last member was
     the Knave-style failed career, which only ever applied to Barebones
     characters; with Barebones removed the group had no member left, and a
     settings button that opens an empty window is worse than no button. */
];

/**
 * The registration blocks below are kept roughly in group order for the
 * reader's sake only — General, then Character Generation, then Inventory &
 * Encumbrance, with the two Hacks settings still sitting in the blocks they
 * grew up in. Nothing positional depends on it (see SETTING_GROUPS).
 */
export const registerSettings = () => {
  // Not a setting anyone sets: the completion marker for the role migration.
  // `config: false` and in no group, so no settings UI ever shows it — it is
  // first only so the grouped blocks stay contiguous and easy to read.
  //
  // A marker rather than a state test, because `system.role` is a PICK-LIST. The
  // three sibling migrations get away with selecting on current state because their
  // "before" value is unreachable once migrated (a remapped container is no longer
  // one of the legacy art paths; a .svg icon is never .png again). A role the
  // Warden changes away from would go straight back into any selection set, so a
  // state test would re-stamp it on every world load — the exact trap the retired
  // forHire migration fell into with its checkbox (its marker, `forhire-migrated`,
  // may still sit unread in old world settings; harmless).
  //
  // **A NEW key, replacing `roles-migrated` (2026-08-01).** That one is `true` in
  // every world that has already opened — and those are exactly the worlds
  // holding a stored `role: "hireling"`, so reusing it would skip the population
  // the re-stamp exists for. It joins `forhire-migrated` as an unread leftover.
  // The name says what the migration does now: it re-stamps every npc's role
  // BLIND, because neither state it fixes can be seen from a client at all.
  game.settings.register(SETTINGS_NS, "roles-restamped", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // Completion marker for the mount→companion restamp (2026-08-08, the role
  // evolved — see NPC_ROLES). Its own marker rather than a reuse of
  // `roles-restamped`, which is long true in every existing world and would
  // skip exactly the population this exists for.
  game.settings.register(SETTINGS_NS, "companion-restamped", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // Completion marker for the NPC/Hireling split (2026-08-20): every person who
  // was role `npc` becomes role `hireling`, because that is what role `npc`
  // MEANT until this release and the key is being reused for the new NPC.
  //
  // MARKER-GATED AND IT MUST BE, more strictly than either sibling above. Those
  // two are blind restamps whose "before" value is unobservable, so re-running
  // them is harmless. This one selects on a stored `role: "npc"` — and once it
  // has run, a genuine NEW npc stores exactly that. A second pass would convert
  // every real NPC in the world into a hireling, silently. The marker is the
  // only thing standing between those two states, so it is set only after the
  // writes land: a failed run must retry, never record itself done.
  game.settings.register(SETTINGS_NS, "hireling-split", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // Completion marker for the art-path migrations (review #17): which
  // GENERATION of cairn.js's ART_MOVES/ART_REENCODED tables this world has
  // been swept to. A NUMBER, not the usual boolean, because those tables
  // grow — a future art move adds a rule, and a stamp made before the rule
  // existed must not block it (bump ART_MIGRATION_GENERATION beside the
  // tables). Before this the sweep ran marker-less on every GM load,
  // forever, pack.getDocuments() round trips included.
  game.settings.register(SETTINGS_NS, "art-migration-generation", {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  });

  /* `grimoire-keys-stamped` was registered here and is GONE with
     `migrateGrimoirePages`, the one migration that read or wrote it. A setting
     no code reads is a row in every world's database and a line in this file
     that reads like a live feature. */

  // Completion marker for the connections flatten + ownership migration
  // (2026-08-01, the flat graph). Same reasoning as its sibling above: gated
  // on a marker, not on state, because both things it writes are re-editable
  // — a Warden can re-raise an ownership default or re-break a link, and a
  // state test would put the migration's answer back on the next load.
  // `config: false`: internal, in no submenu.
  game.settings.register(SETTINGS_NS, "connections-migrated", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // The Connections UI is PARKED (user ruling 2026-08-09): the mechanic is not
  // being pursued further for now, and its surfaces hide until it is — the PC
  // Connections tab, the npc header attach/detach line and wording (the For
  // Hire checkbox on that line SURVIVES — it is the day-rate mechanic, not
  // connections), the four connection sheet actions, and drag-to-connect.
  // Everything underneath keeps working: the minting flows (marketplace
  // transports, generation grants), carry capacity from connected containers,
  // the ownership automation and its socket brokers, and the flatten
  // migration. Flipping this to true restores the whole UI.
  //
  // `config: false` on purpose, and NOT a Warden-visible setting: this repo
  // removed `show-containers-tab` (2026-07-31) on the reasoning that a display
  // toggle hiding a live graph is not a setting worth having, and a visible
  // toggle here would re-litigate that. Probes exercise the enabled state by
  // SHADOWING the settings read in-page — never by writing this into a world.
  //
  // DEFAULT TRUE since 2026-09-02 (user report: "los vínculos no aparecen en la
  // hoja de personaje, solo el campo de notas"). The flag was parked false by the
  // upstream author while the feature was being reconsidered; here the Vínculos
  // list IS the top half of the «Vínculos y notas» tab, so parked meant a tab
  // that showed only its notes editor. It stays `config: false` — there is no
  // reason to offer a switch that hides half a tab.
  game.settings.register(SETTINGS_NS, "connections-ui-enabled", {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
  });

  // The 2e backgrounds a Warden has switched off, as an array of UUIDs — the
  // eye toggle on the picker's rows (2026-08-04). World state, NOT a
  // flag on the documents: the shipped packs are replaced wholesale on every
  // system update, so anything written into them is one release from gone.
  // `config: false` — the picker is the whole UI; internal, in no submenu.
  game.settings.register(SETTINGS_NS, "disabled-backgrounds", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  // `name`/`hint` are i18n KEYS, not localized strings. registerSettings runs on
  // the `init` hook, which the client fires (game.mjs:652) BEFORE it loads any
  // translations (`await i18n.initialize()`, game.mjs:663) — so calling
  // game.i18n.localize() here returns the key verbatim and stores that. Core
  // re-localizes name/hint at display time (settings/config.mjs:126-127), which
  // is what the key is for. Do NOT wrap these in game.i18n.localize().
  // ---- General -------------------------------------------------------------

  // The four content compendiums.
  //
  // `onChange` clears the once-per-session warning set so that fixing a wrong
  // name makes the next miss speak up again — without it a Warden who corrects
  // a typo gets silence either way and cannot tell whether it worked.
  //
  // No `requiresReload`: every read goes through content-packs.js at the moment
  // it is needed, so a corrected name takes effect on the next roll.
  for (const [key, name, hint] of [
    ["pack-generators", "CAIRN.Settings.PackGenerators.label", "CAIRN.Settings.PackGenerators.hint"],
    ["pack-market", "CAIRN.Settings.PackMarket.label", "CAIRN.Settings.PackMarket.hint"],
    ["pack-backgrounds", "CAIRN.Settings.PackBackgrounds.label", "CAIRN.Settings.PackBackgrounds.hint"],
    ["pack-npc-backgrounds", "CAIRN.Settings.PackNpcBackgrounds.label", "CAIRN.Settings.PackNpcBackgrounds.hint"],
    ["pack-items", "CAIRN.Settings.PackItems.label", "CAIRN.Settings.PackItems.hint"],
  ]) {
    game.settings.register(SETTINGS_NS, key, {
      name,
      hint,
      scope: "world",
      config: false,
      type: String,
      default: "",
      requiresReload: false,
      onChange: () => clearPackWarnings(),
    });
  }

  // The languages of the setting, as one comma-separated line.
  //
  // Free text rather than a fixed set: the languages of a world are the
  // Warden's invention, and a list they can retype in one field is the whole
  // feature. Everything that offers a language to pick reads it through
  // `languages()` in content-packs.js, so the splitting lives in one place.
  game.settings.register(SETTINGS_NS, "languages", {
    name: "CAIRN.Settings.Languages.label",
    hint: "CAIRN.Settings.Languages.hint",
    scope: "world",
    config: false,
    type: String,
    default: "",
    requiresReload: false,
  });

  game.settings.register(SETTINGS_NS, "use-panic", {
    name: "CAIRN.Settings.UsePanic.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: true,
  });

  game.settings.register(SETTINGS_NS, "use-cairn-dice-notation", {
    name: "CAIRN.Settings.UseCairnDiceNotation.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    // Read live at every use — `evaluateFormula` (utils.js) per roll and the
    // Warden's dice builder (warden-damage.js) per dialog — so nothing needed
    // the world reload the inherited `requiresReload: true` prompted for on
    // every flip (review #18; the flag was the fork's).
    requiresReload: false,
  });

  game.settings.register(SETTINGS_NS, "use-item-icons", {
    name: "CAIRN.Settings.UseItemIcons.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: true,
  });

  // Show a "Background / Question" chip on items that generation granted.
  game.settings.register(SETTINGS_NS, "show-grant-tags", {
    name: "CAIRN.Settings.ShowGrantTags.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: true,
  });

  // The same tags on the PRINTED sheet, under their own switch (user ask
  // 2026-08-11) — deliberately independent of show-grant-tags above: the
  // print reads the ungated grantLabelRaw at print time, so no reload.
  game.settings.register(SETTINGS_NS, "show-grant-tags-print", {
    name: "CAIRN.Settings.ShowGrantTagsPrint.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
  });

  // Cairn 2e hands the party's YOUNGEST member an omen; a table that does not
  // use the rule had no way to get the field off the sheet (user ask
  // 2026-08-17). Off hides the Omen checkbox and field on every character sheet
  // AND drops the printed page's Omen section — ONE switch, both surfaces, by
  // ruling: a field a Warden has hidden must not reappear on paper. That is
  // deliberately NOT the show-grant-tags / show-grant-tags-print split, which
  // exists because a grant tag is an annotation both surfaces legitimately
  // show; switching omens off says the table does not use the rule at all.
  // Stored omen TEXT is never touched and returns if this goes back on.
  //
  // General, not Character Generation: an omen is not generated —
  // character-generator.js lands every new character with omenEnabled false —
  // so this is a rules/display question and belongs beside use-panic, not among
  // the parameters of the character being made. World-scoped and it applies to
  // everyone including the Warden; it is a table preference, not a permission
  // like allow-player-randomization.
  //
  // The sheet reads it in _prepareContext, so the fan is what makes "read live"
  // true for a sheet already open (the review #13 rule rerenderActorSheets
  // exists for) — hence no reload.
  game.settings.register(SETTINGS_NS, "show-omens", {
    name: "CAIRN.Settings.ShowOmens.label",
    hint: "CAIRN.Settings.ShowOmens.hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
    onChange: rerenderActorSheets,
  });

  // `show-features-section` was registered here and is GONE (2026-08-09, user
  // ruling): the Features list it toggled was removed outright — a
  // fork-inherited UI nobody here uses. The `system.features` field SURVIVES,
  // orphaned, so anything a Warden recorded is still on the document (the
  // character-`description` precedent).

  // `show-containers-tab` was registered here and is GONE. It dated from when a
  // container was a bag of slots a character might not own one of, so an empty
  // tab beside Items was noise. Under the roles model the tab is the only view
  // of the connection graph — who travels with whom, who owns what — and the
  // graph exists whether or not it is displayed, so the switch could only hide
  // relationships that went on mattering. The tab is now structural: everything
  // but a Monster and an unlinked token's actor shows it (CairnActor#prepareData).
  // Do not re-add it as a display toggle.

  // Cairn calls the Game Master the "Warden". When enabled, relabel the GM role
  // wherever Foundry localizes it and rename the default account. Applied in
  // cairn.js; reload to take effect.
  game.settings.register(SETTINGS_NS, "use-warden-title", {
    name: "CAIRN.Settings.UseWardenTitle.label",
    // The one visible setting that had no hint (review #17) — which meant no
    // tooltip at all once hints surfaced (2026-08-21), on the one setting
    // that renames a User document.
    hint: "CAIRN.Settings.UseWardenTitle.hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: true,
  });

  // The manual-change log: whisper a ledger card (to the actor's
  // owners/observers plus the Warden) whenever someone HAND-changes a tracked
  // field or adds/removes an item — see CairnActor#postChangeLog for what
  // counts as manual. Default ON (user ruling 2026-08-08: existing worlds
  // start logging on upgrade). No reload and no onChange: the posting sites
  // read it live, so the shipped "Toggle Change Log" macro takes effect on the
  // next change.
  game.settings.register(SETTINGS_NS, "change-log", {
    name: "CAIRN.Settings.ChangeLog.label",
    hint: "CAIRN.Settings.ChangeLog.hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
  });

  // The one AUTOMATED sheet write in the damage flow, and a deliberate,
  // bounded breach of the "trust players, no automation" house line (user
  // ruling 2026-08-09): when the Scars draw fires for a PLAYER CHARACTER,
  // the drawn scar is also checked on the sheet's scar list. Default OFF —
  // the generationEnabled precedent: an update must not change a table's
  // behavior until the Warden flips it. The write site, with the PC-only /
  // owner-only / dedupe rules, is damage.js `_rollScarsTable`; read live
  // there, no reload.
  game.settings.register(SETTINGS_NS, "auto-record-scars", {
    name: "CAIRN.Settings.AutoRecordScars.label",
    hint: "CAIRN.Settings.AutoRecordScars.hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    requiresReload: false,
  });

  // ---- Character Generation ------------------------------------------------
  /* `content-source-barebones` and `barebones-failed-career` stood here and are
     GONE (2026-09-02, user ruling: "eliminar cualquier referencia a Cairn
     Barebones. La generación de personaje será solo una"). With one generator
     there is no source to choose, and the failed career was a Barebones-only
     flourish. Their orphaned world rows are harmless, like every other setting
     retired here — Foundry simply stops reading them. */
  game.settings.register(SETTINGS_NS, "show-generate-header", {
    name: "CAIRN.Settings.ShowGenerateHeader.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: true,
  });

  // The Warden's switch for the PLAYER-facing Generate PC button in the Actor
  // Directory (both variants: the create-row button and the no-ACTOR_CREATE
  // relay button). Sibling of show-generate-header above — that one gates the
  // sheet's Regenerate button, this one gates the directory's Generate PC —
  // and the toggle the shipped "Toggle Player Generate PC" macro flips. The
  // GM's own button never hides: the read site ORs in isGM.
  //
  // No reload: onChange fires on EVERY client (the settings-fanout primitive
  // the custom-portrait folder scan also rides), so each connected player's
  // directory re-renders itself the moment the Warden flips it — the whole
  // point of a mid-session switch. The pop-out directory is a second,
  // independent ActorDirectory application (the render hook already handles
  // its DOM separately), so the sweep covers both.
  game.settings.register(SETTINGS_NS, "allow-player-generate", {
    name: "CAIRN.Settings.AllowPlayerGenerate.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
    onChange: () => {
      for (const app of foundry.applications.instances.values()) {
        if (app instanceof foundry.applications.sidebar.tabs.ActorDirectory && app.rendered) app.render();
      }
    },
  });

  // The Warden's switch for the SHEET's randomization surface as seen by
  // players: the title-bar Randomization toggle, the Roll button behind it,
  // and every per-line re-roll die (background, age, omen, an
  // npc's name/profession/portrait). Off hides ALL of it from players — even
  // on an actor whose own Randomization flag is on, because the sheet derives
  // its generationEnabled context through _mayRandomize (render-only; no
  // actor is written). The Warden keeps everything; the shipped "Toggle
  // Player Randomization" macro flips this. Third sibling of the two switches
  // above, same onChange shape as allow-player-marketplace: re-render every
  // open actor sheet on every client, so the surface leaves and returns
  // mid-session.
  game.settings.register(SETTINGS_NS, "allow-player-randomization", {
    name: "CAIRN.Settings.AllowPlayerRandomization.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
    onChange: rerenderActorSheets,
  });

  // Post the five generation rolls -- HP, STR, DEX, WIL, Gold -- as one chat
  // message carrying the real Roll objects, so Dice So Nice animates them and
  // core supplies the dice sound without it. Read live at the posting site
  // (postGenerationRolls), hence no reload. World-scoped because the generatePC
  // relay runs generation on the Warden's client for a player who lacks
  // ACTOR_CREATE: the posting client must read the same value the roller would.
  // NO rerenderActorSheets fan, deliberately (review #13 weighed and dropped
  // it): no sheet reads this in _prepareContext — the read happens when a
  // generation POSTS, so there is no open surface to go stale.
  game.settings.register(SETTINGS_NS, "show-generation-rolls", {
    name: "CAIRN.Settings.ShowGenerationRolls.label",
    hint: "CAIRN.Settings.ShowGenerationRolls.hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
  });

  // A GM-curated folder of custom character portraits (per-world local pool). When
  // it holds images, new characters/hirelings draw ONLY from it and the portrait
  // picker gains a "Custom" tab; empty, everything falls back to the shipped Jon
  // Aspeheim art. Default is a folder at the Foundry data root -- NEVER inside the
  // system folder, which is overwritten on update. Portraits are its OWN token
  // (no paired token art), so each image doubles as portrait and token.
  game.settings.register(SETTINGS_NS, "custom-portrait-folder", {
    name: "CAIRN.Settings.CustomPortraitFolder.label",
    hint: "CAIRN.Settings.CustomPortraitFolder.hint",
    scope: "world",
    config: false,
    type: String,
    default: "mondolme-portraits",
    requiresReload: false,
    // requiresReload: false was a claim nothing made true. Both functions that act
    // on this setting ran only in the `ready` hook and from the gallery's GM
    // refresh button, so changing the folder did NOTHING: no reload prompt, the new
    // folder was never created, and the cached custom-portrait-list still held the
    // OLD folder's files. Every character generated afterwards silently drew from
    // the old folder, and if it had been moved the assigned img paths 404'd on both
    // sheet and token.
    //
    // onChange fires on every client, so this is GM-gated: scanning a folder needs
    // FILES_BROWSE and writing custom-portrait-list is a world-setting write.
    // Single-writer via activeGM, not bare isGM — the top of this file explains
    // why isGM alone is not enough (two GMs both scan and race Setting.create;
    // the loser's write is permanently shadowed). Every other client picks the
    // new list up through the setting.
    //
    // Imported dynamically to avoid a static cycle — character-generator.js already
    // imports SETTINGS_NS from here.
    onChange: async () => {
      if (!game.user?.isGM) return;
      if (game.users.activeGM && game.users.activeGM !== game.user) return;
      const gen = await import("./character-generator.js");
      await gen.ensureCustomPortraitFolder();
      const files = await gen.refreshCustomPortraits();
      // formatCount, not format: the key carried an "image(s)" hack because no
      // plural machinery reached this toast. Dynamic import for the same reason
      // as the line above — utils.js imports SETTINGS_NS from here, so a static
      // import is a cycle. `{count}` stays the placeholder (formatCount's `n`
      // rides unused) because lang/es.json already carries it, and that file is
      // the translator's to edit.
      const { formatCount } = await import("./utils.js");
      ui.notifications.info(
        formatCount("CAIRN.Notify.PortraitFolderScanned", files.length, { count: files.length })
      );
    },
  });

  // The scanned file list for the folder above, cached so players (who lack the
  // FILES_BROWSE permission a folder scan needs) can still see and pick custom
  // portraits. A GM refresh (or GM login) rewrites it. Not shown in the UI.
  game.settings.register(SETTINGS_NS, "custom-portrait-list", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    requiresReload: false,
  });

  // ---- Inventory & Encumbrance ---------------------------------------------
  game.settings.register(SETTINGS_NS, "max-equip-slots", {
    name: "CAIRN.Settings.MaxEquipSlots.label",
    scope: "world",
    config: false,
    type: Number,
    default: 10,
    requiresReload: true,
  });

  game.settings.register(SETTINGS_NS, "character-inventory-limit", {
    name: "CAIRN.Settings.CharacterInventoryLimit.label",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    requiresReload: true,
  });

  // The Warden's switch for player shopping — the sheet's Marketplace button
  // and both acquire paths (marketplace.js reads it live; the shipped "Toggle
  // Player Marketplace" macro flips it). The GM always shops. Sibling of
  // allow-player-generate in the Generation group; this one lives here
  // because shopping is an INVENTORY affair. No reload: the onChange fires on
  // every client and re-renders each open actor sheet, so the button
  // hides/returns mid-session — and a sheet that somehow keeps a stale button
  // still cannot buy, because acquire() refuses (the shop's own
  // affordance/enforcement split).
  game.settings.register(SETTINGS_NS, "allow-player-marketplace", {
    name: "CAIRN.Settings.AllowPlayerMarketplace.label",
    hint: "CAIRN.Settings.AllowPlayerMarketplace.hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: false,
    onChange: rerenderActorSheets,
  });

  // Cairn 2e (p.9): coins are heavy. The first N are petty; every further N fills
  // a slot. N is this "coins per slot" value (default 100). 0 = coins weightless.
  game.settings.register(SETTINGS_NS, "use-gold-threshold", {
    name: "CAIRN.Settings.UseGoldThreshold.label",
    hint: "CAIRN.Settings.UseGoldThreshold.hint",
    scope: "world",
    config: false,
    type: Number,
    default: 100,
    requiresReload: true,
  });

  /* `show-gold-not-cost` was registered here and is GONE (2026-07-31), for the
     same reason `show-containers-tab` went: the behaviour it toggled no longer
     exists. It swapped the Cost box on a CONTAINER SHEET for a Gold box, and
     the container type — sheet, model and all — is retired. The npc sheet that
     replaced it has no Cost box to swap: Round 2 settled that Gold simply hides
     on a thing or a mount (`system.showGold`), which is a role fact, not a
     world preference. Do not re-add it without a field for it to govern. */

  /* `show-container-actors` was registered here and is GONE (2026-08-02, by
     ruling: "this feature should always be on and should never be disabled").
     It hid plain/worn containers from the Actor Directory while keeping
     mounts, transports and piles listed; the hide rule in renderActorDirectory
     went with it, so every container actor is simply always listed. The
     grayscale-thumbnail rule survives — it never depended on this setting. */

  /* `enable-inventory-reorder` was registered here and is GONE (2026-08-22, by
     ruling: drag-to-reorder "should not be optional and just be an always-on
     setting"). It gated whether the sheet READ each item's `sort` and honoured
     a same-actor drop as a reorder; with it off the list fell back to
     equipped-first alphabetical and a generated loadout's arrangement was
     invisible. Both paths are unconditional now. A stored value may sit unread
     in old worlds — harmless, like the other retired keys. `dev:ui-parity`
     asserts it is not registered, so re-adding it fails a gate. */

  // The submenu buttons, in group order — registered after every
  // setting so each app finds its keys registered when it opens. These are
  // the only mondolme rows the main settings window shows.
  registerSettingMenus(SETTINGS_NS, SETTING_GROUPS);
};
