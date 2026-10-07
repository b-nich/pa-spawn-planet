// Spawn Planet Picker - runs on every scene (global_mod_list)
//
// The server mod overrides a server-script file. The server loads all of its
// scripts the moment server.exe starts, before the host's mods are uploaded to
// it, so an override delivered the normal way arrives too late. Zips mounted at
// /server_mods/<id>/ are not overlaid onto the root either. What does work: the
// game passes every zip the client has mounted to the local server on launch,
// and a zip mounted at "/" sits directly over the game's own files. So mount
// the server mod zip at the filesystem root here, on every scene, before the
// host ever launches a server.
(function () {
    'use strict';

    var ZIP = '/download/com.pa.bteam.spawnplanet-server.zip';
    var ROOT = '/';

    if (!window.api || !api.file || !api.file.zip || !api.file.zip.mount)
        return;

    try {
        api.file.zip.mount(ZIP, ROOT, false).then(function (result) {
            if (result)
                console.log('[spawnplanet] server mod zip mounted at ' + ROOT);
            else
                console.log('[spawnplanet] server mod zip not found at ' + ZIP + ' (run install-dev.ps1)');
        });
    }
    catch (e) {
        console.error('[spawnplanet] failed to mount server mod zip', e);
    }
})();
