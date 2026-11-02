import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the UI into the shipped core tree. The output is committed; CI
// rebuilds it and fails when the committed bundle differs.
export default defineConfig({
  root: resolve(__dirname, "ui"),
  plugins: [react()],
  base: "/",
  build: { outDir: resolve(__dirname, "../core/command-center/ui"), emptyOutDir: true, assetsDir: "assets" },
});
