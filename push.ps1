$versionFile = "version.json"
if (Test-Path $versionFile) {
    $json = Get-Content $versionFile | ConvertFrom-Json
    $currentVersion = $json.version
    $currentBuild = $json.build
}
else {
    Write-Host "version.json not found !"
    exit
}
Write-Host ""
Write-Host "=============================="
Write-Host "      oifeel. Push Manager     "
Write-Host "=============================="
Write-Host "Version actuelle: $currentVersion"
Write-Host "Build actuel:       $currentBuild"
Write-Host ""

$mode = "build"
$newVersion = $currentVersion
$newBuild = $currentBuild

Write-Host "Ancienne version : $currentVersion"
$newVersion = Read-Host "Nouvelle version ('', '-' ou ' ' pour garder $currentVersion)"
Write-Host "Ancien build: $currentBuild"
$newBuild = Read-Host "Nouveau build ('', '-' ou ' ' pour garder $currentBuild)"

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) {
    $possibleGitDirs = @(
        "C:\Program Files\Git\cmd",
        "C:\Program Files\Git\bin",
        "C:\Program Files\Git\mingw64\bin"
    )
    foreach ($dir in $possibleGitDirs) {
        if (Test-Path "$dir\git.exe") {
            $env:PATH = "$dir;$env:PATH"
            $gitCommand = Get-Command git -ErrorAction SilentlyContinue
            break
        }
    }
}

if (-not $gitCommand) {
    Write-Host "Git n'est pas installe ou n'est pas dans votre PATH. Installez Git pour Windows puis relancez ce script." -ForegroundColor Red
    exit 1
}

$gitExe = $gitCommand.Source
$currentBranch = (& $gitExe rev-parse --abbrev-ref HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch) -or $currentBranch -eq "HEAD") {
    $fallbackBranch = (& $gitExe symbolic-ref -q --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($fallbackBranch)) {
        $currentBranch = $fallbackBranch
    }
}

if ([string]::IsNullOrWhiteSpace($currentBranch) -or $currentBranch -eq "HEAD") {
    $branchList = (& $gitExe branch --list 2>$null)
    if ($LASTEXITCODE -eq 0) {
        $branchNames = @($branchList | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^\*' })
        if ($branchNames -contains 'main') {
            $currentBranch = 'main'
        }
    }
}

if ([string]::IsNullOrWhiteSpace($currentBranch) -or $currentBranch -eq "HEAD") {
    Write-Host "Impossible de determiner la branche Git active. Assurez-vous d'executer ce script depuis un depôt Git valide avec une branche locale." -ForegroundColor Red
    exit 1
}

Write-Host "Branche Git active : $currentBranch"
if ($currentBranch -ne "main") {
    Write-Host "La branche active n'est pas 'main'. Le script va pousser sur '$currentBranch'." -ForegroundColor Yellow
}

if ([string]::IsNullOrWhiteSpace($newVersion) -or $newVersion -eq "-") {
    $newVersion = $currentVersion
    Write-Host "Version inchangee: $currentVersion"
}
if ([string]::IsNullOrWhiteSpace($newBuild) -or $newBuild -eq "-") {
    $newBuild = $currentBuild
    Write-Host "Build inchange: $currentBuild"
}
else {
    $json.version = $newVersion
    $json.build = $newBuild
    $json | ConvertTo-Json -Depth 10 | Set-Content $versionFile -Encoding UTF8
    Write-Host "version.json mis a jour a la version $newVersion (build $newBuild)"
}
Write-Host "Git pull en cours..."
if ($LASTEXITCODE -eq 0) {
    $pullResult = (& $gitExe pull origin $currentBranch 2>&1)
    if ($pullResult -match "Merge automatique n'a pas abouti") {
        Write-Host "⚠️ Des conflits de merge ont ete detectes ! Resolution en cours..." -ForegroundColor Yellow
        
        $mergeMessage = "Merge la branche main pour synchroniser avec les changements a distance"
        Set-Content -Path ".git/MERGE_MSG" -Value $mergeMessage
        
        & $gitExe add .
        & $gitExe commit -m "$mergeMessage"
        
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Merge echoue! Merci de resoudre les conflits manuellement" -ForegroundColor Red
            exit 1
        }
    }
}
else {
    Write-Host "Aucun commit local detecte. Le script va creer le premier commit puis pousser vers origin/$currentBranch."
}

$json.version = $newVersion
$json.build = $newBuild
$json | ConvertTo-Json -Depth 10 | Set-Content $versionFile -Encoding UTF8
Write-Host "version.json mis a jour → v$newVersion (build $newBuild)"

& $gitExe add .
& $gitExe commit -m "V$newVersion (build $newBuild)" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Rien a commit."
}

& $gitExe push origin $currentBranch
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push echoue!"
    exit 1
}
Write-Host "Changements pousses avec succes !."
if ($mode -eq "release") {
    Write-Host ""
    Write-Host "Creating GitHub release..."
    $tagName = "v$newVersion"
    git tag -a $tagName -m "Release $tagName - $changelog"
    git push origin $tagName
    $releaseNotes = @"
 Release $tagName
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm")
Build: $newBuild
 Changelog:
$changelog
"@
    $releaseFile = "RELEASE_NOTES_$tagName.txt"
    $releaseNotes | Out-File -Encoding UTF8 $releaseFile
    Write-Host "Release notes enregistre a $releaseFile"
}
Write-Host ""
Write-Host "🎉 Operation effectue avec succes !"
Write-Host "=============================="
Write-Host "Version: $newVersion"
Write-Host "Build: $newBuild"
Write-Host "Mode: $mode"
Write-Host "=================================="