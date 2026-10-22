-- analytics/schema.sql
-- Dueño: Persona A. Persona B la corre al arrancar el API (initSchema) y lee la tabla para el dashboard.
-- También puede ejecutarse una vez a mano contra la instancia de ClickHouse (CLICKHOUSE_URL).

CREATE TABLE IF NOT EXISTS events (
  ts      DateTime DEFAULT now(),
  kind    LowCardinality(String),
  payload String
) ENGINE = MergeTree
ORDER BY (kind, ts);

-- kinds emitidos (worker y api):
--   recall_detected | patient_matched | bulletin_generated | alert_sent
