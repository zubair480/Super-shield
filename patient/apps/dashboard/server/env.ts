import { fileURLToPath } from "node:url";

// Carga .env si existe (Node >= 20.6, sin dependencias). El .env vive en la
// raíz del repo y el cwd depende de cómo se lance el server (npm -w corre
// desde apps/dashboard), así que primero se resuelve relativo a este archivo
// y luego se intenta el del cwd. Sin .env, se usa process.env (Render/CI).
export function loadEnv(): void {
  const load = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (!load) return;
  const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
  for (const path of [rootEnv, undefined]) {
    try {
      load.call(process, path);
      return;
    } catch {
      /* sin archivo .env en esa ruta: probar la siguiente */
    }
  }
}
