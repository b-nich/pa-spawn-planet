// Builds the server mod's landing.js by patching the stock file from the PA
// Titans install. Re-run after game updates; every anchor must match or the
// build fails loudly so a changed stock file is noticed instead of silently
// shipping stale code.
//
//   node build.js [path-to-PA-Titans-install]
//   or set PA_TITANS_DIR
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var installDir = process.argv[2] || process.env.PA_TITANS_DIR ||
    'M:\\SteamLibrary\\steamapps\\common\\Planetary Annihilation Titans';
var stockPath = path.join(installDir, 'media', 'server-script', 'states', 'landing.js');
var outPath = path.join(__dirname, 'com.pa.bteam.spawnplanet-server', 'server-script', 'states', 'landing.js');

// md5 of the stock file this patch was written against (build 124683).
var KNOWN_STOCK_MD5 = 'd89b32415e066ce68b84e4fad6c88dd0';

if (!fs.existsSync(stockPath)) {
    console.error('Stock landing.js not found at ' + stockPath);
    console.error('Pass the PA Titans install folder as the first argument or set PA_TITANS_DIR.');
    process.exit(1);
}

var source = fs.readFileSync(stockPath, 'utf8');
var md5 = crypto.createHash('md5').update(source).digest('hex');
if (md5 !== KNOWN_STOCK_MD5)
    console.warn('WARNING: stock landing.js md5 ' + md5 + ' differs from the one this patch was written for (' + KNOWN_STOCK_MD5 + '). Review the output.');

// Normalise line endings so anchors match regardless of CRLF/LF.
var text = source.replace(/\r\n/g, '\n');

function replaceOnce(anchor, replacement, label) {
    var index = text.indexOf(anchor);
    if (index < 0)
        throw new Error('Anchor not found for patch "' + label + '":\n' + anchor);
    if (text.indexOf(anchor, index + 1) >= 0)
        throw new Error('Anchor is not unique for patch "' + label + '":\n' + anchor);
    text = text.slice(0, index) + replacement + text.slice(index + anchor.length);
}

function insertAfter(anchor, addition, label) {
    replaceOnce(anchor, anchor + addition, label);
}

function insertBefore(anchor, addition, label) {
    replaceOnce(anchor, addition + anchor, label);
}

// ---------------------------------------------------------------------------
// Patch 1: module state and helpers
// ---------------------------------------------------------------------------
insertAfter(
    "var FORCE_START_TIMEOUT = 2 * 60 * 1000; /* in ms */\n",
    [
        '',
        '// ---- Spawn Planet Picker (com.pa.bteam.spawnplanet-server) -----------------',
        '// Lets the lobby designate a starting planet per army. Picks arrive two ways:',
        '//   * AI armies: the stock lobby stores whatever landing policy string the host',
        '//     set, so "planet:N" reaches us as slot.landing_policy.',
        '//   * Any army: the host client sends spawn_planet_assignments once the landing',
        '//     phase begins, mapping player/AI client ids to policy strings.',
        "var SPAWN_PLANET_PREFIX = 'planet:';",
        'var spawnPlanetAssignments = {};   // client id -> policy string',
        'var spawnPlanetSlotIds = [];       // armies index -> [client id per slot, in slot order]',
        'var spawnPlanetNames = [];         // planet index -> display name',
        'var allPlanetZones = null;         // pristine copy of the generated zones',
        'var spawnPlanetFallbackZones = {}; // planet index -> zones generated for starting planets the map rules left empty',
        '',
        "console.log('[spawnplanet] landing.js override active');",
        '',
        'function spawnPlanetLog() {',
        "    console.log.apply(console, ['[spawnplanet]'].concat(Array.prototype.slice.call(arguments)));",
        '}',
        '',
        'function spawnPlanetIndex(policy) {',
        '    if (!_.isString(policy) || policy.indexOf(SPAWN_PLANET_PREFIX) !== 0)',
        '        return -1;',
        '    var index = Number(policy.substr(SPAWN_PLANET_PREFIX.length));',
        '    if (!_.isFinite(index))',
        '        return -1;',
        '    var hasZones = _.any(allPlanetZones, function (element) {',
        '        return element && element.planet_index === index && element.positions.length;',
        '    });',
        '    if (!hasZones && spawnPlanetFallbackZones[index] && spawnPlanetFallbackZones[index].positions.length)',
        '        hasZones = true;',
        '    return hasZones ? index : -1;',
        '}',
        '',
        '// armies index -> planet index. The first pick in slot order wins for an army,',
        '// which matches the lobby showing one dropdown for a shared-army team.',
        'function spawnPlanetChoices() {',
        '    var result = {};',
        '    _.forEach(armies, function (army, armyIndex) {',
        '        var ids = spawnPlanetSlotIds[armyIndex] || [];',
        '        var chosen = -1;',
        '        _.forEach(ids, function (id) {',
        '            if (chosen >= 0 || !id)',
        '                return;',
        '            var policy = spawnPlanetAssignments[id];',
        '            if (policy === undefined) {',
        '                var ai = _.find(army.ai, function (slot) { return slot.client && slot.client.id === id; });',
        '                if (ai)',
        '                    policy = ai.landing_policy;',
        '            }',
        '            var index = spawnPlanetIndex(policy);',
        '            if (index >= 0)',
        '                chosen = index;',
        '        });',
        '        if (chosen >= 0)',
        '            result[armyIndex] = chosen;',
        '    });',
        '    return result;',
        '}',
        '',
        'function spawnPlanetMakeZone(position, element) {',
        '    return { position: position, planet_index: element.planet_index, radius: element.radius };',
        '}',
        '',
        '// Sent to each client inside server_state so the UI can show that the',
        '// override is live and which planet the army was designated.',
        'function spawnPlanetClientInfo(army) {',
        '    var choices = spawnPlanetChoices();',
        '    var index = (army && _.has(choices, army.index)) ? choices[army.index] : -1;',
        '    return {',
        '        active: true,',
        '        planet_index: index,',
        "        planet_name: index >= 0 ? (spawnPlanetNames[index] || ('Planet ' + (index + 1))) : null,",
        "        zone_planets: army ? _.uniq(_.pluck(army.zones, 'planet_index')) : []",
        '    };',
        '}',
        '// ---------------------------------------------------------------------------',
        ''
    ].join('\n'),
    'helpers');

// ---------------------------------------------------------------------------
// Patch 2: choice-aware assignZones (replaces the stock round-robin)
// ---------------------------------------------------------------------------
replaceOnce(
    [
        'function assignZones(zones) {',
        '    if (!armies.length)',
        '        return;',
        '',
        '    _.forEach(armies, function (army) {',
        '        army.zones = [];',
        '    });',
        '',
        '    var army_index = 0;',
        '    _.forEach(zones, function (element) {',
        '        var list = element.positions;',
        '        while (list.length) {',
        '            var army = armies[army_index % armies.length];',
        '            army.zones.push({',
        '                position: list.pop(),',
        '                planet_index: element.planet_index,',
        '                radius: element.radius',
        '            });',
        '',
        '            army_index = army_index + 1;',
        '        }',
        '    });',
        '}',
        ''
    ].join('\n'),
    [
        '// Spawn Planet Picker: does not consume `zones`, so it can run again when the',
        '// host sends assignments. Stock behaviour is preserved when nobody picked.',
        'function assignZones(zones) {',
        '    if (!armies.length)',
        '        return;',
        '',
        '    var elements = _.filter(zones, function (element) { return element && element.positions; });',
        '    var pools = _.map(elements, function (element) {',
        '        return { planet_index: element.planet_index, radius: element.radius, positions: element.positions.slice() };',
        '    });',
        '    var choices = spawnPlanetChoices();',
        '',
        '    _.forEach(armies, function (army) {',
        '        army.zones = [];',
        '    });',
        '',
        '    // 1. Armies that picked a planet take that planet\'s zones first.',
        '    var choosersByPlanet = {};',
        '    _.forEach(choices, function (planetIndex, armyIndex) {',
        '        (choosersByPlanet[planetIndex] = choosersByPlanet[planetIndex] || []).push(Number(armyIndex));',
        '    });',
        '    _.forEach(choosersByPlanet, function (choosers, planetIndex) {',
        '        var pool = _.find(pools, { planet_index: Number(planetIndex) });',
        '        if (!pool || !pool.positions.length) {',
        '            // The map rules gave this planet no zones for this army count; use',
        '            // the fallback set. It is deliberately not added to `pools`, so',
        '            // armies that did not pick this planet never land there.',
        '            var fallback = spawnPlanetFallbackZones[planetIndex];',
        '            if (!fallback || !fallback.positions.length)',
        '                return;',
        '            pool = { planet_index: Number(planetIndex), radius: fallback.radius, positions: fallback.positions.slice() };',
        '        }',
        '        var list = pool.positions;',
        '        if (list.length >= choosers.length) {',
        '            var next = 0;',
        '            while (list.length) {',
        '                armies[choosers[next % choosers.length]].zones.push(spawnPlanetMakeZone(list.pop(), pool));',
        '                next = next + 1;',
        '            }',
        '        }',
        '        else {',
        '            // Fewer zones than armies that want this planet: they share them.',
        '            _.forEach(choosers, function (armyIndex) {',
        '                _.forEach(list, function (position) {',
        '                    armies[armyIndex].zones.push(spawnPlanetMakeZone(position, pool));',
        '                });',
        '            });',
        '            list.length = 0;',
        '        }',
        '    });',
        '',
        '    // 2. Everyone else gets the remaining zones round-robin, as stock does.',
        '    var others = _.filter(_.range(armies.length), function (armyIndex) { return !_.has(choices, armyIndex); });',
        '    if (others.length) {',
        '        var army_index = 0;',
        '        _.forEach(pools, function (pool) {',
        '            var list = pool.positions;',
        '            while (list.length) {',
        '                armies[others[army_index % others.length]].zones.push(spawnPlanetMakeZone(list.pop(), pool));',
        '                army_index = army_index + 1;',
        '            }',
        '        });',
        '    }',
        '',
        '    // 3. Never leave an army without somewhere to land.',
        '    _.forEach(armies, function (army) {',
        '        if (army.zones.length)',
        '            return;',
        '        _.forEach(elements, function (element) {',
        '            _.forEach(element.positions, function (position) {',
        '                army.zones.push(spawnPlanetMakeZone(position, element));',
        '            });',
        '        });',
        '    });',
        '',
        '    if (!_.isEmpty(choices))',
        "        spawnPlanetLog('zones assigned with picks ' + JSON.stringify(choices) + ' planets per army ' +",
        "            JSON.stringify(_.map(armies, function (army) { return _.uniq(_.pluck(army.zones, 'planet_index')); })));",
        '}',
        ''
    ].join('\n'),
    'assignZones');

// ---------------------------------------------------------------------------
// Patch 3: remember slot ids per army so picks can be resolved to armies
// ---------------------------------------------------------------------------
insertAfter(
    '    initArmyState(config);\n',
    [
        '',
        '    spawnPlanetSlotIds = _.map(config.armies, function (army) {',
        '        return _.map(army ? army.slots : [], function (slot) {',
        '            return slot && slot.client ? slot.client.id : null;',
        '        });',
        '    });',
        '    spawnPlanetAssignments = {};',
        "    spawnPlanetNames = _.pluck((config.game && config.game.system && config.game.system.planets) || [], 'name');",
        ''
    ].join('\n'),
    'slot ids');

// ---------------------------------------------------------------------------
// Patch 3b: tell each client whether the override is live and its planet
// ---------------------------------------------------------------------------
replaceOnce(
    [
        '    if (!player) { //if there is no player you are a spectator',
        '        return {',
        '            vision_bits: sim.armies.getVisionBits(client),',
        '            game_options: game_options',
        '        };',
        '    }',
        '    var army = player.army;',
        '    return {',
        '        army_id: army.desc.id,',
        '        vision_bits: sim.armies.getVisionBits(client),',
        '        zones: army.zones,',
        '        landing_position: player.spawn,',
        '        game_options: game_options',
        '    };'
    ].join('\n'),
    [
        '    if (!player) { //if there is no player you are a spectator',
        '        return {',
        '            vision_bits: sim.armies.getVisionBits(client),',
        '            game_options: game_options,',
        '            spawn_planet_picker: spawnPlanetClientInfo(null)',
        '        };',
        '    }',
        '    var army = player.army;',
        '    return {',
        '        army_id: army.desc.id,',
        '        vision_bits: sim.armies.getVisionBits(client),',
        '        zones: army.zones,',
        '        landing_position: player.spawn,',
        '        game_options: game_options,',
        '        spawn_planet_picker: spawnPlanetClientInfo(army)',
        '    };'
    ].join('\n'),
    'client info');

// ---------------------------------------------------------------------------
// Patch 4: keep a pristine copy of the zones before assigning
// ---------------------------------------------------------------------------
replaceOnce(
    '    assignZones(planet_zones);\n',
    [
        '    allPlanetZones = _.cloneDeep(_.filter(planet_zones, Boolean));',
        '',
        '    // Spawn Planet Picker: a starting planet whose custom landing-zone rules',
        '    // exclude this army count ends up with no zones, so nobody could pick it.',
        '    // Generate a random fallback set for each such planet, exactly as the stock',
        '    // "not enough zones" path does, and keep it aside for armies that pick it.',
        '    spawnPlanetFallbackZones = {};',
        '    _.forEach(sim.planets, function (planet, index) {',
        '        var planetConfig = config.game.system.planets[index];',
        '        if (!planetConfig || !planetConfig.starting_planet || !planetConfig.generator)',
        '            return;',
        '        var existing = _.find(allPlanetZones, { planet_index: index });',
        '        if (existing && existing.positions.length)',
        '            return;',
        '        var planetRadius = planetConfig.generator.radius;',
        '        var fallbackZonesPerArmy = planetConfig.generator.landingZonesPerArmy > 0',
        '            ? planetConfig.generator.landingZonesPerArmy',
        '            : Math.min(Math.ceil(planetRadius / 300), 4);',
        '        var fallbackZoneRadius = planetConfig.generator.landingZoneSize > 0',
        '            ? planetConfig.generator.landingZoneSize',
        '            : planetRadius / 5;',
        '        try {',
        '            var generated = planet.genMetalAndLandingSpots(fallbackZonesPerArmy, fallbackZoneRadius, planetRadius * 0.2, sim.armies.length, true);',
        '            if (generated && generated.positions && generated.positions.length) {',
        '                generated.planet_index = index;',
        '                spawnPlanetFallbackZones[index] = generated;',
        "                spawnPlanetLog('generated ' + generated.positions.length + ' fallback zones on planet ' + index + ' (' + (spawnPlanetNames[index] || '?') + ')');",
        '            }',
        '        }',
        '        catch (e) {',
        "            spawnPlanetLog('fallback zone generation failed for planet ' + index + ': ' + e);",
        '        }',
        '    });',
        '',
        '    assignZones(allPlanetZones);',
        ''
    ].join('\n'),
    'pristine zones');

// ---------------------------------------------------------------------------
// Patch 5: host message handler and re-broadcast
// ---------------------------------------------------------------------------
insertBefore(
    'function playerMsg_surrender(msg) {\n',
    [
        '// Spawn Planet Picker: mirror main.setState\'s per-client server_state send so',
        '// every client redraws its green zones after a reassignment.',
        'function spawnPlanetBroadcastState() {',
        "    var message = { message_type: 'server_state', payload: exports.hello_response };",
        '    if (!message.payload.data)',
        '        message.payload.data = {};',
        '    _.forEach(server.clients, function (client) {',
        '        if (!client.connected)',
        '            return;',
        '        message.payload.data.client = exports.getClientState(client);',
        '        client.message(message);',
        '    });',
        '    delete message.payload.data.client;',
        '}',
        '',
        'function spawnPlanetReassign() {',
        '    if (!allPlanetZones)',
        '        return false;',
        '    // Armies that already landed keep the zones they were validated against.',
        '    var landed = {};',
        '    _.forEach(players, function (player) {',
        '        if (player.spawn && player.army)',
        '            landed[player.army.index] = player.army.zones;',
        '    });',
        '    assignZones(allPlanetZones);',
        '    _.forEach(landed, function (zones, armyIndex) {',
        '        if (armies[armyIndex])',
        '            armies[armyIndex].zones = zones;',
        '    });',
        '    spawnPlanetBroadcastState();',
        '    return true;',
        '}',
        '',
        'function playerMsg_spawnPlanetAssignments(msg) {',
        '    var response = server.respond(msg);',
        '    var player = players[msg.client.id];',
        '    if (!player || !player.creator)',
        '        return response.fail("Only the host can assign spawn planets");',
        '    if (!msg.payload || !_.isObject(msg.payload.assignments))',
        '        return response.fail("Invalid payload");',
        '',
        '    spawnPlanetAssignments = _.clone(msg.payload.assignments);',
        "    spawnPlanetLog('assignments received ' + JSON.stringify(spawnPlanetAssignments));",
        '',
        '    if (!spawnPlanetReassign())',
        '        return response.fail("Landing zones not ready");',
        '',
        '    response.succeed({',
        "        planets_per_army: _.map(armies, function (army) { return _.uniq(_.pluck(army.zones, 'planet_index')); })",
        '    });',
        '}',
        '',
        ''
    ].join('\n'),
    'handler');

// ---------------------------------------------------------------------------
// Patch 6: register the handler for the landing state
// ---------------------------------------------------------------------------
replaceOnce(
    [
        '    var transientHandlers = {',
        '        landing_location_selected: playerMsg_landingLocationSelected,',
        '        surrender: playerMsg_surrender',
        '    };'
    ].join('\n'),
    [
        '    var transientHandlers = {',
        '        landing_location_selected: playerMsg_landingLocationSelected,',
        '        spawn_planet_assignments: playerMsg_spawnPlanetAssignments,',
        '        surrender: playerMsg_surrender',
        '    };'
    ].join('\n'),
    'handler registration');

var header = [
    '// GENERATED by pa-spawn-planet/server/build.js. Do not edit by hand.',
    '// Stock source: media/server-script/states/landing.js (md5 ' + md5 + ')',
    '// Search for "Spawn Planet Picker" to find the patched regions.',
    ''
].join('\n');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header + text);
console.log('Wrote ' + outPath);

// Packaging into dist/<identifier>.zip is done by ../package.js, which needs
// only Node and therefore also runs in the release workflow.
