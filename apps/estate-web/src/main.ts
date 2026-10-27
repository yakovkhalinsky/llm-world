/**
 * The page: open the estate in the worker, answer page3d's requests from
 * it, then start page3d's viewer — apps/estate's own 3D front end, which
 * asks `/api/ground`, `/api/state`, `/api/plain` and `/api/control` as it
 * does of web.py and never knows there is no server.
 *
 * `?seed=N` plants that estate; with no seed it is seed 1. page3d's own
 * parameters (`?static=1`, `?show=…`) pass through untouched.
 */
import { parseSeed } from "./seed.ts";
import { API_PATHS, type FromWorker, type ToWorker } from "./worker/protocol.ts";

type Reply = Exclude<FromWorker, { type: "error" }>;
type Ask = ToWorker extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

const worker = new Worker(new URL("./worker/sim.worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, { ok: (r: Reply) => void; no: (e: Error) => void }>();
let nextId = 1;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  const w = m.id === null ? undefined : waiting.get(m.id);
  if (!w) {
    // an error that answers no request: the estate itself stopped
    if (m.type === "error") stopped(m.message);
    return;
  }
  waiting.delete(m.id!);
  if (m.type === "error") w.no(new Error(m.message));
  else w.ok(m);
};

/** Say on the page that the estate stopped, the way page3d says it has no WebGL. */
function stopped(why: string): void {
  console.error("estate worker:", why);
  const box = document.getElementById("nogl");
  const text = document.getElementById("noglWhy");
  if (text) text.textContent = why;
  if (box) box.hidden = false;
}

/** The worker died or a reply was unreadable: nothing waiting will be answered. */
function fail(why: string): void {
  for (const w of waiting.values()) w.no(new Error(why));
  waiting.clear();
  stopped(why);
}
worker.onerror = (e: ErrorEvent) => {
  e.preventDefault();
  fail(`the estate stopped: ${e.message || "the worker failed"}`);
};
worker.onmessageerror = () => fail("the estate's reply could not be read");

function ask(m: Ask): Promise<Reply> {
  const id = nextId++;
  return new Promise((ok, no) => {
    waiting.set(id, { ok, no });
    worker.postMessage({ ...m, id } as ToWorker);
  });
}

/** page3d's four endpoints, answered by the worker; anything else is fetched. */
function installApi(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== location.origin || !API_PATHS.has(url.pathname)) return real(input, init);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const r = await ask({ type: "api", method: req.method, path: url.pathname, body });
    if (r.type !== "api") throw new TypeError("the estate answered something else");
    return new Response(r.body, { status: r.status, headers: { "Content-Type": r.contentType } });
  };
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const raw = params.get("seed");
  const seed = raw === null ? null : parseSeed(raw);
  const r = await ask({ type: "open", seed });
  if (r.type !== "opened") throw new TypeError("the estate did not open");
  if (seed === null || String(seed) !== raw) {
    // the address names the estate on screen
    params.set("seed", String(r.seed));
    params.delete("fresh");
    history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
  }
  installApi();
  const viewer = document.createElement("script");
  viewer.type = "module";
  viewer.src = "3d/viewer.js";
  document.body.append(viewer);
}

boot().catch((e: unknown) => {
  stopped(`the estate could not open: ${e instanceof Error ? e.message : String(e)}`);
});
