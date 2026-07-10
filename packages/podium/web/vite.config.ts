/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Build emits static assets into the Podium package's served static dir.
// Podium owns the origin root, so SPA deep links must resolve assets from it.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("../src/podium/static", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Proxy API calls to a locally running Podium backend during `npm run dev`.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});
