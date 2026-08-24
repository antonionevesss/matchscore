@echo off
setlocal
fltmc >nul 2>&1
if errorlevel 1 (
  echo [info] Requesting Administrator permission...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b %errorlevel%
)

schtasks /query /tn "MatchdayControl" >nul 2>&1
if errorlevel 1 (
  echo [info] The "MatchdayControl" task is not installed.
  endlocal
  exit /b 0
)

schtasks /end /tn "MatchdayControl" >nul 2>&1
schtasks /delete /tn "MatchdayControl" /f
if errorlevel 1 (
  echo [error] Could not remove the task. Try again as Administrator.
  endlocal
  exit /b 1
)
echo [ok] Scheduled task "MatchdayControl" removed.
echo The executable, config.json, and data remain intact.
endlocal
