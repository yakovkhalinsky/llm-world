/**
 * The page is apps/estate's page3d/index.html, rewritten as the build
 * serves it: every page3d file relative to the page, the import map
 * pointing at ./3d/, and src/main.ts in place of viewer.js.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { page3dIndex } from "../vite.config.ts";
import { respond } from "../src/view/api.ts";
import { plant } from "../src/view/runner.ts";
import { API_PATHS } from "../src/worker/protocol.ts";

const PAGE3D_DIRS = ["../../estate/estate/page3d", "../../shared/page3d"].map((d) => resolve(import.meta.dirname, d));
const original = readFileSync(resolve(import.meta.dirname, "../../estate/estate/page3d/index.html"), "utf8");

it("serves page3d's page from any sub-path, with main.ts starting the viewer", () => {
  const html = page3dIndex(original);
  expect(html).not.toMatch(/(src|href)="\/3d\//);
  expect(html).not.toContain("viewer.js");
  expect(html).toContain('<script type="module" src="/src/main.ts"></script>');
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!);
  expect(map.imports).toEqual({ three: "./3d/vendor/three.module.min.js", "/3d/": "./3d/" });
  // everything else is page3d's own page, untouched
  expect(html.split("\n").length).toBe(original.split("\n").length);
});

it("fails loudly when page3d's page no longer has what it rewrites", () => {
  expect(() => page3dIndex(original.replace("/3d/viewer.js", "/3d/view.js"))).toThrow(/no longer has/);
});

it("fails loudly on a /3d/ reference the rewrite does not cover", () => {
  for (const variant of ["src='/3d/walk.js'", "src=/3d/walk.js", "SRC = \"/3d/walk.js\""]) {
    expect(() => page3dIndex(original.replace('src="/3d/walk.js"', variant)), variant).toThrow(/does not cover/);
  }
});

it("carries no import-map key it would drop, and keeps </script> out of the map", () => {
  const scoped = original.replace(/("imports"\s*:)/, '"scopes": {}, $1');
  expect(scoped).not.toBe(original);
  expect(() => page3dIndex(scoped)).toThrow(/scopes/);
  const sneaky = original.replace(/("three"\s*:\s*")/, '"x": "/3d/<\\/script><b>", $1');
  expect(sneaky).not.toBe(original);
  const html = page3dIndex(sneaky);
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!;
  expect(map).not.toContain("<");
  expect(JSON.parse(map).imports.x).toBe("./3d/</script><b>");
});

it("answers every /api request page3d makes", () => {
  const seen = new Set<string>();
  for (const dir of PAGE3D_DIRS) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      for (const m of readFileSync(resolve(dir, f), "utf8").matchAll(/\/api\/[\w/]+/g)) seen.add(m[0]);
    }
  }
  expect([...seen].sort()).toEqual([...API_PATHS].sort());
  const s = plant(1);
  for (const path of seen) {
    const r = path === "/api/control" ? respond(s, { step: 0 }, "POST", path, "{}") : respond(s, { step: 0 }, "GET", path, null);
    expect(r.status, path).toBe(200);
  }
});
