import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { embedFonts } from "./embed-fonts.ts";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const scoreboardDir = join(dist, "scoreboard");
mkdirSync(scoreboardDir, { recursive: true });
writeFileSync(
  join(scoreboardDir, "README.txt"),
  `Pasta de saída do Matchday Control
====================================

Os 5 ficheiros de texto que o OBS lê são escritos aqui assim que existir um
controlo ativo (equipas configuradas):

  Home Name.txt    -> nome da equipa da casa
  Home Score.txt   -> resultado da casa
  Away Name.txt    -> nome da equipa visitante
  Away Score.txt   -> resultado visitante
  Clock.txt        -> temporizador (MM:SS, máx 120:00)

Para usar outra pasta, muda o campo "outputDir" no config.json (relativo a
esta pasta ou caminho absoluto) e reinicia o Matchday Control.
`,
  "utf8",
);

console.log("[build] a compilar MatchdayControl.exe…");
embedFonts();
const result = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    join(root, "src", "server.ts"),
    "--outfile",
    join(dist, "MatchdayControl.exe"),
    "--minify",
    "--loader",
    ".html:text",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) {
  console.error("[build] falhou.");
  process.exit(result.exitCode ?? 1);
}

for (const file of ["install-service.cmd", "uninstall-service.cmd", "task.template.xml", "config.example.json"]) {
  copyFileSync(join(root, file), join(dist, file));
}

console.log("[build] concluído:");
console.log(`  ${join(dist, "MatchdayControl.exe")}`);
console.log(`  ${join(dist, "scoreboard")} (pasta dos ficheiros .txt)`);
console.log(`  ${join(dist, "install-service.cmd")}`);
console.log(`  ${join(dist, "uninstall-service.cmd")}`);
console.log(`  ${join(dist, "config.example.json")}`);
