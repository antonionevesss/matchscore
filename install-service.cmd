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
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $exe=(Resolve-Path -LiteralPath '%EXE%').Path; $action=New-ScheduledTaskAction -Execute $exe; $trigger=New-ScheduledTaskTrigger -AtStartup; $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero); Register-ScheduledTask -TaskName 'MatchdayControl' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Matchday Control - marcador do estadio' -Force; Start-ScheduledTask -TaskName 'MatchdayControl'"
if errorlevel 1 (
  echo [error] Failed to create the scheduled task.
  exit /b 1
)
echo [ok] Matchday Control installed and running.
echo [info] Diagnostics log: %DIR%data\matchday.log
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $port=8080; $config=Join-Path '%DIR%' 'data\config.json'; if(Test-Path -LiteralPath $config){try{$json=Get-Content -Raw -LiteralPath $config | ConvertFrom-Json; $configuredPort=$json.port -as [int]; if($configuredPort -gt 0 -and $configuredPort -lt 65536){$port=$configuredPort}}catch{}}; $url='http://localhost:' + $port; for($i=0;$i -lt 30;$i++){try{$response=Invoke-WebRequest -UseBasicParsing -Uri ($url + '/api/health') -TimeoutSec 1; if($response.StatusCode -eq 200){Start-Process $url; exit 0}}catch{}; Start-Sleep -Milliseconds 250}; Write-Host ('[warn] Control panel did not respond yet. Open ' + $url + ' manually.'); exit 1"
if errorlevel 1 echo [warn] The service is running, but the browser could not be opened automatically.
echo [info] The app runs in the background; use the browser panel instead of starting a second .exe.
echo Check status:  schtasks /query /tn MatchdayControl /v /fo list
echo Remove:        uninstall-service.cmd
endlocal
