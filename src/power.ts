import { dlopen, FFIType } from "bun:ffi";

// SetThreadExecutionState flags from Win32.
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_DISPLAY_REQUIRED = 0x00000002;
const KEEP_SYSTEM_AWAKE = ES_CONTINUOUS + ES_SYSTEM_REQUIRED + ES_DISPLAY_REQUIRED;

export interface PowerRequest {
  release(): void;
}

const NOOP_REQUEST: PowerRequest = { release() {} };

/**
 * Impede suspensão/hibernação e desligamento automático dos ecrãs enquanto o
 * processo está ativo.
 * Ao terminar o processo, o Windows também elimina automaticamente o pedido.
 */
export function keepSystemAwake(): PowerRequest {
  if (process.platform !== "win32") return NOOP_REQUEST;

  try {
    const kernel32 = dlopen("kernel32.dll", {
      SetThreadExecutionState: {
        args: [FFIType.u32],
        returns: FFIType.u32,
      },
    });

    const previousState = kernel32.symbols.SetThreadExecutionState(KEEP_SYSTEM_AWAKE);
    if (previousState === 0) {
      console.warn("[power] Could not prevent automatic Windows sleep.");
      return NOOP_REQUEST;
    }

    let active = true;
    return {
      release(): void {
        if (!active) return;
        active = false;
        kernel32.symbols.SetThreadExecutionState(ES_CONTINUOUS);
      },
    };
  } catch (error) {
    console.warn(
      `[power] Power control unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return NOOP_REQUEST;
  }
}
