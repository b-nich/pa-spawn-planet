# Builds the server mod from the stock game file, packages both mods, and copies
# them into PA's local mod folders so they show up under Community Mods >
# Installed. Re-run after every edit (PA's virtual filesystem does not follow
# junctions or symlinks, so real copies are required). Requires Node.js.
$ErrorActionPreference = 'Stop'

$paRoot = Join-Path $env:LOCALAPPDATA 'Uber Entertainment\Planetary Annihilation'

$clientId = 'com.pa.bteam.spawnplanet'
$serverId = 'com.pa.bteam.spawnplanet-server'

$clientSource = Join-Path $PSScriptRoot "client\$clientId"
$serverSource = Join-Path $PSScriptRoot "server\$serverId"
$clientTarget = Join-Path $paRoot "mods\$clientId"
$serverTarget = Join-Path $paRoot "server_mods\$serverId"

# 1. Build the patched landing.js from the installed game, then package.
Write-Host 'Building server mod...'
& node (Join-Path $PSScriptRoot 'server\build.js') @args
if ($LASTEXITCODE -ne 0) { throw "build.js failed with exit code $LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'package.js')
if ($LASTEXITCODE -ne 0) { throw "package.js failed with exit code $LASTEXITCODE" }

function Deploy($source, $target) {
    if (-not (Test-Path $source)) { throw "Mod source not found: $source" }
    $parent = Split-Path $target -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    if (Test-Path $target) {
        $item = Get-Item $target -Force
        if ($item.LinkType) { [System.IO.Directory]::Delete($target) }
    }
    # /MIR mirrors the source, removing files that no longer exist in the project.
    robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE for $target" }
    Write-Host "Copied $source -> $target"
}

Deploy $clientSource $clientTarget
Deploy $serverSource $serverTarget

# 2. The server-script override must be mounted when the local server starts.
#    The client mod mounts this zip (same name and layout Community Mods uses)
#    from the download folder, and the game passes it to server.exe on launch.
$zipSource = Join-Path $PSScriptRoot "dist\$serverId.zip"
$zipTarget = Join-Path $paRoot "download\$serverId.zip"
Copy-Item $zipSource $zipTarget -Force
Write-Host "Copied $zipSource -> $zipTarget"

Write-Host ''
Write-Host "In game: Community Mods > Installed > enable both 'Spawn Planet Picker' and 'Spawn Planet Picker - Server'."
Write-Host 'Restart PA after each re-run so the override zip is re-read.'
exit 0   # robocopy leaves a non-zero "files copied" code in $LASTEXITCODE
