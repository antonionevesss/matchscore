@echo off
setlocal
fltmc >nul 2>&1
if errorlevel 1 (
  echo [info] A pedir permissao de Administrador...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b %errorlevel%
)

schtasks /query /tn "MatchdayControl" >nul 2>&1
if errorlevel 1 (
  echo [info] A tarefa "MatchdayControl" nao esta instalada.
  endlocal
  exit /b 0
)

schtasks /end /tn "MatchdayControl" >nul 2>&1
schtasks /delete /tn "MatchdayControl" /f
if errorlevel 1 (
  echo [erro] Nao foi possivel remover a tarefa. Tenta novamente como Administrador.
  endlocal
  exit /b 1
)
echo [ok] Servico "MatchdayControl" removido.
echo O executavel, config.json e os dados continuam intactos - podes voltar a abrir o TeleScore.
endlocal
