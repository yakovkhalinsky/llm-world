"""grove web — a zero-dependency dashboard for the grove.

Serves one hand-written HTML page (no build step, works fully offline)
plus a small JSON state API. The simulation keeps running here in a
background thread; visitors get pause / step / invite-soul buttons.

The map is a <canvas> scene: procedural trees that sway, creatures that
glide between their weekly positions, rain/snow/leaf particles, season
palettes, and washes where the soul's effects are active. A plain emoji
map remains as a no-canvas fallback (?plain or canvas unsupported).

  grove web [--port 8787] [--public] [--tick-seconds 8] [--offline]

Default bind is loopback only (viewable through an ssh tunnel); pass
--public to open it to the LAN.
"""

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import llm as llmm
from . import render
from . import world as W
from .app import Grove

POLL_MS = 600           # creature polls; the scene rebuild is cheap


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
        self.last_step_at = None     # wall time of the last simulated week
        self.stopping = threading.Event()

    def run(self):
        while not self.stopping.is_set():
            try:
                self._beat()
            except Exception as e:
                # the world's heartbeat survives anything: a bad sim week,
                # a bad LLM payload, even our own diagnostics
                import sys
                print(f"grove: runner error: {e}", file=sys.stderr)
                self.stopping.wait(1.0)

    def _beat(self):
        if self.paused:
            if self.steps_requested > 0:
                self.steps_requested = 0
                with self.lock:
                    _evs, notable = self.grove.step()
                    self.grove.apply_results()
                    self.grove.maybe_schedule(notable)
                    self.last_step_at = time.time()
            self.stopping.wait(0.15)
            return
        with self.lock:
            _evs, notable = self.grove.step()
            self.grove.apply_results()
            self.grove.maybe_schedule(notable)
            self.last_step_at = time.time()
        self.stopping.wait(self.tick_seconds)


def snapshot(grove, runner, lock):
    """Build the JSON the page lives on. Under the lock."""
    with lock:
        g = grove
        w = g.world
        if w is None:
            return {"error": "no world yet — run: grove new"}
        size = w["size"]
        names = w.get("names", {})
        cells = []
        for y in range(size):
            for x in range(size):
                c = w["cells"][y][x]
                cells.append((c["terrain"][0], round(c["grass"], 2),
                              round(c["moisture"], 2),
                              1 if c["mushroom"] else 0,
                              1 if c["carcass"] else 0))
        plants = [{"sp": p["sp"], "x": p["x"], "y": p["y"],
                   "st": p["stage"],
                   "el": 1 if p.get("elder") or p["id"] in w["elder_ids"]
                   else 0,
                   "b": 1 if p.get("berries") else 0,
                   "n": names.get(str(p["id"]))}
                  for p in w["plants"].values()]
        animals = [{"sp": a["sp"], "x": a["x"], "y": a["y"],
                    "px": a.get("px", a["x"]), "py": a.get("py", a["y"]),
                    "n": names.get(str(a["id"]))}
                   for a in w["animals"].values()]

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
            llm_bits["jobs"] = dict(g.jobs)
            llm_bits["worker_busy"] = g.worker.busy
            llm_bits["tasks_pending"] = g.worker.tasks.qsize()
            llm_bits["results_waiting"] = g.worker.results.qsize()
            if getattr(g.llm, "last_raw", None):
                llm_bits["last_raw"] = g.llm.last_raw
        return {
            "tick": w["tick"],
            "season": W.season_name(w["tick"]),
            "weather": w["weather"],
            "weather_emo": render.WEATHER_EMOJI.get(w["weather"], ""),
            "pops": pops_now,
            "pop_chips": pop_chips,
            "plants": plants_now,
            "size": size,
            "cells": cells,
            "plants": plants,
            "animals": animals,
            "map": render.render_map(w).splitlines(),
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
            # wall-clock anchors so the canvas can glide creatures by the
            # true phase of the simulated week, independent of poll timing
            "now": time.time(),
            "step_at": runner.last_step_at or time.time(),
        }


PAGE = r"""<!doctype html>
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
  #scene { width: 100%; height: auto; display: block; cursor: pointer;
           border-radius: 8px; }
  .map { font-size: clamp(11px, 3.1vmin, 20px); line-height: 1.12;
         letter-spacing: .08em; text-align: center; white-space: pre;
         font-family: sans-serif; display: none; }
  body.plain #scene { display: none; }
  body.plain .map { display: block; }
  .chips { font-size: 14px; color: var(--dim); }
  .chip { background: var(--panel-2); border: 1px solid var(--line);
          border-radius: 999px; padding: 2px 10px; margin-right: 6px; }
  .soul { color: var(--soul); font-style: italic; min-height: 1.2em; }
  .soul.pulse::before { content: "☾ "; animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  button {
    background: var(--panel-2); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 14px; font: inherit; font-size: 14px; cursor: pointer;
  }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: .45; cursor: default; }
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
  #look { color: var(--moss); font-style: italic; font-size: 14px;
          min-height: 1.4em; }
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
    <canvas id="scene"></canvas>
    <pre class="map" id="map">…</pre>
  </div>

  <div class="card">
    <div id="look"></div>
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
"use strict";
const $ = id => document.getElementById(id);
const ago = (tick, now) => { const d = now - tick;
  return d <= 0 ? "now" : d + "wk ago"; };

/* ================= state ================= */
/* Creature movement: the sim knows each creature's week-start (px,py)
   and week-end (x,y) cells. The client flies them between the two,
   anchored to poll ARRIVAL and ending exactly when the next simulation
   week lands — re-polls of the same week never restart a flight. */
const ST = { s: null, flight: null, seenTick: -1 };
const FACING = [];                 // sticky per-creature facing (by index)
async function poll() {
  try {
    const r = await fetch("/api/state",
                          { signal: AbortSignal.timeout(4000) });
    const s = await r.json();
    if (s.error) { $("status").textContent = s.error; return; }
    ST.s = s;
    if (s.tick !== ST.seenTick) {          // a NEW sim week: new flight
      ST.seenTick = s.tick;
      const lag = Math.max(0, s.now - s.step_at);   // poll lag, seconds
      const dur = Math.max(0.25, s.tick_seconds - lag);
      ST.flight = { start: performance.now() / 1000, dur };
    }
    updateDom();
  } catch (e) { $("status").textContent = "reconnecting…"; }
}

function glidePhase() {
  const s = ST.s;
  if (!s || s.paused || !ST.flight) return 1;
  const p = (performance.now() / 1000 - ST.flight.start) / ST.flight.dur;
  return Math.max(0, Math.min(1, p));
}

function updateDom() {
  const s = ST.s;
  if (!s) return;
  if (s.error) { $("status").textContent = s.error; return; }
  $("when").textContent = `Week ${s.tick} · ${s.season}`;
  $("weather").textContent = `${s.weather_emo} ${s.weather}`;
  $("pops").textContent = (s.pop_chips || [])
    .map(c => c.emo + c.n).join(" ");
  if (document.body.classList.contains("plain"))
    $("map").textContent = s.map.join("\n");
  const soulEl = $("soul");
  soulEl.textContent = s.soul ? "☾ " + s.soul : "";
  soulEl.className = "soul" + (s.soul === "listening…" ? " pulse" : "");
  $("chron").innerHTML = s.chronicle.map(c => {
    const cls = (c.source === "llm" || c.source === "soul") ? "mark-llm"
      : c.source === "voice" ? "mark-voice" : "mark-template";
    const mark = (c.source === "llm" || c.source === "soul") ? "☾"
      : c.source === "voice" ? "☂" : "·";
    return `<li><span class="${cls}">${mark}</span> ${c.text}` +
           `<span class="when">${ago(c.tick, s.tick)}</span></li>`;
  }).join("");
  $("sparks").innerHTML = (s.series || []).map(sr => {
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
  for (const id of ["stepBtn", "soulBtn"]) $(id).disabled = !s.paused;
}

$("pauseBtn").onclick = async () => {
  await fetch("/api/pause", { method: "POST" }); poll();
};
$("stepBtn").onclick = async () => {
  await fetch("/api/step", { method: "POST" }); poll();
};
$("soulBtn").onclick = async () => {
  await fetch("/api/soul", { method: "POST" }); poll();
};

/* ================= canvas scene ================= */
try { $("scene").getContext("2d"); }
catch (e) { document.body.classList.add("plain"); }
if (new URLSearchParams(location.search).has("plain"))
  document.body.classList.add("plain");

const TS = 22;                       // logical tile size
const cnv = $("scene"), ctx = cnv.getContext("2d");
const DPR = Math.max(1, window.devicePixelRatio || 1);
function fitCanvas(size) {
  const px = size * TS;
  if (cnv.width !== px * DPR) {
    cnv.width = px * DPR; cnv.height = px * DPR;
    cnv.style.aspectRatio = "1 / 1";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
}

const SEASONS = {
  spring: { grass: "#6fa053", soil: "#4a3a29", water: "#2a4d66",
            rock: "#5d6266", pine: "#2f6038", leaf: "#6f9f4a",
            canopyDim: 1.0, wash: null },
  summer: { grass: "#5d8f45", soil: "#45362a", water: "#27496b",
            rock: "#5a6062", pine: "#2a5630", leaf: "#5f9440",
            canopyDim: 1.0, wash: null },
  autumn: { grass: "#9a8a4a", soil: "#4d3a28", water: "#284a5e",
            rock: "#5d6266", pine: "#2d5035", leaf: "#b0762f",
            canopyDim: 1.0, wash: null },
  winter: { grass: "#a8b3ad", soil: "#5a5148", water: "#31536e",
            rock: "#68707a", pine: "#2c4a42", leaf: "#86775d",
            canopyDim: 0.85, wash: "rgba(190,215,225,0.10)" },
};
const pal = () => SEASONS[(ST.s && ST.s.season) || "spring"] || SEASONS.spring;

const ANIMAL_BODY = {
  rabbit: "#9b8d90", deer: "#a8834f", fox: "#c26a35", owl: "#8d7358",
  robin: "#7d8ba0", boar: "#5c4a42", stag: "#9a7546", wolf: "#8a8f94",
};

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
  c.fill();
}

function drawTerrain(s, tsec) {
  const p = pal(), size = s.size;
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    const x = (i % size) * TS, y = Math.floor(i / size) * TS;
    if (c[0] === "w") {
      ctx.fillStyle = p.water;
      ctx.fillRect(x, y, TS, TS);
      const wob = Math.sin(tsec * 1.4 + i * 1.7) * 2;
      ctx.strokeStyle = "rgba(200,225,240,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + TS * 0.4 + wob);
      ctx.lineTo(x + TS - 6, y + TS * 0.4 + wob);
      ctx.stroke();
      continue;
    }
    // soil blends toward grass with the grass value
    const g = c[1];
    const soilmix = 1 - Math.min(1, c[2] * 0.5);   // wet soil darker
    ctx.fillStyle = p.soil;
    ctx.fillRect(x, y, TS, TS);
    if (g > 0.06) {
      ctx.globalAlpha = Math.min(1, g * 0.9);
      ctx.fillStyle = p.grass;
      ctx.fillRect(x, y, TS, TS);
      ctx.globalAlpha = 1;
    }
    if (c[2] > 0.75) {                             // soaked ground
      ctx.fillStyle = "rgba(30,50,66,0.18)";
      ctx.fillRect(x, y, TS, TS);
    }
    if (c[0] === "r") {
      ctx.fillStyle = p.rock;
      ctx.fillRect(x, y, TS, TS);
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 15); ctx.lineTo(x + 10, y + 5);
      ctx.lineTo(x + 17, y + 15); ctx.closePath(); ctx.fill();
    }
    if (c[3]) {                                    // mushrooms
      ctx.fillStyle = "#e8e3d2";
      ctx.fillRect(x + 9, y + 13, 2, 5);
      ctx.fillStyle = "#b0483c";
      ctx.beginPath(); ctx.arc(x + 10, y + 13, 4, 3.2, 6.1); ctx.fill();
    }
    if (c[4]) {                                    // carrion
      ctx.fillStyle = "#c9c2b8";
      ctx.beginPath(); ctx.arc(x + 11, y + 13, 3.5, 0, 6.3); ctx.fill();
    }
  }
}

function drawPlants(s, tsec) {
  const p = pal(), sway = Math.sin(tsec * 1.1) * 0.045;
  for (const t of s.plants) {
    const cx = t.x * TS + TS / 2, by = t.y * TS + TS - 2;
    const isPine = t.sp === "pine", isFern = t.sp === "fern",
          isBerry = t.sp === "berry";
    if (t.st === "log") {
      ctx.fillStyle = "#6b4a33";
      roundRect(ctx, t.x * TS + 3, by - 6, TS - 6, 5, 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(t.x * TS + 3, by - 6, TS - 6, 2);
      continue;
    }
    if (isFern) {
      ctx.strokeStyle = "#3f6d38"; ctx.lineWidth = 1.4;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(cx, by);
        ctx.quadraticCurveTo(cx + k * 6, by - 8, cx + k * 9,
                             by - 13 + sway * 30);
        ctx.stroke();
      }
      continue;
    }
    if (isBerry) {
      ctx.fillStyle = "#4a7a3a";
      roundRect(ctx, cx - 7, by - 9, 14, 9, 4);
      if (t.b) {
        ctx.fillStyle = "#b03a48";
        for (const [bx, byy] of [[-4, -3], [1, -6], [4, -2]]) {
          ctx.beginPath(); ctx.arc(cx + bx, by + byy, 1.6, 0, 6.3); ctx.fill();
        }
      }
      continue;
    }
    // trees
    let scale = t.st === "mature" ? 1 : t.st === "old" ? 1.08 : 0.55;
    if (t.el) scale *= 1.12;
    const leafCol = isPine ? p.pine : p.leaf;
    // trunk
    ctx.fillStyle = t.sp === "birch" ? "#d9d4c9"
        : t.sp === "willow" ? "#8a7663" : "#5b422f";
    const trunkH = isPine ? 6 : 9, tw = t.st === "sapling" ? 2 : 3;
    ctx.fillRect(cx - tw / 2, by - trunkH, tw, trunkH);
    if (t.sp === "birch" && t.st !== "sapling") {
      ctx.fillStyle = "rgba(60,60,60,0.7)";
      ctx.fillRect(cx - 1.6, by - trunkH + 2, 1.5, 1);   // birch marks
    }
    ctx.save();
    ctx.translate(cx, by);
    ctx.rotate(sway * (isPine ? 0.4 : 1.0));
    const C = TS * scale;
    if (isPine) {
      ctx.fillStyle = leafCol;
      for (let k = 0; k < 3; k++) {
        const w = 11 - k * 3, h = 8 - k, oy = -7 - k * 4.5;
        ctx.beginPath();
        ctx.moveTo(0, oy - h);
        ctx.lineTo(w, oy);
        ctx.lineTo(-w, oy);
        ctx.closePath(); ctx.fill();
      }
      if (ST.s && ST.s.season === "winter") {
        ctx.fillStyle = "rgba(240,246,250,0.5)";
        ctx.beginPath();
        ctx.moveTo(0, -21); ctx.lineTo(3.5, -16); ctx.lineTo(-3.5, -16);
        ctx.closePath(); ctx.fill();
      }
    } else {
      const r = C * 0.42;
      ctx.fillStyle = leafCol;
      ctx.beginPath(); ctx.arc(0, -trunkH - r * 0.7, r, 0, 6.3); ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(r * 0.55, -trunkH - r * 0.35, r * 0.7,
                               0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(-r * 0.6, -trunkH - r * 0.5, r * 0.62,
                               0, 6.3); ctx.fill();
      ctx.globalAlpha = 1;
      if (t.st === "old" || t.el) {
        ctx.fillStyle = "rgba(40,50,35,0.25)";
        ctx.beginPath(); ctx.arc(-r * 0.3, -trunkH - r * 0.6,
                                 r * 0.5, 0, 6.3); ctx.fill();
      }
    }
    ctx.restore();
    if ((t.st === "old" || t.el) && t.n && t.n !== "-") {
      ctx.font = "italic 9px Georgia, serif";
      ctx.fillStyle = "rgba(10,14,12,0.65)";
      ctx.fillText(t.n, cx + 1, by - TS * 0.7);
      ctx.fillStyle = "#dfe9db";
      ctx.fillText(t.n, cx, by - TS * 0.7 - 1);
    }
  }
}

function drawAnimal(a, f, tsec, idx) {
  const cx0 = a.px * TS + TS / 2, cy0 = a.py * TS + TS / 2;
  const cx1 = a.x * TS + TS / 2, cy1 = a.y * TS + TS / 2;
  // creatures that didn't move stay put; movers glide with easing
  const e = f < 1 ? (f * f * (3 - 2 * f)) : 1;   // smoothstep
  const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
  const body = ANIMAL_BODY[a.sp] || "#999";
  // face the direction of glide; keep the facing when the glide is done
  // or when a creature briefly stands still (index-sticky across polls)
  const dx = cx1 - cx0;
  if (Math.abs(dx) > 0.9) FACING[idx] = dx < 0 ? -1 : 1;
  const flip = FACING[idx] || 1;
  const bob = Math.sin(tsec * 5 + a.x) * 0.8;
  ctx.save();
  ctx.translate(cx, cy + (a.sp === "owl" ? 0 : bob * 0.6));
  ctx.scale(flip, 1);
  const winter = ST.s && ST.s.season === "winter";
  switch (a.sp) {
    case "rabbit":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 2, 5, 4, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.ellipse(2, -3, 1.6, 4, 0.35, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.ellipse(4.4, -3, 1.6, 4, 0.2, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(-4.5, 1, 2.2, 0, 6.3); ctx.fill();
      break;
    case "deer": case "stag": {
      const sz = a.sp === "stag" ? 1.2 : 1;
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 1, 7, 4, 0, 0, 6.3); ctx.fill();
      ctx.fillRect(-5, 4, 1.6, 4); ctx.fillRect(3, 4, 1.6, 4);
      ctx.beginPath(); ctx.arc(6, -2, 2.4, 0, 6.3); ctx.fill();
      ctx.strokeStyle = winter ? "#d9d4c9" : "#775f38"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(6.5, -4); ctx.lineTo(7.5, -8); ctx.lineTo(9.5, -9);
      ctx.moveTo(5.5, -4); ctx.lineTo(4.5, -8); ctx.lineTo(2.5, -9);
      ctx.stroke();
      break;
    }
    case "fox":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 2, 6, 3.2, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(5.4, 0, 2.1, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#e8dccb";
      ctx.beginPath();
      ctx.moveTo(-4, 1.5); ctx.quadraticCurveTo(-9, -1, -8, -6);
      ctx.lineTo(-6, -2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(-5, 2.5, 1.7, 0, 6.3); ctx.fill();
      break;
    case "owl":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 0, 4.6, 5.6, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.arc(-1.6, -1.5, 1.3, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(1.6, -1.5, 1.3, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#222";
      ctx.beginPath(); ctx.arc(-1.6, -1.5, 0.6, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(1.6, -1.5, 0.6, 0, 6.3); ctx.fill();
      break;
    case "robin":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 3, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#b25c3e";
      ctx.beginPath(); ctx.ellipse(1.2, 0.8, 1.6, 1.2, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#494f5c";
      ctx.beginPath(); ctx.arc(-2.6, -1.6, 1.5, 0, 6.3); ctx.fill();
      break;
    case "boar":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 1.5, 6.4, 4.2, 0, 0, 6.3); ctx.fill();
      ctx.strokeStyle = "#4a3b35"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4, 5); ctx.lineTo(-4, 7);
      ctx.moveTo(3, 5); ctx.lineTo(3, 7);
      ctx.stroke();
      ctx.fillStyle = "#3a2f2b";
      ctx.beginPath(); ctx.arc(6.2, 0.5, 2.4, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#e8e3d2";
      ctx.beginPath(); ctx.arc(7.4, 1.6, 1, 0, 6.3); ctx.fill();
      break;
    default:  // wolf
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 1, 6.6, 3.4, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(5.8, -1, 2.3, 0, 6.3); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(4.2, -3); ctx.lineTo(5.2, -6); ctx.lineTo(6.4, -3.4);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = body; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-5, 0); ctx.quadraticCurveTo(-9, 2, -8, 7); ctx.stroke();
      break;
  }
  ctx.restore();
  if (a.n && a.n !== "-") {
    ctx.font = "italic 9px Georgia, serif";
    ctx.fillStyle = "rgba(10,14,12,0.65)";
    ctx.fillText(a.n, cx + 1, cy - 9);
    ctx.fillStyle = "#dfe9db";
    ctx.fillText(a.n, cx, cy - 10);
  }
}

/* particles */
const dots = [];
function spawnParticles(s, dt) {
  const storm = s.weather === "storm", rain = s.weather === "rain",
        frost = s.weather === "frost";
  const count = kind => dots.reduce((n, d) => n + (d.kind === kind), 0);
  if ((rain || storm) && count("rain") < (storm ? 120 : 36) &&
      Math.random() < 0.5)
    dots.push({ kind: "rain", x: Math.random() * 560, y: -6,
                v: 190 + Math.random() * 90, dx: storm ? 42 : 12 });
  if (frost && count("snow") < 70)
    for (let k = 0; k < 2; k++)
      dots.push({ kind: "snow", x: Math.random() * 560, y: -4,
                  v: 18 + Math.random() * 14, dx: Math.random() * 10 - 5 });
  if (s.season === "autumn" && count("leaf") < 10 && Math.random() < 0.015)
    dots.push({ kind: "leaf", x: Math.random() * 560, y: -4,
                v: 22 + Math.random() * 16, dx: Math.random() * 24 - 12 });
}

function drawParticles(dt) {
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    d.y += d.v * dt; d.x += d.dx * dt;
    if (d.kind === "leaf") d.x += Math.sin((d.y + i * 10) * 0.05) * 12 * dt;
    if (d.y > 540) { dots.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = d.kind === "rain" ? 0.55 : 0.8;
    if (d.kind === "rain") {
      ctx.strokeStyle = "#9fc6dd"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.dx * 0.05, d.y - d.v * 0.05);
      ctx.stroke();
    } else {
      ctx.fillStyle = d.kind === "leaf" ? "#a5763c" : "#eef4f6";
      ctx.beginPath(); ctx.arc(d.x, d.y, d.kind === "leaf" ? 2.2 : 1.4,
                               0, 6.3);
      ctx.fill();
    }
    ctx.restore();
  }
  if (dots.length > 260) dots.splice(0, dots.length - 260);
}

const REGIONS = { all: [0,0,1,1], NW: [0,0,.5,.5], NE: [.5,0,1,.5],
                  SW: [0,.5,.5,1], SE: [.5,.5,1,1] };
function drawEffects(s) {
  for (const e of s.effects || []) {
    const r = REGIONS[e.split(" over ")[1].split(" ")[0]] || REGIONS.all;
    ctx.fillStyle = e.startsWith("blight")
        ? "rgba(120,60,140,0.14)"
        : e.startsWith("drought") ? "rgba(190,140,40,0.15)"
        : "rgba(140,210,140,0.10)";
    ctx.fillRect(r[0] * s.size * TS, r[1] * s.size * TS,
                 (r[2] - r[0]) * s.size * TS, (r[3] - r[1]) * s.size * TS);
    ctx.strokeStyle = "rgba(230,230,230,0.12)";
    ctx.setLineDash([4, 4]); ctx.strokeRect(
      r[0] * s.size * TS, r[1] * s.size * TS,
      (r[2] - r[0]) * s.size * TS, (r[3] - r[1]) * s.size * TS);
    ctx.setLineDash([]);
  }
}

let flash = 0;
function drawScene(tnow) {
  const s = ST.s;
  if (!s || !s.cells) return;
  fitCanvas(s.size);
  const tsec = tnow / 1000;
  const dt = Math.min(0.1, (tnow - (drawScene.last || tnow)) / 1000);
  drawScene.last = tnow;
  // fraction of the glide between weekly positions, from the true phase
  const glide = glidePhase();

  drawTerrain(s, tsec);
  drawPlants(s, tsec);
  s.animals.forEach((a, i) => drawAnimal(a, glide, tsec, i));
  spawnParticles(s, dt);
  drawParticles(dt);
  drawEffects(s);

  ctx.fillStyle = (pal().wash || SEASONS.winter.wash);
  if (pal().wash) ctx.fillRect(0, 0, s.size * TS, s.size * TS);
  if (s.weather === "storm") {
    ctx.fillStyle = "rgba(20,28,40,0.25)";
    ctx.fillRect(0, 0, s.size * TS, s.size * TS);
    if (Math.random() < 0.006) flash = 0.30;
  }
  if (flash > 0) {
    ctx.fillStyle = `rgba(240,245,255,${flash})`;
    ctx.fillRect(0, 0, s.size * TS, s.size * TS);
    flash -= dt * 1.8;
  }
}

function loop(tnow) {
  if (!document.body.classList.contains("plain"))
    drawScene(tnow);
  requestAnimationFrame(loop);
}

/* look at a tile (click) */
cnv.addEventListener("click", e => {
  const s = ST.s;
  if (!s || !s.cells) return;
  const r = cnv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * s.size);
  const y = Math.floor((e.clientY - r.top) / r.height * s.size);
  const c = s.cells[y * s.size + x];
  const plants = (s.plants || []).filter(t =>
    t.x === x && t.y === y && t.n);
  const critters = (s.animals || []).filter(a => a.x === x && a.y === y);
  const bits = [];
  if (c[0] === "w") bits.push("the water");
  else if (c[0] === "r") bits.push("rock");
  else if (c[1] > 0.5) bits.push("long grass");
  else bits.push("open ground");
  for (const p of plants) bits.push(`${p.n} the ${p.sp} (${p.st})`);
  for (const a of critters)
    bits.push(`${a.n || "a wild " + a.sp}${a.n ? " (the " + a.sp + ")" : ""}`);
  $("look").textContent = bits.length > 1
    ? "Here: " + bits.slice(1).join(" · ") : "Here: " + bits[0];
});

poll(); setInterval(poll, 600);
requestAnimationFrame(loop);
// test/debug hook: lets a headless harness (or the console) reach the scene
if (typeof globalThis !== "undefined" && !("groveDebug" in globalThis))
  Object.defineProperty(globalThis, "groveDebug", {
    value: { ST, drawScene, updateDom, poll }, configurable: true });
</script>
</body>
</html>
"""

def _ip_hint(host):
    if host != "0.0.0.0":
        return (f"local only: http://localhost:{{}}"
                "\n  (LAN view: add --public, or tunnel: "
                "ssh -L 8787:localhost:8787 user@this-host)")
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
    print(f"grove web · world tick {g.world['tick']} "
          f"{W.season_name(g.world['tick'])}")
    print(_ip_hint(bind).format(port), flush=True)
    srv = ThreadingHTTPServer((bind, port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stopping.set()
        g.db.close()
