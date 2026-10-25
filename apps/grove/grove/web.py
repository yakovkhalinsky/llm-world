"""grove web — a zero-dependency 3D view of the grove.

Serves one hand-written page (no build step, works fully offline) plus a
small JSON state API. The simulation keeps running here in a background
thread; visitors get pause / step / invite-soul buttons.

The view is Three.js, vendored once for both apps in
`apps/shared/page3d/` and served under `/3d/` after the grove's own
`page3d/`: the ground in relief, the trees and the understory, creatures
walking between their weekly cells around trunks and the pond, a day and
night that turns gradually, and a soft glow where mushrooms grow. If WebGL
will not start (or `?plain` is asked for), the page shows the server's own
emoji map from `/api/plain`.

  grove web [--port 8787] [--public] [--tick-seconds 12] [--offline]

Default bind is loopback only (viewable through an ssh tunnel); pass
--public to open it to the LAN.
"""

import os
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import db as dbm
from . import llm as llmm
from . import memory
from . import operator
from . import reviewer
from . import rules
from . import render
from . import webguard
from . import world as W
from .app import Grove

POLL_MS = 600           # creature polls; the scene rebuild is cheap

# The glow under the trees: how far a mushroom's light reaches, in cells,
# and the field's top step. A view-only fact: the sim never reads it.
GLOW_REACH = 2.6
GLOW_STEPS = 9


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
                              1 if c["carcass"] else 0,
                              round(c.get("elev", 0), 2)))
        plants = [{"id": p["id"], "sp": p["sp"], "x": p["x"], "y": p["y"],
                   "st": p["stage"],
                   "el": 1 if p.get("elder") or p["id"] in w["elder_ids"]
                   else 0,
                   "b": 1 if p.get("berries") else 0,
                   "n": names.get(str(p["id"]))}
                  for p in w["plants"].values()]
        animals = [{"id": a["id"], "sp": a["sp"], "x": a["x"], "y": a["y"],
                    "px": a.get("px", a["x"]), "py": a.get("py", a["y"]),
                    "ag": round(a.get("age", 0)),
                    "h": 1 if a["hunger"] > 5 else 0,
                    "n": names.get(str(a["id"]))}
                   for a in w["animals"].values()]

        chron = [{"tick": t, "source": s, "text": tx}
                 for t, s, tx in g.db.chronicle_lines(14)]
        hist = g.db.history(36)
        pops_now = W.counts(w)
        plants_now = W.plant_counts(w)
        pop_chips = [{"emo": render.emoji(sp), "n": n,
                      "name": sp}
                     for sp, n in sorted(pops_now.items(), key=lambda kv: -kv[1])]
        series = []
        for sp, n in sorted(pops_now.items()):
            ser = [d["pop"].get(sp, 0) for _t, d in hist]
            if n or any(ser):
                series.append({"name": sp, "emo": render.emoji(sp),
                               "values": ser})
        for sp in sorted(rules.R["plants"]):
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
        pres = rules.R["presentation"]
        biome = {"seasons": pres.get("seasons_palette"),
                 "bodies": pres.get("animal_body"),
                 "shapes": pres.get("shapes"),
                 "elev_px": pres.get("elev_px", 26),
                 # what the view needs to route a walker: which plants
                 # stand as trunks, which creatures fly over everything.
                 # The pack's facts, shipped, not guessed by the page.
                 "kinds": {sp: t.get("kind") for sp, t in
                           sorted(rules.R["plants"].items())},
                 "flyers": sorted(sp for sp, t in rules.R["animals"].items()
                                  if t.get("flyer"))}
        llm_bits = {
            "status": llmm.status_line(g.llm),
            "ok": bool(g.llm and g.llm.enabled),
            "reason": str(getattr(g.llm, "reason", "") or ""),
            "fails": dict(getattr(g.llm, "job_fails", {})),
            # which job stumbled, and what it actually sent back — a
            # voice that cannot be read must not look like silence
            "fail": getattr(g.llm, "last_fail", None),
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
            "glow": glow_field(w),
            "chronicle": chron,
            "soul": soul,
            "ops": ops,
            "biome": biome,
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


def glow_field(w):
    """The soft light under the trees: one step 0..GLOW_STEPS per cell,
    row-major, brightest on a mushroom and fading over GLOW_REACH cells.

    It is the grove's lamplight — the view paints it as one smooth field
    at night rather than a disc per mushroom. Pure: it reads the cells and
    writes nothing, so the sim cannot be moved by it."""
    size = w["size"]
    out = [0] * (size * size)
    srcs = [(x, y) for y in range(size) for x in range(size)
            if w["cells"][y][x]["mushroom"]]
    r = int(GLOW_REACH)
    for sx, sy in srcs:
        for y in range(max(0, sy - r), min(size, sy + r + 1)):
            for x in range(max(0, sx - r), min(size, sx + r + 1)):
                d = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5
                if d >= GLOW_REACH:
                    continue
                v = int(round(GLOW_STEPS * (1 - d / GLOW_REACH)))
                i = y * size + x
                if v > out[i]:
                    out[i] = v
    return out


PAGE3D = os.path.join(os.path.dirname(__file__), "page3d")
# what the grove's and the estate's 3D views share: apps/shared/page3d
SHARED3D = os.path.join(os.path.dirname(__file__), "..", "..", "shared",
                        "page3d")

# one suffix, one content type. A module served as text/plain is a module
# the browser refuses to execute, which looks exactly like a broken page.
_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}


def _page3d(rel):
    """A file of the 3D view, as (bytes, content type), or None.

    The grove's own `page3d/` is looked in first, then the folder both
    apps' views share (the vendored engine, the day clock, the walk
    router), so the page names every file as `/3d/...` whichever folder
    holds it. Each lookup is confined to its own folder's *real* path
    after unquoting: no traversal — plain, encoded, or through a symlink —
    reaches a file outside either of them.
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
    if os.path.basename(full).startswith("LICENSE"):
        return data, "text/plain; charset=utf-8"
    # a fixed set of types: a file of any other kind is not served at all,
    # rather than as a guess (and no SVG, which can carry script)
    ctype = _STATIC_TYPES.get(os.path.splitext(full)[1].lower())
    if ctype is None:
        return None
    return data, ctype


def _respond(handler, code, body, ctype):
    """Write one response. Every route's response goes through here, so a
    header added to one cannot be forgotten on another. `nosniff` matters
    because the engine and the page's modules are served by suffix: a
    browser left to guess may run something the server did not send it
    as."""
    data = body if isinstance(body, bytes) else body.encode()
    handler.send_response(code)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler._nosniff_sent = True      # `end_headers` adds it only if unset
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(data)


def plain(grove, lock):
    """The no-WebGL page's whole picture: the header line and the emoji
    map, as text."""
    with lock:
        w = grove.world
        if w is None:
            return "no world yet — run: grove new\n"
        return render.header(w) + "\n" + render.render_map(w) + "\n"


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


def make_handler(g, lock, runner, data_dir, emb=None, hosts=None):
    """Build the request handler around a loaded grove.

    A factory rather than a closure inside `cmd_web`: the tests start a
    real `ThreadingHTTPServer` on port 0 with this handler. `emb` is the
    embedder's own sqlite connection (None with the LLM off).

    The steward's accept and dismiss are POSTs: they change the rules, and
    the old page already sent them as POSTs (which this server used to
    answer only on GET, with a 404 on POST).

    Every POST changes something, so every POST passes `webguard` first:
    the page's own host and origin, a JSON body, a declared and bounded
    length. `hosts` is the set of Host values it answers to; None means
    the loopback names on the port the server is bound to.
    """

    class Handler(BaseHTTPRequestHandler):
        # The stdlib's default is HTTP/0.9, which is what a reply to a
        # request line it could not parse goes out as: a bare body with no
        # status line and no headers, so `end_headers` below never got the
        # chance to add nosniff to the 400.
        default_request_version = "HTTP/1.0"
        # the socket's read timeout: a body shorter than its declared
        # length, or a client that stops mid-request, costs a thread this
        # long and then a 400, never a hang
        timeout = 10

        def _send(self, code, body, ctype):
            _respond(self, code, body, ctype)

        def log_message(self, *_a):   # keep the terminal readable
            pass

        def end_headers(self):
            # `send_error` writes the stdlib's own HTML for a 501 (PUT,
            # OPTIONS) or a 400 (a malformed request line) and never passes
            # through `_respond`: the headers belong to every response, not
            # to one route's writer. (One request per connection — the
            # server speaks HTTP/1.0 — so the flag never outlives one.)
            if not getattr(self, "_nosniff_sent", False):
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                self._nosniff_sent = True
            super().end_headers()

        def _hosts(self):
            if hosts is not None:
                return hosts
            return webguard.allowed_hosts("127.0.0.1",
                                          self.server.server_address[1],
                                          False, lookup=False)

        def do_HEAD(self):
            # GET's status and headers, without the body (`_respond`)
            self.do_GET()

        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/", "/3d", "/3d/"):
                got = _page3d("index.html")
                if got is None:
                    self._send(404, "the page is missing", "text/plain")
                else:
                    self._send(200, *got)
            elif path.startswith("/3d/"):
                got = _page3d(path[len("/3d/"):])
                if got is None:
                    self._send(404, "not found", "text/plain")
                else:
                    self._send(200, *got)
            elif path == "/api/plain":
                self._send(200, plain(g, lock), "text/plain; charset=utf-8")
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
            elif path == "/api/tuning":
                with lock:
                    props = reviewer.pending(g.db, (g.world or {}).get(
                        "tick", 0) if g.world else 0)
                    hist = reviewer.history(g.db, 12)
                self._send(200, json.dumps({
                    "pending": [{"id": i, "week": wk, "rule": rp,
                                 "value": v, "why": wy, "status": st,
                                 "was": ws}
                                for i, wk, rp, v, wy, st, ws in props],
                    "history": [{"id": i, "week": wk, "status": s,
                                 "rule": rp, "value": v, "was": ws}
                                for i, wk, s, rp, v, ws in hist],
                    "auto_tune": bool(rules.R["review"].get("auto_tune")),
                    "current": {sp: t.get("cap") for sp, t in
                                sorted(rules.R["animals"].items())},
                    # the reading itself, so a steward who restrains
                    # itself does not simply look like one who never spoke
                    "last": g.jobs.get("last_review"),
                    "review": g.jobs.get("review", 0),
                }), "application/json")
            else:
                self._send(404, "not found", "text/plain")

        def do_POST(self):
            path = urlparse(self.path).path
            route = {
                "/api/pause": self._pause,
                "/api/step": self._step,
                "/api/soul": self._soul,
                "/api/ask": self._ask,
                "/api/tuning/accept": self._accept,
                "/api/tuning/dismiss": self._dismiss,
            }.get(path)
            if route is None:
                self._send(404, "not found", "text/plain")
                return
            try:
                webguard.check(self, self._hosts())
                body = webguard.read_json(self)
                code, out = route(body)
            except webguard.Refused as e:
                # whatever of the body was not read is not read now
                self.close_connection = True
                code, out = e.code, {"error": e.why}
            self._send(code, json.dumps(out), "application/json")

        def _pause(self, _body):
            runner.paused = not runner.paused
            return 200, {"paused": runner.paused}

        def _step(self, _body):
            if not runner.paused:
                return 200, {"stepped": False}
            with lock:
                g.step()
                g.apply_results()
                g.maybe_schedule([])
            return 200, {"stepped": True}

        def _soul(self, _body):
            invited = False
            if g.llm and g.llm.enabled and g.worker:
                with lock:
                    if not g.worker.busy:
                        g._invite_operator()
                        invited = True
            return 200, {"invited": invited}

        def _ask(self, body):
            # the ask waits for its turn, then thinks OUTSIDE the
            # world lock — the forest keeps ticking while it ponders
            q = body.get("q", "")
            if not isinstance(q, str):
                raise webguard.Refused(400, "q must be text")
            q = q.strip()[:300]
            if not q:
                return 200, {"answer": "…", "excerpts": []}
            waited = 0.0
            while g.worker and g.worker.busy and waited < 40:
                time.sleep(0.5)
                waited += 0.5
            t0 = time.time()
            # index newer chronicle lines through the embedder's own
            # sqlite connection — never the sim's; the forest does
            # not stall (and no half-written week can be sealed)
            if g.llm is not None and g.llm.enabled:
                try:
                    memory.ensure_index(emb, g.llm)
                except Exception:
                    pass
            with lock:                       # brief reads only
                if g.world is None or g.llm is None or not g.llm.enabled:
                    return 200, {"answer": "the grove is wordless just now "
                                           "(LLM off)", "excerpts": []}
                rows = g.db.con.execute(
                    "SELECT key, tick, text, vec FROM vec").fetchall()
                digest_text = operator.digest(g.world, [])
            excerpts = memory.recall(g.db, g.llm, q, rows=rows)
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
            return 200, {"answer": answer, "excerpts": excerpts,
                         "took": round(time.time() - t0, 1)}

        def _proposal(self, body):
            """The proposal a steward's button names: (id, rule, value),
            or `Refused` — 404 for an id that names none, 409 for one
            already applied, dismissed or expired."""
            pid = webguard.positive_id(body)
            row = g.db.con.execute(
                "SELECT rule, value, status FROM proposals WHERE id=?",
                (pid,)).fetchone()
            if row is None:
                raise webguard.Refused(404, "no such proposal")
            if row[2] not in ("pending", "offered"):
                raise webguard.Refused(409, f"already {row[2]}")
            return pid, row[0], row[1]

        def _accept(self, body):
            with lock:
                _pid, rule, value = self._proposal(body)
                # the stored row is checked again against the law before
                # it is applied: a row that names a whole table, or a
                # value that is not a number, changes nothing
                ok, value, why = reviewer.validate(
                    {"rule": rule, "value": value})
                current = reviewer._value_at(str(rule))
                if not ok or isinstance(current, bool) or \
                        not isinstance(current, (int, float)):
                    raise webguard.Refused(
                        409, "not a lawful amendment: " +
                        (why or "it names no number in the rules"))
                if not reviewer.apply_amendment(g.db, rules, rule, value):
                    raise webguard.Refused(409, "the rule could not be set")
                g.db.save_override(data_dir, rules)
            return 200, {"ok": True, "rule": rule, "value": value}

        def _dismiss(self, body):
            with lock:
                pid, _rule, _value = self._proposal(body)
                reviewer.dismiss(g.db, pid)
            return 200, {"ok": True}

    return Handler


def cmd_web(args):
    if not os.path.isfile(os.path.join(PAGE3D, "index.html")):
        raise SystemExit("grove web: the page is missing "
                         f"({PAGE3D}/index.html)")
    g = Grove(args)
    g.load_or_exit()
    g.init_llm()
    lock = threading.Lock()
    runner = SimRunner(g, lock, args.tick_seconds)
    runner.start()

    if g.llm and g.llm.enabled:
        # the embedding threads (the indexer and the ask's pre-index)
        # get their OWN sqlite connection: a commit of theirs can then
        # never seal a week that the sim is still writing. Created with
        # the main one, closed with the main one.
        emb = dbm.DB(os.path.join(args.data, "grove.db"))

        def indexer():
            time.sleep(20)
            while True:
                try:          # one patient batch per pass; the chronicle
                    memory.ensure_index(emb, g.llm, limit=32)
                except Exception:
                    pass
                time.sleep(75)
        threading.Thread(target=indexer, daemon=True).start()

    port = args.port
    bind = "0.0.0.0" if args.public else "127.0.0.1"
    hosts = webguard.allowed_hosts(bind, port, args.public,
                                   getattr(args, "allow_host", None) or ())
    Handler = make_handler(g, lock, runner, args.data,
                           emb if g.llm and g.llm.enabled else None,
                           hosts=hosts)

    print(f"grove web · world tick {g.world['tick']} "
          f"{W.season_name(g.world['tick'])}")
    print(_ip_hint(bind).format(port), flush=True)
    print("  buttons answer at: " + ", ".join(sorted(hosts)), flush=True)
    srv = ThreadingHTTPServer((bind, port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stopping.set()
        g.db.close()
        if g.llm and g.llm.enabled:
            emb.close()
