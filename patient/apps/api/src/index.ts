import { config } from 'dotenv';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirnameEnv = dirname(fileURLToPath(import.meta.url));
// Carga .env de la raíz del repo (funciona en dev tsx y en dist compilado).
config({ path: resolve(__dirnameEnv, '../../../.env') });
import type { Alert, SafetyCheckRequest } from '@farmavigia/shared';
import { postAlert } from '@farmavigia/notifier';
// M2: checkDrugSafety real de A (openFDA + seed fallback + boletín vía LLM).
import { checkDrugSafety } from '@farmavigia/sources';
import {
  initSchema,
  writeEvent,
  queryEvents,
  clickhouseEnabled,
} from './clickhouse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolve(__dirname, '../../../analytics/dashboard');

const app = express();
app.use(express.json());
app.use(express.static(DASHBOARD_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true, clickhouse: clickhouseEnabled(), dryRun: process.env.DRY_RUN === 'true' });
});

// POST /check — núcleo del flujo end-to-end
app.post('/check', async (req, res) => {
  const body = req.body as SafetyCheckRequest;
  if (!body?.drugs || !Array.isArray(body.drugs) || body.drugs.length === 0) {
    return res.status(400).json({ error: 'Falta drugs: string[]' });
  }

  try {
    const report = await checkDrugSafety(body);

    // 1) Loggear recalls detectados + (opcional) match de paciente
    for (const d of report.drugs) {
      for (const r of d.activeRecalls) {
        await writeEvent('recall_detected', {
          input: d.input,
          recallId: r.recallId,
          classification: r.classification,
          reason: r.reason,
          sourceUrl: r.sourceUrl,
        });
      }
    }
    const hits = report.drugs.filter((d) => d.activeRecalls.length > 0);
    if (body.patientId && hits.length) {
      await writeEvent('patient_matched', {
        patientId: body.patientId,
        drugs: hits.map((d) => d.input),
      });
    }

    // 2) Boletín generado
    await writeEvent('bulletin_generated', {
      patientId: body.patientId ?? null,
      bulletin: report.bulletin,
    });

    // 3) Si hay retiro activo, disparar alerta vía Composio
    let alertResult: { ok: boolean; ref: string } | null = null;
    const first = hits[0];
    const top = first?.activeRecalls[0];
    if (first && top) {
      const alert: Alert = {
        title: `⚠️ Retiro FDA Clase ${top.classification} — ${first.input}`,
        body: report.bulletin,
        channel: 'slack',
        provenance: report.sources.map((url) => ({ url })),
      };
      alertResult = await postAlert(alert);
      await writeEvent('alert_sent', {
        channel: alert.channel,
        ok: alertResult.ok,
        ref: alertResult.ref,
        title: alert.title,
      });
    }

    res.json({ report, alert: alertResult });
  } catch (err) {
    console.error('[/check] error:', err);
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

// GET /events — alimenta el dashboard
app.get('/events', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    const rows = await queryEvents(limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

const PORT = Number(process.env.PORT) || 3000;

initSchema()
  .catch((e) => console.error('[init] schema falló (sigo de todas formas):', e))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`🚀 FarmacoVigía API en http://localhost:${PORT}`);
      console.log(`   Dashboard: http://localhost:${PORT}/`);
      console.log(`   ClickHouse: ${clickhouseEnabled() ? 'on' : 'off (respaldo en memoria)'}`);
      console.log(`   DRY_RUN: ${process.env.DRY_RUN === 'true'}`);
    });
  });
