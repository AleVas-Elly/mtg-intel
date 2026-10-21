import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: { target: "es2022", cssMinify: true, assetsInlineLimit: 0 },
  server: { proxy: { "/api": "https://mtg-intel.mtgintel-096633.workers.dev", "/sym": "https://mtg-intel.mtgintel-096633.workers.dev" } },
});
