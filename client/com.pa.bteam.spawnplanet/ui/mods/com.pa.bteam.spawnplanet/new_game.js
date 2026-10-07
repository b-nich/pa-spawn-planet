// Spawn Planet Picker - lobby (new_game scene)
//
// Runs after `model = new NewGameViewModel()` and before `ko.applyBindings(model)`
// (see loadSceneMods('new_game') in new_game.js), so we can extend the model and
// patch the slot template before knockout binds it.
//
// How choices travel:
//   AI slots    -> the stock per-slot landing dropdown gains "planet:N" entries.
//                  The stock client sends set_ai_landing_policy and the stock
//                  server stores the string verbatim, so every client sees it in
//                  the players payload and it reaches the landing state as
//                  army.landing_policy.
//   Human slots -> a new dropdown bound to a per-slot observable. Changes are
//                  broadcast to the other lobby clients via json_message
//                  (identifier com.pa.bteam.spawnplanet).
//   Game start  -> the host client persists {playerId: policy} for every slot in
//                  session storage; live_game.js sends it to the server mod as
//                  spawn_planet_assignments when the landing phase begins.
(function () {
    'use strict';

    var MOD_ID = 'com.pa.bteam.spawnplanet';
    var SERVER_MOD_ID = 'com.pa.bteam.spawnplanet-server';
    var PLANET_PREFIX = 'planet:';
    var ANY = 'no_restriction';

    if (!window.model || !model.aiLandingPolicyOptions || !window.handlers) {
        console.error('[spawnplanet] lobby model not available; mod disabled');
        return;
    }

    var log = function () {
        console.log.apply(console, ['[spawnplanet]'].concat(_.toArray(arguments)));
    };

    var isPlanetPolicy = function (value) {
        return _.isString(value) && value.indexOf(PLANET_PREFIX) === 0;
    };

    var planetIndexOf = function (value) {
        return isPlanetPolicy(value) ? Number(value.substr(PLANET_PREFIX.length)) : -1;
    };

    // ------------------------------------------------------------------
    // State handed to live_game.js through session storage
    // ------------------------------------------------------------------
    model.spawnPlanetAssignments = ko.observable({}).extend({ session: 'spawnplanet_assignments' });
    model.spawnPlanetIsHost = ko.observable(false).extend({ session: 'spawnplanet_is_host' });
    model.spawnPlanetAssignments({});
    model.spawnPlanetIsHost(!!model.isGameCreator());
    model.isGameCreator.subscribe(function (value) { model.spawnPlanetIsHost(!!value); });

    // Human choices as seen by this client: playerId -> policy
    var choices = {};
    var hostId = null;
    var syncRequested = false;

    // ------------------------------------------------------------------
    // Planets that can be started on, from the loaded system
    // ------------------------------------------------------------------
    model.spawnPlanetList = ko.computed(function () {
        var system = model.system() || {};
        var result = [];
        _.forEach(system.planets || [], function (planet, index) {
            var spec = planet.planet || planet.generator || {};
            var canSpawn = !!planet.starting_planet || spec.landingZonesPerArmy > 0;
            if (!canSpawn)
                return;
            result.push({
                value: PLANET_PREFIX + index,
                index: index,
                name: planet.name || ('Planet ' + (index + 1))
            });
        });
        return result;
    });

    model.spawnPlanetHumanOptions = ko.computed(function () {
        return [ANY].concat(_.pluck(model.spawnPlanetList(), 'value'));
    });

    var stockOptions = model.aiLandingPolicyOptions().slice();
    var stockDescriptions = _.clone(model.aiLandingPolicyDescriptions());

    model.spawnPlanetDescription = function (value) {
        if (isPlanetPolicy(value)) {
            var planet = _.find(model.spawnPlanetList(), { index: planetIndexOf(value) });
            return planet ? planet.name : loc('!LOC:Unknown planet');
        }
        var text = stockDescriptions[value];
        return text ? loc(text) : String(value || '');
    };

    // The stock AI dropdown uses $root.getAILandingPolicyDescription; swap it so
    // planet entries render with the planet name.
    model.getAILandingPolicyDescription = model.spawnPlanetDescription;

    // Extend the stock AI landing dropdown with one entry per spawnable planet.
    ko.computed(function () {
        var planets = model.spawnPlanetList();
        var descriptions = _.clone(stockDescriptions);
        _.forEach(planets, function (planet) { descriptions[planet.value] = planet.name; });
        model.aiLandingPolicyDescriptions(descriptions);
        model.aiLandingPolicyOptions(stockOptions.concat(_.pluck(planets, 'value')));
    });

    // Never make a planet pick the default for newly added AIs.
    model.previousAILandingPolicy.subscribe(function (value) {
        if (isPlanetPolicy(value))
            model.previousAILandingPolicy(ANY);
    });
    if (isPlanetPolicy(model.previousAILandingPolicy()))
        model.previousAILandingPolicy(ANY);

    // ------------------------------------------------------------------
    // Per-slot observable for human players
    // ------------------------------------------------------------------
    model.spawnPlanetCanEdit = function (slot) {
        if (slot.ai())
            return false;
        if (model.isGameCreator())
            return true;
        return !!slot.containsThisPlayer();
    };

    model.spawnPlanetPolicyFor = function (slot) {
        if (!slot.spawnPlanetPolicy) {
            var lock = false;
            var observable = ko.observable(ANY);
            slot.spawnPlanetPolicy = observable;
            slot.spawnPlanetSet = function (value) {
                lock = true;
                observable(value || ANY);
                lock = false;
            };
            observable.subscribe(function (value) {
                if (lock || slot.ai())
                    return;
                var id = slot.playerId();
                if (!id || !value)
                    return;
                if (!model.spawnPlanetCanEdit(slot))
                    return;
                setChoice(id, value, true);
            });
        }
        return slot.spawnPlanetPolicy;
    };

    var forEachSlot = function (fn) {
        _.forEach(model.armies(), function (army) {
            _.forEach(army.slots(), function (slot) {
                if (!slot.isEmpty() && slot.playerId())
                    fn(slot, army);
            });
        });
    };

    var refreshSlots = function () {
        forEachSlot(function (slot) {
            if (slot.ai())
                return;
            model.spawnPlanetPolicyFor(slot);
            slot.spawnPlanetSet(choices[slot.playerId()] || ANY);
        });
    };

    // Build the full {playerId: policy} map (humans and AIs) and stash it for
    // live_game.js. Only the host's copy is ever sent to the server.
    var persist = function () {
        var assignments = {};
        forEachSlot(function (slot) {
            var id = slot.playerId();
            var policy = slot.ai() ? slot.aiLandingPolicy() : choices[id];
            if (policy && policy !== ANY)
                assignments[id] = policy;
        });
        model.spawnPlanetAssignments(assignments);
    };

    var send = function (payload) {
        payload.identifier = MOD_ID;
        model.sendJsonMessage(payload);
    };

    var setChoice = function (id, value, broadcast) {
        value = value || ANY;
        if (choices[id] === value)
            return;
        choices[id] = value;
        log('choice', id, '->', value);
        refreshSlots();
        persist();
        if (broadcast)
            send({ action: 'set', id: id, policy: value });
    };

    // ------------------------------------------------------------------
    // Lobby messaging between clients that have this mod
    // ------------------------------------------------------------------
    model.registerJsonMessageHandler(MOD_ID, function (msg) {
        var payload = msg && msg.payload;
        if (!payload)
            return;
        var sender = msg.id;

        switch (payload.action) {
            case 'set':
                // Only the player themself or the host may set a slot's planet.
                if (sender !== payload.id && sender !== hostId)
                    return;
                setChoice(payload.id, payload.policy, false);
                break;

            case 'request':
                if (model.isGameCreator())
                    send({ action: 'sync', choices: choices });
                break;

            case 'sync':
                if (sender !== hostId)
                    return;
                choices = _.clone(payload.choices || {});
                refreshSlots();
                persist();
                break;
        }
    });

    var stockPlayersHandler = handlers.players;
    handlers.players = function (payload, force) {
        stockPlayersHandler(payload, force);

        var creator = _.find(payload, function (element) { return element.creator; });
        if (creator)
            hostId = creator.id;

        refreshSlots();
        persist();

        if (!syncRequested && !model.isGameCreator() && hostId) {
            syncRequested = true;
            send({ action: 'request' });
        }
    };

    // ------------------------------------------------------------------
    // Reset picks when the host loads a different system
    // ------------------------------------------------------------------
    var lastSignature = null;
    model.spawnPlanetList.subscribe(function (list) {
        var signature = JSON.stringify(_.pluck(list, 'name'));
        var changed = lastSignature !== null && signature !== lastSignature;
        lastSignature = signature;
        if (!changed)
            return;

        if (model.isGameCreator()) {
            forEachSlot(function (slot) {
                if (slot.ai() && isPlanetPolicy(slot.aiLandingPolicy()))
                    slot.aiLandingPolicy(ANY);
            });
            choices = {};
            refreshSlots();
            persist();
            send({ action: 'sync', choices: choices });
        }
        else {
            refreshSlots();
        }
    });

    // ------------------------------------------------------------------
    // Server mod presence
    // ------------------------------------------------------------------
    model.spawnPlanetServerModMissing = ko.computed(function () {
        var identifiers = model.gameModIdentifiers ? model.gameModIdentifiers() : [];
        return !_.contains(identifiers || [], SERVER_MOD_ID);
    });

    // ------------------------------------------------------------------
    // Template patches (DOM is still unbound at this point)
    // ------------------------------------------------------------------
    var insertHtmlBefore = function (reference, html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        while (tmp.firstChild)
            reference.parentNode.insertBefore(tmp.firstChild, reference);
    };

    var patchSlotTemplate = function () {
        var controls = $('.slot-player').not('.empty').find('.slot-controls').first();
        if (!controls.length) {
            console.error('[spawnplanet] could not find slot controls to patch');
            return;
        }
        var anchor = controls.children('.slot-player-checkmark').first();
        var select = '<select data-bind="options: $root.spawnPlanetHumanOptions, ' +
            'optionsText: $root.spawnPlanetDescription, ' +
            'selectPicker: $root.spawnPlanetPolicyFor(slot)" data-width="139px"></select>';

        var html =
            '<!-- ko ifnot: slot.ai -->' +
            '<!-- ko if: $index() === 0 || !army.sharedArmy() -->' +
            '<!-- ko if: $root.spawnPlanetCanEdit(slot) -->' +
            '<div class="form-control-landing spawn-planet" data-bind="visible: $root.systemHasMultiPlanetSpawns, ' +
            "tooltip: '!LOC:Planet this player will start on'\">" + select + '</div>' +
            '<!-- /ko -->' +
            '<!-- ko ifnot: $root.spawnPlanetCanEdit(slot) -->' +
            '<div class="form-control-landing spawn-planet disabled" data-bind="visible: $root.systemHasMultiPlanetSpawns">' +
            select.replace('<select ', '<select disabled ') + '</div>' +
            '<!-- /ko -->' +
            '<!-- /ko -->' +
            '<!-- /ko -->';

        if (anchor.length)
            insertHtmlBefore(anchor[0], html);
        else
            controls.prepend(html);
    };

    var patchOptionsPanel = function () {
        var shuffle = $('input[data-bind*="shuffleLandingZones"]').closest('.system-options');
        if (!shuffle.length)
            return;
        shuffle.after(
            '<div class="system-options spawnplanet-warning" data-bind="visible: spawnPlanetServerModMissing() && systemHasMultiPlanetSpawns()">' +
            '<loc>Spawn Planet Picker: server mod not active, planet picks will be ignored.</loc>' +
            '</div>');
    };

    patchSlotTemplate();
    patchOptionsPanel();

    log('loaded');
})();
