$ErrorActionPreference = 'Stop'
$paRoot = Join-Path $env:LOCALAPPDATA 'Uber Entertainment\Planetary Annihilation'
$targets = @(
    (Join-Path $paRoot 'mods\com.pa.bteam.spawnplanet'),
    (Join-Path $paRoot 'server_mods\com.pa.bteam.spawnplanet-server'),
    (Join-Path $paRoot 'download\com.pa.bteam.spawnplanet-server.zip'),
    (Join-Path $paRoot 'download\com.pa.bteam.spawnplanet-override.zip'),
    (Join-Path $paRoot 'download\com.pa.bteam.spawnplanet-override.zip.dlmeta')
)
foreach ($target in $targets) {
    if (Test-Path $target) {
        $item = Get-Item $target -Force
        if ($item.LinkType) {
            [System.IO.Directory]::Delete($target)
        } else {
            Remove-Item $target -Recurse -Force
        }
        Write-Host "Removed $target"
    } else {
        Write-Host "Nothing to remove at $target"
    }
}
