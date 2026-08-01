# =========================================================
# IEK Voting System — One-Click Deploy Script
# Stages changes, commits with a timestamp, and pushes to
# GitHub. Vercel's Git integration picks up the push and
# auto-deploys — this script does not call Vercel directly.
# =========================================================

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red }

function Stop-WithPause($code) {
    Read-Host "`nPress Enter to close"
    exit $code
}

# Always run from the folder this script lives in, regardless of
# where it was double-clicked from.
Set-Location -Path $PSScriptRoot

Write-Host "=================================================" -ForegroundColor DarkGray
Write-Host "  IEK VOTING SYSTEM -- ONE-CLICK DEPLOY" -ForegroundColor White
Write-Host "=================================================" -ForegroundColor DarkGray

# ---------------------------------------------------------
# 1. Sanity checks
# ---------------------------------------------------------
Write-Step "Checking Git is installed"
git --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Git is not installed or not on PATH."
    Write-Host "Install it from https://git-scm.com/downloads and try again." -ForegroundColor Yellow
    Stop-WithPause 1
}
Write-Ok "Git found"

Write-Step "Checking this is a Git repository"
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "This folder is not a Git repository (no .git found)."
    Write-Host "Run 'git init' and connect a GitHub remote first." -ForegroundColor Yellow
    Stop-WithPause 1
}
Write-Ok "Git repository detected"

$branch = (git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
    Write-Fail "Could not detect current branch (detached HEAD?)."
    Stop-WithPause 1
}
Write-Ok "Current branch: $branch"

$remoteUrl = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remoteUrl)) {
    Write-Fail "No 'origin' remote configured."
    Write-Host "Add one with: git remote add origin <your-repo-url>" -ForegroundColor Yellow
    Stop-WithPause 1
}
Write-Ok "Remote: $remoteUrl"

# ---------------------------------------------------------
# 2. Stage changes
# ---------------------------------------------------------
Write-Step "Staging all changes (git add .)"
git add .
if ($LASTEXITCODE -ne 0) {
    Write-Fail "git add failed. See output above."
    Stop-WithPause 1
}

$statusOutput = git status --porcelain
if ([string]::IsNullOrWhiteSpace($statusOutput)) {
    Write-Warn "No changes to deploy -- working tree is already clean."
    Write-Host "`nNothing was committed or pushed. No deployment was triggered." -ForegroundColor Yellow
    Stop-WithPause 0
}

Write-Host "`nChanges to be deployed:" -ForegroundColor White
git status --short

# ---------------------------------------------------------
# 3. Commit
# ---------------------------------------------------------
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$commitMessage = "Auto-deploy: $timestamp"

Write-Step "Committing changes"
git commit -m "$commitMessage" *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "git commit failed. See output above."
    Stop-WithPause 1
}
Write-Ok "Committed: `"$commitMessage`""

# ---------------------------------------------------------
# 4. Sync with remote before pushing (avoids rejected pushes)
# ---------------------------------------------------------
Write-Step "Pulling latest changes from origin/$branch"
git pull --rebase --autostash origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Fail "git pull --rebase failed -- likely a merge conflict."
    Write-Host "Your commit is safe locally but was NOT pushed." -ForegroundColor Yellow
    Write-Host "Resolve the conflict, then run: git rebase --continue" -ForegroundColor Yellow
    Stop-WithPause 1
}
Write-Ok "Up to date with origin/$branch"

# ---------------------------------------------------------
# 5. Push
# ---------------------------------------------------------
Write-Step "Pushing to GitHub"
git rev-parse --abbrev-ref --symbolic-full-name "@{u}" *> $null
if ($LASTEXITCODE -ne 0) {
    git push --set-upstream origin $branch
} else {
    git push
}
if ($LASTEXITCODE -ne 0) {
    Write-Fail "git push failed. Check your GitHub credentials/permissions above."
    Stop-WithPause 1
}

$commitHash = (git rev-parse --short HEAD).Trim()

Write-Host "`n=================================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT TRIGGERED!" -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
Write-Host "  Branch:  $branch"
Write-Host "  Commit:  $commitHash -- $commitMessage"
Write-Host "  Remote:  $remoteUrl"
Write-Host "`n  Vercel is watching this GitHub repo and will auto-build" -ForegroundColor White
Write-Host "  and deploy within a couple of minutes." -ForegroundColor White
Write-Host "  Check progress at: https://vercel.com/dashboard`n" -ForegroundColor Cyan

Write-Host "  Reminder (Neon PostgreSQL backend):" -ForegroundColor DarkYellow
Write-Host "  - DATABASE_URL must be set in Vercel Project Settings -> Environment Variables." -ForegroundColor DarkYellow
Write-Host "  - If this is a fresh database, run schema.sql once, then POST /api/seed." -ForegroundColor DarkYellow

Stop-WithPause 0
