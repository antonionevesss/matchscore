@echo off
setlocal
set "DIR=%~dp0"
set "EXE=%DIR%MatchdayControl.exe"

fltmc >nul 2>&1
if errorlevel 1 (
  echo [info] A pedir permissao de Administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b %errorlevel%
)

if not exist "%EXE%" (
  echo [erro] MatchdayControl.exe nao encontrado em %DIR%
  echo Copia o exe e o install-service.cmd para a mesma pasta.
  exit /b 1
)
echo [ok] A criar servico "MatchdayControl" (arranque + reinicio automatico)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $exe=(Resolve-Path -LiteralPath '%EXE%').Path; $action=New-ScheduledTaskAction -Execute $exe; $trigger=New-ScheduledTaskTrigger -AtStartup; $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName 'MatchdayControl' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Matchday Control - marcador do estadio' -Force; Start-ScheduledTask -TaskName 'MatchdayControl'"
if errorlevel 1 (
  echo [erro] Falhou a criacao da tarefa agendada.
  exit /b 1
)
echo [ok] Matchday Control instalado e em execucao.
echo Ver o estado:  schtasks /query /tn MatchdayControl /v /fo list
echo Remover:       uninstall-service.cmd
endlocal
