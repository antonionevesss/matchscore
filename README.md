# Matchday Control

App Windows única e independente para controlar o marcador do estádio a partir
de um telemóvel na rede local. Substitui o par Torre de Controlo + Bridge por
um único executável que corre no PC do OBS, serve o controlo ao telemóvel e
escreve **os mesmos 5 ficheiros `.txt`** que o OBS já lê — sem Postgres, sem
nuvem, sem framework.

```text
Telemóvel (Wi-Fi do estádio)
        ↓ HTTP + SSE (palavra-passe)
MatchdayControl.exe (PC do estádio)
        ↓ escreve os MESMOS .txt (atómico, só quando muda)
OBS (1920x1200, inalterado) → HDMI → NovaLCT (inalterado)
```

## Requisitos

- **Runtime (PC do estádio):** Windows 10/11. Apenas o `MatchdayControl.exe`.
- **Build (máquina de desenvolvimento):** [Bun](https://bun.sh) 1.2+.

## Compilar

```sh
bun install
bun run build
```

Gera `dist/MatchdayControl.exe` (~50–80 MB, sem ficheiros externos em runtime)
e copia para `dist/` o `install-service.cmd`, `uninstall-service.cmd`,
`task.template.xml` e `config.example.json`. Cria também `dist/scoreboard/`,
onde o app escreve os 5 ficheiros `.txt` (assim que houver um controlo ativo).

## Instalação no PC do estádio

1. Copiar `MatchdayControl.exe` + `install-service.cmd` (+ `uninstall-service.cmd`
   e `task.template.xml`) para uma pasta com permissões de escrita, ex.:
   `C:\Scoreboard\MatchdayControl`.
2. Executar `install-service.cmd` **como Administrador**. Cria a tarefa do
   Windows `MatchdayControl` com arranque no boot e reinício automático em caso
   de falha (3 tentativas, intervalo de 1 min).
3. No primeiro arranque, o exe gera `config.json`. A palavra-passe operacional
   é fixa: **1887**.

Alternativa sem serviço: executar `MatchdayControl.exe` diretamente.

Por omissão, o arranque abre o controlo no browser do PC
(`http://localhost:8080`) para a configuração das equipas. Para desligar,
define `openBrowserOnStart: false` no `config.json`.

## Uso

1. No PC do estádio, abrir `http://localhost:8080`, entrar com a palavra-passe e
   **configurar as equipas** (só os nomes da casa e da fora; o setup só
   funciona a partir do PC, `127.0.0.1`).
2. No telemóvel (mesmo Wi-Fi), abrir `http://IP_DO_PC:8080` e entrar com a
   mesma palavra-passe. O IP é mostrado na consola no arranque (ou via `ipconfig`).
3. Controlar: resultado, relógio, períodos, anular, trocar lados, renomear
   equipas e recomeçar o jogo.

Os 5 ficheiros `.txt` são escritos na pasta `scoreboard` junto do executável
(em dev/build: `dist/scoreboard/`), com o mesmo contrato do TeleScore.

### Tempo de jogo (regras da liga)

O relógio é **contínuo** e **nunca passa do limite** de cada período:

| Período | Limite |
| --- | --- |
| 1.ª parte | 45:00 |
| 2.ª parte (começa em 45:00) | 90:00 |
| 1.ª parte do prolongamento (começa em 90:00) | 105:00 |
| 2.ª parte do prolongamento (começa em 105:00) | 120:00 |
| Fim do 2.º tempo | fixa em 90:00 |
| Fim do prolongamento | fixa em 120:00 |

- `1.º TEMPO` repõe 00:00 e pára; `INICIAR`/`PAUSAR` controla o relógio.
- `INTERVALO` fixa o relógio em 45:00.
- `FIM 2.ª PARTE` fixa o relógio em 90:00.
- `INT. PROL.` fixa o relógio em 105:00.
- `FIM PROL.` fixa o relógio em 120:00.
- `2.º TEMPO`, `1.ª PR. PROL.` e `2.ª PR. PROL.` arrancam automaticamente em
  45:00, 90:00 e 105:00, respetivamente.
- Ao chegar ao limite, o relógio trava aí (e `INICIAR` deixa de estar
  disponível) — não há compensação.

### Identidade visual

- Cores da Académica (marca oficial): preto `#10110F` + marfim `#F4F2EC`,
  com o dourado `#E0BB78` como acento.
- Tipografia: **Albireo** (títulos) e **Poppins** (restante interface),
  embutidas no executável a partir da pasta `fonts/` (regerar com
  `bun run fonts`).
- Formato responsivo: telemóvel numa coluna; em ecrãs largos (PC) o
  resultado e o relógio ficam lado a lado.

### Fallback TeleScore

Para voltar ao fluxo antigo: `uninstall-service.cmd` (ou `schtasks /end /tn
MatchdayControl`) e abrir o TeleScore. O OBS continua a ler os mesmos ficheiros.

## Garantias operacionais

- **Escritas atómicas** (temp + rename) — o OBS nunca lê conteúdo a meio.
- **Relógio derivado** de `clockBaseSeconds + clockStartedAt`: continua correto
  após reinícios e falhas de rede (não depende de ticks) e é sempre limitado
  ao máximo do período em curso.
- **Persistência** em `matchday.db` (SQLite WAL) com transações, `version`
  incrementada, histórico de anular (últimos 30 estados) e **backups
  rotativos** (`matchday.db.bak`, `matchday.db.bak2`) — DB corrompido é
  restaurado automaticamente no arranque.
- **Supervisão**: Task Scheduler reinicia o processo; watchdog interno sai com
  código 1 se o event loop ficar preso >10 s; `uncaughtException` /
  `unhandledRejection` fazem flush e saída limpa; lock de instância única
  impede processos duplicados.
- **Falha de escrita nunca derruba** o processo: aparece em `GET /api/health`
  e na UI; o último valor válido mantém-se.

## Configuração (`config.json`)

| Campo | Default | Descrição |
| --- | --- | --- |
| `outputDir` | `scoreboard` | Pasta de saída junto do exe (relativa a esta pasta; também aceita caminho absoluto) |
| `files` | TeleScore | Nomes dos 5 ficheiros (`Home Name.txt`, `Home Score.txt`, `Away Name.txt`, `Away Score.txt`, `Clock.txt`) |
| `telescore.enabled` | `true` | Espelho do TeleScore ligado (redundância na mesma pasta) |
| `telescore.watchDir` | `null` | Pasta a vigiar; `null` = `outputDir` |
| `telescore.pollMs` | `500` | Intervalo de verificação dos ficheiros |
| `telescore.adoptTeams` / `adoptScores` / `adoptClock` | `true` | Adotar alterações externas de equipas/resultado/relógio |
| `telescore.processName` | `TeleScore.exe` | Processo usado para o estado online/offline |
| `openBrowserOnStart` | `true` | Abre o controlo em `http://localhost:8080` automaticamente no arranque |
| `port` | `8080` | Porta HTTP |
| `bind` | `0.0.0.0` | Interface de rede |
| `pinHash` | legado | Ignorado; a palavra-passe é fixa (`1887`) |
| `tokenSecret` | — | Segredo HMAC dos tokens (gerado no 1.º arranque) |
| `tokenTtlMs` | `43200000` | Validade do token (12 h) |
| `obs.enabled` | `false` | Liga o controlo opcional de cenas OBS |
| `obs.host` / `obs.port` | `127.0.0.1:4455` | Servidor OBS WebSocket 5.x |
| `obs.password` | vazio | Palavra-passe do OBS WebSocket |
| `obs.scenes` | Cena 1/2/3 | Nomes das três cenas controladas |

As equipas podem ser alteradas diretamente no painel principal, sem abrir uma
janela. No telemóvel, a ordem prioritária é relógio, resultado, OBS e nomes das
equipas. As definições OBS também podem ser editadas na secção **Definições
OBS** da webapp; **Testar conexão** verifica a ligação sem alterar a cena.

Mostrar a palavra-passe fixa: `MatchdayControl.exe --print-pin`.

## Coexistência com o TeleScore (redundância)

O MatchdayControl e o TeleScore podem correr ao mesmo tempo e escrever os
mesmos 5 ficheiros `.txt` na mesma pasta (a pasta `Output` do TeleScore, que é
a que o OBS lê). A sincronização é feita pelo contrato de ficheiros — o
TeleScore não é alterado.

- O app **vigia a pasta** (`telescore.watchDir`, por omissão a própria
  `outputDir`) e adota alterações externas: equipas, resultado e relógio
  (quando o nosso relógio está parado, limitado ao máximo do período).
- O app é a **autoridade do relógio**: com o nosso relógio a correr, o
  `Clock.txt` externo é ignorado e a UI avisa se o TeleScore estiver também a
  correr o relógio (instrução: manter o relógio do TeleScore parado).
- **Failover automático**: se o TeleScore morrer, o app já tem o último estado
  espelhado e mantém o marcador vivo; se o app morrer, o Task Scheduler
  reinicia-o e o arranque re-adota os ficheiros mais recentes.
- As nossas escritas são atómicas e "só quando muda"; as do TeleScore mantêm-se
  como hoje (não atómicas).

## API (resumo)

- `POST /api/auth` `{ pin }` → `{ token, expiresAt }`
- `GET /api/state` → `{ state, undoAvailable, setupAllowed }`
- `GET /api/stream` (SSE, `?token=` ou `Authorization`) → `event: state`
- `POST /api/command` `{ baseVersion, action }` → snapshot; `409` com snapshot
  se a versão estiver desatualizada
- `GET /api/obs/settings` → configuração OBS sem expor a palavra-passe
- `PUT /api/obs/settings` → guarda host, porta, ativação e nomes das cenas; a
  palavra-passe só é substituída quando é preenchida
- `POST /api/obs/test` → testa a ligação ao OBS e devolve o estado atualizado
- `POST /api/obs/scene` `{ sceneKey: "matchscore" | "goal" | "sponsors" }`
- `POST /api/setup` `{ homeTeam, awayTeam }` — só `127.0.0.1`
- `GET /api/health` → `{ status, uptime, stateVersion, filesOk, lastError, lastWriteAt, obs }`

## Testes

```sh
bun test
```

Cobre o port da máquina de estado (relógio contínuo com limites 45/90/105/120,
prolongamento, resultado, anular, ações sem efeito), escrita atómica e "só
escreve quando muda", recuperação de DB corrompido, palavra-passe/token e conflito de
versão (`409`). Com o
`dist/MatchdayControl.exe` compilado, corre também o teste de integração do
executável: arranque, controlo via HTTP, `kill -9`, restauro de estado com o
relógio a retomar e lock de instância única.

## Limites (MVP)

Rede local apenas (Wi-Fi do estádio); sem acesso externo (VPN/túnel fica para
depois). Um operador principal; vários telemóveis suportados por versionamento,
sem roles/perfis. Escopo: resultado, relógio com limites por período e
prolongamento, anular, equipas, trocar lados, reset e controlo manual opcional
de três cenas OBS. Sem compensação, golos animados, substituições, cartões ou XI.
