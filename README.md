# Spawn Planet Picker for Planetary Annihilation: TITANS

Lets players choose which planet they start on from the lobby, instead of only
"Start Anywhere / Nearby / Offworld".

Two mods make up the feature:

| Part | Identifier | Who needs it | Status |
|------|-----------|--------------|--------|
| Client mod | `com.pa.bteam.spawnplanet` | Anyone who wants to pick, plus the host | built (this folder, `client/`) |
| Server mod | `com.pa.bteam.spawnplanet-server` | Host only | built (`server/`), generated from the stock game file by `server/build.js` |

Without the server mod the dropdowns appear and sync between players, but the
server ignores the picks. The lobby shows an orange warning in that case.

## What the client mod does

Lobby (`new_game` scene):

- Adds one entry per spawnable planet (planets with `starting_planet: true`, or
  with custom landing zones) to the existing AI landing dropdown. Planet entries
  use the value `planet:<index>` where `<index>` is the planet's position in the
  system definition.
- Adds the same style dropdown to human slots. A player can set their own slot.
  The host can set any slot. Everyone else sees the pick read-only.
- Shared-army teams show one dropdown for the whole team (same rule the stock
  econ box uses).
- Keeps everyone's dropdowns in sync using the lobby's `json_message` relay.
  Late joiners request the current picks from the host.
- Resets all picks when the host loads a different system.
- Never saves a planet pick as the default for the next AI you add.

Landing phase (`live_game` scene):

- The host's client sends one `spawn_planet_assignments` message as soon as the
  landing phase starts. Payload: `{ "assignments": { "<playerId>": "planet:N", ... } }`,
  covering humans and AIs with a pick. Players left on Start Anywhere are omitted.

## What the server mod does

The server's lobby and landing logic is JavaScript under `media/server-script/`.
The server mod ships a patched copy of `server-script/states/landing.js`, which
the game mounts over the stock file. `server/build.js` generates it from the
stock file in your install and fails if any patch anchor no longer matches, so a
game update cannot silently ship stale code. Re-run the build after each patch.

The patch:

1. Registers a `spawn_planet_assignments` handler in the landing state. Only the
   game creator may send it.
2. Resolves each army's pick, in slot order, from the host's assignments first
   and then from any `planet:N` AI landing policy that arrived natively.
3. Replaces the stock round-robin `assignZones` with a choice-aware version.
   Armies that picked a planet take that planet's zones first, sharing them if
   there are fewer zones than armies. Everyone else gets the remaining zones
   round-robin exactly as before. No army is ever left without a zone.
4. On assignment, re-runs the distribution (keeping zones for anyone who has
   already landed) and re-sends `server_state` to every client so the green
   zones redraw. Humans are then limited to the chosen planet by the stock
   `validateSpawnPoint`; AIs pick from the filtered list.
5. Ignores picks for planets that have no zones (not a starting planet, or out
   of range).

`server/test_assign.js` exercises the generated file offline with the game's
own lodash build and mock armies:

```powershell
node .\server\test_assign.js
```

### Verifying on a real server

The local server log (`%LOCALAPPDATA%\Uber Entertainment\Planetary Annihilation\server-<date>.txt`)
should contain `[spawnplanet] landing.js override active` at startup and, once
the landing phase begins, `[spawnplanet] assignments received` followed by
`zones assigned with picks`. If the first line is missing, the server did not
mount the mod at startup.

### Why the server mod is also shipped as a zip

The server loads all of its state scripts when `server.exe` starts. Mods the
host uploads afterwards (the "Loaded remote mod" lines in the server log) are
fine for unit JSON, which the sim reads lazily, but too late for a
`server-script` override. The game does pass every zip the client has mounted
to the local server on its command line, so `build.js` also packages the
server mod as `server/dist/com.pa.bteam.spawnplanet-server.zip`, the install
script drops it in the PA `download` folder, and the client mod's
`mount_server_mod.js` (run on every scene) mounts it at
`/server_mods/com.pa.bteam.spawnplanet-server/`. The server still only applies
mods listed in the mount order the Community Mods manager publishes, so the
"Spawn Planet Picker - Server" toggle remains the on/off switch.

When the mod is published through Community Mods it arrives as a zip anyway,
and this extra step becomes unnecessary.

## Developer install

Run from this folder in PowerShell after every edit:

```powershell
.\install-dev.ps1
```

This builds the server mod, then copies both mods into PA's local mod folders
(`%LOCALAPPDATA%\Uber Entertainment\Planetary Annihilation\mods\com.pa.bteam.spawnplanet`
and `...\server_mods\com.pa.bteam.spawnplanet-server`). PA's virtual filesystem
does not follow junctions or symlinks, so real copies are required and the
script must be re-run after each change. Restart the game, or at least return
to the main menu, to pick up new files. Node.js is required for the build.

In game: Community Mods, Installed tab, enable both "Spawn Planet Picker" and
"Spawn Planet Picker - Server".

`.\uninstall-dev.ps1` removes the installed copy.

## Manual test plan

1. Host a game, load a multi-planet system (for example Collision System).
2. Confirm each occupied slot shows a dropdown with Start Anywhere plus the
   starting planets. AI slots show the stock three options plus planets.
3. Pick planets, then switch system. All picks should reset to Start Anywhere.
4. Have a second player join. Their dropdown should be editable for their own
   slot only, and should show your picks for other slots.
5. Open the Coherent UI debugger (`--coherent-debug` in launch options, port 9999)
   and check the console for `[spawnplanet]` lines, including
   `sending assignments` once the landing phase begins.

## Reference points in the game files

- Lobby UI: `media/ui/main/game/new_game/new_game.js` (AI landing dropdown at
  `aiLandingPolicyOptions`, scene mods load at `loadSceneMods('new_game')`
  just before `ko.applyBindings`).
- Lobby server: `media/server-script/states/lobby.js` (`setAILandingPolicy`,
  `playerMsg_jsonMessage`, `getFinalData`).
- Landing server: `media/server-script/states/landing.js` (`assignZones`,
  `selectAISpawnsAndStartGame`, `validateSpawnPoint`, `getClientState`).
- Zone generation per planet: `planet.genMetalAndLandingSpots(maxZonesPerArmy,
  zoneRadius, bufferRadius, armyCount, forceRandom)`.
