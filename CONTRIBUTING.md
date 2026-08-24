# Contributing

Thanks for contributing to Matchday Control.

## Before opening a pull request

1. Explain the problem or intended change.
2. Keep the behaviour club- and installation-agnostic.
3. Update the documentation when configuration, API, or operation changes.
4. Run `bun run typecheck` and `bun test`.

## Conventions

- Use strict TypeScript and keep responsibilities separated by module.
- Do not commit `data/`, `scoreboard/`, executables, databases, or credentials.
- Do not add tokens, PINs, passwords, or data from a real installation.
- For panel changes, test on a phone and a wide screen when possible.

## Pull requests

Describe what changed, how it was validated, and any compatibility impact.
Changes that affect the five output files must explain how existing consumers can
migrate.
