"""estate web — a zero-dependency dashboard for the estate.

Serves one hand-written page (no build step, works fully offline) plus a
small JSON state API. The simulation keeps running in a background thread;
visitors get pause / step / speed controls.

The estate is drawn in **three dimensions** by the Three.js scene in
`page3d/`, vendored beside the page: this is a living picture of a place,
not a chart of its numbers, and a world you cannot see is a world you cannot
judge (grove's b26/b48 — several bugs were found only by looking at the
artifact). The server-side glyph map remains as the honest fallback for a
browser that cannot draw it.

  estate web [--port 8787] [--public] [--tick-seconds 20] [--offline]

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
from urllib.parse import unquote, urlparse

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
        self.daybooks = {}           # day -> the shape of that day
        self.past_lines = {}         # day -> its line, from the database
        self.past_news = {}          # day -> its news, from the database
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
                    day = self.est.world["day"]
                    book = self.est.world.get("daybook") or {}
                    self.daybooks[day] = dict(book, uses=dict(book.get("uses", {})))
                    for old_day in [d for d in self.daybooks if d < day - 64]:
                        del self.daybooks[old_day]
                    del self.events[:-400]
                    self.est.save(evs)
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
        # and the shapes of the days it has already lived, so a restart
        # resumes the feed rather than blanking it
        self.past_days = self.db.days(64)
        self.save_every = 1
        # the watcher is optional in the only sense that matters: with no
        # model the estate still runs, because the model never owned any of
        # it. `invite` returns quiet and the days go on.
        if not getattr(args, "offline", False):
            self.llm = llmm.LLM(model=getattr(args, "model", "auto") or "auto",
                                tier=getattr(args, "tier", "cloud"))

    def save(self, evs=()):
        self.db.save_world(self.world)
        w = self.world
        book = w.get("daybook") or {}
        self.db.add_stats(w["day"], _census(w),
                          render.day_line(book, max(1, len(w["residents"]))),
                          book, [render.say(e) for e in evs])


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
        # What a step onto each site costs, from the pack — `null` where
        # nobody may walk. The pages route their people over this ground, and
        # the price of a lawn is the pack's fact: a renderer that wrote its
        # own would be a second copy that drifts (grove b2/b34).
        "walk": {name: rules.R["sites"][name].get("walk") for name in codes},
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
        "speeds": list(rules.R["pacing"]["day_seconds"]),
        "words": {"world": rules.R["presentation"].get("world_word",
                                                       "the estate"),
                  "seasons": list(rules.R["presentation"].get("seasons",
                                                              ()))},
    }


def day_feed(w, events, books, past=None, news=None, days=24):
    """The last few days, one row each.

    A feed of *events* looks frozen on an estate having a quiet week, which
    is most weeks: the panel held the same two lines for half an hour of
    watching and read as a broken page. The feed is days, and a day with
    nothing in it says so — which is the honest report, and it is also what
    makes the panel visibly alive.
    """
    by_day = {}
    for e in events:
        by_day.setdefault(e["day"], []).append(render.say(e))
    today = w["day"]
    people = max(1, len(w["residents"]))
    out = []
    for d in range(max(1, today - days + 1), today + 1):
        line = render.day_line(books.get(d), people) or (past or {}).get(d)
        says = by_day.get(d) or (news or {}).get(d) or []
        # a day the estate has no record of is not a quiet day; it is a day
        # before the record began, and it is left out rather than dressed
        # up as something it was not
        if not line and not says:
            continue
        out.append({"day": d, "says": says, "line": line or ""})
    return out


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
        day_events = list(runner.events)
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
                # the fixture this resident last used, so a view can seat
                # them only where they chose to sit rather than wherever a
                # walk happened to end
                "fixture": wh.get("fixture"),
                "px": px, "py": py, "pin": pmode == "in", "punit": punit,
                "habit": r["habit"], "stress": round(r["stress"], 1),
                "needs": {k: round(v, 2) for k, v in r["needs"].items()},
            })
        fixtures = [{"id": int(fid), "kind": f["kind"], "x": f["x"],
                     "y": f["y"], "c": round(f["condition"], 3),
                     "uses": f["use_total"], "stock": f.get("stock"),
                     # how many can use it at once. The views seat people on
                     # a bench up to its capacity, and capacity is the pack's
                     # fact — a renderer that hardcoded two would be a second
                     # home for it (grove b34).
                     "cap": rules.R["fixtures"][f["kind"]].get("capacity", 0),
                     # generation marks the benches it puts out beside the
                     # perimeter footpath; `?focus=perimeter` needs the mark
                     # to find them without a second copy of the geometry
                     "perimeter": bool(f.get("perimeter"))}
                    for fid, f in w["fixtures"].items()]
        buildings = []
        for bid, b in w["buildings"].items():
            live = [u for u in b["units"]
                    if w["units"][str(u)]["household"] is not None]
            buildings.append({
                "id": int(bid), "kind": b["kind"],
                "units": len(b["units"]), "lived": len(live),
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
            "days": day_feed(w, day_events, runner.daybooks,
                             runner.past_lines, runner.past_news),
            "watcher": dict(runner.last_watch),
            "chronicle": list(runner.chronicle[-8:]),
            "llm": llmm.status_line(runner.llm),
        }


PAGE3D = os.path.join(os.path.dirname(__file__), "page3d")

# one suffix, one content type. A module served as text/plain is a module
# the browser refuses to execute, which looks exactly like a broken page.
_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}


def _page3d(rel):
    """A file under `page3d/`, as (bytes, content type), or None.

    The 3D view is a folder of ES modules and a vendored engine, so it is
    served as static files rather than folded into one inline script. The
    handler is confined to page3d's *real* path after unquoting, so no
    traversal — plain, encoded, or through a symlink — can reach a file
    outside it.
    """
    root = os.path.realpath(PAGE3D)
    rel = unquote(rel)
    if "\x00" in rel:
        return None
    full = os.path.realpath(os.path.join(root, rel.lstrip("/")))
    try:
        if os.path.commonpath((root, full)) != root:
            return None
    except ValueError:
        return None
    if not os.path.isfile(full):
        return None
    try:
        with open(full, "rb") as f:
            data = f.read()
    except OSError:
        return None
    name = os.path.basename(full)
    if name.startswith("LICENSE"):
        return data, "text/plain; charset=utf-8"
    ctype = _STATIC_TYPES.get(os.path.splitext(full)[1].lower(),
                              "application/octet-stream")
    return data, ctype


def _respond(handler, code, body, ctype):
    """Write one response. Every response goes through here, so a header
    added to one route cannot be forgotten on another.

    `nosniff` is the whole point of the route: the vendored engine and the
    page's modules are served by suffix, and a browser left to guess is a
    browser that may run something the server did not send it as.
    """
    data = body if isinstance(body, bytes) else body.encode()
    handler.send_response(code)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler._nosniff_sent = True      # `end_headers` adds it only if unset
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


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


def make_handler(est, lock, runner):
    """Build the request handler around a planted estate.

    A factory rather than a closure inside `cmd_web`: the tests start a
    real `ThreadingHTTPServer` on port 0 with this handler, and a test that
    built its own would pin a server nobody serves.
    """

    class Handler(BaseHTTPRequestHandler):
        # The stdlib's default is HTTP/0.9, which is what a reply to a
        # request line it could not parse goes out as: a bare body with no
        # status line and no headers, so `end_headers` below never got the
        # chance to add nosniff to the 400. Every client this page has
        # speaks 1.0 or later.
        default_request_version = "HTTP/1.0"

        def _send(self, code, body, ctype):
            _respond(self, code, body, ctype)

        def log_message(self, *_a):   # keep the terminal readable
            pass

        def send_response(self, code, message=None):
            # a fresh response per request, including on a keep-alive
            # connection: the flag below must not leak across requests
            self._nosniff_sent = False
            super().send_response(code, message)

        def end_headers(self):
            # `send_error` writes the stdlib's own HTML for a 501 (PUT,
            # HEAD) or a 400 (a malformed request line) and never passes
            # through `_respond`, so those responses had no nosniff. The
            # header belongs to every response, not to one route's writer;
            # `_respond` marks its own so nothing is sent twice.
            if not getattr(self, "_nosniff_sent", False):
                self.send_header("X-Content-Type-Options", "nosniff")
                self._nosniff_sent = True
            super().end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            # The 3D view is the estate's only view and `/` is its address.
            # `/3d` and `/3d/` stay as aliases rather than redirects: old
            # links and the `?phase=` / `?focus=` screenshot URLs keep their
            # query string, and every asset the page names is absolute under
            # `/3d/`, so it resolves from either address.
            if path in ("/", "/3d", "/3d/"):
                f = _page3d("index.html")
                if f:
                    self._send(200, f[0], f[1])
                else:
                    self._send(404, "the 3d view is missing", "text/plain")
            elif path.startswith("/3d/"):
                f = _page3d(path[len("/3d/"):])
                if f:
                    self._send(200, f[0], f[1])
                else:
                    self._send(404, "no such thing", "text/plain")
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

    return Handler


def cmd_web(args):
    # the page is files now, not a string loaded at import, so a missing
    # page would only show up as a 404 on `/`. Fail at startup instead.
    if _page3d("index.html") is None:
        raise SystemExit("estate web: page3d/index.html is missing")
    est = Estate(args)
    lock = threading.Lock()
    runner = SimRunner(est, lock, args.tick_seconds, est.llm)
    # the record the estate already has. Without this the dashboard showed
    # an empty chronicle on every restart while the database held a year of
    # it — the write path and the read path each worked, and nothing joined
    # them. (The patch that was supposed to add this line silently matched
    # nothing, which is why it is asserted now.)
    runner.chronicle = list(est.history)
    runner.past_lines = {d["day"]: d["line"] for d in est.past_days}
    runner.past_news = {d["day"]: d["says"] for d in est.past_days if d["says"]}
    runner.daybooks = {d["day"]: d["book"] for d in est.past_days if d["book"]}
    runner.start()

    Handler = make_handler(est, lock, runner)

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
