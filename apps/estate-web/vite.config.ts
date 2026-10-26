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

/**
 * This app's page is page3d's own index.html, with every page3d file named
 * relative to the page (3d/...) so the static build works from any
 * sub-path, a seed row under the pace controls, and src/main.ts in place
 * of viewer.js: it answers the page's
 * /api requests from the worker, then starts 3d/viewer.js itself. Each
 * rewrite must find what it rewrites, so a change to page3d's page fails
 * the build here rather than shipping a page that half works.
 */
/** This app's one addition to page3d's controls: which estate, kept or anew. */
const SEED_ROW = `      <div class="speedrow seedrow">
        <span class="hint" title="every estate grows from a seed; the same seed grows the same estate">seed</span>
        <input id="seedIn" inputmode="numeric" aria-label="seed" value="">
        <button id="plantBtn" title="open this seed's estate, where it was left">plant</button>
        <button id="againBtn" title="this seed again from day 0">start over</button>
        <span class="note" id="seedNote"></span>
      </div>`;
const SEED_STYLE = `<style>
  .speedrow.seedrow { flex-wrap: wrap; }
  .seedrow input { width: 5em; min-width: 0; font: inherit; font-size: 12px;
    background: transparent; color: inherit; border: 1px solid var(--edge, #555);
    border-radius: 6px; padding: 3px 6px; font-variant-numeric: tabular-nums; }
  .seedrow .note { flex-basis: 100%; font-size: 11px; color: var(--dim, #999); }
</style>`;

export function page3dIndex(html: string): string {
  const swap = (from: RegExp | string, to: string | ((...m: string[]) => string)) => {
    const out = html.replace(from, to as string);
    if (out === html) throw new Error(`page3d's index.html no longer has ${from}`);
    html = out;
  };
  swap(/<script type="module" src="\/3d\/viewer\.js"><\/script>/, '<script type="module" src="/src/main.ts"></script>');
  swap(/(<div class="speedrow phases">[\s\S]*?<\/div>)/, `$1\n${SEED_ROW}`);
  swap(/(<\/head>)/, `${SEED_STYLE}\n$1`);
  swap(/(src|href)="\/3d\//g, '$1="3d/');
  swap(/(<script type="importmap">)([\s\S]*?)(<\/script>)/, (_m, open, map, close) => {
    const parsed: Record<string, unknown> = JSON.parse(map!);
    const extra = Object.keys(parsed).filter((k) => k !== "imports");
    // scopes, integrity…: their URLs would need rewriting too; say so, not drop them
    if (extra.length) throw new Error(`page3d's import map has ${extra.join(", ")}, which this rewrite does not carry`);
    const imports = parsed.imports as Record<string, string>;
    for (const [k, v] of Object.entries(imports)) if (v.startsWith("/3d/")) imports[k] = `.${v}`;
    // world.js imports the vendored controls root-relative
    imports["/3d/"] = "./3d/";
    // a value with </script> in it must not close the tag it is written in
    return `${open}\n${JSON.stringify({ imports }).replace(/</g, "\\u003c")}\n${close}`;
  });
  // any /3d/ reference left (quoted another way, or unquoted) would break
  // the page on a sub-path: fail here rather than ship it
  const left = /(?:src|href)\s*=\s*['"]?\/3d\//i.exec(html);
  if (left) throw new Error(`page3d's index.html has a /3d/ reference the rewrite does not cover: ${left[0]}`);
  return html;
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
    transformIndexHtml: {
      order: "pre",
      handler: () => page3dIndex(readFileSync(join(PAGE3D[0]!, "index.html"), "utf8")),
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!;
        if (!path.startsWith("/3d/")) return next();
        let p: string | null;
        try {
          // a malformed %-escape or a NUL byte is not a page3d file
          p = find(decodeURIComponent(path.slice(4)));
        } catch {
          return next();
        }
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
