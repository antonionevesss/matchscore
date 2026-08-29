/**
 * Verifica se um PID ainda está ativo no Windows.
 * O mesmo mecanismo é usado pelo lock da aplicação e pelo saneamento do
 * pacote de build, para evitar que estas duas rotinas se desviem.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return new RegExp(`\\b${pid}\\b`).test(result.stdout.toString());
  } catch {
    // À cautela: se não conseguirmos verificar, assume-se vivo (não duplica).
    return true;
  }
}
