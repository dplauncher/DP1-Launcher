Set-Location 'e:\Localization\DP1\Launcher\New'
$output = & 'C:\Program Files\nodejs\node.exe' '.\node_modules\@electron\packager\bin\electron-packager.mjs' `
    . 'DP1 Launcher' `
    --platform=win32 --arch=x64 `
    --out=dist --overwrite `
    '--ignore=^/dist' '--ignore=^/dist2' '--ignore=^/.claude' `
    '--ignore=DPfix.ini' '--ignore=\.bak$' `
    --app-version=2.0.0 --icon=tool.ico `
    '--extra-resource=assets/4gb_patch.exe' `
    '--extra-resource=assets/d9vk.dll' 2>&1
$output | ForEach-Object { Write-Host "  $_" }
Write-Host "Exit code: $LASTEXITCODE"
Write-Host "Dist exists: $(Test-Path 'e:\Localization\DP1\Launcher\New\dist')"
