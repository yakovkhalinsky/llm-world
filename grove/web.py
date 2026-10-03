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
from urllib.parse import urlparse, parse_qs

from . import llm as llmm
from . import memory
from . import operator
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
        plants = [{"id": p["id"], "sp": p["sp"], "x": p["x"], "y": p["y"],
                   "st": p["stage"],
                   "el": 1 if p.get("elder") or p["id"] in w["elder_ids"]
                   else 0,
                   "b": 1 if p.get("berries") else 0,
                   "n": names.get(str(p["id"]))}
                  for p in w["plants"].values()]
        animals = [{"id": a["id"], "sp": a["sp"], "x": a["x"], "y": a["y"],
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
  .wrap { max-width: 1160px; margin: 0 auto; padding: 16px 14px 40px; }
  h1 { font-size: 20px; margin: 6px 0 2px; letter-spacing: .04em; }
  .sub { color: var(--dim); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px 14px; margin: 12px 0;
  }
  .map-scroll { overflow: auto;
                height: calc(100vh - 288px);
                height: calc(100dvh - 288px);
                min-height: 320px;
                background: radial-gradient(
                    ellipse at 50% 30%,
                    rgba(38, 58, 46, 0.35),
                    rgba(12, 18, 16, 0.0) 70%); }
  .map-scroll > * { margin: auto; }    /* centered when small, pannable */
  #scene { display: block; cursor: pointer; border-radius: 8px; }
  .zoomrow { display: flex; gap: 6px; align-items: center;
             justify-content: center; margin: 6px 0 0; }
  .zoomrow button { padding: 3px 10px; font-size: 13px; }
  .zoomrow .on { border-color: var(--moss); color: var(--moss); }
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
  #bio { display: none; position: fixed; right: 14px; bottom: 16px;
        width: min(360px, 92vw); max-height: 54vh; overflow: auto;
        z-index: 5; box-shadow: 0 10px 34px rgba(0,0,0,0.55); }
  #bio.on { display: block; }
  .biohead { display: flex; justify-content: space-between;
             align-items: center; gap: 8px; }
  .biohead h3 { margin: 0; font-size: 15px; }
  .biohead .x { cursor: pointer; border: none; background: none;
                color: var(--dim); font-size: 16px;
                padding: 0 2px 4px; }
  .timeline { list-style: none; margin: 6px 0 0; padding: 0;
              font-size: 13.5px; }
  .timeline li { padding: 3px 0; border-top: 1px solid var(--line); }
  .timeline .wk { color: var(--dim); font-size: 11px;
                  display: inline-block; width: 40px; }
  #followBtn.on { border-color: var(--moss); color: var(--moss); }
  #qinput { background: var(--panel-2); color: var(--text);
            border: 1px solid var(--line); border-radius: 8px;
            padding: 6px 10px; font: inherit; font-size: 14px;
            flex: 1; min-width: 130px; }
  #askout { flex-basis: 100%; }
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
    <div class="map-scroll">
      <canvas id="scene"></canvas>
      <pre class="map" id="map">…</pre>
    </div>
    <div class="zoomrow">
      <button id="zoomFit" class="on">fit</button>
      <button id="zoom1x">1.5×</button>
      <button id="zoom2x">2×</button>
      <span class="status" id="zoomHint">click a tile to inspect</span>
    </div>
  </div>

  <div class="card">
    <div id="look"></div>
    <div class="row">
      <button id="pauseBtn">⏸ pause</button>
      <button id="stepBtn">+ one week</button>
      <button id="soulBtn">☾ invite the soul</button>
      <span class="soul" id="soul"></span>
    </div>
    <div class="row" style="margin-top:8px">
      <input id="qinput" placeholder="ask the grove — a name, a season, a fate…">
      <button id="askBtn">ask ☾</button>
      <span class="soul" id="askout"></span>
    </div>
  </div>

  <div id="bio" class="card">
    <div class="biohead">
      <h3 id="bioName">…</h3>
      <span><button id="followBtn">◎ follow</button>
      <button class="x" id="bioClose">✕</button></span>
    </div>
    <div class="status" id="bioState"></div>
    <ul class="timeline" id="bioRows"></ul>
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
      // creatures cover their journey in the early part of their week,
      // then browse and rest; the flight still ends before the next week
      const dur = Math.max(0.5, (s.tick_seconds - lag) * 0.45);
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

const TW = 40, TH = 20;              // isometric tile diamond (2:1)
const SIDE = 17;                     // slab thickness under the floor
const PADX = 30, PADY = 72;          // margins head-/foot-room
const cnv = $("scene"), ctx = cnv.getContext("2d");
const DPR = Math.max(1.5, window.devicePixelRatio || 1);
/* art factor: everything drawn scales with the tile size */
const K = TW / 30;
let OX = 0, OY = 0, CW = 0, CH = 0;
/* contain-fit: the scene takes whatever room the window gives it,
   drawn at device resolution so zoom stays sharp; only re-fits when
   the size, zoom or window box actually changed */
let VIEW = { dw: 0, dh: 0, zoom: 1 };
function fitCanvas(size) {
  const sc = document.querySelector(".map-scroll");
  const availW = (sc ? sc.clientWidth : window.innerWidth - 20) || 600;
  const availH = (sc ? sc.clientHeight : window.innerHeight - 200) || 400;
  const w = (size - 1) * TW + TW + PADX * 2;
  const h = (size - 1) * TH + TH + PADY * 2;
  const key = `${size}|${VIEW.zoom}|${Math.round(availW)}x${Math.round(availH)}`;
  if (fitCanvas.key === key) return;
  fitCanvas.key = key;
  CW = w; CH = h;
  if (VIEW.zoom === 1) {
    VIEW.dw = Math.min(availW, availH * w / h);
    VIEW.dh = VIEW.dw * h / w;                 // contain: both fit
  } else {
    VIEW.dw = availW * VIEW.zoom;              // zoom wins; user pans
    VIEW.dh = VIEW.dw * h / w;
  }
  cnv.width = Math.round(VIEW.dw * DPR);
  cnv.height = Math.round(VIEW.dh * DPR);
  cnv.style.width = `${Math.round(VIEW.dw)}px`;
  cnv.style.height = `${Math.round(VIEW.dh)}px`;
  OX = w / 2;  OY = PADY;          // (0,0) sits at the top corner
  const s = VIEW.dw * DPR / w;     // logical → buffer pixels
  ctx.setTransform(s, 0, 0, s, 0, 0);
}
window.addEventListener("resize", () => {
  if (ST.s && ST.s.size) fitCanvas(ST.s.size);
});
/* cell (x, y) → screen position of the diamond's center */
function iso(x, y) { return [OX + (x - y) * TW / 2, OY + (x + y) * TH / 2]; }

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

/* one isometric ground diamond centered at (cx, cy) */
function diamondPath(c, cx, cy) {
  c.beginPath();
  c.moveTo(cx, cy - TH / 2);
  c.lineTo(cx + TW / 2, cy);
  c.lineTo(cx, cy + TH / 2);
  c.lineTo(cx - TW / 2, cy);
  c.closePath();
}

/* soft ellipse shadow that grounds a standing thing */
function shadow(cx, cy, rx) {
  ctx.fillStyle = "rgba(8,14,11,0.20)";
  ctx.beginPath(); ctx.ellipse(cx, cy + 2 * K, rx * K, rx * 0.38 * K,
                               0, 0, 6.3);
  ctx.fill();
}

function drawTerrain(s, tsec) {
  const p = pal(), size = s.size;
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    const [sx, sy] = iso(i % size, Math.floor(i / size));

    if (c[0] === "w") {
      ctx.fillStyle = p.water;
      diamondPath(ctx, sx, sy); ctx.fill();
      const wob = Math.sin(tsec * 1.4 + i * 1.7) * 2;
      ctx.strokeStyle = "rgba(200,225,240,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 7, sy + wob);
      ctx.lineTo(sx + 4, sy + wob);
      ctx.stroke();
      continue;
    }

    diamondPath(ctx, sx, sy);
    ctx.fillStyle = p.soil;
    ctx.fill();
    const g = c[1];
    if (g > 0.06) {
      ctx.globalAlpha = Math.min(1, g * 0.9);
      ctx.fillStyle = p.grass;
      diamondPath(ctx, sx, sy); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (c[2] > 0.75) {                             // soaked ground
      ctx.fillStyle = "rgba(30,50,66,0.18)";
      diamondPath(ctx, sx, sy); ctx.fill();
    }
    if (c[0] === "r") {
      ctx.fillStyle = p.rock;
      diamondPath(ctx, sx, sy); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(sx - 5, sy); ctx.lineTo(sx, sy - 5);
      ctx.lineTo(sx + 5, sy); ctx.closePath(); ctx.fill();
    }

    /* faint diamond seams so the grid reads */
    ctx.strokeStyle = "rgba(0,0,0,0.055)";
    ctx.lineWidth = 1;
    diamondPath(ctx, sx, sy); ctx.stroke();

    if (c[3]) {                                    // mushrooms
      ctx.fillStyle = "#e8e3d2";
      ctx.fillRect(sx - 1, sy - 2, 2, 5);
      ctx.fillStyle = "#b0483c";
      ctx.beginPath(); ctx.arc(sx, sy - 2, 4, 3.2, 6.1); ctx.fill();
    }
    if (c[4]) {                                    // carrion
      ctx.fillStyle = "#c9c2b8";
      ctx.beginPath(); ctx.arc(sx, sy + 2, 3.2, 0, 6.3); ctx.fill();
    }
  }
}

/* the world sits on a raised earth slab */
function drawSlab(s) {
  const size = s.size, p = pal();
  const [rx, ry] = iso(size - 1, 0);
  const [bx, by] = iso(size - 1, size - 1);
  const [lx, ly] = iso(0, size - 1);
  ctx.fillStyle = "#4a392a";                       // sunlit side
  ctx.beginPath();
  ctx.moveTo(rx + TW / 2, ry);
  ctx.lineTo(bx, by + TH / 2);
  ctx.lineTo(bx, by + TH / 2 + SIDE);
  ctx.lineTo(rx + TW / 2, ry + SIDE);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#3a2d20";                       // shaded side
  ctx.beginPath();
  ctx.moveTo(bx, by + TH / 2);
  ctx.lineTo(lx - TW / 2, ly);
  ctx.lineTo(lx - TW / 2, ly + SIDE);
  ctx.lineTo(bx, by + TH / 2 + SIDE);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.22)";              // soft ground shadow
  ctx.beginPath();
  ctx.ellipse(OX, OY + (size - 1) * TH + SIDE + 8,
              (size - 1) * TW / 2 + 30, 20, 0, 0, 6.3);
  ctx.fill();
}

function drawPlant(t, tsec) {
  const p = pal(), sway = Math.sin(tsec * 1.1) * 0.05;
  const [sx, sy] = iso(t.x, t.y);
  const isPine = t.sp === "pine";

  if (t.st === "log") {                            // flat lying trunk
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((t.x * 7 % 3 - 1) * 0.25);          // settled at an angle
    ctx.fillStyle = "#6b4a33";
    roundRect(ctx, -10 * K, -4 * K, 20 * K, 5 * K, 2 * K);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(-10 * K, -4 * K, 20 * K, 2 * K);
    ctx.restore();
    return;
  }
  if (t.sp === "fern") {
    ctx.strokeStyle = "#3f6d38"; ctx.lineWidth = 1.4 * K;
    for (let k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.moveTo(sx, sy + 2 * K);
      ctx.quadraticCurveTo(sx + k * 4 * K, sy - 6 * K,
                           sx + k * 6 * K, sy - 11 * K + sway * 26 * K);
      ctx.stroke();
    }
    return;
  }
  if (t.sp === "berry") {
    shadow(sx, sy, 6);
    ctx.fillStyle = "#4a7a3a";
    ctx.beginPath();
    ctx.ellipse(sx, sy - 3 * K, 7.5 * K, 5.2 * K, 0, 0, 6.3); ctx.fill();
    if (t.b) {
      ctx.fillStyle = "#b03a48";
      for (const [bx, byy] of [[-3.5, -4], [1, -6.5], [4, -3.5]]) {
        ctx.beginPath();
        ctx.arc(sx + bx * K, sy + byy * K, 1.5 * K, 0, 6.3); ctx.fill();
      }
    }
    return;
  }
  // trees
  let scale = t.st === "mature" ? 1 : t.st === "old" ? 1.1 : 0.55;
  if (t.el) scale *= 1.12;
  scale *= K;                                      // art grows with tiles
  shadow(sx, sy, 9 * scale);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(sway * (isPine ? 0.35 : 0.85));
  const trunkCol = t.sp === "birch" ? "#d9d4c9"
      : t.sp === "willow" ? "#8a7663" : "#5b422f";
  const trunkH = isPine ? 7 : 10, tw = (t.st === "sapling" ? 2 : 3) * K;
  ctx.fillStyle = trunkCol;
  ctx.fillRect(-tw / 2, -trunkH * scale, tw, trunkH * scale);
  if (t.sp === "birch" && t.st !== "sapling") {
    ctx.fillStyle = "rgba(70,70,70,0.7)";
    ctx.fillRect(-1.6 * K, -trunkH * scale + 2, 1.5 * K, K);
  }
  const leafCol = isPine ? p.pine : p.leaf;
  if (isPine) {
    ctx.fillStyle = leafCol;
    for (let k = 0; k < 3; k++) {
      const w = (11 - k * 3) * scale, h = (9 - k) * scale,
            oy = -(7 + k * 4.5) * scale;
      ctx.beginPath();
      ctx.moveTo(0, oy - h);
      ctx.lineTo(w, oy);
      ctx.lineTo(-w, oy);
      ctx.closePath(); ctx.fill();
    }
    if (ST.s && ST.s.season === "winter") {
      ctx.fillStyle = "rgba(240,246,250,0.55)";
      ctx.beginPath();
      ctx.moveTo(0, -22 * scale); ctx.lineTo(3.5 * scale, -17 * scale);
      ctx.lineTo(-3.5 * scale, -17 * scale);
      ctx.closePath(); ctx.fill();
    }
  } else {
    const r = 9.5 * scale;
    const cy = -trunkH * (t.st === "sapling" ? 1.15 : 1) - r * 0.55;
    ctx.fillStyle = leafCol;
    ctx.beginPath();
    ctx.ellipse(0, cy, r, r * 0.72, 0, 0, 6.3); ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(r * 0.5, cy + r * 0.3, r * 0.68, r * 0.5, 0, 0, 6.3);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-r * 0.55, cy + r * 0.15, r * 0.6, r * 0.45, 0, 0, 6.3);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (t.sp === "willow") {                       // drooping fronds
      ctx.strokeStyle = leafCol; ctx.lineWidth = 1.3;
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 3, cy + r * 0.3);
        ctx.quadraticCurveTo(k * 5.5, cy + r * 0.9, k * 7, cy + r * 1.6);
        ctx.stroke();
      }
    }
    if (t.st === "old" || t.el) {
      ctx.fillStyle = "rgba(30,42,28,0.22)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.3, cy - r * 0.35, r * 0.5, r * 0.38, 0, 0, 6.3);
      ctx.fill();
    }
  }
  ctx.restore();
  if ((t.st === "old" || t.el) && t.n && t.n !== "-") {
    const ly = -trunkH * 2 - 16 * scale;
    ctx.font = "italic 9px Georgia, serif";
    ctx.fillStyle = "rgba(10,14,12,0.65)";
    ctx.fillText(t.n, sx + 1, ly);
    ctx.fillStyle = "#dfe9db";
    ctx.fillText(t.n, sx, ly - 1);
  }
}

function drawAnimal(a, f, tsec, idx) {
  // glide between week-start and week-end cells — in iso space
  const e = f < 1 ? (f * f * (3 - 2 * f)) : 1;   // smoothstep
  const cx0 = ((a.px - a.py) * TW / 2), cy0 = ((a.px + a.py) * TH / 2);
  const cx1 = ((a.x - a.y) * TW / 2), cy1 = ((a.x + a.y) * TH / 2);
  const gx = cx0 + (cx1 - cx0) * e, gy = cy0 + (cy1 - cy0) * e;
  const body = ANIMAL_BODY[a.sp] || "#999";
  // face the direction of glide; keep the facing when the glide is done
  // or when a creature briefly stands still (index-sticky across polls)
  const dx = cx1 - cx0;
  if (Math.abs(dx) > 0.9) FACING[idx] = dx < 0 ? -1 : 1;
  const flip = FACING[idx] || 1;
  const flyer = a.sp === "owl" || a.sp === "robin";
  const lift = (flyer ? -9 : Math.sin(tsec * 5 + a.x) * 0.8);
  const cy = OY + gy + lift * K;
  if (flyer) shadow(OX + gx, OY + gy + 2, 3);      // small, distant
  else shadow(OX + gx, OY + gy, 6);
  ctx.save();
  ctx.translate(OX + gx, cy);
  ctx.scale(flip * K, K);
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
    ctx.fillText(a.n, OX + gx + 1, cy - 10 * K);
    ctx.fillStyle = "#dfe9db";
    ctx.fillText(a.n, OX + gx, cy - 11 * K);
  }
}

/* particles fall over the whole scene */
const dots = [];
function spawnParticles(s, dt) {
  const storm = s.weather === "storm", rain = s.weather === "rain",
        frost = s.weather === "frost";
  const count = kind => dots.reduce((n, d) => n + (d.kind === kind), 0);
  if ((rain || storm) && count("rain") < (storm ? 120 : 36) &&
      Math.random() < 0.5)
    dots.push({ kind: "rain", x: Math.random() * CW, y: -6,
                v: 190 + Math.random() * 90, dx: storm ? 42 : 12 });
  if (frost && count("snow") < 70)
    for (let k = 0; k < 2; k++)
      dots.push({ kind: "snow", x: Math.random() * CW, y: -4,
                  v: 18 + Math.random() * 14, dx: Math.random() * 10 - 5 });
  if (s.season === "autumn" && count("leaf") < 10 && Math.random() < 0.015)
    dots.push({ kind: "leaf", x: Math.random() * CW, y: -4,
                v: 22 + Math.random() * 16, dx: Math.random() * 24 - 12 });
}

function drawParticles(dt) {
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    d.y += d.v * dt; d.x += d.dx * dt;
    if (d.kind === "leaf") d.x += Math.sin((d.y + i * 10) * 0.05) * 12 * dt;
    if (d.y > CH - 4) { dots.splice(i, 1); continue; }
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
    const reg = REGIONS[e.split(" over ")[1].split(" ")[0]] || REGIONS.all;
    const x0 = reg[0] * s.size, xe = reg[2] * s.size;
    const y0 = reg[1] * s.size, ye = reg[3] * s.size;
    ctx.fillStyle = e.startsWith("blight")
        ? "rgba(120,60,140,0.15)"
        : e.startsWith("drought") ? "rgba(190,140,40,0.16)"
        : "rgba(140,210,140,0.10)";
    ctx.beginPath();
    ctx.moveTo(...iso(x0, y0));
    ctx.lineTo(...iso(xe, y0));
    ctx.lineTo(...iso(xe, ye));
    ctx.lineTo(...iso(x0, ye));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(230,230,230,0.14)";
    ctx.setLineDash([4, 4]);
    ctx.stroke();
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

  drawSlab(s);
  drawTerrain(s, tsec);

  /* depth sorting: entities paint far-to-near (by x+y); within one
     diamond the ground cover comes first, creatures in front */
  const ents = [];
  for (const t of s.plants)
    ents.push({ d: t.x + t.y, k: t.st === "log" ? 0 : 1, t });
  s.animals.forEach((a, i) => ents.push({ d: a.x + a.y, k: 2, a, i }));
  ents.sort((p, q) => p.d - q.d || p.k - q.k);
  for (const en of ents) {
    if (en.k === 1) drawPlant(en.t, tsec);
    else if (en.k === 2) drawAnimal(en.a, glide, tsec, en.i);
  }
  trackFollow(glide);
  spawnParticles(s, dt);
  drawParticles(dt);
  drawEffects(s);

  if (pal().wash) {
    ctx.fillStyle = pal().wash;
    ctx.fillRect(0, 0, CW, CH);
  }
  if (s.weather === "storm") {
    ctx.fillStyle = "rgba(20,28,40,0.25)";
    ctx.fillRect(0, 0, CW, CH);
    if (Math.random() < 0.006) flash = 0.30;
  }
  if (flash > 0) {
    ctx.fillStyle = `rgba(240,245,255,${flash})`;
    ctx.fillRect(0, 0, CW, CH);
    flash -= dt * 1.8;
  }
}

function loop(tnow) {
  if (!document.body.classList.contains("plain"))
    drawScene(tnow);
  requestAnimationFrame(loop);
}

/* look at a tile (click) — inverse isometric mapping; a named (or lone)
   occupant opens its biography */
cnv.addEventListener("click", e => {
  const s = ST.s;
  if (!s || !s.cells) return;
  const r = cnv.getBoundingClientRect();
  const u0 = (e.clientX - r.left) / r.width * CW;
  const v0 = (e.clientY - r.top) / r.height * CH;
  const x = Math.round((u0 - OX) / (TW / 2) / 2
                       + (v0 - OY) / (TH / 2) / 2);
  const y = Math.round((v0 - OY) / (TH / 2) / 2
                       - (u0 - OX) / (TW / 2) / 2);
  if (x < 0 || y < 0 || x >= s.size || y >= s.size) return;
  const c = s.cells[y * s.size + x];
  const here = [];
  for (const a of s.animals || [])
    if (a.x === x && a.y === y) here.push({ id: a.id, kind: "animal",
                                            sp: a.sp, n: a.n });
  for (const t of s.plants || [])
    if (t.x === x && t.y === y && t.st !== "log") here.push(
      { id: t.id, kind: "plant", sp: t.sp, n: t.n });
  const named = here.filter(t => t.n);
  if (named.length === 1 || here.length === 1) {
    const one = named[0] || here[0];
    openBio(one.id, one.kind, one.sp, one.n);
    $("look").textContent = "Here: " + (one.n || "a wild " + one.sp);
    return;
  }
  const bits = [];
  if (c[0] === "w") bits.push("the water");
  else if (c[0] === "r") bits.push("rock");
  else if (c[1] > 0.5) bits.push("long grass");
  else bits.push("open ground");
  for (const t of here)
    bits.push(`${t.n || "a wild " + t.sp} (${t.kind === "plant"
               ? t.st : "creature"})`);
  $("look").textContent = "Here: " + bits.join(" · ");
});

/* zoom: fit / 1.5x / 2x — real levels; the scroller pans when zoomed */
const zoomLevels = [["zoomFit", 1], ["zoom1x", 1.6], ["zoom2x", 2.2]];
for (const [zid, z] of zoomLevels)
  $(zid).onclick = () => {
    VIEW.zoom = z;
    fitCanvas.key = null;
    if (ST.s && ST.s.size) fitCanvas(ST.s.size);
    for (const [oid] of zoomLevels)
      $(oid).classList.toggle("on", oid === zid);
    const sc = document.querySelector(".map-scroll");
    if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
  };

/* ask the grove a question — answered from the world's own history */
$("askBtn").onclick = async () => {
  const q = $("qinput").value.trim();
  if (!q || !q.length) return;
  $("askout").textContent = " ☾ the grove ponders…";
  $("askBtn").disabled = true;
  try {
    const r = await fetch("/api/ask", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
      signal: AbortSignal.timeout(90000) });
    const s = await r.json();
    $("askout").textContent = s.answer ? (" ☾ " + s.answer)
                                       : " ☾ no answer came";
  } catch (e) { $("askout").textContent = " ☾ the thought was lost"; }
  $("askBtn").disabled = false;
};
$("qinput").addEventListener("keydown", e => {
  if (e.key === "Enter") $("askBtn").onclick();
});

/* the biography panel: any soul's ledger */
function openBio(oid, kind, sp, name) {
  $("bio").classList.add("on");
  $("bioName").textContent = (name || "a wild " + sp) + " · " + sp;
  $("bioState").textContent = "consulting the ledger…";
  $("bioRows").innerHTML = "";
  fetch("/api/bio?id=" + oid).then(r => r.json()).then(b => {
    const state = b.gone ? "remembered in the chronicle"
        : (b.alive ? "alive in the grove" : "…");
    $("bioName").textContent = (b.name || name || "a wild " + b.sp)
        + " · " + b.sp;
    $("bioState").textContent = state;
    const rows = b.events || [];
    $("bioRows").innerHTML = rows.map(ev =>
      `<li><span class="wk">wk${ev.tick}</span>${ev.text}</li>`).join("") ||
      "<li><span class='wk'>—</span>no marked events yet; its story is still quiet.</li>";
  }).catch(() => { $("bioState").textContent = "the ledger resisted"; });
}
$("bioClose").onclick = () => {
  $("bio").classList.remove("on");
  setFollow(null);
};
$("followBtn").onclick = () =>
  setFollow($("followBtn").classList.contains("on") ? null : { oid: bio.oid, kind: bio.kind });

/* follow-cam: the camera eases toward a soul each frame */
function setFollow(b) {
  ST.follow = b;
  $("followBtn").classList.toggle("on", !!b);
  const sc = document.querySelector(".map-scroll");
  if (!b && sc)
    sc.scrollTo({ left: 0, top: 0, behavior: "smooth" });
}
function trackFollow(glide) {
  const s = ST.s, f = ST.follow;
  if (!s || !f) return;
  const list = f.kind === "animal" ? s.animals : s.plants;
  let ent = null;
  for (const q of list || []) if (q.id === f.oid && !q.log) { ent = q; break; }
  if (!ent) return;
  const sc = document.querySelector(".map-scroll");
  if (!sc) return;
  const scale = VIEW.dw / CW;
  const px = iso(ent.x, ent.y)[0] * scale,
        py = iso(ent.x, ent.y)[1] * scale;
  sc.scrollLeft += (px - sc.clientWidth / 2 - sc.scrollLeft) * 0.14;
  sc.scrollTop += (py - sc.clientHeight / 2 - sc.scrollTop) * 0.14;
}

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

    if g.llm and g.llm.enabled:
        def indexer():
            time.sleep(20)
            while True:
                try:          # one patient batch per pass; the chronicle
                    memory.ensure_index(g.db, g.llm, limit=32)
                except Exception:
                    pass
                time.sleep(75)
        threading.Thread(target=indexer, daemon=True).start()

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
            elif path == "/api/bio":
                qs = parse_qs(urlparse(self.path).query)
                try:
                    oid = int((qs.get("id") or ["0"])[0])
                except ValueError:
                    oid = 0
                with lock:
                    world_w = g.world
                    if world_w is None:
                        self._send(404, '{"error": "no world"}',
                                   "application/json")
                        return
                    animal = world_w["animals"].get(str(oid))
                    plant = world_w["plants"].get(str(oid))
                    ent = animal or plant
                    if ent is None:
                        self._send(200, json.dumps(
                            {"id": oid, "gone": True,
                             "events": g.db.bio(oid)}), "application/json")
                        return
                    self._send(200, json.dumps({
                        "id": oid,
                        "kind": "animal" if animal else "plant",
                        "sp": ent["sp"],
                        "name": world_w["names"].get(str(oid)),
                        "alive": True,
                        "x": ent["x"], "y": ent["y"],
                        "events": g.db.bio(oid),
                    }), "application/json")
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
            elif path == "/api/ask":
                # the ask waits for its turn, then thinks OUTSIDE the
                # world lock — the forest keeps ticking while it ponders
                try:
                    length = int(self.headers.get("Content-Length", 0) or 0)
                    q = json.loads(
                        self.rfile.read(length).decode()).get("q", "")
                except Exception:
                    q = ""
                q = str(q).strip()[:300]
                if not q:
                    self._send(200, json.dumps({"answer": "…",
                                                "excerpts": []}),
                               "application/json")
                    return
                waited = 0.0
                while g.worker and g.worker.busy and waited < 40:
                    time.sleep(0.5)
                    waited += 0.5
                t0 = time.time()
                # index newer chronicle lines (out of the lock; the sqlite
                # connection is serialized, and the forest must not stall)
                try:
                    memory.ensure_index(g.db, g.llm)
                except Exception:
                    pass
                with lock:                       # brief reads only
                    if g.world is None or g.llm is None or not g.llm.enabled:
                        self._send(200, json.dumps(
                            {"answer": "the grove is wordless just now "
                                       "(LLM off)", "excerpts": []}),
                            "application/json")
                        return
                    excerpts = memory.recall(g.db, g.llm, q)
                    digest_text = operator.digest(g.world, [])
                prompt = ("question: " + q
                          + "\n\ndigest of the world now:\n" + digest_text
                          + "\n\nchronicle excerpts:\n"
                          + "\n".join(f" wk{e['tick']}: {e['text']}"
                                      for e in excerpts))
                ans = g.llm.chat_json(memory.ASK_SYSTEM, prompt,
                                      memory.ASK_SCHEMA, max_tokens=100,
                                      temperature=0.7, retries=1,
                                      job="ask")
                answer = (ans or {}).get("answer", "")
                answer = str(answer).strip()[:400]
                if not answer:
                    answer = "The grove lost the thought mid-way. Ask again?"
                self._send(200, json.dumps(
                    {"answer": answer, "excerpts": excerpts,
                     "took": round(time.time() - t0, 1)}),
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
