import { resolve } from "node:path";

/**
 * Cria um ICO simples com o PNG fornecido.
 * Windows aceita PNG comprimido dentro de uma entrada ICO, evitando dependências
 * externas só para gerar o ícone da aplicação.
 */
export async function createIco(inputPath: string, outputPath: string): Promise<void> {
  const png = new Uint8Array(await Bun.file(inputPath).arrayBuffer());
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    throw new Error(`O recurso do ícone não é um PNG válido: ${inputPath}`);
  }

  // ICONDIR + uma entrada: largura/altura 0 representam 256px.
  const ico = new Uint8Array(22 + png.length);
  const view = new DataView(ico.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  ico[6] = 0;
  ico[7] = 0;
  ico[8] = 0;
  ico[9] = 0;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.length, true);
  view.setUint32(18, 22, true);
  ico.set(png, 22);
  await Bun.write(outputPath, ico);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  await createIco(resolve(root, "assets", "app-icon.png"), resolve(root, "assets", "app-icon.ico"));
}
