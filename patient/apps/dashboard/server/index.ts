import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env";
import { fetchEvents } from "./clickhouse";
import { getLatestRecalls, getRecallDetail, isValidRecallId } from "./recalls";
import {
  addPatient,
  checkDrug,
  isValidDrugQuery,
  loadRegistry,
  readJsonBody,
  updateDrugs,
  validateDrugs,
  validateNewPatient,
} from "./registry";
import { listNotifications, readMonitorStatus, dataSource } from "@supershield/sources";
import { alertNewPatient, type InstantAlertResult } from "./alerts";

loadEnv();

const PORT = Number(process.env.PORT ?? 3000);
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveStatic(res: import("node:http").ServerResponse, urlPath: string) {
  let rel = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  if (rel === "/") rel = "/index.html";
  const filePath = normalize(join(DIST, rel));

  // Evita path traversal fuera de dist/.
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error("dir");
    const buf = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    // SPA fallback -> index.html
    try {
      const buf = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        "Dashboard not built yet. Run:  npm run build -w @supershield/dashboard",
      );
    }
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  try {
    if (url.startsWith("/api/events")) {
      const data = await fetchEvents();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.startsWith("/api/recalls/latest")) {
      const raw = Number(new URL(url, "http://x").searchParams.get("limit"));
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 500;
      const data = await getLatestRecalls(limit);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.startsWith("/api/recall/")) {
      const id = decodeURIComponent(url.slice("/api/recall/".length).split("?")[0] ?? "");
      if (!isValidRecallId(id)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid recall id" }));
        return;
      }
      const detail = await getRecallDetail(id);
      if (!detail) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "recall not found" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
      res.end(JSON.stringify(detail));
      return;
    }
    if (url.startsWith("/api/drug-check")) {
      const name = new URL(url, "http://localhost").searchParams.get("name")?.trim() ?? "";
      if (!isValidDrugQuery(name)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid medication name" }));
        return;
      }
      const data = await checkDrug(name);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.startsWith("/api/monitor/status")) {
      const status = readMonitorStatus() ?? {
        running: false,
        intervalSec: Number(process.env.WORKER_INTERVAL_SEC || 60),
        dataSource: dataSource(),
        patientsChecked: 0,
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(status));
      return;
    }
    const patientRoute = /^\/api\/patients\/([\w-]{1,20})\/(notifications|drugs)$/.exec(
      url.split("?")[0] ?? "",
    );
    if (patientRoute) {
      const [, id = "", action] = patientRoute;
      if (action === "notifications") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ notifications: listNotifications(id) }));
        return;
      }
      if (req.method !== "PUT") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "use PUT" }));
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
      const drugs = validateDrugs(body);
      if (typeof drugs === "string") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: drugs }));
        return;
      }
      const patient = updateDrugs(id, drugs);
      if (!patient) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "patient not found" }));
        return;
      }
      // Revisión inmediata de lo recién guardado; el worker sigue en su ciclo.
      void alertNewPatient(patient).catch((e) =>
        console.warn(`[instant-alert] ${(e as Error).message}`),
      );
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(patient));
      return;
    }
    if ((url.split("?")[0] ?? "") === "/api/patients") {
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: (e as Error).message }));
          return;
        }
        const valid = validateNewPatient(body);
        if (typeof valid === "string") {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: valid }));
          return;
        }
        const patient = addPatient(valid.name, valid.drugs);
        // Alerta inmediata: si el doctor confirmó un fármaco con recall
        // ("Add anyway"), el aviso a Slack sale ahora, no en la pasada del worker.
        let alert: InstantAlertResult;
        try {
          alert = await alertNewPatient(patient);
        } catch (e) {
          alert = { alerted: false, error: (e as Error).message };
        }
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ patient, alert }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(loadRegistry()));
      return;
    }
    if (url.startsWith("/healthz")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    await serveStatic(res, url);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(PORT, () => {
  console.log(`📊 SuperShield Patient dashboard at http://localhost:${PORT}`);
});
