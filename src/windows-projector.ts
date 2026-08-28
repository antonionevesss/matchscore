/**
 * OBS WebSocket accepts an OpenVideoMixProjector request without exposing a
 * projector id or a list of currently open projector windows. On Windows we
 * can still verify the result by enumerating visible top-level windows.
 *
 * PowerShell is used instead of bun:ffi here because the application is
 * distributed as a Windows executable and PowerShell is part of supported
 * Windows installations. The probe is deliberately read-only and only looks
 * for visible windows belonging to OBS whose title identifies them as a
 * projector.
 */

const OBS_PROJECTOR_PROBE = String.raw`
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MatchdayWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

$count = 0
$callback = [MatchdayWindowProbe+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [MatchdayWindowProbe]::IsWindowVisible($hWnd)) { return $true }

    [uint32]$windowPid = 0
    [void][MatchdayWindowProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
    if ($windowPid -eq 0) { return $true }

    try {
        $process = Get-Process -Id $windowPid -ErrorAction Stop
    } catch {
        return $true
    }

    if ($process.ProcessName -notin @('obs64', 'obs')) { return $true }

    $title = New-Object System.Text.StringBuilder 512
    [void][MatchdayWindowProbe]::GetWindowText($hWnd, $title, $title.Capacity)
    $windowTitle = $title.ToString()

    # OBS localizes these words (for example: "Projetor - Antevisão").
    # The second match avoids confusing a Program/Multiview projector with
    # the Preview projector controlled by this application.
    if (($windowTitle -match '(?i)projector|projetor|proyector|projektor|projecteur') -and ($windowTitle -match '(?i)preview|antevis|vista\s*previa|vorschau|aperçu|anteprima|podgląd')) {
        $script:count++
    }

    return $true
}

[void][MatchdayWindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
[Console]::Out.WriteLine($count)
`;

/**
 * Returns the number of visible OBS projector windows, or null when the
 * platform/probe cannot confirm the state.
 */
export async function detectObsPreviewProjectors(): Promise<number | null> {
  if (process.platform !== "win32") return null;

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        OBS_PROJECTOR_PROBE,
      ],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
  } catch {
    return null;
  }

  const timeout = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // The probe may already have exited.
    }
  }, 2_000);

  try {
    const [stdout, exitCode] = await Promise.all([
      typeof child.stdout === "number" ? Promise.resolve("") : new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode !== 0) return null;
    const count = Number(stdout.trim());
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
