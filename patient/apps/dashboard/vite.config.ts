import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// El frontend (React) corre en :5173 en dev y proxya /api al server Node (:3000).
// En producción, `vite build` -> dist/ y el server Node sirve esos archivos.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
