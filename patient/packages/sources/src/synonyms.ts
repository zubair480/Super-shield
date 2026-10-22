// openFDA usa nombres en inglés. Mapeamos nombres comunes ES -> EN para que el
// match funcione con un padrón en español. Si no hay sinónimo, se usa el original.

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalize(s: string): string {
  return stripAccents(s).trim().toLowerCase();
}

const SYNONYMS: Record<string, string> = {
  aspirina: "aspirin",
  "acido acetilsalicilico": "aspirin",
  paracetamol: "acetaminophen",
  acetaminofen: "acetaminophen",
  ibuprofeno: "ibuprofen",
  naproxeno: "naproxen",
  diclofenaco: "diclofenac",
  ketorolaco: "ketorolac",
  omeprazol: "omeprazole",
  ranitidina: "ranitidine",
  metformina: "metformin",
  atorvastatina: "atorvastatin",
  simvastatina: "simvastatin",
  losartan: "losartan",
  valsartan: "valsartan",
  enalapril: "enalapril",
  amlodipino: "amlodipine",
  metoprolol: "metoprolol",
  clopidogrel: "clopidogrel",
  warfarina: "warfarin",
  insulina: "insulin",
  levotiroxina: "levothyroxine",
  amoxicilina: "amoxicillin",
  azitromicina: "azithromycin",
  sertralina: "sertraline",
  fluoxetina: "fluoxetine",
  alprazolam: "alprazolam",
  prednisona: "prednisone",
};

/** Término canónico (inglés) para consultar/matchear openFDA. */
export function canonicalDrug(drug: string): string {
  const n = normalize(drug);
  return SYNONYMS[n] ?? drug.trim();
}
