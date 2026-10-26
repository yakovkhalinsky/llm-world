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
import math
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
from . import webguard
from . import world as W
from .engine import daytime
from .engine import families
from .engine import residents

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
        self.why_busy = False        # a watcher why is being written
        self.chron_busy = False      # a chronicle entry is being written
        self.stop = threading.Event()

    def snapshot_prev(self):
        out = {}
        for rid, r in self.est.world["residents"].items():
            wh = r["where"]
            out[rid] = (wh["x"], wh["y"], wh["mode"], wh.get("unit"))
        return out

    def step(self):
        """One day, under the lock: tick, keep what the page reads, save.
        (Its own method so apps/estate-web's tests can drive this runner a
        day at a time, without the thread or the wall clock.)"""
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
        return evs

    def run(self):
        while not self.stop.is_set():
            if not self.paused or self.step_once:
                self.step()
                if self.step_once:
                    self.step_once -= 1
                self._maybe_watch()
                self._maybe_chronicle()
            self.stop.wait(0.1 if (self.paused and self.step_once) else
                           self.tick_seconds)

    def _maybe_chronicle(self):
        """Write the estate's record of a stretch of days.

        The deterministic lines are gathered under the lock and the prose
        is written on a thread of its own — a model must never stall the
        estate, and a hung Ollama would otherwise freeze the sim for the
        whole call timeout. The fallback is the lines themselves, so the
        record is complete whether or not anyone was awake to phrase it.
        While an entry is being written the days go on gathering lines for
        the next one.
        """
        if self.chron_busy or not chronicler.worth_writing(self.span):
            return
        with self.lock:
            w = self.est.world
            # what narrate reads, copied: the world moves on meanwhile
            view = {"width": w["width"], "height": w["height"],
                    "day": w["day"], "weather": w["weather"],
                    "residents": dict(w["residents"]),
                    "households": dict(w["households"])}
            lines = list(self.lines)
            span = self.span
            day = w["day"]
            recent = [c["text"] for c in self.chronicle[-2:]]
            self.lines = []
            self.span = 0
        if self.llm is None or not self.llm.ready():
            # no model to wait on: the template, here and now
            self._land_chronicle(day, chronicler.fallback(lines, span))
            return
        self.chron_busy = True
        threading.Thread(target=self._write_chronicle,
                         args=(view, lines, span, day, recent),
                         daemon=True, name="chronicle").start()

    def _write_chronicle(self, view, lines, span, day, recent):
        try:
            text = chronicler.narrate(self.llm, view, lines, span, recent)
        except Exception:                  # the record is never lost
            text = chronicler.fallback(lines, span)
        try:
            self._land_chronicle(day, text)
        finally:
            self.chron_busy = False

    def _land_chronicle(self, day, text):
        with self.lock:
            self.est.db.add_chronicle(day, text)
            self.chronicle.append({"day": day, "text": text})
            del self.chronicle[:-40]

    def _maybe_watch(self):
        """Invite the watcher on its cadence, if there is one and it is
        due.

        The world lock is taken to read the digest and taken again to land
        the answer, and is NEVER held across the call: the estate must keep
        living while the model thinks. Grove lost a world to that (b9/b17)
        and it is not repeated here.
        """
        if self.llm is None:
            return
        rules_decide = self.llm.decide == "rules"
        if not rules_decide and not self.llm.ready():
            return
        now = time.time()
        if now < self.next_watch:
            return
        lo, hi = self.llm.watch_gap()
        self.next_watch = now + lo + random.random() * (hi - lo)
        if rules_decide:
            # the choice is code (decide.py): it lands now, under the lock,
            # and the sim thread never waits on a model. The why is words,
            # written afterwards on a thread of its own — the pack's line
            # stands until (and unless) the model's arrives.
            with self.lock:
                w = self.est.world
                recent = [render.say(e) for e in self.events[-8:]]
                intent = watcher.choose(w)
                prompt = watcher.why_prompt(w, intent, recent)
                watcher.queue(w, intent)
                self.est.save()
                intent["day"] = w["day"]
            self.last_watch = intent
            if intent["fate"] != watcher.QUIET and not self.why_busy and \
                    self.llm.ready():
                self.why_busy = True
                threading.Thread(target=self._write_why,
                                 args=(intent, prompt), daemon=True,
                                 name="watcher-why").start()
            return
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

    def _write_why(self, intent, prompt):
        """The watcher's why, off the sim thread. Words only: the fate has
        already landed, so nothing here can change the world."""
        try:
            why = watcher.clean_why(self.llm.chat_json(
                watcher.system(), prompt, watcher.WHY_SCHEMA,
                max_tokens=80, job="watch"))
            if why:
                intent["why"] = why
        finally:
            self.why_busy = False


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
            self.llm = llmm.from_args(args)

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
                          "floors": b["floors"], "door": b["door"],
                          # the school's fenced yard [x, y, w, h] and the
                          # gate in its fence (gen.py), None for the flats
                          "yard": b.get("yard"), "gate": b.get("gate")})
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


def _walking_with(w, r):
    """engine/families.py owns who a child is walking with; the page asks
    it rather than keeping a second copy of the rule."""
    return families.walking_with(w, r)


def _phases(w):
    book = w.get("day_phases") or {}
    if book.get("day") != w["day"]:
        return None
    return {"day": book["day"], "order": list(residents.PHASES),
            "at": book.get("phases", {})}


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
                # "in" is "not drawn on the plan": indoors, or away at work
                # for the whole of the view (a worker is drawn walking to
                # the stop, then gone; hud.js makes the same call)
                "x": wh["x"], "y": wh["y"],
                "in": wh["mode"] == "in" or (wh["mode"] == pmode == "away"),
                # "in", "at", "school" (inside the school fence) or "away"
                # (off the estate at work): engine/daytime.py
                "mode": wh["mode"],
                "pupil": daytime.is_pupil(r),
                "job": bool(r.get("job")),
                "unit": wh.get("unit"),
                # the fixture this resident last used, so a view can seat
                # them only where they chose to sit rather than wherever a
                # walk happened to end
                "fixture": wh.get("fixture"),
                "px": px, "py": py, "pin": pmode == "in", "pmode": pmode,
                "punit": punit,
                "habit": r["habit"], "stress": round(r["stress"], 1),
                "needs": {k: round(v, 2) for k, v in r["needs"].items()},
                # the rest of the household, for the card; and, for a young
                # child out on the plan, the guardian they are walking with
                # (engine/families.py), so a view can draw the two as a pair
                "family": [m for m in hh.get("members", ())
                           if m != r["id"] and str(m) in w["residents"]],
                "with": _walking_with(w, r),
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
            # the school's and the bus stop's numbers for their cards
            "daytime": daytime.roll(w),
            # where everybody was at the end of each of today's phases
            # (engine/daytime.py `record`): the live frame is always the
            # end of the night, and this is how the page shows a weekday
            # morning that has already happened
            "phases": _phases(w),
            "shade": shade, "light": light,
            "events": [dict(e, say=render.say(e)) for e in evs],
            "days": day_feed(w, day_events, runner.daybooks,
                             runner.past_lines, runner.past_news),
            "watcher": dict(runner.last_watch),
            "chronicle": list(runner.chronicle[-8:]),
            "llm": llmm.status_line(runner.llm),
            # the same, as data: which model each job is on and what is
            # not installed (None with --offline)
            "models": runner.llm.model_status() if runner.llm else None,
        }


PAGE3D = os.path.join(os.path.dirname(__file__), "page3d")
# what the estate's and the grove's 3D views share: apps/shared/page3d
SHARED3D = os.path.join(os.path.dirname(__file__), "..", "..", "shared",
                        "page3d")

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
    estate's own `page3d/` is looked in first, then the folder both apps'
    3D views share (`apps/shared/page3d/`: the vendored engine, the day
    clock and the walk router), so the page names every file as `/3d/...`
    whichever folder holds it. Each lookup is confined to its own folder's
    *real* path after unquoting, so no traversal — plain, encoded, or
    through a symlink — can reach a file outside either of them.
    """
    rel = unquote(rel)
    if "\x00" in rel:
        return None
    for base in (PAGE3D, SHARED3D):
        got = _static_under(base, rel)
        if got is not None:
            return got
    return None


def _static_under(base, rel):
    """One folder's half of `_page3d`: the file, or None if it is not
    there or its real path leaves `base`."""
    root = os.path.realpath(base)
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
    """The startup line; `{0}` is the port, filled in by the caller."""
    if host != "0.0.0.0":
        return ("local only: http://localhost:{0}"
                "\n  (LAN view: add --public, or tunnel: "
                "ssh -L {0}:localhost:{0} user@this-host)")
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return (f"LAN: http://{ip}:{{0}}  (any device on this network)\n"
                "  off-network: ssh -L {0}:localhost:{0} user@this-host")
    except OSError:
        return "lan ip undetectable — check hostname -I"


def make_handler(est, lock, runner, hosts=None):
    """Build the request handler around a planted estate.

    `hosts` is the set of `Host` values a POST is answered for (see
    `webguard.allowed_hosts`); None means loopback on the bound port.

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
        # a client that declares a body and does not send it is dropped,
        # not waited on forever
        timeout = 10

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

        def _hosts(self):
            if hosts is not None:
                return hosts
            return webguard.allowed_hosts("127.0.0.1",
                                          self.server.server_address[1],
                                          False, lookup=False)

        def do_POST(self):
            # The one POST changes the clock: pause, step, pace. It must come
            # from the page — this host, this origin, a JSON body of a
            # declared length — or a page on any other site the viewer has
            # open could drive it (a text/plain form post needs no CORS
            # preflight; a rebinding name needs no origin at all).
            path = urlparse(self.path).path
            if path != "/api/control":
                self._send(404, "no such thing", "text/plain")
                return
            try:
                webguard.check(self, self._hosts())
                req = webguard.read_json(self)
                code, out = _control(runner, req)
            except webguard.Refused as e:
                self.close_connection = True
                code, out = e.code, {"error": e.why}
            self._send(code, json.dumps(out), "application/json")

    return Handler


def _control(runner, req):
    """Apply one control request, all of it or none of it. Each field has
    one type: `paused` a bool, `step` a whole number of days 1..100,
    `tick_seconds` a finite number (clamped to 0.2s..1 day). Anything else
    is a 400 and changes nothing."""
    unknown = set(req) - {"paused", "step", "tick_seconds"}
    if unknown:
        raise webguard.Refused(400, "unknown field")
    paused = req.get("paused")
    if "paused" in req and type(paused) is not bool:
        raise webguard.Refused(400, "paused must be true or false")
    step = req.get("step")
    if "step" in req and not (type(step) is int and 1 <= step <= 100):
        raise webguard.Refused(400, "step must be a whole number 1..100")
    pace = req.get("tick_seconds")
    if "tick_seconds" in req and not (
            type(pace) in (int, float) and math.isfinite(pace)):
        raise webguard.Refused(400, "tick_seconds must be a number")
    if "paused" in req:
        runner.paused = paused
    if "step" in req:
        runner.step_once += step
        runner.paused = True
    if "tick_seconds" in req:
        runner.tick_seconds = min(86400.0, max(0.2, float(pace)))
    return 200, {"ok": True}


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

    host = "0.0.0.0" if args.public else "127.0.0.1"
    hosts = webguard.allowed_hosts(host, args.port, args.public,
                                   getattr(args, "allow_host", None) or ())
    Handler = make_handler(est, lock, runner, hosts=hosts)

    httpd = ThreadingHTTPServer((host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"estate web — {_ip_hint(host).format(args.port)}", flush=True)
    print("  the controls answer at: " + ", ".join(sorted(hosts)),
          flush=True)
    if getattr(args, "allow_host", None) and not args.public:
        print("  (--allow-host is ignored without --public)", flush=True)
    print(f"  day {est.world['day']} · {rules.active_biome()} · "
          f"{est.world['width']}×{est.world['height']} · "
          f"{llmm.status_line(est.llm)}", flush=True)
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
