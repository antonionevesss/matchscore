import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ObsLaunchResult {
  alreadyRunning: boolean;
  executablePath: string;
}

export interface ObsLauncherDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  findOnPath?: () => string | null;
  isRunning?: () => boolean;
  spawn?: (path: string) => void;
}

const OBS_PROCESS_NAMES = ["obs64.exe", "obs.exe"];

/**
 * Starts OBS on Windows without creating a second instance when a visible OBS
 * window is already open. The executable can be configured, otherwise common OBS
 * Studio installation paths and PATH are checked.
 */
export function launchObs(
  configuredPath?: string,
  dependencies: ObsLauncherDependencies = {},
): ObsLaunchResult {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("OBS can only be started automatically on Windows.");
  }

  const path = configuredPath?.trim() ?? "";
  const isRunning = dependencies.isRunning ?? isObsProcessRunning;
  if (isRunning()) {
    return { alreadyRunning: true, executablePath: path || "obs64.exe" };
  }

  const executablePath = findObsExecutable(path, dependencies);
  if (!executablePath) {
    throw new Error(
      "OBS executable not found. Install OBS Studio or set obs.executablePath in data/config.json.",
    );
  }

  (dependencies.spawn ?? spawnObs)(executablePath);
  return { alreadyRunning: false, executablePath };
}

function findObsExecutable(
  configuredPath: string,
  dependencies: ObsLauncherDependencies,
): string | null {
  const exists = dependencies.exists ?? existsSync;
  if (configuredPath) {
    if (exists(configuredPath)) return configuredPath;
    throw new Error(`OBS executable not found at configured path: ${configuredPath}`);
  }

  const env = dependencies.env ?? process.env;
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA || join(env.USERPROFILE || "", "AppData", "Local");
  const candidates = [
    join(programFiles, "obs-studio", "bin", "64bit", "obs64.exe"),
    join(programFilesX86, "obs-studio", "bin", "64bit", "obs64.exe"),
    join(localAppData, "Programs", "obs-studio", "bin", "64bit", "obs64.exe"),
  ];

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const fromPath = (dependencies.findOnPath ?? findObsOnPath)();
  return fromPath && exists(fromPath) ? fromPath : null;
}

function findObsOnPath(): string | null {
  for (const processName of OBS_PROCESS_NAMES) {
    try {
      const result = Bun.spawnSync(["where.exe", processName], {
        stdout: "pipe",
        stderr: "ignore",
      });
      if (result.exitCode !== 0) continue;
      const firstPath = result.stdout.toString().split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (firstPath) return firstPath;
    } catch {
      // PATH lookup is optional; fixed installation paths were checked first.
    }
  }
  return null;
}

function isObsProcessRunning(): boolean {
  try {
    const result = Bun.spawnSync(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$visible = @(Get-Process -Name obs64,obs -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }); if ($visible.Count -gt 0) { '1' } else { '0' }",
      ],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    return result.exitCode === 0 && result.stdout.toString().trim() === "1";
  } catch {
    // A failed visibility check should allow the explicit button action to
    // try starting OBS instead of reporting a false positive.
    return false;
  }
}

function spawnObs(executablePath: string): void {
  const child = Bun.spawn([executablePath], {
    cwd: dirname(executablePath),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // OBS is a GUI application: hiding the child window can leave obs64.exe
    // running without a usable main window.
    windowsHide: false,
  });
  (child as unknown as { unref?: () => void }).unref?.();
}
