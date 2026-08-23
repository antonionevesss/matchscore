# Matchday Control

Controlador de marcador para jogos e transmissões locais. Corre num PC
Windows, disponibiliza um painel web para telemóvel ou computador e mantém
ficheiros .txt que podem ser lidos pelo OBS ou por outro software de grafismo.

O projeto é agnóstico a clubes: nomes das equipas, ficheiros de saída, cenas OBS
e rede são configurados por instalação.

~~~text
Operador (browser)
       │ HTTP + SSE na rede local
       ▼
Matchday Control (Windows)
       ├── ficheiros .txt do marcador
       └── OBS WebSocket 5.x (opcional)
~~~

## Funcionalidade

- Nomes das equipas, resultado, relógio, períodos e prolongamento.
- Anular a última ação, trocar lados e reiniciar o jogo.
- Escrita atómica dos ficheiros do marcador, apenas quando o conteúdo muda.
- Estado persistente em SQLite, com histórico e backups rotativos.
- Três cenas OBS opcionais através de WebSocket.
- API HTTP e eventos SSE em tempo real.
- Execução como tarefa agendada do Windows, com reinício em caso de falha.

## Requisitos

Para executar o executável empacotado:

- Windows 10 ou 11;
- permissões de escrita na pasta de saída do marcador;
- uma rede local comum ao PC e aos dispositivos que vão operar o painel.

Para desenvolver ou compilar:

- Bun 1.2 ou superior;
- Windows para gerar e testar o executável .exe.

O OBS é opcional. Só é necessário para usar as ações de mudança de cena, com o
WebSocket do OBS 5.x ativo.

## Desenvolvimento rápido

~~~sh
bun install
bun run dev
~~~

Abre http://localhost:8080 no computador anfitrião. No primeiro arranque o
executável mostra o PIN aleatório numa caixa de destaque na consola e guarda-o
temporariamente em data/initial-pin.txt. Usa-o para entrar e configura a equipa
da casa e a equipa visitante.

Para aceder a partir de outro dispositivo, abre http://IP_DO_PC:8080 na mesma
rede local. O IP é mostrado na consola ou pode ser consultado com ipconfig.

## Executável Windows

~~~sh
bun install
bun run build
~~~

O build cria:

~~~text
dist/
├── MatchdayControl.exe
├── data/                 # configuração, SQLite, backups e lock
├── scoreboard/           # ficheiros .txt consumidos pelo grafismo
├── install-service.cmd
└── uninstall-service.cmd
~~~

O executável é autónomo e não precisa de Bun no PC de operação.

As fontes em fonts/ fazem parte do design do projeto e são embutidas no painel
durante o build. Para regenerar esse bloco depois de alterar as fontes, executa
bun run fonts.

Antes de instalar a tarefa do Windows, define um PIN próprio:

~~~bat
MatchdayControl.exe --print-pin
MatchdayControl.exe --set-pin 123456
~~~

O PIN deve ter exatamente seis algarismos. O comando print-pin volta a mostrar
o PIN inicial em destaque enquanto ele ainda existir. O hash fica em
data/config.json; o PIN inicial é removido quando se define um novo.

Para arranque automático, copia o executável e os dois scripts .cmd para uma
pasta com permissões de escrita, como C:/Scoreboard/MatchdayControl, e executa
install-service.cmd como Administrador. Para remover a tarefa, executa
uninstall-service.cmd. Também é possível executar o .exe diretamente.

## Configuração

No primeiro arranque é criado data/config.json. config.example.json serve como
referência para instalações personalizadas.

| Campo | Default | Função |
| --- | --- | --- |
| outputDir | ../scoreboard no pacote | Pasta dos ficheiros .txt |
| files | nomes Home/Away/Clock | Mapeamento dos valores para o grafismo |
| openBrowserOnStart | true | Abre o painel no PC ao arrancar |
| port | 8080 | Porta HTTP |
| bind | 0.0.0.0 | Interface de rede |
| accessPinHash | automático | Hash do PIN operacional |
| tokenSecret | automático | Segredo dos tokens de sessão |
| tokenTtlMs | 43200000 | Validade da sessão em milissegundos |
| obs.enabled | false | Ativa a integração com OBS |
| obs.host / obs.port | 127.0.0.1:4455 | Endereço do WebSocket do OBS |
| obs.password | vazio | Palavra-passe do WebSocket do OBS |
| obs.scenes | nomes genéricos | Nomes das três cenas |

Depois de alterar a configuração, reinicia a aplicação. As equipas podem ser
alteradas no próprio painel, sem editar o JSON.

### Ficheiros de saída

Por defeito, são escritos estes cinco ficheiros UTF-8:

~~~text
Home Name.txt    nome da equipa da casa
Home Score.txt   resultado da equipa da casa
Away Name.txt   nome da equipa visitante
Away Score.txt  resultado da equipa visitante
Clock.txt        relógio no formato MM:SS
~~~

As escritas são atómicas. Os nomes podem ser alterados em files para manter
uma integração existente.

### Relógio

O relógio é contínuo, deriva do estado persistido e nunca ultrapassa o limite
do período em curso:

| Período | Limite |
| --- | ---: |
| 1.ª parte | 45:00 |
| 2.ª parte | 90:00 |
| 1.ª parte do prolongamento | 105:00 |
| 2.ª parte do prolongamento | 120:00 |

Não há compensação automática.

## API

As rotas privadas usam Authorization: Bearer token depois de autenticar em
POST /api/auth com o PIN operacional.

- GET /api/health — estado operacional, escrita e OBS;
- GET /api/state — snapshot atual;
- GET /api/stream — eventos SSE;
- POST /api/command — executa uma ação com controlo de versão;
- POST /api/setup — cria o jogo inicial; apenas no computador anfitrião;
- GET/PUT /api/obs/settings — lê/altera a configuração OBS;
- POST /api/obs/test — testa a ligação ao OBS;
- POST /api/obs/scene — muda para uma das cenas configuradas.

## Comandos de desenvolvimento

~~~sh
bun run dev
bun run typecheck
bun test
bun run build
~~~

Estrutura principal:

~~~text
src/domain/   regras do jogo e relógio
src/api.ts    HTTP, autenticação e SSE
src/store.ts  SQLite, histórico e recuperação
src/writer.ts ficheiros .txt atómicos
src/obs.ts    cliente OBS WebSocket
src/ui/       painel web embutido
scripts/      build e empacotamento
tests/        testes do domínio, API e executável
~~~

## Segurança e limites

- Destinado a uma rede local confiável; não exponhas o servidor diretamente à
  Internet.
- Usa um PIN por instalação, sessões assinadas e limitação de tentativas.
- Protege a pasta data/, que contém a configuração e as credenciais do OBS.
- A configuração inicial fica limitada a 127.0.0.1.
- Não existem utilizadores, roles ou permissões distintas.
- Não inclui cartões, substituições, compensação automática ou animações de golo.

## Contribuir

Consulta CONTRIBUTING.md antes de abrir uma alteração. Problemas de segurança
devem seguir SECURITY.md, não ser publicados num issue.

## Licença

Distribuído sob a licença MIT.
