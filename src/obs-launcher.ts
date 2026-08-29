import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ObsLaunchResult {
  alreadyRunning: boolean;
  executablePath: string;
  processState?: ObsProcessState;
}

export interface ObsSpawnOptions {
  cwd: string;
  detached: boolean;
  windowsHide: boolean;
}

export type ObsProcessState = "visible" | "hidden" | "notDetected" | "unknown";

export interface ObsLauncherDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  findOnPath?: () => string | null;
  isRunning?: () => boolean;
  processState?: () => ObsProcessState;
  spawn?: (path: string, options?: ObsSpawnOptions) => void;
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
  if (dependencies.isRunning) {
    if (dependencies.isRunning()) {
      return { alreadyRunning: true, executablePath: path || "obs64.exe" };
    }
  } else {
    const processState = dependencies.processState?.() ?? detectObsProcessState(platform);
    if (processState === "visible" || processState === "hidden") {
      return { alreadyRunning: true, executablePath: path || "obs64.exe", processState };
    }
  }

  const executablePath = findObsExecutable(path, dependencies);
  if (!executablePath) {
    throw new Error(
      "OBS executable not found. Install OBS Studio or set obs.executablePath in data/config.json.",
    );
  }

  (dependencies.spawn ?? spawnObs)(executablePath, {
    cwd: dirname(executablePath),
    detached: true,
    windowsHide: false,
  });
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

export function detectObsProcessState(platform: NodeJS.Platform = process.platform): ObsProcessState {
  if (platform !== "win32") return "unknown";
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
        "$processes = @(Get-Process -Name obs64,obs -ErrorAction SilentlyContinue); if ($processes.Count -eq 0) { 'notDetected' } elseif (@($processes | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { 'visible' } else { 'hidden' }",
      ],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    if (result.exitCode !== 0) return "unknown";
    const state = result.stdout.toString().trim();
    return state === "visible" || state === "hidden" || state === "notDetected" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

export function focusObsWindow(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
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
        "Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class MatchdayObsWindow { [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\n'@; $process = Get-Process -Name obs64,obs -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($null -eq $process) { '0' } else { [void][MatchdayObsWindow]::ShowWindowAsync($process.MainWindowHandle, 9); [void][MatchdayObsWindow]::SetForegroundWindow($process.MainWindowHandle); '1' }",
      ],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    return result.exitCode === 0 && result.stdout.toString().trim() === "1";
  } catch {
    return false;
  }
}

function spawnObs(executablePath: string, options: ObsSpawnOptions): void {
  const child = Bun.spawn([executablePath], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Do not make OBS a child tied to the Matchday Control lifetime. On
    // Windows, a GUI child without a detached process group can be terminated
    // together with the launcher when the executable or service stops.
    detached: options.detached,
    // OBS is a GUI application: hiding the child window can leave obs64.exe
    // running without a usable main window.
    windowsHide: options.windowsHide,
  });
  (child as unknown as { unref?: () => void }).unref?.();
}
