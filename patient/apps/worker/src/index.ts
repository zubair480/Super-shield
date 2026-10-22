import { loadEnv } from "./env";
import {
  dataSource,
  monitorPatient,
  readMonitorStatus,
  writeMonitorStatus,
} from "@supershield/sources";
import { loadPatients } from "./patients";
import { recordEvent } from "./eventlog";
import { postAlert } from "./notify";

// El agente de SuperShield Patient (sobre SuperShield Patient):
//   registro de pacientes -> checkDrugSafety (openFDA + feed compartido + boletín Claude)
//   -> notificación in-app (siempre) + entrega externa vía Composio (estado real)
//   -> eventos en ClickHouse + espejo local. Sin botón de "Scan": corre en bucle.
async function runOnce(): Promise<number> {
  const patients = loadPatients();
  console.log(`🩺 Checking ${patients.length} patient(s) from the registry...`);

  let alertCount = 0;
  for (const patient of patients) {
    try {
      const fresh = await monitorPatient(patient, { postAlert, log: recordEvent });
      if (fresh.length === 0) {
        console.log(`   ✓ ${patient.id}: nothing new.`);
        continue;
      }
      alertCount++;
      console.log(
        `\n✅ ${patient.id}: ${fresh.length} new alert(s) — ${fresh
          .map((n) => `${n.drug} ${n.recallId}`)
          .join(", ")}`,
      );
    } catch (e) {
      console.error(`   ✗ ${patient.id}: check failed (${(e as Error).message})`);
    }
  }

  console.log(`\n🏁 ${alertCount} patient(s) notified out of ${patients.length}.`);
  return patients.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  loadEnv();

  // Monitoreo continuo por defecto (60 s). WORKER_INTERVAL_SEC=0 = una sola pasada.
  const raw = process.env.WORKER_INTERVAL_SEC;
  const intervalSec = raw === undefined || raw === "" ? 60 : Number(raw);

  const run = async () => {
    // Latido al empezar: el dashboard ve "corriendo" aunque la pasada tarde.
    const prev = readMonitorStatus();
    writeMonitorStatus({
      intervalSec,
      lastRunAt: prev?.lastRunAt ?? new Date().toISOString(),
      nextRunAt: new Date().toISOString(),
      dataSource: dataSource(),
      patientsChecked: prev?.patientsChecked ?? 0,
    });
    let patientsChecked = 0;
    let lastError: string | undefined;
    try {
      patientsChecked = await runOnce();
    } catch (e) {
      lastError = (e as Error).message;
      console.error("Run failed (will retry):", lastError);
    }
    const now = Date.now();
    writeMonitorStatus({
      intervalSec,
      lastRunAt: new Date(now).toISOString(),
      nextRunAt: intervalSec > 0 ? new Date(now + intervalSec * 1000).toISOString() : undefined,
      dataSource: dataSource(),
      patientsChecked,
      lastError,
    });
  };

  if (intervalSec > 0) {
    console.log(`🔁 Continuous monitoring — checking every ${intervalSec}s. (Ctrl+C to stop)`);
    for (;;) {
      const stamp = new Date().toLocaleTimeString("en-US", { hour12: false });
      console.log(`\n──────────── run ${stamp} ────────────`);
      await run();
      await sleep(intervalSec * 1000);
    }
  } else {
    await run();
  }
}

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
