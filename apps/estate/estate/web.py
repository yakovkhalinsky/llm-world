"""estate web — a zero-dependency dashboard for the estate.

Serves one hand-written HTML page (no build step, works fully offline) plus
a small JSON state API. The simulation keeps running in a background thread;
visitors get pause / step / speed controls.

The plan is drawn by **PixiJS**, vendored beside the page — the same engine
grove's island uses, and for the same reason: this is a living picture of a
place, not a chart of its numbers, and a world you cannot see is a world you
cannot judge (grove's b26/b48 — several bugs were found only by looking at
the artifact). A plain glyph map remains as the honest fallback, exactly as
it does for the grove.

  estate web [--port 8787] [--public] [--tick-seconds 6] [--offline]

Default bind is loopback only (viewable through an ssh tunnel); pass
--public to open it to the LAN.
"""

import json
import os
import random
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import chronicler
from . import db as dbm
from . import llm as llmm
from . import render
from . import rules
from . import sim
from . import watcher
from . import world as W

POLL_MS = 700          # what the page is told to wait between polls


class SimRunner(threading.Thread):
    """Advances the estate in the background.

    `prev` is the day we just left, kept so the page can glide a resident
    from where they were to where they are. Grove's creatures glide between
    their weekly positions; a person glides between their days, and the day
    between them is drawn as five phases of light — which is the only way a
    five-phase day is visible in a one-day tick.
    """

    def __init__(self, est, lock, tick_seconds, llm=None):
        super().__init__(daemon=True)
        self.est = est
        self.lock = lock
        self.tick_seconds = tick_seconds
        self.llm = llm
        self.paused = False
        self.step_once = 0
        self.prev = {}
        self.events = []
        self.last_watch = {"fate": None, "region": None, "why": None,
                           "day": None}
        self.lines = []              # since the last chronicle entry
        self.span = 0                # days since the last chronicle entry
        self.chronicle = []
        self.next_watch = 0.0
        self.stop = threading.Event()

    def snapshot_prev(self):
        out = {}
        for rid, r in self.est.world["residents"].items():
            wh = r["where"]
            out[rid] = (wh["x"], wh["y"], wh["mode"], wh.get("unit"))
        return out

    def run(self):
        while not self.stop.is_set():
            if not self.paused or self.step_once:
                with self.lock:
                    self.prev = self.snapshot_prev()
                    evs = sim.tick(self.est.world)
                    self.events.extend(evs)
                    self.lines.extend(chronicler.day_lines(self.est.world, evs))
                    self.span += 1
                    del self.events[:-400]
                    self.est.save()
                if self.step_once:
                    self.step_once -= 1
                self._maybe_watch()
                self._maybe_chronicle()
            self.stop.wait(0.1 if (self.paused and self.step_once) else
                           self.tick_seconds)

    def _maybe_chronicle(self):
        """Write the estate's record of a stretch of days.

        The deterministic lines are gathered under the lock and the prose
        is written outside it — a model must never stall the estate — and
        the fallback is the lines themselves, so the record is complete
        whether or not anyone was awake to phrase it.
        """
        if not chronicler.worth_writing(self.span):
            return
        with self.lock:
            w = self.est.world
            lines = list(self.lines)
            span = self.span
            recent = [c["text"] for c in self.chronicle[-2:]]
        text = chronicler.narrate(self.llm, w, lines, span, recent)
        with self.lock:
            day = self.est.world["day"]
            self.est.db.add_chronicle(day, text)
        self.chronicle.append({"day": day, "text": text})
        del self.chronicle[:-40]
        self.lines = []
        self.span = 0

    def _maybe_watch(self):
        """Invite the watcher on its cadence, if there is one and it is
        due.

        The world lock is taken to read the digest and taken again to land
        the answer, and is NEVER held across the call: the estate must keep
        living while the model thinks. Grove lost a world to that (b9/b17)
        and it is not repeated here.
        """
        if self.llm is None or not self.llm.enabled:
            return
        now = time.time()
        if now < self.next_watch:
            return
        lo, hi = self.llm.watch_gap()
        self.next_watch = now + lo + random.random() * (hi - lo)
        with self.lock:
            recent = [render.say(e) for e in self.events[-8:]]
            text = watcher.digest(self.est.world, recent)
        raw = self.llm.chat_json(watcher.system(), text, watcher.schema(),
                                 max_tokens=220, job="watch")
        intent = watcher._quiet(why="the watcher did not answer") \
            if raw is None else watcher.validate(raw)
        with self.lock:
            watcher.queue(self.est.world, intent)
            self.est.save()
        intent["day"] = self.est.world["day"]
        self.last_watch = intent


class Estate:
    """A thin owner: the world, its database, and how a day is saved."""

    def __init__(self, args):
        self.args = args
        self.llm = None
        self.path = os.path.join(args.data, "estate.db")
        self.db = dbm.DB(self.path)
        self.world = self.db.load_world()
        if self.world is None:
            raise SystemExit(f"no estate in '{args.data}'; plant one first: "
                             f"estate new")
        if self.world.get("biome"):
            rules.select_biome(self.world["biome"])
        # the record the estate already has, so a restart resumes its
        # chronicle rather than beginning a new one
        self.history = self.db.chronicle(40)
        self.save_every = 1
        # the watcher is optional in the only sense that matters: with no
        # model the estate still runs, because the model never owned any of
        # it. `invite` returns quiet and the days go on.
        if not getattr(args, "offline", False):
            self.llm = llmm.LLM(model=getattr(args, "model", "auto") or "auto",
                                tier=getattr(args, "tier", "cloud"))

    def save(self):
        self.db.save_world(self.world)
        self.db.add_stats(self.world["day"], _census(self.world))


def _census(world):
    return W.counts(world)


def _codes():
    """The site names, in the order the grid's integers refer to them."""
    return list(rules.R["sites"])


# The ground is static: sent once under /api/ground, never polled.
_GROUND = {}


def ground(est):
    """The plan as it was drawn: which cell is what, and where the
    buildings stand. The walls never move, so the page fetches this once
    and the poll carries only what the day changed."""
    w = est.world
    codes = _codes()
    idx = {name: i for i, name in enumerate(codes)}
    rows = [[idx[c["site"]] for c in row] for row in w["cells"]]
    # the blocks are ground, not weather: where the walls stand never
    # changes once the estate is planted, so it is sent once and the poll
    # carries only who is in them today
    buildings, units = [], {}
    for bid, b in w["buildings"].items():
        buildings.append({"id": int(bid), "name": b["name"], "kind": b["kind"],
                          "x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"],
                          "floors": b["floors"], "door": b["door"]})
        per = {}
        for u in sorted(b["units"]):
            per.setdefault(w["units"][str(u)]["floor"], []).append(u)
        for fl, ids in per.items():
            for i, u in enumerate(ids):
                units[str(u)] = {"b": int(bid), "f": fl, "i": i,
                                 "n": len(ids), "floors": b["floors"]}
    return {
        "width": w["width"], "height": w["height"],
        "codes": codes, "rows": rows,
        "biome": w.get("biome"),
        "seed": w["seed"], "buildings": buildings, "units": units,
        # every glyph comes from the pack too. A page that spells its own
        # emoji is a second copy of a fact the pack owns, and the two
        # drift the first time a pack is edited (grove b21/b34).
        "glyphs": {
            "needs": {k: v.get("glyph") for k, v in rules.R["needs"].items()},
            "households": {k: v.get("glyph")
                           for k, v in rules.R["households"].items()},
            "fixtures": {k: v.get("glyph")
                         for k, v in rules.R["fixtures"].items()},
            "sites": {k: v.get("glyph") for k, v in rules.R["sites"].items()},
            "roles": render.ROLE_GLYPH,
            "weather": render.WEATHER_GLYPH,
        },
        "words": {"world": rules.R["presentation"].get("world_word",
                                                       "the estate"),
                  "seasons": list(rules.R["presentation"].get("seasons",
                                                              ()))},
    }


def _small(vals, scale=9.0):
    """A field as small integers: the page draws washes, not measurements,
    and 0-9 is all a wash needs."""
    return [min(9, int(v * scale)) for v in vals]


def snapshot(est, runner, lock):
    """Everything the page needs for one frame. Deliberately small: the
    ground is not repeated here, and the fields are quantised."""
    with lock:
        w = est.world
        prev = dict(runner.prev)
        evs = list(runner.events[-60:])
        day = w["day"]
        people = []
        for rid, r in w["residents"].items():
            wh = r["where"]
            px, py, pmode, punit = prev.get(rid, (wh["x"], wh["y"],
                                                  wh["mode"], wh.get("unit")))
            hh = w["households"].get(str(r["household"]), {})
            people.append({
                "id": int(rid), "name": r["name"], "role": r["role"],
                "kind": hh.get("kind"), "age": r["age"],
                "x": wh["x"], "y": wh["y"], "in": wh["mode"] == "in",
                "unit": wh.get("unit"),
                "px": px, "py": py, "pin": pmode == "in", "punit": punit,
                "habit": r["habit"], "stress": round(r["stress"], 1),
                "needs": {k: round(v, 2) for k, v in r["needs"].items()},
            })
        fixtures = [{"id": int(fid), "kind": f["kind"], "x": f["x"],
                     "y": f["y"], "c": round(f["condition"], 3),
                     "uses": f["use_total"], "stock": f.get("stock")}
                    for fid, f in w["fixtures"].items()]
        buildings = []
        for bid, b in w["buildings"].items():
            live = [u for u in b["units"]
                    if w["units"][str(u)]["household"] is not None]
            buildings.append({
                "id": int(bid), "units": len(b["units"]), "lived": len(live),
                "power": b["power"], "water": b["water"],
            })
        shade, light = [], []
        for row in w["cells"]:
            shade += _small([c["shade"] for c in row])
            light += _small([c["light"] for c in row])
        return {
            "day": day, "season": W.season_index(day),
            "season_name": W.season_name(day),
            "weekday": W.weekday_name(day),
            "year": W.year_of(day),
            "weather": w["weather"], "weather_left": w["weather_left"],
            "wet_days": w["wet_days"],
            "paused": runner.paused, "tick_seconds": runner.tick_seconds,
            "census": _census(w),
            "residents": len(w["residents"]),
            "units": len(w["units"]),
            "waiting": len(w["waiting"]),
            "people": people, "fixtures": fixtures,
            "buildings": buildings,
            "shade": shade, "light": light,
            "events": [dict(e, say=render.say(e)) for e in evs],
            "watcher": dict(runner.last_watch),
            "chronicle": list(runner.chronicle[-8:]),
            "llm": llmm.status_line(runner.llm),
        }


def _load_page():
    """Assemble the served page: the skeleton, the style, and the page's
    scripts joined in boot order."""
    dd = os.path.join(os.path.dirname(__file__), "page")

    def read(name):
        with open(os.path.join(dd, name)) as f:
            return f.read()

    return (read("index.html")
            .replace("{{STYLE}}", "\n" + read("style.css"))
            .replace("{{SCRIPT}}", read("boot.js") + read("scene.js")
                     + read("panels.js")))


PIXI_JS = os.path.join(os.path.dirname(__file__), "page",
                       "vendor", "pixi.min.js")

_PIXI_CACHE = None


def _pixi_bytes():
    """The scene's engine, vendored — the file the head may never fetch
    from a CDN at runtime."""
    global _PIXI_CACHE
    if _PIXI_CACHE is None:
        try:
            with open(PIXI_JS, "rb") as f:
                _PIXI_CACHE = f.read()
        except OSError:
            _PIXI_CACHE = b""
    return _PIXI_CACHE


def _ip_hint(host):
    if host != "0.0.0.0":
        return ("local only: http://localhost:{}"
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
    page = _load_page()          # loaded once, so a broken script fails here
    est = Estate(args)
    lock = threading.Lock()
    runner = SimRunner(est, lock, args.tick_seconds, est.llm)
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
                self._send(200, page, "text/html; charset=utf-8")
            elif path == "/pixi.js":
                b = _pixi_bytes()
                if b:
                    self._send(200, b, "application/javascript; charset=utf-8")
                else:
                    self._send(404, "the engine's file is missing", "text/plain")
            elif path == "/api/ground":
                with lock:
                    self._send(200, json.dumps(ground(est)),
                               "application/json")
            elif path == "/api/state":
                try:
                    self._send(200, json.dumps(snapshot(est, runner, lock)),
                               "application/json")
                except Exception as e:
                    self._send(500, json.dumps({"error": str(e)}),
                               "application/json")
            elif path == "/api/plain":
                with lock:
                    self._send(200, render.full(_frame(est.world, runner)),
                               "text/plain; charset=utf-8")
            else:
                self._send(404, "no such thing", "text/plain")

        def do_POST(self):
            path = urlparse(self.path).path
            if path == "/api/control":
                n = int(self.headers.get("Content-Length", 0) or 0)
                try:
                    req = json.loads(self.rfile.read(n).decode() or "{}")
                except json.JSONDecodeError:
                    req = {}
                if "paused" in req:
                    runner.paused = bool(req["paused"])
                if "step" in req:
                    runner.step_once += int(req["step"])
                    runner.paused = True
                if "tick_seconds" in req:
                    runner.tick_seconds = max(0.2, float(req["tick_seconds"]))
                self._send(200, json.dumps({"ok": True}),
                           "application/json")
            else:
                self._send(404, "no such thing", "text/plain")

    host = "0.0.0.0" if args.public else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"estate web — {_ip_hint(host).format(args.port)}")
    print(f"  day {est.world['day']} · {rules.active_biome()} · "
          f"{est.world['width']}×{est.world['height']} · "
          f"{llmm.status_line(est.llm)}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop.set()
        with lock:
            est.db.close()
        print(f"stopped at day {est.world['day']} — nothing is lost")


def _frame(world, runner):
    return {"world": world,
            "status": ("paused · " if runner.paused else "") +
                      f"{W.weekday_name(world['day'])} · no watcher yet",
            "watcher_line": None, "chronicle": []}
