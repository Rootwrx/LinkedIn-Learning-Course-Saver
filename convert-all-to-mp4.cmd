@echo off
setlocal
rem Usage: convert-all-to-mp4.cmd [folder] [-Watch] [-DeleteOriginals]
rem With no folder, scans everything under your Downloads folder.
set "ROOT=%~1"
if "%ROOT%"=="" set "ROOT=%USERPROFILE%\Downloads"
echo Scanning for .ts files in: %ROOT%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert-all-to-mp4.ps1" -Root "%ROOT%" %2 %3 %4
pause
