import type { CheckDrugSafety, RecallHit, SafetyReport } from '@farmavigia/shared';

// MOCK determinista que B usa hasta M2.
// En M2 se reemplaza por el checkDrugSafety real de A (packages/sources).
// Mantiene un "recall sembrado" para que la demo siempre encuentre algo.

const SEEDED: Record<string, RecallHit> = {
  losartan: {
    recallId: 'D-1234-2026',
    classification: 'I',
    reason: 'Contaminación con nitrosaminas (NMBA) por encima del límite aceptable.',
    status: 'Ongoing',
    sourceUrl: 'https://api.fda.gov/drug/enforcement.json?search=losartan',
  },
  metformin: {
    recallId: 'D-5678-2026',
    classification: 'II',
    reason: 'Niveles de NDMA por encima del límite diario aceptable.',
    status: 'Ongoing',
    sourceUrl: 'https://api.fda.gov/drug/enforcement.json?search=metformin',
  },
};

export const checkDrugSafetyMock: CheckDrugSafety = async (req) => {
  const drugs = req.drugs.map((input) => {
    const key = input.trim().toLowerCase();
    const hit = SEEDED[key];
    return { input, activeRecalls: hit ? [hit] : [] };
  });

  const anyHit = drugs.some((d) => d.activeRecalls.length > 0);
  const sources = drugs.flatMap((d) => d.activeRecalls.map((r) => r.sourceUrl));

  const bulletin = anyHit
    ? `Se detectó al menos un fármaco con retiro activo de la FDA. ` +
      drugs
        .filter((d) => d.activeRecalls.length)
        .map((d) => {
          const r = d.activeRecalls[0];
          return r ? `${d.input}: retiro Clase ${r.classification} — ${r.reason}` : d.input;
        })
        .join(' ') +
      ` Suspenda el uso y contacte a su médico o farmacéutico.`
    : `No se encontraron retiros activos de la FDA para los fármacos consultados.`;

  const report: SafetyReport = {
    drugs,
    bulletin,
    sources,
    generatedAt: new Date().toISOString(),
    disclaimer:
      'Información generada automáticamente con fines informativos. No sustituye el consejo de un profesional de salud.',
  };
  return report;
};
