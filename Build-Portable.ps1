$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
if ((& $node -p "process.arch === 'x64' && parseInt(process.versions.node) >= 22") -ne 'true') {
    throw 'Build requires Node.js 22+ for Windows x64.'
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ('SelectReader-' + [guid]::NewGuid())
$app = Join-Path $stage 'SelectReader'
$dist = Join-Path $PSScriptRoot 'dist'
try {
    $runtime = New-Item -ItemType Directory -Path (Join-Path $app 'runtime') -Force
    Copy-Item -LiteralPath $node,(Join-Path (Split-Path $node) 'LICENSE') -Destination $runtime.FullName
    $modules = 'server','reader','direct-broker','direct-models','native-auth','native-content','native-text',
        'model-export','export-folder','export-markdown','uml-data','windows-smb'
    foreach ($module in $modules) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "$module.mjs") -Destination $app
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Destination $app
    $web = New-Item -ItemType Directory -Path (Join-Path $app 'web')
    foreach ($asset in 'index.html','app.mjs','diagram.mjs','style.css','uml.mjs') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "web\$asset") -Destination $web.FullName
    }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:winexe /platform:x64 /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32icon:$PSScriptRoot\SelectReader.ico" "/out:$app\SelectReader.exe" "$PSScriptRoot\ReaderTray.cs"
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
    Compress-Archive -LiteralPath $app -DestinationPath "$stage\SelectReader-win-x64.zip"
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    Move-Item -LiteralPath "$stage\SelectReader-win-x64.zip" -Destination "$dist\SelectReader-win-x64.zip" -Force
    Write-Output "$dist\SelectReader-win-x64.zip"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
