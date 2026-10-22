-- Phase 7 (SuperShield Pharmacy): pharmacist alert + follow-up tables.
-- Same ClickHouse database as the lakehouse - no new datastore.

-- Older lakehouses predate these shared columns (patient workflow uses them).
ALTER TABLE supershield.fda_recalls ADD COLUMN IF NOT EXISTS product_description String DEFAULT '';
ALTER TABLE supershield.fda_recalls ADD COLUMN IF NOT EXISTS generic_name String DEFAULT '';

-- One row per recall that matched pharmacy dispensing records by NDC.
-- ReplacingMergeTree on updated_at so status changes are plain inserts.
CREATE TABLE IF NOT EXISTS supershield.pharmacist_alerts
(
    recall_number   String,
    product_ndc     String,
    severity        String,
    classification  String,
    recalling_firm  String,
    reason_for_recall String,
    source_url      String,
    origin          String,   -- live | backfill | synthetic_demo
    match_type      String,   -- ndc_candidate (lot not yet verified)
    customers       UInt64,
    pharmacies      UInt64,
    states          UInt64,
    status          String,   -- new | reviewing | resolved
    detected_at     DateTime,
    updated_at      DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY recall_number;

-- Pharmacist follow-up per affected customer. Absence of a row = not yet reviewed.
CREATE TABLE IF NOT EXISTS supershield.customer_followups
(
    recall_number String,
    customer_id   String,
    status        String,   -- contacted | lot_verified | not_affected
    updated_at    DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (recall_number, customer_id);

-- Result of the real phone push for this alert (sent / not_configured / error text).
ALTER TABLE supershield.pharmacist_alerts ADD COLUMN IF NOT EXISTS push_status String DEFAULT '';
