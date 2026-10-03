"""grove web — a zero-dependency dashboard for the grove.

Serves one hand-written HTML page (no build step, works fully offline)
plus a small JSON state API. The simulation keeps running here in a
background thread; visitors get pause / step / invite-soul buttons.

  grove web [--port 8787] [--public] [--tick-seconds 8] [--offline]

Default bind is loopback only (viewable through an ssh tunnel); pass
--public to open it to the LAN.
"""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import llm as llmm
from . import render
from . import world as W
from .app import Grove

POLL_MS = 2500          # how often the page re-reads /api/state


class SimRunner(threading.Thread):
    """Advances the world in the background. Shares the grove only under
    the world lock."""

    def __init__(self, grove, lock, tick_seconds):
        super().__init__(daemon=True)
        self.grove = grove
        self.lock = lock
        self.tick_seconds = tick_seconds
        self.paused = False          # an ambient dashboard lives by default
        self.steps_requested = 0
        self.stopping = threading.Event()

    def run(self):
        while not self.stopping.is_set():
            if self.paused:
                if self.steps_requested > 0:
                    self.steps_requested = 0
                    with self.lock:
                        _evs, notable = self.grove.step()
                        self.grove.apply_results()
                        self.grove.maybe_schedule(notable)
                self.stopping.wait(0.15)
                continue
            with self.lock:
                _evs, notable = self.grove.step()
                self.grove.apply_results()
                self.grove.maybe_schedule(notable)
            self.stopping.wait(self.tick_seconds)


def snapshot(grove, runner, lock):
    """Build the JSON the page lives on. Under the lock."""
    with lock:
        g = grove
        w = g.world
        if w is None:
            return {"error": "no world yet — run: grove new"}
        rows = render.render_map(w).splitlines()
        chron = [{"tick": t, "source": s, "text": tx}
                 for t, s, tx in g.db.chronicle_lines(14)]
        hist = g.db.history(36)
        pops_now = W.counts(w)
        plants_now = W.plant_counts(w)
        pop_chips = [{"emo": render.ANIMAL_EMOJI.get(sp, "·"), "n": n}
                     for sp, n in sorted(pops_now.items(), key=lambda kv: -kv[1])]
        series = []
        for sp, n in sorted(pops_now.items()):
            ser = [d["pop"].get(sp, 0) for _t, d in hist]
            if n or any(ser):
                series.append({"name": sp, "emo": render.ANIMAL_EMOJI.get(
                    sp, "·"), "values": ser})
        for sp in ("pine", "birch", "willow"):
            ser = [d["plants"].get(sp, 0) for _t, d in hist]
            if ser:
                series.append({"name": sp, "emo": "🌲" if sp == "pine"
                               else "🌳", "values": ser})
        pending = w.get("pending_effect")
        soul = None
        if pending:
            soul = g.soul_line or f"{pending.get('action')} " \
                f"{pending.get('region')}"
        elif g.worker and g.worker.busy:
            soul = "listening…"
        ops = [{"week": h["tick"], "action": h["action"],
                "region": h.get("region"), "strength": h.get("strength")}
               for h in w.get("op_history", [])]
        llm_bits = {
            "status": llmm.status_line(g.llm),
            "ok": bool(g.llm and g.llm.enabled),
        }
        if g.worker is not None:
            llm_bits["worker_busy"] = g.worker.busy
            llm_bits["tasks_pending"] = g.worker.tasks.qsize()
            llm_bits["results_waiting"] = g.worker.results.qsize()
        return {
            "tick": w["tick"],
            "season": W.season_name(w["tick"]),
            "weather": w["weather"],
            "weather_emo": render.WEATHER_EMOJI.get(w["weather"], ""),
            "pops": pops_now,
            "pop_chips": pop_chips,
            "plants": plants_now,
            "map": rows,
            "chronicle": chron,
            "soul": soul,
            "ops": ops,
            "effects": ["%s over %s (%d weeks left)" %
                        (e["kind"], e["region"], e["ticks"])
                        for e in w.get("effects", [])],
            "series": series,
            "llm": llm_bits,
            "paused": runner.paused,
            "tick_seconds": runner.tick_seconds,
        }


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grove</title>
<style>
  :root {
    --bg: #0c1210; --panel: #131c17; --panel-2: #0f1713;
    --line: #223329; --text: #d7e3d3; --dim: #7d9285;
    --moss: #7fc98f; --soul: #b9a7e0; --warn: #d8b471;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.5 "Georgia", serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 16px 14px 40px; }
  h1 { font-size: 20px; margin: 6px 0 2px; letter-spacing: .04em; }
  .sub { color: var(--dim); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px 14px; margin: 12px 0;
  }
  .map { font-size: clamp(11px, 3.1vmin, 20px); line-height: 1.12;
         letter-spacing: .08em; text-align: center; white-space: pre;
         font-family: sans-serif; }
  .chips { font-size: 14px; color: var(--dim); }
  .chip { background: var(--panel-2); border: 1px solid var(--line);
          border-radius: 999px; padding: 2px 10px; margin-right: 6px; }
  .soul { color: var(--soul); font-style: italic; min-height: 1.2em; }
  button {
    background: var(--panel-2); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 14px; font: inherit; font-size: 14px; cursor: pointer;
  }
  button:active { transform: translateY(1px); }
  .chron { list-style: none; margin: 0; padding: 0; font-size: 15px; }
  .chron li { padding: 2px 0; color: var(--text); }
  .chron .when { color: var(--dim); font-size: 12px; margin-left: 8px; }
  .mark-llm { color: var(--soul); }
  .mark-voice { color: var(--moss); }
  .mark-template { color: var(--dim); }
  .spark { font-family: "Menlo", monospace; color: var(--moss);
           letter-spacing: 1px; font-size: 13px; }
  .sparkline { display: flex; gap: 10px; align-items: baseline; }
  .sparkline .name { width: 64px; color: var(--dim); font-size: 13px; }
  .status { color: var(--dim); font-size: 12px; }
  .err { color: var(--warn); }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase;
       letter-spacing: .12em; margin: 4px 0 8px; font-family: sans-serif; }
</style>
</head>
<body>
<div class="wrap">
  <h1>☁ ☾ Grove</h1>
  <div class="sub">a forest world run by a small local soul</div>

  <div class="row" style="margin-top:12px">
    <div class="chip" id="when">…</div>
    <div class="chip" id="weather">…</div>
    <div class="chip" id="pops">…</div>
  </div>

  <div class="card" style="padding:8px">
    <pre class="map" id="map">…</pre>
  </div>

  <div class="card">
    <div class="row">
      <button id="pauseBtn">⏸ pause</button>
      <button id="stepBtn">+ one week</button>
      <button id="soulBtn">☾ invite the soul</button>
      <span class="soul" id="soul"></span>
    </div>
  </div>

  <div class="card">
    <h2>Chronicle</h2>
    <ul class="chron" id="chron"></ul>
  </div>

  <div class="card">
    <h2>Seasons past (36 weeks)</h2>
    <div id="sparks"></div>
  </div>

  <div class="status" id="status">…</div>
</div>
<script>
const $ = id => document.getElementById(id);
const ago = (tick, now) => {
  const d = now - tick;
  return d <= 0 ? "now" : d + "wk ago";
};
async function tick() {
  try {
    const r = await fetch("/api/state", {signal: AbortSignal.timeout(4000)});
    const s = await r.json();
    if (s.error) { $("status").textContent = s.error; return; }
    $("when").textContent = `Week ${s.tick} · ${s.season}`;
    $("weather").textContent = `${s.weather_emo} ${s.weather}`;
    $("pops").textContent = (s.pop_chips || [])
      .map(c => c.emo + c.n).join(" ") + "  at large";
    $("map").textContent = s.map.join("\\n");
    $("soul").textContent = s.soul ? "☾ " + s.soul : "";
    $("chron").innerHTML = s.chronicle.map(c => {
      const cls = c.source === "llm" ? "mark-llm"
        : c.source === "voice" ? "mark-voice" : "mark-template";
      const mark = c.source === "llm" ? "☾" : c.source === "voice" ? "☂" : "·";
      return `<li><span class="${cls}">${mark}</span> ${c.text}` +
             `<span class="when">${ago(c.tick, s.tick)}</span></li>`;
    }).join("");
    $("sparks").innerHTML = s.series.map(sr => {
      const v = sr.values.length ? sr.values : [0];
      const peak = Math.max(Math.max(...v), 1);
      const blocks = "▁▂▃▄▅▆▇█";
      return `<div class="sparkline"><span class="name">${sr.emo} ${sr.name}` +
             `</span><span class="spark">${v.map(x =>
                 blocks[Math.min(7, Math.floor(x * 8 / peak))]).join("")
             }</span></div>`;
    }).join("");
    $("status").textContent = (s.paused ? "paused · " : "") + s.llm.status;
    $("pauseBtn").textContent = s.paused ? "▶ resume" : "⏸ pause";
    for (const id of ["stepBtn", "soulBtn"])
      $(id).disabled = !s.paused;
  } catch (e) { $("status").textContent = "reconnecting…"; }
}
$("pauseBtn").onclick = async () => {
  await fetch("/api/pause", {method: "POST"}); tick();
};
$("stepBtn").onclick = async () => {
  await fetch("/api/step", {method: "POST"}); tick();
};
$("soulBtn").onclick = async () => {
  await fetch("/api/soul", {method: "POST"}); tick();
};
tick();
setInterval(tick, 2500);
</script>
</body>
</html>
"""


def _ip_hint(host):
    if host != "0.0.0.0":
        return f"local only: http://localhost:{{}}\n  (LAN view: add --public," \
               " or tunnel: ssh -L 8787:localhost:8787 user@this-host)"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return (f"LAN: http://{ip}:{{}}  (any device on this network)\n"
                "  off-network: ssh -L 8787:localhost:8787 user@this-host")
    except OSError:
        return "lan ip undetectable — check hostname -I"


def cmd_web(args):
    g = Grove(args)
    g.load_or_exit()
    g.init_llm()
    lock = threading.Lock()
    runner = SimRunner(g, lock, args.tick_seconds)
    runner.start()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype):
            data = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_a):   # keep the terminal readable
            pass

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/":
                self._send(200, PAGE, "text/html; charset=utf-8")
            elif path == "/api/state":
                try:
                    state = snapshot(g, runner, lock)
                    self._send(200, json.dumps(state), "application/json")
                except Exception as e:
                    self._send(500, json.dumps({"error": str(e)}),
                               "application/json")
            else:
                self._send(404, "not found", "text/plain")

        def do_POST(self):
            path = urlparse(self.path).path
            if path == "/api/pause":
                runner.paused = not runner.paused
                self._send(200, json.dumps({"paused": runner.paused}),
                           "application/json")
            elif path == "/api/step":
                if runner.paused:
                    with lock:
                        g.step()
                        g.apply_results()
                        g.maybe_schedule([])
                    self._send(200, json.dumps({"stepped": True}),
                               "application/json")
                else:
                    self._send(200, json.dumps({"stepped": False}),
                               "application/json")
            elif path == "/api/soul":
                invited = False
                if g.llm and g.llm.enabled and g.worker:
                    with lock:
                        if not g.worker.busy:
                            g._invite_operator()
                            invited = True
                self._send(200, json.dumps({"invited": invited}),
                           "application/json")
            else:
                self._send(404, "not found", "text/plain")

    port = args.port
    bind = "0.0.0.0" if args.public else "127.0.0.1"
    print(f"grove web · world tick {g.world['tick']} {W.season_name(g.world['tick'])}")
    print(_ip_hint(bind).format(port))
    srv = ThreadingHTTPServer((bind, port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stopping.set()
        g.db.close()