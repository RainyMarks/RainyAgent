# Fixed-artifact smoke on an ephemeral hosted VM; no source build or optional tool download.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -ne 'RainyMarks/RainyAgent' -or -not $env:RUNNER_TEMP) {
    throw 'This script requires the fixed RainyAgent GitHub-hosted Windows job.'
}
$expected = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'artifact.json') | ConvertFrom-Json
$testRoot = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'rainy-1.0.2-installer-smoke'))
if (Test-Path -LiteralPath $testRoot) { throw 'The installation smoke requires a fresh run directory.' }
$media = Join-Path $testRoot 'media'
$install = Join-Path $testRoot 'Core App'
$data = Join-Path $testRoot 'isolated-user-data'
$evidence = Join-Path $testRoot 'evidence'
foreach ($directory in @($media, $data, $evidence)) { New-Item -ItemType Directory -Path $directory | Out-Null }
$setup = Join-Path $media $expected.installer.file
$app = Join-Path $install 'RainyAgent.exe'
$uninstaller = Join-Path $install 'Uninstall RainyAgent.exe'
$defaultData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'RainyAgent'
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'RainyAgent.lnk'
$programsLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'RainyAgent.lnk'
$shortcuts = @($desktopLink, $programsLink)
$sentinelText = 'Keep this user-owned fixture after uninstall.'
$sentinels = @((Join-Path $defaultData 'ci-user-sentinel.txt'), (Join-Path $data 'ci-user-sentinel.txt'), (Join-Path $install 'tools\ci-user-sentinel.txt'))
$report = [ordered]@{ schemaVersion = 1; version = $expected.version; sourceCommit = $expected.sourceCommit; installerSha256 = $expected.installer.sha256; passed = $false; checks = @(); cleanup = [ordered]@{} }
$applicationProcess = $null
$installerProcess = $null
$driverProcess = $null
$uninstallAttempted = $false
$registryPath = $null
$installationRegistryPath = $null

function Get-RainyEntries {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path -LiteralPath $root) {
            Get-ChildItem -LiteralPath $root | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -match '^RainyAgent(?: [0-9]|$)' }
        }
    }
}
function Wait-Condition([scriptblock] $Read, [string] $Message, [int] $Seconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Read) { return }
        Start-Sleep -Milliseconds 200
    }
    throw $Message
}
function Wait-OwnProcess($Process, [string] $Label, [int] $Seconds) {
    if (-not $Process.WaitForExit($Seconds * 1000)) {
        & taskkill.exe /PID $Process.Id /T /F | Out-Null
        $Process.WaitForExit()
        throw "$Label timed out; its owned process tree was stopped."
    }
    if ($Process.ExitCode -ne 0) { throw "$Label failed with exit code $($Process.ExitCode)." }
}
function Invoke-CoreUninstall {
    $copy = Join-Path $testRoot 'uninstall-copy.exe'
    Copy-Item -LiteralPath $uninstaller -Destination $copy -Force
    $process = Start-Process -FilePath $copy -ArgumentList ('/S /currentuser _?=' + $install) -WindowStyle Hidden -PassThru
    Wait-OwnProcess $process 'NSIS uninstall' 180
    Wait-Condition { -not (Test-Path -LiteralPath $app) -and -not (Test-Path -LiteralPath (Join-Path $install 'resources\app.asar')) } 'Core application files remain after uninstall.'
}

try {
    if (@(Get-RainyEntries).Count -or (Test-Path -LiteralPath $defaultData) -or @($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count -or (Get-Process -Name RainyAgent -ErrorAction SilentlyContinue)) {
        throw 'The hosted VM already contains RainyAgent state; refusing to replace it.'
    }
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($testRoot).TrimEnd(':\'))
    if ($drive.Free -lt 8GB) { throw 'The hosted temporary drive needs at least 8 GiB free for core extraction.' }
    $releaseJson = & gh release view $expected.tag --repo $expected.repository --json tagName,isDraft,targetCommitish
    if ($LASTEXITCODE -ne 0) { throw 'The fixed draft release could not be read with this job token.' }
    $release = $releaseJson | ConvertFrom-Json
    if ($release.tagName -ne $expected.tag -or -not $release.isDraft) { throw 'The expected release is not the fixed draft.' }
    & gh release download $expected.tag --repo $expected.repository --pattern $expected.installer.file --dir $media
    if ($LASTEXITCODE -ne 0) { throw 'The fixed draft installer could not be downloaded.' }
    if ((Get-Item -LiteralPath $setup).Length -ne $expected.installer.bytes -or (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLowerInvariant() -ne $expected.installer.sha256) {
        throw 'Downloaded installer size or SHA256 differs from the fixed artifact.'
    }
    if (@(Get-ChildItem -LiteralPath $media -File).Count -ne 1) { throw 'Core-only media must contain exactly the fixed NSIS executable.' }
    $report.checks += 'The fixed draft NSIS bytes and SHA256 match; no optional tool volumes were downloaded.'
    Get-ChildItem Env: | Where-Object { $_.Name -match 'KEY|SECRET|TOKEN|PASSWORD' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
    $installerProcess = Start-Process -FilePath $setup -ArgumentList ('/S /currentuser /D=' + $install) -WindowStyle Hidden -PassThru
    Wait-OwnProcess $installerProcess 'NSIS installation' 600
    if (-not (Test-Path -LiteralPath $app) -or -not (Test-Path -LiteralPath $uninstaller)) { throw 'Core installation did not produce the application and uninstaller.' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $install 'resources\app.asar')).Hash.ToLowerInvariant() -ne $expected.appAsarSha256) { throw 'Installed app.asar differs from the final artifact.' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $install 'resources\release-manifest.signed.json')).Hash.ToLowerInvariant() -ne $expected.resourceManifestSha256) { throw 'Installed signed resources differ from the final artifact.' }
    $entries = @(Get-RainyEntries)
    if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $expected.version) { throw 'NSIS registration does not match the isolated 1.0.2 installation.' }
    $registryPath = $entries[0].PSPath
    $appGuid = [Guid]::Empty
    if (-not [Guid]::TryParse($entries[0].PSChildName, [ref]$appGuid)) { throw 'The fixed NSIS uninstall entry does not contain its application GUID.' }
    $installationRegistryPath = Join-Path 'HKCU:\Software' $entries[0].PSChildName
    $installationEntry = Get-ItemProperty -LiteralPath $installationRegistryPath
    if ([IO.Path]::GetFullPath($installationEntry.InstallLocation).TrimEnd('\') -ne $install) { throw 'The NSIS installation key does not point to the owned install directory.' }
    if ($entries[0].UninstallString -ne ('"' + $uninstaller + '" /currentuser') -or $entries[0].QuietUninstallString -ne ('"' + $uninstaller + '" /currentuser /S')) { throw 'The registered uninstaller does not point to the owned executable.' }
    $shortcutShell = New-Object -ComObject WScript.Shell
    try {
        foreach ($link in $shortcuts) {
            if (-not (Test-Path -LiteralPath $link)) { throw 'A configured desktop or Start Menu shortcut was not created.' }
            $shortcut = $shortcutShell.CreateShortcut($link)
            try {
                if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ne $app -or $shortcut.Arguments -ne '') { throw 'A shortcut does not target the owned application without extra arguments.' }
            } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
        }
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutShell) | Out-Null }
    if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $app }) { throw 'Silent installation unexpectedly started the main application.' }
    $report.checks += 'Silent NSIS installation created the matching core, installation/uninstall registration, and two correctly targeted shortcuts without auto-starting.'
    foreach ($sentinel in $sentinels) { New-Item -ItemType Directory -Path (Split-Path -Parent $sentinel) -Force | Out-Null; [IO.File]::WriteAllText($sentinel, $sentinelText) }
    $applicationProcess = Start-Process -FilePath $app -ArgumentList @("--user-data-dir=`"$data`"", '--remote-debugging-port=0', '--lang=zh-CN', '--disable-gpu') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'app.stdout.log') -RedirectStandardError (Join-Path $testRoot 'app.stderr.log')
    Wait-Condition { $applicationProcess.Refresh(); if ($applicationProcess.HasExited) { throw 'Installed application exited before CDP readiness.' }; Test-Path -LiteralPath (Join-Path $data 'DevToolsActivePort') } 'Installed application did not expose its own CDP endpoint.' 180
    $nodePath = @(Get-Command node -CommandType Application)[0].Source
    $driverArguments = @(('"' + (Join-Path $PSScriptRoot 'browser-smoke.mjs') + '"'), ('"' + $data + '"'), ('"' + $evidence + '"'))
    $driverProcess = Start-Process -FilePath $nodePath -ArgumentList $driverArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'driver.stdout.log') -RedirectStandardError (Join-Path $testRoot 'driver.stderr.log')
    Wait-OwnProcess $driverProcess 'Installed browser driver' 360
    Wait-OwnProcess $applicationProcess 'Installed application close' 60
    if ((Test-Path -LiteralPath (Join-Path $data 'license.dat')) -or (Test-Path -LiteralPath (Join-Path $defaultData 'license.dat'))) { throw 'The fresh application created an activation file.' }
    $report.checks += 'The installed application served its real authenticated UI and closed normally without activation.'
    $uninstallAttempted = $true
    Invoke-CoreUninstall
    if ((Test-Path -LiteralPath $registryPath) -or (Test-Path -LiteralPath $installationRegistryPath) -or @($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count) { throw 'Uninstall left an installation/uninstall registration key or shortcut.' }
    foreach ($sentinel in $sentinels) { if ((Get-Content -Raw -LiteralPath $sentinel) -ne $sentinelText) { throw 'Uninstall changed a user-owned sentinel.' } }
    $report.checks += 'Silent uninstall removed the core, both registration keys, and both shortcuts while preserving all three user sentinels.'
    $report.cleanup.applicationClosed = $true
    $report.cleanup.coreUninstalled = $true
    $report.cleanup.userSentinelsPreserved = $true
    $report.cleanup.retainedRuntimeDirectories = @('windows-host', 'strata-runtime') | Where-Object { Test-Path -LiteralPath (Join-Path $install ('resources\' + $_)) }
    $report.passed = $true
} catch {
    $report.failure = $_.Exception.Message
    throw
} finally {
    if ($driverProcess) {
        $driverProcess.Refresh()
        if (-not $driverProcess.HasExited) { & taskkill.exe /PID $driverProcess.Id /T /F | Out-Null; $driverProcess.WaitForExit(); $report.cleanup.forcedDriverStop = $true }
    }
    if ($applicationProcess) {
        $applicationProcess.Refresh()
        if (-not $applicationProcess.HasExited) { & taskkill.exe /PID $applicationProcess.Id /T /F | Out-Null; $applicationProcess.WaitForExit(); $report.cleanup.forcedApplicationStop = $true }
    }
    if (-not $uninstallAttempted -and (Test-Path -LiteralPath $uninstaller)) {
        try { Invoke-CoreUninstall; $report.cleanup.failurePathUninstalled = $true } catch { $report.cleanup.uninstallFailure = $_.Exception.Message }
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'installer.json') -Encoding UTF8
}
