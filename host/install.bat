@echo off
setlocal
title Fardeen YT Downloader - helper installer
cd /d "%~dp0"

echo ==============================================
echo   Fardeen YT Downloader - native helper setup
echo ==============================================
echo.

rem ---- find Python 3 (prefer the py launcher; it ignores stray virtualenvs on PATH)
set "PY="
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo ERROR: Python 3 was not found.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this again.
  echo.
  pause
  exit /b 1
)

rem ---- extension ID: argument or prompt
set "EXT_ID=%~1"
if not defined EXT_ID (
  echo Open chrome://extensions, enable Developer mode, and copy the ID shown under
  echo "Fardeen YT Downloader" ^(32 letters, e.g. abcdefghijklmnopabcdefghijklmnop^).
  echo.
  set /p "EXT_ID=Paste the extension ID and press Enter: "
)

%PY% "%~dp0fardeen_host.py" --install "%EXT_ID%"
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="1" (
  echo Installation failed. Check the extension ID and try again.
) else if "%RESULT%"=="2" (
  echo The helper is registered, but some tools are missing ^(see above^).
  echo Quick install:  pip install -U yt-dlp    and    winget install Gyan.FFmpeg
) else (
  echo Done! Restart Chrome completely, then click the extension icon.
)
echo.
pause
exit /b %RESULT%
