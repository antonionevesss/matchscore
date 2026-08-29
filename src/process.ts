import { dlopen, FFIType, ptr } from "bun:ffi";

let kernel32Symbols: {
  OpenProcess: (desiredAccess: number, inheritHandle: boolean, processId: number) => number | bigint | null;
  GetExitCodeProcess: (processHandle: number | bigint, exitCodePtr: any) => boolean;
  CloseHandle: (handle: number | bigint) => boolean;
} | null = null;

if (process.platform === "win32") {
  try {
    const kernel32 = dlopen("kernel32.dll", {
      OpenProcess: {
        args: [FFIType.u32, FFIType.bool, FFIType.u32],
        returns: FFIType.ptr,
      },
      GetExitCodeProcess: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      CloseHandle: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
    });
    kernel32Symbols = kernel32.symbols as unknown as typeof kernel32Symbols;
  } catch {
    kernel32Symbols = null;
  }
}

/**
 * Verifica se um PID ainda está ativo no Windows.
 * Usa Win32 FFI de alta performance (<0.01ms) com fallback seguro para spawnSync.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === "win32" && kernel32Symbols) {
    try {
      const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      const STILL_ACTIVE = 259;
      const hProcess = kernel32Symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!hProcess) return false;
      const exitCodeBuf = Buffer.alloc(4);
      try {
        const ok = kernel32Symbols.GetExitCodeProcess(hProcess, ptr(exitCodeBuf));
        if (!ok) return false;
        return exitCodeBuf.readUInt32LE(0) === STILL_ACTIVE;
      } finally {
        kernel32Symbols.CloseHandle(hProcess);
      }
    } catch {
      // Em caso de erro na FFI, tenta o fallback abaixo.
    }
  }

  try {
    if (process.platform === "win32") {
      const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      return new RegExp(`\\b${pid}\\b`).test(result.stdout.toString());
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

