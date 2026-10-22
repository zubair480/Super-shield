// Datos livianos del globo (sin three.js), para que el hero no cargue WebGL de inmediato.

export interface GlobeMarker {
  lat: number;
  lon: number;
  tone: "I" | "II" | "III" | "bg";
}

/* Centroides aproximados por estado (para ubicar al fabricante del recall). */
export const STATE_LL: Record<string, [number, number]> = {
  AL: [32.8, -86.8], AK: [61.4, -152.3], AZ: [34.2, -111.7], AR: [34.9, -92.4], CA: [36.8, -119.4],
  CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5], FL: [28.6, -82.4], GA: [32.7, -83.4],
  HI: [20.8, -156.3], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5],
  KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8],
  MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7], MO: [38.4, -92.5],
  MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6], NJ: [40.1, -74.7],
  NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
  OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9],
  SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7],
  VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43.0, -107.6],
  DC: [38.9, -77.0], PR: [18.2, -66.5],
};

/* Países frecuentes en openFDA (fabricantes fuera de EE. UU.). */
export const COUNTRY_LL: Record<string, [number, number]> = {
  India: [21.0, 78.0], China: [35.0, 103.0], Canada: [56.0, -106.0], Germany: [51.0, 10.0],
  Italy: [42.8, 12.5], Spain: [40.4, -3.7], France: [46.6, 2.4], "United Kingdom": [54.0, -2.0],
  Switzerland: [46.8, 8.2], Israel: [31.0, 35.0], Ireland: [53.4, -8.2], Japan: [36.2, 138.3],
  "Korea (the Republic of)": [36.5, 127.9], Mexico: [23.6, -102.5], Taiwan: [23.7, 121.0],
};
