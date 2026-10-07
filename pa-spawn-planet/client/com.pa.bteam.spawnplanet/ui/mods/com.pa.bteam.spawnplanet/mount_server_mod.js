// Spawn Planet Picker - runs on every scene (global_mod_list)
//
// Why this file exists
// --------------------
// The server mod replaces one server-script file (states/landing.js). The
// server loads all of its scripts the moment server.exe starts, before the
// host's mods are uploaded to it, so an override delivered the normal way
// arrives too late. Zips mounted at /server_mods/<id>/ are not layered over
// the game files either. What does work: the game passes every zip the client
// has mounted to the local server on launch, and a zip mounted at "/" sits
// directly over the game's own files. So this script mounts the server mod's
// zip (which Community Mods stores as /download/<identifier>.zip) at the root.
//
// Safeguards
// ----------
// * The zip is only mounted when the server mod is enabled in Community Mods,
//   which is read from the mount order the manager publishes.
// * The zip's catalog is checked first. It may only contain the mod's
//   modinfo.json and the single landing.js override. Anything else and the
//   mount is refused, so this mechanism cannot shadow any other game file.
// * Mounting is additive and lasts until the game is restarted, so disabling
//   the server mod takes effect after a restart.
(function () {
    'use strict';

    var SERVER_MOD_ID = 'com.pa.bteam.spawnplanet-server';
    var ZIP = '/download/' + SERVER_MOD_ID + '.zip';
    var ROOT = '/';
    var MODS_JSON = 'coui://server_mods/mods.json';
    var ALLOWED = ['modinfo.json', 'server-script/states/landing.js'];
    var RETRY_MS = 2000;
    var MAX_RETRIES = 30;   // the manager may still be mounting its zips at boot

    if (!window.api || !api.file || !api.file.zip || !api.file.zip.mount)
        return;

    var log = function (text) { console.log('[spawnplanet] ' + text); };

    // Normalise whatever zip.catalog returns into a list of file paths.
    var catalogPaths = function (catalog) {
        var entries = catalog;
        if (entries && !_.isArray(entries) && _.isArray(entries.files))
            entries = entries.files;
        if (!_.isArray(entries))
            return null;
        var paths = [];
        var ok = true;
        _.forEach(entries, function (entry) {
            var path = _.isString(entry) ? entry : (entry && (entry.path || entry.name || entry.file));
            if (!_.isString(path)) {
                ok = false;
                return false;
            }
            path = path.replace(/^\/+/, '');
            if (path && path.substr(-1) !== '/')
                paths.push(path);
        });
        return ok ? paths : null;
    };

    var mount = function () {
        api.file.zip.catalog(ZIP).then(function (catalog) {
            var paths = catalogPaths(catalog);
            if (paths === null) {
                log('could not interpret zip catalog, mounting anyway: ' + JSON.stringify(catalog).substr(0, 300));
            }
            else {
                var unexpected = _.difference(paths, ALLOWED);
                if (unexpected.length) {
                    log('REFUSING to mount ' + ZIP + ': unexpected entries ' + JSON.stringify(unexpected));
                    return;
                }
                if (!_.contains(paths, 'server-script/states/landing.js')) {
                    log('REFUSING to mount ' + ZIP + ': landing.js override missing');
                    return;
                }
            }
            api.file.zip.mount(ZIP, ROOT, false).then(function (result) {
                log(result ? 'server mod override mounted from ' + ZIP : 'mount of ' + ZIP + ' failed');
            });
        }, function () {
            log('server mod zip not found at ' + ZIP + '; install the server mod from Community Mods');
        });
    };

    var attempt = 0;
    var checkEnabled = function () {
        $.getJSON(MODS_JSON).done(function (data) {
            var order = (data && data.mount_order) || [];
            if (_.contains(order, SERVER_MOD_ID))
                mount();
            else
                log('server mod is not enabled in Community Mods; override not mounted');
        }).fail(function () {
            attempt = attempt + 1;
            if (attempt <= MAX_RETRIES)
                setTimeout(checkEnabled, RETRY_MS);
            else
                log('could not read ' + MODS_JSON + '; override not mounted');
        });
    };

    try {
        checkEnabled();
    }
    catch (e) {
        console.error('[spawnplanet] mount check failed', e);
    }
})();
