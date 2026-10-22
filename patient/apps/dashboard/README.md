# @farmavigia/dashboard

Frontend en **React + Vite** con un mini-servidor Node que sirve el build y expone:

- `/api/events` — lee la tabla `events` de **ClickHouse** vía HTTP, con fallback al
  respaldo `demo/seed-data/events-backup.json` si la DB no responde (Plan B).
- `/api/recall/:id` — dossier completo de un recall (motivo, fabricante, lotes,
  distribución, cantidad, cronología). Resuelve primero contra el fixture
  `demo/seed-data/recalls.json` (determinista, funciona offline) y si no está ahí,
  consulta **openFDA** en vivo con caché en memoria.

> Dueño: Persona A. No toca `analytics/dashboard/` de Persona B.

## Local

```bash
# Opción rápida (build + servir en :3000)
npm run dashboard:build      # vite build -> apps/dashboard/dist
npm run dashboard            # server Node en http://localhost:3000

# Opción dev (hot reload de React en :5173, proxya /api al server :3000)
npm run dev:server -w @farmavigia/dashboard   # terminal 1
npm run dev:web    -w @farmavigia/dashboard   # terminal 2  -> http://localhost:5173
```

Sin `CLICKHOUSE_URL` configurado, el dashboard muestra el respaldo (badge "Respaldo").
Con `CLICKHOUSE_URL` (la que comparte Persona B), lee datos reales (badge "ClickHouse").

## Deploy en Render (Web Service)

- **Build Command:** `npm install && npm run build -w @farmavigia/dashboard`
- **Start Command:** `npm run start -w @farmavigia/dashboard`
- **Env vars:** `CLICKHOUSE_URL` (Render inyecta `PORT` automáticamente)
- **Health check path:** `/healthz`

> El tooling de build (vite, tsx, react) está en `dependencies` a propósito, para que
> Render lo instale aunque `NODE_ENV=production`.
>
> Si Persona B prefiere centralizar todo en `render.yaml`, agregar este servicio ahí
> (en vez de crearlo desde la UI). Coordinarlo para no duplicar.
