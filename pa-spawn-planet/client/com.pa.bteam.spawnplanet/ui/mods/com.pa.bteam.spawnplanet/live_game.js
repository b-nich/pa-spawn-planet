// Spawn Planet Picker - landing phase (live_game scene)
//
// Two jobs:
//   1. Host only: send the lobby's picks to the server once the landing phase
//      begins. The server mod answers by re-dealing landing zones.
//   2. Everyone: show a banner during landing that says whether the server
//      override is live and which planet this army was designated. The server
//      mod puts that in server_state.data.client.spawn_planet_picker; a stock
//      server omits the field.
//
// Runs after `model = new LiveGameViewModel()` and before ko.applyBindings.
(function () {
    'use strict';

    if (!window.model || !model.mode || !window.handlers) {
        console.error('[spawnplanet] live game model not available; mod disabled');
        return;
    }

    var assignments = ko.observable({}).extend({ session: 'spawnplanet_assignments' });
    var isHost = ko.observable(false).extend({ session: 'spawnplanet_is_host' });

    // ------------------------------------------------------------------
    // 1. Send picks (host)
    // ------------------------------------------------------------------
    var sent = false;
    var maybeSend = function (mode) {
        if (sent || mode !== 'landing' || !isHost())
            return;
        var map = assignments() || {};
        if (_.isEmpty(map))
            return;
        sent = true;
        console.log('[spawnplanet] sending assignments ' + JSON.stringify(map));
        model.send_message('spawn_planet_assignments', { assignments: map }, function (success, response) {
            console.log('[spawnplanet] server replied ' + success + ' ' + JSON.stringify(response));
            if (!success)
                model.spawnPlanetInfo({ active: false, rejected: true });
        });
    };
    model.mode.subscribe(maybeSend);
    maybeSend(model.mode());

    // ------------------------------------------------------------------
    // 2. Banner
    // ------------------------------------------------------------------
    // null = nothing heard yet; { active: false } = stock server; otherwise the
    // server mod's info object.
    model.spawnPlanetInfo = ko.observable(null);

    model.spawnPlanetBannerVisible = ko.computed(function () {
        if (model.mode() !== 'landing')
            return false;
        if (model.isSpectator && model.isSpectator())
            return false;
        var info = model.spawnPlanetInfo();
        if (!info)
            return false;
        // On a stock server only nag when someone actually picked something.
        if (!info.active && _.isEmpty(assignments()))
            return false;
        return true;
    });

    model.spawnPlanetBannerActive = ko.computed(function () {
        var info = model.spawnPlanetInfo();
        return !!(info && info.active);
    });

    model.spawnPlanetBannerText = ko.computed(function () {
        var info = model.spawnPlanetInfo();
        if (!info)
            return '';
        if (!info.active) {
            return info.rejected
                ? loc('!LOC:Spawn Planet Picker: the server rejected the planet picks.')
                : loc('!LOC:Spawn Planet Picker: server override is NOT active. Planet picks are ignored.');
        }
        if (info.planet_index >= 0 && info.planet_name)
            return loc('!LOC:Spawn Planet Picker active. Your designated starting planet: ') + info.planet_name;
        return loc('!LOC:Spawn Planet Picker active. No planet designated for your army, all landing zones available.');
    });

    var stockServerState = handlers.server_state;
    handlers.server_state = function (msg) {
        stockServerState(msg);
        if (!msg || msg.state !== 'landing' || !msg.data)
            return;
        var client = msg.data.client || {};
        if (client.spawn_planet_picker) {
            model.spawnPlanetInfo(client.spawn_planet_picker);
            // One string: the game log drops extra console.log arguments.
            console.log('[spawnplanet] server override active, designated planet ' +
                client.spawn_planet_picker.planet_index + ' (' + client.spawn_planet_picker.planet_name + '), zones on planets ' +
                JSON.stringify(client.spawn_planet_picker.zone_planets));
        }
        else if (!model.spawnPlanetInfo()) {
            model.spawnPlanetInfo({ active: false });
            console.log('[spawnplanet] server_state carried no spawn planet info; server override inactive');
        }
    };

    var banner = document.createElement('div');
    banner.className = 'spawnplanet-banner';
    banner.setAttribute('data-bind',
        'visible: spawnPlanetBannerVisible, css: { active: spawnPlanetBannerActive(), inactive: !spawnPlanetBannerActive() }');
    banner.innerHTML = '<span class="spawnplanet-banner-text" data-bind="text: spawnPlanetBannerText"></span>';
    document.body.appendChild(banner);
})();
