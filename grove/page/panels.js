/* the biography panel: any soul's ledger */
let bioTarget = null;               // the soul the follow-cam would keep
function openBio(oid, kind, sp, name) {
  bioTarget = { oid, kind };
  $("bio").classList.add("on");
  setHudVisibility();
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
  setHudVisibility();
};
$("followBtn").onclick = () =>
  setFollow($("followBtn").classList.contains("on") ? null : bioTarget);

/* follow-cam: the camera eases toward a soul each frame */
function setFollow(b) {
  ST.follow = b;
  $("followBtn").classList.toggle("on", !!b);
  const sc = document.querySelector(".map-scroll");
  if (!b && sc)
    sc.scrollTo({ left: 0, top: 0, behavior: "smooth" });
}
function trackFollow() {
  const s = ST.s, f = ST.follow;
  if (!s || !f) return;
  const list = f.kind === "animal" ? s.animals : s.plants;
  let ent = null;
  // a fallen tree stays findable; the ledger keeps it, the cam lets it lie
  for (const q of list || [])
    if (q.id === f.oid && q.st !== "log") { ent = q; break; }
  if (!ent) return;
  const sc = document.querySelector(".map-scroll");
  if (!sc) return;
  // iso() is world-local; the scroller counts canvas pixels, where the
  // point lands at (PX, PY) + the world unit scaled by FIT
  const u = iso(ent.x, ent.y);
  const px = PX + u[0] * FIT, py = PY + u[1] * FIT;
  sc.scrollLeft += (px - sc.clientWidth / 2 - sc.scrollLeft) * 0.14;
  sc.scrollTop += (py - sc.clientHeight / 2 - sc.scrollTop) * 0.14;
}

/* ============ the HUD's life: calm, fullscreen, tabs ============ */
/* The panels are always here now. They used to fade out after a few still
   seconds and leave only the world, on the theory that the chronicle was
   something you woke; there is room on the screen for both, so they stay,
   and 'c' (calm) is the one thing that clears the view. */

$("tabChron").onclick = () => {
  $("chron").hidden = false; $("sparks").hidden = true;
  $("tune").hidden = true;
  $("tabChron").classList.add("on"); $("tabCensus").classList.remove("on");
  $("tabTune").classList.remove("on");
};
$("tabCensus").onclick = () => {
  $("chron").hidden = true; $("sparks").hidden = false;
  $("tune").hidden = true;
  $("tabCensus").classList.add("on"); $("tabChron").classList.remove("on");
  $("tabTune").classList.remove("on");
};
$("tabTune").onclick = async () => {
  $("chron").hidden = true; $("sparks").hidden = true;
  $("tune").hidden = false;
  $("tabTune").classList.add("on"); $("tabChron").classList.remove("on");
  $("tabCensus").classList.remove("on");
  const r = await fetch("/api/tuning");
  const s = await r.json();
  /* The steward takes its own first amendment, so under auto-tune the rest
     are only a record of what it also asked for — there is nothing for the
     keeper to press, and the accept/leave buttons belong to the
     offers-only flow (`--no-auto-tune`). */
  const auto = !!s.auto_tune;
  // both ends of the move: a steward's worth is in what it changed FROM
  const moveTo = (was, now) =>
      (was === null || was === undefined) ? `→ ${now}` : `${was} → ${now}`;
  const rows = (s.pending || []).map(p =>
    `<li><b>${p.rule}</b> ${moveTo(p.was, p.value)}` +
    `<div class="when">wk${p.week} — ${p.why}</div>` +
    (auto ? "" :
      `<div><button class="mini" data-a="accept" data-id="${p.id}">⚔ accept</button> ` +
      `<button class="mini" data-a="dismiss" data-id="${p.id}">leave it</button></div>`) +
    `</li>`);
  const last = s.last
      ? `<div class="when" style="margin-bottom:8px">the steward read the ` +
        `ledger at wk${s.last.week} — ` +
        (s.last.amendments
          ? s.last.amendments + " amendment" + (s.last.amendments > 1 ? "s" : "")
          : "nothing to change") +
        (s.last.verdict ? `<br><i>“${s.last.verdict}”</i>` : "") + `</div>`
      : "";
  const head = rows.length && auto
      ? `<div class="when" style="margin:2px 0 5px">also asked for, and kept ` +
        `for the record — one rule is taken a year:</div>` : "";
  $("tune").innerHTML = last + head + (rows.join("") ||
      "<div class='when'>the steward offers nothing at the moment.</div>");
  const hrows = (s.history || []).slice(0, 8).map(h =>
    `<li style="opacity:.75"><b>${h.rule}</b> ${moveTo(h.was, h.value)}` +
    ` <span class="when">${h.status} · wk${h.week}</span></li>`);
  if (hrows.length)
    $("tune").innerHTML += "<div style='margin-top:8px'><i style='color:var(--dim);font-size:12px'>the world's amendments</i></div>" +
      "<ul class='chron' style='max-height:none'>" + hrows.join("") + "</ul>";
  for (const b of document.querySelectorAll("button.mini"))
    b.onclick = async () => {
      await fetch("/api/tuning/" + b.dataset.a,
                  {method: "POST", headers: {"Content-Type": "application/json"},
                   body: JSON.stringify({ id: parseInt(b.dataset.id) })});
      $("tabTune").onclick();
    };
};

let calm = false;
function setHudVisibility() {
  const reading = document.getElementById("bio") &&
      document.getElementById("bio").classList.contains("on");
  // 'c' clears the HUD; an open biography holds it on screen regardless
  document.body.classList.toggle("calm", calm && !reading);
}
window.addEventListener("keydown", e => {
  if (e.target && e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); $("pauseBtn").onclick(); }
  else if (e.key === "s") { if (!$("stepBtn").disabled) $("stepBtn").onclick(); }
  else if (e.key === "n") { if (!$("soulBtn").disabled) $("soulBtn").onclick(); }
  else if (e.key === "f") $("fsBtn").onclick();
  else if (e.key === "c") { calm = !calm; setHudVisibility(); }
});
$("fsBtn").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().then(() =>
    setTimeout(() => { if (ST.s && ST.s.size) fitCanvas(ST.s.size); }, 250));
};

poll(); setInterval(poll, 600);
requestAnimationFrame(loop);
// test/debug hook: lets a headless harness (or the console) reach the scene
if (typeof globalThis !== "undefined" && !("groveDebug" in globalThis))
  Object.defineProperty(globalThis, "groveDebug", {
    value: { ST, ENG, drawScenePixi, glideOf, pickCell, updateDom,
             poll, CW: () => CW, CH: () => CH,
             // where a cell's ground lands on the canvas: a harness needs
             // this to click a tile wherever the framing has put it
             cellPoint: (x, y) => {
               const [ix, iy] = iso(x, y);
               return [PX + ix * FIT, PY + (iy - elevAt(x, y)) * FIT];
             } }, configurable: true });
