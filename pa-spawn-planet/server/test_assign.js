// Offline test for the patched assignZones / spawnPlanetChoices logic.
// Loads the generated landing.js with stubbed server modules and the game's own
// lodash build, then exercises the zone assignment with mock armies.
//
//   node test_assign.js [path-to-PA-Titans-install]
'use strict';

var fs = require('fs');
var path = require('path');
var assert = require('assert');

var installDir = process.argv[2] || process.env.PA_TITANS_DIR ||
    'M:\\SteamLibrary\\steamapps\\common\\Planetary Annihilation Titans';
var lodashPath = path.join(installDir, 'media', 'server-script', 'thirdparty', 'lodash.js');
var landingPath = path.join(__dirname, 'com.pa.bteam.spawnplanet-server', 'server-script', 'states', 'landing.js');

var lodash = require(lodashPath);

var stubs = {
    'console': console,
    'main': { setState: function () {}, states: {}, spectators: 0 },
    'server': { clients: [], broadcast: function () {}, respond: function () { return { succeed: function () {}, fail: function () {} }; } },
    'sim': { armies: { getVisionBits: function () { return 0; } }, players: [], planets: [] },
    'utils': { pushCallback: function () {} },
    'thirdparty/lodash': lodash,
    'vec': {},
    'chat_utils': { getChatHandlers: function () { return {}; } },
    'states/playing_shared': { import: function () { return {}; } }
};

var text = fs.readFileSync(landingPath, 'utf8');
// Expose module-scoped functions and let the test set module-scoped state.
text += '\nmodule.exports.__test = {' +
    ' assignZones: assignZones, spawnPlanetChoices: spawnPlanetChoices,' +
    ' set: function (name, value) { eval(name + " = value"); },' +
    ' get: function (name) { return eval(name); } };\n';

var sandboxModule = { exports: {} };
var quietConsole = { log: function () {}, error: console.error, warn: console.warn };
new Function('require', 'module', 'exports', 'console', text)(
    function (name) {
        if (!stubs.hasOwnProperty(name)) throw new Error('unexpected require: ' + name);
        return stubs[name];
    },
    sandboxModule, sandboxModule.exports, quietConsole);

var t = sandboxModule.exports.__test;

function makeArmy(index, aiSlots) {
    return { index: index, zones: [], ai: aiSlots || [], desc: { slots: [] } };
}
function zonesFor(planetIndex, count) {
    var positions = [];
    for (var i = 0; i < count; ++i) positions.push([planetIndex * 1000 + i, 0, 0]);
    return { planet_index: planetIndex, radius: 100, positions: positions };
}
function planetsOf(army) { return lodash.uniq(lodash.pluck(army.zones, 'planet_index')).sort(); }

function setup(armies, slotIds, assignments, zones, fallback) {
    t.set('armies', armies);
    t.set('players', {});
    t.set('spawnPlanetSlotIds', slotIds);
    t.set('spawnPlanetAssignments', assignments || {});
    t.set('allPlanetZones', lodash.cloneDeep(zones));
    t.set('spawnPlanetFallbackZones', lodash.cloneDeep(fallback || {}));
}

// 1. Nobody picked: stock round-robin, every army gets zones on every planet.
(function () {
    var armies = [makeArmy(0), makeArmy(1), makeArmy(2)];
    var zones = [zonesFor(0, 6), zonesFor(1, 6)];
    setup(armies, [['h0'], ['h1'], ['h2']], {}, zones);
    t.assignZones(t.get('allPlanetZones'));
    armies.forEach(function (army) {
        assert.deepStrictEqual(planetsOf(army), [0, 1]);
        assert.strictEqual(army.zones.length, 4);
    });
    // Input must not be consumed so we can run again.
    assert.strictEqual(t.get('allPlanetZones')[0].positions.length, 6);
    console.log('ok  no picks -> stock distribution');
})();

// 2. Human pick via host assignments, AI pick via native landing_policy.
(function () {
    var ai = { ai: true, client: { id: 'ai0' }, landing_policy: 'planet:0' };
    var armies = [makeArmy(0, [ai]), makeArmy(1), makeArmy(2)];
    var zones = [zonesFor(0, 6), zonesFor(1, 6)];
    setup(armies, [['ai0'], ['h1'], ['h2']], { h1: 'planet:1' }, zones);
    assert.deepStrictEqual(t.spawnPlanetChoices(), { 0: 0, 1: 1 });
    t.assignZones(t.get('allPlanetZones'));
    assert.deepStrictEqual(planetsOf(armies[0]), [0]);
    assert.deepStrictEqual(planetsOf(armies[1]), [1]);
    assert.strictEqual(armies[0].zones.length, 6, 'sole chooser of planet 0 gets all its zones');
    assert.strictEqual(armies[1].zones.length, 6);
    assert.strictEqual(armies[2].zones.length, 12, 'non-chooser falls back to every zone when pools are empty');
    console.log('ok  human + AI picks -> restricted to chosen planets');
})();

// 3. Two armies pick a planet with a single zone: they share it.
(function () {
    var armies = [makeArmy(0), makeArmy(1), makeArmy(2)];
    var zones = [zonesFor(0, 1), zonesFor(1, 4)];
    setup(armies, [['h0'], ['h1'], ['h2']], { h0: 'planet:0', h1: 'planet:0' }, zones);
    t.assignZones(t.get('allPlanetZones'));
    assert.deepStrictEqual(planetsOf(armies[0]), [0]);
    assert.deepStrictEqual(planetsOf(armies[1]), [0]);
    assert.strictEqual(armies[0].zones.length, 1);
    assert.strictEqual(armies[1].zones.length, 1);
    assert.deepStrictEqual(planetsOf(armies[2]), [1]);
    assert.strictEqual(armies[2].zones.length, 4);
    console.log('ok  shared single zone');
})();

// 4. Picks for planets without zones are ignored; assignments beat AI policy.
(function () {
    var ai = { ai: true, client: { id: 'ai0' }, landing_policy: 'planet:1' };
    var armies = [makeArmy(0, [ai]), makeArmy(1)];
    var zones = [zonesFor(0, 4), zonesFor(1, 4)];
    setup(armies, [['ai0'], ['h1']], { ai0: 'planet:0', h1: 'planet:7' }, zones);
    assert.deepStrictEqual(t.spawnPlanetChoices(), { 0: 0 });
    t.assignZones(t.get('allPlanetZones'));
    assert.deepStrictEqual(planetsOf(armies[0]), [0]);
    assert.deepStrictEqual(planetsOf(armies[1]), [1], 'unpicked army gets what is left');
    console.log('ok  invalid pick ignored, host assignment overrides AI policy');
})();

// 5. Shared-army team: first slot's pick wins.
(function () {
    var armies = [makeArmy(0), makeArmy(1)];
    var zones = [zonesFor(0, 4), zonesFor(1, 4)];
    setup(armies, [['h0', 'h1'], ['h2']], { h0: 'planet:1', h1: 'planet:0' }, zones);
    assert.deepStrictEqual(t.spawnPlanetChoices(), { 0: 1 });
    console.log('ok  shared army uses first slot pick');
})();

// 6. Per-client info reports the designated planet by name.
(function () {
    var armies = [makeArmy(0), makeArmy(1)];
    var zones = [zonesFor(0, 4), zonesFor(1, 4)];
    setup(armies, [['h0'], ['h1']], { h0: 'planet:1' }, zones);
    t.set('spawnPlanetNames', ['Hope', 'Id']);
    t.set('players', { h0: { army: armies[0], client: { id: 'h0' } } });
    t.assignZones(t.get('allPlanetZones'));
    var state = sandboxModule.exports.getClientState({ id: 'h0' });
    assert.strictEqual(state.spawn_planet_picker.active, true);
    assert.strictEqual(state.spawn_planet_picker.planet_index, 1);
    assert.strictEqual(state.spawn_planet_picker.planet_name, 'Id');
    assert.deepStrictEqual(state.spawn_planet_picker.zone_planets, [1]);
    var spectator = sandboxModule.exports.getClientState({ id: 'nobody' });
    assert.strictEqual(spectator.spawn_planet_picker.active, true);
    assert.strictEqual(spectator.spawn_planet_picker.planet_index, -1);
    console.log('ok  client info carries designated planet name');
})();

// 7. The two-player Marshall's Artifice case: the map rules left only planet 1
//    with zones for this army count. Picks for planets 3 and 4 must use the
//    fallback sets, and armies that did not pick must never land on them.
(function () {
    var ais = [1, 2, 3, 4].map(function (n) { return { ai: true, client: { id: String(n) }, landing_policy: 'planet:3' }; });
    var armies = [makeArmy(0), makeArmy(1), makeArmy(2, [ais[0]]), makeArmy(3, [ais[1]]), makeArmy(4, [ais[2]]), makeArmy(5, [ais[3]])];
    var zones = [zonesFor(1, 12)];
    var fallback = { 3: zonesFor(3, 8), 4: zonesFor(4, 2) };
    setup(armies, [['Dudedwag'], ['CyberSol'], ['1'], ['2'], ['3'], ['4']],
        { Dudedwag: 'planet:4', CyberSol: 'planet:1', 1: 'planet:3', 2: 'planet:3', 3: 'planet:3', 4: 'planet:3' },
        zones, fallback);
    assert.deepStrictEqual(t.spawnPlanetChoices(), { 0: 4, 1: 1, 2: 3, 3: 3, 4: 3, 5: 3 });
    t.assignZones(t.get('allPlanetZones'));
    assert.deepStrictEqual(planetsOf(armies[0]), [4], 'host lands on Id via fallback zones');
    assert.strictEqual(armies[0].zones.length, 2);
    assert.deepStrictEqual(planetsOf(armies[1]), [1]);
    assert.strictEqual(armies[1].zones.length, 12, 'sole picker of planet 1 gets all of its zones');
    [2, 3, 4, 5].forEach(function (i) {
        assert.deepStrictEqual(planetsOf(armies[i]), [3]);
        assert.strictEqual(armies[i].zones.length, 2, 'four AIs share 8 fallback zones');
    });
    console.log('ok  picks for planets the map left empty use fallback zones');
})();

// 8. Fallback zones are never handed to armies that did not pick that planet.
(function () {
    var armies = [makeArmy(0), makeArmy(1)];
    setup(armies, [['h0'], ['h1']], { h0: 'planet:2' }, [zonesFor(0, 4)], { 2: zonesFor(2, 4) });
    t.assignZones(t.get('allPlanetZones'));
    assert.deepStrictEqual(planetsOf(armies[0]), [2]);
    assert.deepStrictEqual(planetsOf(armies[1]), [0], 'non-picker stays on the stock zones');
    console.log('ok  fallback zones stay exclusive to pickers');
})();

console.log('all assignment tests passed');
