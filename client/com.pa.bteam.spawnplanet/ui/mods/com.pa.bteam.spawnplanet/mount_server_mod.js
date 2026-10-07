// Spawn Planet Picker - runs on every scene (global_mod_list)
//
// Why this file exists
// --------------------
// The server mod replaces one server-script file (states/landing.js). The
// server loads all of its scripts the moment server.exe starts, before the
// host's mods are uploaded to it, so an override delivered the normal way
// arrives too late. What does work: the game passes every zip the client has
// mounted to the local server on launch, and a zip mounted at "/" sits
// directly over the game's own files.
//
// One more wrinkle: the game only passes along zips that are NOT mods. A zip
// with modinfo.json at its root (which is what Community Mods downloads) is
// treated as a mod and left out. So this script builds a one-file zip holding
// just the override, from the server mod's own landing.js, saves it to the
// download folder through the same API the mod manager uses for its generated
// zips, and mounts that at "/".
//
// Safeguards
// ----------
// * Runs only when the server mod is enabled in Community Mods, read from
//   the mount order the manager publishes.
// * The generated zip contains exactly one file, so this mechanism cannot
//   shadow anything else.
// * Mounting is additive and lasts until the game is restarted, so disabling
//   the server mod takes effect after a restart.
(function () {
    'use strict';

    var SERVER_MOD_ID = 'com.pa.bteam.spawnplanet-server';
    var SOURCE = 'coui://server_mods/' + SERVER_MOD_ID + '/server-script/states/landing.js';
    var ENTRY = 'server-script/states/landing.js';
    var OVERRIDE_FILE = 'com.pa.bteam.spawnplanet-override.zip';
    var OVERRIDE_PATH = '/download/' + OVERRIDE_FILE;
    var MODS_JSON = 'coui://server_mods/mods.json';
    var RETRY_MS = 2000;
    var MAX_RETRIES = 30;   // the manager may still be mounting its zips at boot
    var STATUS_POLL_MS = 250;
    var STATUS_POLLS = 40;

    if (!window.api || !api.file || !api.file.zip || !api.file.zip.mount || !api.download)
        return;

    // global_mod_list scripts also run in helper panels (icon atlases, chat)
    // that lack jQuery. One mount per scene from the main game page is enough.
    if (!api.Panel || api.Panel.pageName !== 'game' || typeof $ !== 'function' || !$.ajax)
        return;

    var log = function (text) { console.log('[spawnplanet] ' + text); };

    // ------------------------------------------------------------------
    // Minimal stored-zip writer (one entry) and base64
    // ------------------------------------------------------------------
    var crcTable = (function () {
        var table = [];
        for (var n = 0; n < 256; ++n) {
            var c = n;
            for (var k = 0; k < 8; ++k)
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    })();

    var crc32 = function (bytes) {
        var crc = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; ++i)
            crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    };

    var utf8Bytes = function (text) {
        var encoded = unescape(encodeURIComponent(text));
        var bytes = [];
        for (var i = 0; i < encoded.length; ++i)
            bytes.push(encoded.charCodeAt(i) & 0xFF);
        return bytes;
    };

    var le16 = function (out, value) { out.push(value & 0xFF, (value >>> 8) & 0xFF); };
    var le32 = function (out, value) { out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF); };

    var buildZip = function (name, data) {
        var nameBytes = utf8Bytes(name);
        var crc = crc32(data);
        var dosTime = 0;
        var dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
        var out = [];

        // local file header
        le32(out, 0x04034b50); le16(out, 20); le16(out, 0); le16(out, 0);
        le16(out, dosTime); le16(out, dosDate); le32(out, crc);
        le32(out, data.length); le32(out, data.length); le16(out, nameBytes.length); le16(out, 0);
        Array.prototype.push.apply(out, nameBytes);
        Array.prototype.push.apply(out, data);
        var centralOffset = out.length;

        // central directory
        le32(out, 0x02014b50); le16(out, 20); le16(out, 20); le16(out, 0); le16(out, 0);
        le16(out, dosTime); le16(out, dosDate); le32(out, crc);
        le32(out, data.length); le32(out, data.length); le16(out, nameBytes.length);
        le16(out, 0); le16(out, 0); le16(out, 0); le16(out, 0); le32(out, 0); le32(out, 0);
        Array.prototype.push.apply(out, nameBytes);
        var centralSize = out.length - centralOffset;

        // end of central directory
        le32(out, 0x06054b50); le16(out, 0); le16(out, 0); le16(out, 1); le16(out, 1);
        le32(out, centralSize); le32(out, centralOffset); le16(out, 0);
        return out;
    };

    var base64 = function (bytes) {
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var out = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
            var triple = (a << 16) | ((b || 0) << 8) | (c || 0);
            out += alphabet[(triple >>> 18) & 63] + alphabet[(triple >>> 12) & 63] +
                (b === undefined ? '=' : alphabet[(triple >>> 6) & 63]) +
                (c === undefined ? '=' : alphabet[triple & 63]);
        }
        return out;
    };

    // ------------------------------------------------------------------
    // Build, save and mount
    // ------------------------------------------------------------------
    var mount = function () {
        api.file.zip.mount(OVERRIDE_PATH, '/', true).then(function (result) {
            log(result ? 'server override mounted from ' + OVERRIDE_PATH : 'mount of ' + OVERRIDE_PATH + ' failed');
        });
    };

    var waitForDownload = function (attempt) {
        api.download.status(OVERRIDE_FILE).then(function (status) {
            var state = status && status.state;
            if (state === 'complete') {
                mount();
            }
            else if (state === 'failed' || state === 'timeout' || attempt >= STATUS_POLLS) {
                log('saving override zip failed: ' + JSON.stringify(status));
            }
            else {
                setTimeout(function () { waitForDownload(attempt + 1); }, STATUS_POLL_MS);
            }
        }, function () {
            if (attempt < STATUS_POLLS)
                setTimeout(function () { waitForDownload(attempt + 1); }, STATUS_POLL_MS);
            else
                log('could not read override download status');
        });
    };

    var buildAndMount = function () {
        $.ajax({ url: SOURCE, dataType: 'text', cache: false }).done(function (source) {
            if (!source || source.indexOf('[spawnplanet]') < 0) {
                log('server mod landing.js at ' + SOURCE + ' does not look like the override; not mounting');
                return;
            }
            var data = utf8Bytes(source);
            var key = String(crc32(data));
            var previous = null;
            try { previous = sessionStorage.getItem('spawnplanet_override_crc'); } catch (e) { }

            if (previous === key) {
                // Already generated this session; just make sure it is mounted.
                mount();
                return;
            }

            var dataUrl = 'data:application/zip;base64,' + base64(buildZip(ENTRY, data));
            api.download.start(dataUrl, OVERRIDE_FILE, 30).then(function () {
                try { sessionStorage.setItem('spawnplanet_override_crc', key); } catch (e) { }
                log('override zip generated (' + data.length + ' bytes of landing.js), saving to ' + OVERRIDE_PATH);
                waitForDownload(0);
            }, function (error) {
                log('download.start failed: ' + JSON.stringify(error));
            });
        }).fail(function () {
            log('could not read ' + SOURCE + '; is the server mod installed?');
        });
    };

    var attempt = 0;
    var checkEnabled = function () {
        $.getJSON(MODS_JSON).done(function (data) {
            var order = (data && data.mount_order) || [];
            if (order.indexOf(SERVER_MOD_ID) >= 0)
                buildAndMount();
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
