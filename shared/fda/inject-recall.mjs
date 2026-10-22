#!/usr/bin/env node
// Inject ONE synthetic openFDA drug/enforcement-shaped recall into demo-recalls.json.
// Both SuperShield workflows (Pharmacy + Patient) read this file alongside live openFDA.
//
// Usage:
//   node shared/fda/inject-recall.mjs --drug Metformin [--ndc 00093-1048-01] [--class "Class I"] [--strength "500 mg"]
//   node shared/fda/inject-recall.mjs --reset        # empties the file (production default: [])
//
// Plain Node ESM, no dependencies.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'demo-recalls.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function load() {
  if (!existsSync(FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8') || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    console.error(`warning: ${FILE} was not valid JSON; starting from []`);
    return [];
  }
}

function save(records) {
  writeFileSync(FILE, JSON.stringify(records, null, 2) + '\n');
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const args = parseArgs(process.argv.slice(2));

if (args.reset) {
  save([]);
  console.log(`reset: ${FILE} now contains []`);
  process.exit(0);
}

if (!args.drug || args.drug === true) {
  console.error('usage: node shared/fda/inject-recall.mjs --drug <name> [--ndc <ndc>] [--class "Class I|II|III"] [--strength "500 mg"] | --reset');
  process.exit(1);
}

const drug = String(args.drug).trim();
const ndc = typeof args.ndc === 'string' ? args.ndc : '00093-1048-01'; // metformin-style NDC format; synthetic
const classification = typeof args.class === 'string' ? args.class : 'Class II';
if (!/^Class (I|II|III)$/.test(classification)) {
  console.error(`invalid --class "${classification}" (expected Class I, Class II or Class III)`);
  process.exit(1);
}
const strength = typeof args.strength === 'string' ? args.strength : '500 mg';

const records = load();
const existing = new Set(records.map((r) => r.recall_number));
let recallNumber;
for (let tries = 0; tries < 10000; tries++) {
  const n = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const candidate = `D-SS-${n}-2026`;
  if (!existing.has(candidate)) { recallNumber = candidate; break; }
}
if (!recallNumber) {
  console.error('could not generate a unique recall_number; run with --reset');
  process.exit(1);
}

const now = new Date();
const today = ymd(now);
const lotSuffix = () => String(Math.floor(Math.random() * 90000) + 10000);
const exp1 = new Date(now.getFullYear() + 1, 5, 30);
const exp2 = new Date(now.getFullYear() + 1, 11, 31);
const fmtExp = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const generic = drug.toUpperCase();

const record = {
  recall_number: recallNumber,
  classification,
  status: 'Ongoing',
  product_type: 'Drugs',
  event_id: String(90000 + Math.floor(Math.random() * 9999)),
  reason_for_recall:
    `CGMP Deviations: Detection of N-Nitrosodimethylamine (NDMA) impurity above the FDA acceptable daily intake limit (96 ng/day) in ${titleCase(drug)} tablets.`,
  product_description:
    `${titleCase(drug)} Tablets, USP, ${strength}, 100-count bottle, Rx only, NDC ${ndc}. SYNTHETIC TEST RECORD.`,
  product_quantity: '12,480 bottles',
  recalling_firm: 'SuperShield Test Labs (synthetic)',
  address_1: '100 Synthetic Way',
  city: 'Testville',
  state: 'NJ',
  postal_code: '07001',
  country: 'United States',
  code_info: `Lot #: SS${lotSuffix()}, Exp ${fmtExp(exp1)}; Lot #: SS${lotSuffix()}, Exp ${fmtExp(exp2)}`,
  report_date: today,
  recall_initiation_date: today,
  center_classification_date: today,
  distribution_pattern: 'Nationwide',
  voluntary_mandated: 'Voluntary: Firm initiated',
  initial_firm_notification: 'Letter',
  openfda: {
    brand_name: [titleCase(drug)],
    generic_name: [generic],
    substance_name: [generic],
    product_ndc: [ndc],
    package_ndc: [ndc],
    manufacturer_name: ['SuperShield Test Labs (synthetic)'],
  },
  synthetic: true,
};

records.push(record);
save(records);

console.log(recallNumber);
console.error(`injected synthetic ${classification} recall for ${titleCase(drug)} (NDC ${ndc}) into ${FILE} [${records.length} record(s) total]`);
