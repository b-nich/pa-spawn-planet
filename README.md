# Spawn Planet Picker for Planetary Annihilation: TITANS

Lets players choose which planet they start on from the lobby, instead of only
"Start Anywhere / Nearby / Offworld". Each player picks for their own slot, the
host picks for AIs and can override anyone, and the server limits each army's
landing zones to the planet it was given.

Two mods make up the feature:

| Part | Identifier | Who needs it |
|------|-----------|--------------|
| Client mod | `com.pa.bteam.spawnplanet` | Anyone who wants to pick, plus the host. Installed automatically for players who join a game using the server mod. |
| Server mod | `com.pa.bteam.spawnplanet-server` | The host. |

Works for locally hosted games (the normal "host a game" flow). On a
community-run dedicated server it only works if the operator installs the
patched landing script on the server; see "How the server mod loads" below.

## Playing

1. Install both mods from Community Mods (or see "Developer install").
2. Host a game on a multi-planet system. Every occupied slot gets a dropdown
   listing Start Anywhere plus each starting planet. AI slots keep the stock
   Nearby / Offworld entries too.
3. Pick planets. Players can set their own slot, the host can set any slot.
   Shared-army teams get one dropdown per team.
4. Start. During the landing phase a banner at the top of the screen says
   whether the server override is live and which planet you were designated.
   Green zones appear only on that planet.

Players who leave their slot on Start Anywhere get exactly the stock
distribution. If two armies pick a planet that has only one landing zone, they
share it.

If a picked planet has no landing zones for the current player count (custom
maps often restrict zones by player count), the server generates a random set
of zones on that planet for the armies that picked it. Armies that did not
pick never receive those zones.

## How it works

### Lobby (client mod, `new_game` scene)

- Adds one entry per spawnable planet (planets with `starting_planet: true`, or
  with custom landing zones) to the existing AI landing dropdown, as
  `planet:<index>` where `<index>` is the planet's position in the system.
  The stock server stores any string the host sets, so AI picks flow through
  stock code.
- Adds the same dropdown to human slots, syncs picks between lobby clients with
  the lobby's `json_message` relay, lets late joiners request the current picks
  from the host, and resets everything when the host loads a different system.
- Shows an orange notice under the landing-zone options when the server mod is
  not active in the lobby.

### Landing phase (client mod, `live_game` scene)

- The host's client sends `spawn_planet_assignments` once the landing phase
  starts: `{ "assignments": { "<playerId>": "planet:N", ... } }` covering humans
  and AIs with a pick.
- Every client reads `spawn_planet_picker` from its landing state and shows the
  banner described above. A stock server never sends that field, which is how
  the client knows the override is not running.

### Server mod

The server's lobby and landing logic is JavaScript under
`media/server-script/`. The server mod ships a patched copy of
`server-script/states/landing.js`. `server/build.js` generates it from the
stock file in your install and fails if any patch anchor no longer matches, so
a game update cannot silently ship stale code.

The patch:

1. Registers a `spawn_planet_assignments` handler (game creator only).
2. Resolves each army's pick, in slot order, from the host's assignments first
   and then from any `planet:N` AI landing policy.
3. Replaces the stock round-robin `assignZones` with a choice-aware version:
   armies that picked a planet take that planet's zones first (sharing if
   short), everyone else gets the remaining zones round-robin as before, and
   no army is ever left without a zone.
4. Generates fallback zones for starting planets the map's rules left empty,
   used only by armies that picked them.
5. On assignment, re-deals (keeping zones for anyone who already landed) and
   re-sends the landing state so clients redraw their green zones. Humans are
   then limited to the chosen planet by the stock `validateSpawnPoint`; AIs
   pick from the filtered list.
6. Includes `spawn_planet_picker` (active flag, designated planet index and
   name, planets the army's zones are on) in each client's landing state.

### How the server mod loads

This is the unusual part, and worth understanding before publishing.

The server loads all of its state scripts the moment `server.exe` starts. The
mods a host uploads to it arrive about a second later. That is fine for unit
JSON, which the simulation reads lazily, but too late for a script override.
Zips mounted at `/server_mods/<id>/` are not layered over the game files
either. The only mount the server's script loader sees at startup is one
layered over the root, and the game passes every zip the client has mounted to
the local server on launch.

So the client mod's `mount_server_mod.js` (run on every scene) mounts the
server mod's zip, which Community Mods stores as
`/download/com.pa.bteam.spawnplanet-server.zip`, at the filesystem root. It:

- only does so when the server mod is enabled in Community Mods, read from the
  mount order the manager publishes at `/server_mods/mods.json`;
- reads the zip's catalog first and refuses to mount unless it contains exactly
  `modinfo.json` and `server-script/states/landing.js`, so the mechanism cannot
  shadow any other game file. `package.js` enforces the same rule when
  building the zip;
- cannot unmount, so disabling the server mod takes effect after a restart.

The long-term fix is upstream: either a landing policy for human players or
server-script overrides mounted before the server's scripts load. The lobby
code already notes that "for now, only AI have landing policy".

## Repository layout

```
client/com.pa.bteam.spawnplanet/            client mod (ships as-is)
server/com.pa.bteam.spawnplanet-server/     server mod; landing.js is GENERATED
server/build.js                             regenerates landing.js from the installed game
server/test_assign.js                       offline tests for the patched zone logic
package.js                                  builds dist/<identifier>.zip for both mods
install-dev.ps1 / uninstall-dev.ps1         local install into PA's mod folders
.github/workflows/release.yml               syntax checks, packaging, releases on v* tags
```

## Developer install

Run from this folder in PowerShell after every edit (requires Node.js and an
installed copy of PA Titans):

```powershell
.\install-dev.ps1
```

It regenerates `landing.js`, packages both zips, copies the client mod to
`%LOCALAPPDATA%\Uber Entertainment\Planetary Annihilation\mods\`, the server
mod to `...\server_mods\`, and the server zip to `...\download\`. Restart PA
afterwards. Then enable both mods under Community Mods, Installed.

`.\uninstall-dev.ps1` removes all three.

If the game is not on the default drive, pass the install folder:

```powershell
.\install-dev.ps1 "D:\SteamLibrary\steamapps\common\Planetary Annihilation Titans"
```

### Tests

```powershell
node .\server\test_assign.js
```

Loads the generated `landing.js` with stubbed server modules and the game's
own lodash build, then exercises zone assignment with mock armies, including
the "map left the picked planet empty" case.

### Verifying on a real server

The local server log (`%LOCALAPPDATA%\Uber Entertainment\Planetary Annihilation\server-<date>.txt`)
should contain `[spawnplanet] landing.js override active` near the top and,
once the landing phase begins, `assignments received`, optional
`generated N fallback zones`, and `zones assigned with picks`. The client log
(`...\log\PA-<date>.txt`) should contain `server mod override mounted`.

## Releasing

1. After a game update, run `node server\build.js` and `node server\test_assign.js`.
   Fix the patch anchors in `build.js` if the build fails.
2. Bump `version` in both `modinfo.json` files, commit, tag `vX.Y.Z`, push the tag.
3. The workflow attaches `dist/com.pa.bteam.spawnplanet.zip` and
   `dist/com.pa.bteam.spawnplanet-server.zip` to a GitHub release.
   `https://github.com/b-nich/pa-spawn-planet/releases/latest/download/<identifier>.zip`
   is a stable link for the Community Mods list.
4. Submit or update the mod list entries through the PA Discord's mod
   submissions channel. The server entry should list the client mod as a
   companion (already declared in its `modinfo.json`).

## License

MIT, see `LICENSE`.
