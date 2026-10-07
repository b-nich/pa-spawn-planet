// Packages both mods into dist/<identifier>.zip, the layout Community Mods
// downloads (modinfo.json at the zip root). Needs only Node, not the game, so
// it also runs in the release workflow.
//
//   node package.js
'use strict';

var fs = require('fs');
var path = require('path');

var MODS = [
    { id: 'com.pa.bteam.spawnplanet', dir: path.join(__dirname, 'client', 'com.pa.bteam.spawnplanet') },
    {
        id: 'com.pa.bteam.spawnplanet-server',
        dir: path.join(__dirname, 'server', 'com.pa.bteam.spawnplanet-server'),
        // The client mod mounts this zip over the game's root, so it must hold
        // nothing but the mod descriptor and the single override file.
        exact: ['modinfo.json', 'server-script/states/landing.js']
    }
];
var DIST = path.join(__dirname, 'dist');

// --- minimal stored-zip writer ---------------------------------------------
var crcTable = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; ++n) {
        var c = n;
        for (var k = 0; k < 8; ++k)
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < buffer.length; ++i)
        crc = crcTable[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function listFiles(dir, prefix) {
    var result = [];
    fs.readdirSync(dir, { withFileTypes: true })
        .sort(function (a, b) { return a.name < b.name ? -1 : 1; })
        .forEach(function (entry) {
            var full = path.join(dir, entry.name);
            var name = prefix + entry.name;
            if (entry.isDirectory())
                result = result.concat(listFiles(full, name + '/'));
            else
                result.push({ name: name, data: fs.readFileSync(full) });
        });
    return result;
}

function buildZip(files) {
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    var dosTime = 0;
    var dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;   // fixed date keeps builds reproducible

    files.forEach(function (file) {
        var name = Buffer.from(file.name, 'utf8');
        var crc = crc32(file.data);

        var local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(file.data.length, 18);
        local.writeUInt32LE(file.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        var central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(file.data.length, 20);
        central.writeUInt32LE(file.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);

        localParts.push(local, name, file.data);
        centralParts.push(central, name);
        offset += local.length + name.length + file.data.length;
    });

    var centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat(localParts.concat(centralParts, [eocd]));
}

// --- package ---------------------------------------------------------------
fs.mkdirSync(DIST, { recursive: true });

MODS.forEach(function (mod) {
    var files = listFiles(mod.dir, '');
    var names = files.map(function (f) { return f.name; });

    var modinfo = JSON.parse(fs.readFileSync(path.join(mod.dir, 'modinfo.json'), 'utf8'));
    if (modinfo.identifier !== mod.id)
        throw new Error(mod.dir + ': modinfo identifier ' + modinfo.identifier + ' does not match ' + mod.id);

    if (mod.exact) {
        var extra = names.filter(function (n) { return mod.exact.indexOf(n) < 0; });
        var missing = mod.exact.filter(function (n) { return names.indexOf(n) < 0; });
        if (extra.length || missing.length)
            throw new Error(mod.id + ' must contain exactly ' + mod.exact.join(', ') +
                (extra.length ? '; unexpected: ' + extra.join(', ') : '') +
                (missing.length ? '; missing: ' + missing.join(', ') : ''));
    }

    var out = path.join(DIST, mod.id + '.zip');
    fs.writeFileSync(out, buildZip(files));
    console.log('Wrote ' + out + ' v' + modinfo.version + ' (' + names.join(', ') + ')');
});
