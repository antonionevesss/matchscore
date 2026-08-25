# Matchday Control

Standalone scoreboard controller for local matches and broadcasts. It runs on
Windows, provides a web control panel for phones or computers, and writes `.txt`
files that can be consumed by OBS or other graphics software.

The project is club-agnostic: team names, output files, OBS scenes, and network
settings are configured per installation.

```text
Operator (browser)
       │ HTTP + SSE over the local network
       ▼
Matchday Control (Windows)
       ├── scoreboard .txt files
       └── OBS WebSocket 5.x (optional)
```

## Features

- Team names, score, clock, periods, and extra time.
- Undo the last action, swap sides, and reset the match.
- Atomic scoreboard file writes, only when content changes.
- Persistent SQLite state with history and rotating backups.
- Three optional OBS scenes through WebSocket.
- HTTP API and real-time SSE events.
- Windows scheduled-task support with automatic restart.

## Requirements

To run the packaged executable:

- Windows 10 or 11;
- write permission for the scoreboard output folder;
- a local network shared by the host PC and the devices operating the panel.

To develop or build:

- Bun 1.2 or newer;
- Windows to generate and test the `.exe`.

OBS is optional. It is only required for scene switching, with the OBS 5.x
WebSocket server enabled.

## Quick start

```sh
bun install
bun run dev
```

Open `http://localhost:8080` on the host computer. On first launch, the
executable prints a random PIN in a high-visibility console box and temporarily
saves it to `data/initial-pin.txt`. Use it to sign in and configure the home and
away teams.

The control panel defaults to English. The UI language can be changed to
Português (Portugal) from the language selector and is remembered in the browser.

To connect from another device, open `http://HOST_IP:8080` on the same local
network. The host IP is shown in the console or can be found with `ipconfig`.

## Windows executable

```sh
bun install
bun run build
```

The build creates:

```text
dist/
├── MatchdayControl.exe
├── data/                 # configuration, SQLite, backups, and lock
├── scoreboard/           # .txt files consumed by the graphics system
├── install-service.cmd
└── uninstall-service.cmd
```

The executable is self-contained and does not require Bun on the operator PC.

The fonts in `fonts/` are part of the project design and are embedded into the
panel during the build. Run `bun run fonts` after changing a font file.

### GitHub Releases

Pushing a version tag such as `v1.5.0` starts the Windows release workflow.
It validates the tag against `package.json`, runs the typecheck and tests,
builds the self-contained executable, creates a clean ZIP without runtime
configuration or match data, and publishes the ZIP to the GitHub Release.

Before installing the Windows scheduled task, set a personal PIN:

```bat
MatchdayControl.exe --print-pin
MatchdayControl.exe --set-pin 123456
```

The PIN must contain exactly six digits. `--print-pin` shows the initial PIN in
the console box while it still exists. The hash is stored in `data/config.json`;
the initial PIN file is removed after a new PIN is set.

To start automatically, copy the executable and both `.cmd` scripts to a
writable folder such as `C:/Scoreboard/MatchdayControl`, then run
`install-service.cmd` as Administrator. Run `uninstall-service.cmd` to remove
the scheduled task. The installer waits for the server and opens the control
panel in the browser automatically. The task then keeps the executable running
in the background, so do not open a second copy of the `.exe`; use the browser
panel instead. The `.exe` can also be run directly for manual/testing mode.

### Startup diagnostics

The executable writes all console output, warnings, and fatal startup errors to
`data/matchday.log`. The log is created before configuration and SQLite are
opened, so it is also available when the window opens and closes immediately.
If `--config PATH` is used, the log is written beside that configuration. A
different location can be selected with `--log PATH`.

Useful checks on Windows:

```bat
type data\matchday.log
schtasks /query /tn MatchdayControl /v /fo list
netstat -ano | findstr :8080
```

To see the error without the console disappearing, open PowerShell in the
installation folder and run `MatchdayControl.exe`. Common startup causes are a
second instance already running (often the scheduled task), port 8080 already
being in use, missing write permission for `data`/`scoreboard`, or an invalid
`data\config.json`.

## Configuration

The first launch creates `data/config.json`. `config.example.json` is a template
for customised installations.

| Field | Default | Purpose |
| --- | --- | --- |
| `outputDir` | `../scoreboard` in the package | Folder for `.txt` files |
| `files` | Home/Away/Clock names | Maps values to graphics consumers |
| `openBrowserOnStart` | `true` | Opens the panel on the host at startup |
| `port` | `8080` | HTTP port |
| `bind` | `0.0.0.0` | Network interface |
| `accessPinHash` | generated automatically | Operational PIN hash |
| `tokenSecret` | generated automatically | Session-token secret |
| `tokenTtlMs` | `43200000` | Session lifetime in milliseconds |
| `obs.enabled` | `false` | Enables OBS integration |
| `obs.host` / `obs.port` | `127.0.0.1:4455` | OBS WebSocket address |
| `obs.password` | empty | OBS WebSocket password |
| `obs.scenes` | generic names | Names of the three scenes |

Restart the application after changing configuration. Team names can be changed
from the panel without editing JSON.

### Output files

By default, these five UTF-8 files are written:

```text
Home Name.txt    home team name
Home Score.txt   home team score
Away Name.txt    away team name
Away Score.txt   away team score
Clock.txt        clock in MM:SS format
```

Writes are atomic. Change the names under `files` to preserve an existing
graphics integration.

### Clock

The clock is continuous, derived from persisted state, and never exceeds the
limit of the current period:

| Period | Limit |
| --- | ---: |
| First half | 45:00 |
| Second half | 90:00 |
| Extra time first half | 105:00 |
| Extra time second half | 120:00 |

Automatic added time is not included.

## API

Private routes use `Authorization: Bearer <token>` after authenticating at
`POST /api/auth` with the operational PIN.

- `GET /api/health` — operational, output, and OBS status;
- `GET /api/state` — current snapshot;
- `GET /api/stream` — SSE events;
- `POST /api/command` — executes a version-controlled action;
- `POST /api/setup` — creates the initial match; host computer only;
- `GET/PUT /api/obs/settings` — reads or updates OBS configuration;
- `POST /api/obs/test` — tests the OBS connection;
- `POST /api/obs/scene` — switches to a configured scene.

## Development commands

```sh
bun run dev
bun run typecheck
bun test
bun run build
```

Main structure:

```text
src/domain/   match and clock rules
src/api.ts    HTTP, authentication, and SSE
src/store.ts  SQLite, history, and recovery
src/writer.ts atomic .txt files
src/obs.ts    OBS WebSocket client
src/ui/       embedded web panel
scripts/      build and packaging
tests/        domain, API, and executable tests
```

## Security and scope

- Intended for a trusted local network; do not expose the server directly to
  the Internet.
- Uses one PIN per installation, signed sessions, and attempt limiting.
- Protect `data/`, which contains configuration and OBS credentials.
- Initial setup is limited to `127.0.0.1`.
- There are no users, roles, or separate permission levels.
- Cards, substitutions, automatic added time, and goal animations are outside
  the current scope.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security issues
must follow [SECURITY.md](SECURITY.md) and should not be posted in a public issue.

## License

Distributed under the MIT License.
