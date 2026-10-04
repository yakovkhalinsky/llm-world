
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
    if (s.biome) {
      // the pack's own colours and shapes, over the built-in fallbacks
      if (s.biome.seasons) Object.assign(SEASONS, s.biome.seasons);
      if (s.biome.bodies) Object.assign(ANIMAL_BODY, s.biome.bodies);
      if (s.biome.shapes) Object.assign(SHAPES, s.biome.shapes);
    }
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
  $("pops").innerHTML = (s.pop_chips || []).map(c =>
    `<div class="popline"><span class="picon">${c.emo}</span>` +
    `<span class="pname">${c.name}</span>` +
    `<span class="pnum">${c.n}</span></div>`).join("");
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
  $("status").textContent = (s.paused ? "paused · " : "") + s.llm.status +
      (s.llm.reason ? " — last stumble: " + s.llm.reason : "");
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

