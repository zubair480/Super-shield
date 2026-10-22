# FarmacoVigía — Demo de 2 horas (2 personas)

> Principio: un solo flujo end-to-end que **siempre funciona en vivo** porque es determinista (recall sembrado). Persona A construye el *agente clínico* (worker + dominio + LLM). Persona B construye los *rieles* (API + ClickHouse + Composio + Render). Se tocan solo a través de 2 funciones y 1 tabla de ClickHouse, congeladas en el commit inicial.
>
> **Sin AWS. Sin crypto.** Sponsors objetivo: **TrueFoundry** (AI Gateway), **Composio** (Slack/Gmail), **ClickHouse** (base de datos), **Render** (deploy del backend).

## La narrativa del demo (lo que ven los jueces)

Un agente de farmacovigilancia que **vigila los retiros de medicamentos de la FDA** (openFDA), los **cruza contra un padrón sintético de pacientes**, y cuando un paciente toma un fármaco retirado:

1. Genera un **boletín en español claro** con Claude → vía el **AI Gateway de TrueFoundry**.
2. **Empuja la alerta a Slack/Gmail** → vía **Composio**.
3. **Registra cada evento en ClickHouse**.
4. Todo vive en una **URL de Render** con un mini-dashboard de eventos.

## Quién es quién

| | Rama | Misión | Carpetas propias |
|---|---|---|---|
| **Persona A** | `feat/agente-clinico` | El agente que vigila, cruza y redacta | `apps/worker/`, `packages/sources/`, `demo/seed-data/` |
| **Persona B** | `feat/rieles` | API + datos + notificación + que viva en una URL | `apps/api/`, `packages/notifier/`, `analytics/dashboard/`, `render.yaml` |

| Compartido (congelado en M0) | Dueño |
|---|---|
| `packages/shared/` (tipos), `analytics/schema.sql`, `.env.example`, `package.json` raíz, CI | **Cambios solo de a dos, commit directo a `main`** |

Cada package tiene su propio `package.json` (workspaces) para que las dependencias de A y B no choquen. El lockfile lo regenera quien mergea segundo.

## El contrato (commiteado a `main` en M0, antes de branchear)

Cada quien consume **una** función del otro; ambas nacen como mock para no bloquearse:

```ts
// packages/shared/src/types.ts
export interface SafetyCheckRequest { patientId?: string; drugs: string[] }
export interface RecallHit { recallId: string; classification: 'I'|'II'|'III'; reason: string; status: string; sourceUrl: string }
export interface SafetyReport {
  drugs: { input: string; activeRecalls: RecallHit[] }[]
  bulletin: string             // texto en español generado por Claude vía TrueFoundry
  sources: string[]            // URLs de provenance (openFDA)
  generatedAt: string
  disclaimer: string
}
export interface Alert { title: string; body: string; channel: 'slack'|'gmail'; provenance: { url: string }[] }

// Contrato A → B (A la implementa en packages/sources; B la consume en apps/api)
export type CheckDrugSafety = (req: SafetyCheckRequest) => Promise<SafetyReport>

// Contrato B → A (B la implementa en packages/notifier vía Composio; A la consume en apps/worker)
export type PostAlert = (a: Alert) => Promise<{ ok: boolean; ref: string }>
```

```sql
-- analytics/schema.sql (dueño A; B solo lee para el dashboard)
CREATE TABLE events (
  ts DateTime, kind LowCardinality(String), payload String
) ENGINE = MergeTree ORDER BY (kind, ts);
-- kinds: recall_detected | patient_matched | bulletin_generated | alert_sent
```

`.env.example` desde M0 (valores reales después):
`CLICKHOUSE_URL`, `COMPOSIO_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `OPENFDA_BASE`.

**Regla del cliente LLM:** A escribe UNA función `llmComplete(model, prompt)` OpenAI-compatible, parametrizada por `LLM_BASE_URL`/`LLM_API_KEY`. El default apunta al **AI Gateway de TrueFoundry** con una virtual key que emite B: toda la inferencia pasa por ahí, el código nunca toca keys de proveedores. Cambiar de modelo = cambiar el string `model`. Fallback si el gateway falla en vivo: apuntar `LLM_BASE_URL` a un proveedor directo (mismo código).

## Cadencia de merges — 3 puntos en 2 horas

| Punto | Hora | Qué se mergea | Criterio de aceptación |
|---|---|---|---|
| **M0** | h0 (~10 min, juntos) | Scaffold + contrato en `main` | `npm run build` verde; tipos y DDL commiteados; ambos branchean. *(Ya existe el commit de scaffold — solo se actualiza el contrato a esta versión.)* |
| **M1** | ~h1 | Avances de ambos con mocks | A: `checkDrugSafety` devuelve datos **reales** de openFDA. B: endpoint `/check` responde, **escribe en ClickHouse** y `postAlert` **publica de verdad** en Slack con un reporte mock. TrueFoundry virtual key probada con un completion. |
| **M2** | ~h1:45 | La integración grande | B reemplaza su mock por el `checkDrugSafety` real de A. **End-to-end:** recall sembrado → match de paciente → boletín de Claude (TrueFoundry) → alerta a Slack/Gmail (Composio) → eventos en ClickHouse → visibles en el dashboard de Render. |
| **Freeze** | últimos ~15 min | Solo `main` | Seeds deterministas, guion de demo, README, deploy final en Render. |

## Reparto media hora por media hora

**Persona A — `feat/agente-clinico`**

| Tiempo | Tarea |
|---|---|
| 0:00–0:10 | (juntos) M0: actualizar `types.ts`, `schema.sql`, `.env.example`; `npm run build` verde; branchear |
| 0:10–0:45 | `packages/sources`: cliente openFDA (endpoint *drug enforcement*) + match de fármacos contra padrón sintético → `RecallHit[]` |
| 0:45–1:20 | `apps/worker` + `llmComplete()`: cruzar recall vs pacientes sintéticos → boletín con Claude (gateway TrueFoundry) → llamar `postAlert` (mock→real) + helper para loggear eventos a ClickHouse |
| 1:20–1:45 | Implementación final de `checkDrugSafety` para B + **fixture de recall sembrado** (demo determinista) |
| 1:45–2:00 | (juntos) seeds, ensayo del demo end-to-end |

**Persona B — `feat/rieles`**

| Tiempo | Tarea |
|---|---|
| 0:00–0:10 | (juntos) M0 + crear instancia **ClickHouse Cloud** (free) y obtener `CLICKHOUSE_URL` + cuenta **Render** |
| 0:10–0:45 | `apps/api`: endpoint Express `/check` que llama `checkDrugSafety` (mock primero) + cliente ClickHouse + escritura de `events` + correr `schema.sql`. Emitir la **virtual key de TrueFoundry** y entregarla a A. |
| 0:45–1:20 | `packages/notifier`: `postAlert` vía **Composio** a Slack (+ Gmail si da tiempo); probar publicando una alerta de ejemplo |
| 1:20–1:45 | Mini-dashboard que lee `events` de ClickHouse + **deploy en Render** (`render.yaml`, web service) |
| 1:45–2:00 | (juntos) conectar el `checkDrugSafety` real, test end-to-end, deploy final |

## Reglas de git (para no pelearse en el merge)

1. Las dos ramas salen de `main` en M0 y mergean a `main` en M1 y M2 (no big-bang al final).
2. Después de cada M, ambos hacen `git merge main` en su rama (o rebase, pero elijan UNO los dos).
3. PR cruzado en cada M: revisión de máximo 5 min — "¿rompes algo mío?".
4. Conflicto esperado único: lockfile raíz → lo regenera quien mergea segundo (`rm package-lock.json && npm install`).
5. Si necesitas algo de la carpeta del otro: NO lo edites — pídelo o agréguenlo a `packages/shared` juntos.
6. Commits con prefijo de área (`worker:`, `api:`, `notifier:`, `sources:`) para que el log cuente la historia en el repo público que ven los jueces.

## Plan B si algo falla en vivo (sin esto no hay demo)

- **Recall sembrado** en `demo/seed-data/`: el worker corre contra un fixture fijo, no depende de que openFDA responda en el momento.
- **`postAlert` con flag `DRY_RUN`**: si Composio/Slack cae, imprime la alerta en consola y sigue.
- **`llmComplete` con fallback**: si el gateway de TrueFoundry falla, `LLM_BASE_URL` apunta a proveedor directo (mismo código).
- El dashboard lee de ClickHouse, pero guarda un **JSON de respaldo** con los últimos eventos por si la DB no responde.
