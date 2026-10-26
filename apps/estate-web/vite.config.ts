import { defineConfig } from "vitest/config";

// `base: "./"` keeps every asset URL relative, so the static build works
// from any sub-path — a GitHub Pages project site included.
export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist" },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000 },
});
