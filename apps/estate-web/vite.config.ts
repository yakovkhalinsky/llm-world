import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * The 3D front end is apps/estate's own page3d, reused byte for byte: the
 * estate's viewer, HUD and scene, then what it shares with the grove
 * (apps/shared/page3d, three.js vendored). They are served at `3d/` in dev
 * and copied there in the build — never forked into this app, so a fix to
 * the Python app's page is a fix here too. The estate's folder wins a
 * name both have, the order web.py serves them in.
 */
const PAGE3D = [
  resolve(import.meta.dirname, "../estate/estate/page3d"),
  resolve(import.meta.dirname, "../shared/page3d"),
];
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

function files(dir: string, at = ""): string[] {
  return readdirSync(join(dir, at)).flatMap((n) => {
    const rel = at ? `${at}/${n}` : n;
    return statSync(join(dir, rel)).isDirectory() ? files(dir, rel) : [rel];
  });
}

function page3d(): Plugin {
  const find = (rel: string): string | null => {
    for (const dir of PAGE3D) {
      const p = resolve(dir, rel);
      if (p.startsWith(dir + sep) && statSync(p, { throwIfNoEntry: false })?.isFile()) return p;
    }
    return null;
  };
  return {
    name: "estate-page3d",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!;
        if (!path.startsWith("/3d/")) return next();
        const p = find(decodeURIComponent(path.slice(4)));
        if (!p) return next();
        res.setHeader("Content-Type", TYPES[extname(p)] ?? "application/octet-stream");
        res.end(readFileSync(p));
      });
    },
    generateBundle() {
      const seen = new Set<string>();
      for (const dir of PAGE3D) {
        for (const rel of files(dir)) {
          // index.html is the Python server's page; this app has its own
          if (rel === "index.html" || seen.has(rel)) continue;
          seen.add(rel);
          this.emitFile({ type: "asset", fileName: `3d/${rel}`, source: readFileSync(join(dir, rel)) });
        }
      }
    },
  };
}

// `base: "./"` keeps every asset URL relative, so the static build works
// from any sub-path — a GitHub Pages project site included.
export default defineConfig({
  base: "./",
  plugins: [page3d()],
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist" },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000 },
});
