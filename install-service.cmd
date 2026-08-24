@echo off
setlocal
set "DIR=%~dp0"
set "EXE=%DIR%MatchdayControl.exe"

fltmc >nul 2>&1
if errorlevel 1 (
  echo [info] Requesting Administrator permission...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b %errorlevel%
)

if not exist "%EXE%" (
  echo [error] MatchdayControl.exe not found in %DIR%
  echo Copy the executable and install-service.cmd to the same folder.
  exit /b 1
)
echo [ok] Creating scheduled task "MatchdayControl" (startup + automatic restart)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $exe=(Resolve-Path -LiteralPath '%EXE%').Path; $action=New-ScheduledTaskAction -Execute $exe; $trigger=New-ScheduledTaskTrigger -AtStartup; $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName 'MatchdayControl' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Matchday Control - marcador do estadio' -Force; Start-ScheduledTask -TaskName 'MatchdayControl'"
if errorlevel 1 (
  echo [error] Failed to create the scheduled task.
  exit /b 1
)
echo [ok] Matchday Control installed and running.
echo Check status:  schtasks /query /tn MatchdayControl /v /fo list
echo Remove:        uninstall-service.cmd
endlocal
