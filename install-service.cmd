@echo off
setlocal
set "DIR=%~dp0"
set "EXE=%DIR%MatchdayControl.exe"
set "TEMPLATE=%DIR%task.template.xml"
set "TARGET=%DIR%matchday-task.xml"

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
if not exist "%TEMPLATE%" (
  echo [erro] task.template.xml nao encontrado em %DIR%
  echo Reconstroi o pacote completo com bun run build.
  exit /b 1
)

echo [ok] A criar servico "MatchdayControl" (arranque + reinicio automatico)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dir=(Resolve-Path -LiteralPath '%DIR%').Path; $exe=Join-Path $dir 'MatchdayControl.exe'; $template=Join-Path $dir 'task.template.xml'; $target=Join-Path $dir 'matchday-task.xml'; $xml=Get-Content -LiteralPath $template -Raw -Encoding UTF8; $xml=$xml.Replace('{{EXE_PATH}}',$exe.Replace('&','&amp;').Replace('"','&quot;')); $xml=$xml.Replace('{{EXE_DIR}}',$dir.Replace('&','&amp;').Replace('"','&quot;')); Set-Content -LiteralPath $target -Value $xml -Encoding Unicode"
if errorlevel 1 (
  echo [erro] Falhou a preparacao da tarefa.
  exit /b 1
)

schtasks /create /tn "MatchdayControl" /xml "%TARGET%" /f
if errorlevel 1 (
  echo [erro] Falhou a criacao da tarefa agendada.
  exit /b 1
)

schtasks /run /tn "MatchdayControl"
if errorlevel 1 (
  echo [erro] A tarefa foi criada, mas nao arrancou. Verifica o estado com:
  echo         schtasks /query /tn MatchdayControl /v /fo list
  exit /b 1
)
echo [ok] Matchday Control instalado e em execucao.
echo Ver o estado:  schtasks /query /tn MatchdayControl /v /fo list
echo Remover:       uninstall-service.cmd
endlocal
