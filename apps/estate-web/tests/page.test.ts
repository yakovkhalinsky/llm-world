/**
 * The page is apps/estate's page3d/index.html, rewritten as the build
 * serves it: every page3d file relative to the page, the import map
 * pointing at ./3d/, and src/main.ts in place of viewer.js.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { page3dIndex } from "../vite.config.ts";

const original = readFileSync(resolve(import.meta.dirname, "../../estate/estate/page3d/index.html"), "utf8");

it("serves page3d's page from any sub-path, with main.ts starting the viewer", () => {
  const html = page3dIndex(original);
  expect(html).not.toMatch(/(src|href)="\/3d\//);
  expect(html).not.toContain("viewer.js");
  expect(html).toContain('<script type="module" src="/src/main.ts"></script>');
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!);
  expect(map.imports).toEqual({ three: "./3d/vendor/three.module.min.js", "/3d/": "./3d/" });
  for (const id of ["seedIn", "plantBtn", "againBtn", "seedNote"]) expect(html).toContain(`id="${id}"`);
  // the seed row and its style are the only lines added
  expect(html.split("\n").length).toBe(original.split("\n").length + 14);
});

it("fails loudly when page3d's page no longer has what it rewrites", () => {
  expect(() => page3dIndex(original.replace("/3d/viewer.js", "/3d/view.js"))).toThrow(/no longer has/);
});
