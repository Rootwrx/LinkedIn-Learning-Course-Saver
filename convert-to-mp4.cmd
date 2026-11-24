@echo off
setlocal
set "FOLDER=%~1"
if "%FOLDER%"=="" set "FOLDER=%CD%"
echo Converting .ts files in: %FOLDER%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert-to-mp4.ps1" -Folder "%FOLDER%" %2 %3
echo.
pause
