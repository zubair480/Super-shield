import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Registro de alertas ya enviadas (clave paciente+retiro). Evita que el modo
// continuo repita la misma alerta en Slack en cada pasada. Espejo local
// simple, igual que events-live.json.
//
// Sin caché en memoria: el server del dashboard también escribe este archivo
// (alertas inmediatas al dar de alta un paciente), así que cada operación
// lee el estado fresco del disco para no pisarse entre procesos.
const SENT_PATH = fileURLToPath(
  new URL("../../../demo/seed-data/alerts-sent.json", import.meta.url),
);

function load(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(SENT_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

export function alertKey(patientId: string, recallId: string): string {
  return `${patientId}:${recallId}`;
}

export function wasAlerted(key: string): boolean {
  return load().has(key);
}

export function markAlerted(keys: string[]): void {
  const set = load();
  for (const key of keys) set.add(key);
  writeFileSync(SENT_PATH, JSON.stringify([...set].sort(), null, 2) + "\n");
}
