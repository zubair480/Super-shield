import { readFileSync } from "node:fs";

export interface Patient {
  id: string;
  name: string;
  drugs: string[];
}

// Default registry: demo/seed-data/patients.json. Override with PATIENTS_FILE
// (absolute or cwd-relative path) to point the worker at your own roster.
const DEFAULT_URL = new URL(
  "../../../demo/seed-data/patients.json",
  import.meta.url,
);

export function loadPatients(): Patient[] {
  const custom = process.env.PATIENTS_FILE?.trim();
  const source = custom || DEFAULT_URL;
  const rows = JSON.parse(readFileSync(source, "utf8")) as Patient[];
  if (!Array.isArray(rows)) {
    throw new Error(`Patient registry is not a JSON array: ${custom ?? "seed"}`);
  }
  return rows;
}
