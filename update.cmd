@echo off
rem ============================================================
rem  dsh-usage-dashboard maintainer one-click update
rem  usage: update.cmd ["commit message"]
rem  Does: git commit+push -> reinstall into dsh web profile.
rem  NOTE: lib/ changes need a `dsh web` restart afterwards;
rem        public/-only changes just need Ctrl+F5 in the browser.
rem ============================================================
setlocal
cd /d "%~dp0"

set MSG=%~1
if "%MSG%"=="" set MSG=update

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MSG%"
) else (
  echo Nothing new to commit.
)

git push --quiet 2>nul
if errorlevel 1 (
  echo push failed directly, retrying via proxy 127.0.0.1:7897 ...
  git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push
)

echo Reinstalling into dsh web profile ...
wsl.exe -e /bin/bash -lic "dsh plugin --profile web add file:/mnt/c/Users/GGBOND/.zcode/workspace/default/dsh-usage-dashboard 2>&1 | tail -1"

echo.
echo Done. Restart `dsh web` if you changed lib/; Ctrl+F5 is enough for public/-only edits.
pause
