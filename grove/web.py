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

import os
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import db as dbm
from . import llm as llmm
from . import memory
from . import operator
from . import reviewer
from . import rules
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
                    "ag": round(a.get("age", 0)),
                    "h": 1 if a["hunger"] > 5 else 0,
                    "n": names.get(str(a["id"]))}
                   for a in w["animals"].values()]

        chron = [{"tick": t, "source": s, "text": tx}
                 for t, s, tx in g.db.chronicle_lines(14)]
        hist = g.db.history(36)
        pops_now = W.counts(w)
        plants_now = W.plant_counts(w)
        pop_chips = [{"emo": render.ANIMAL_EMOJI.get(sp, "·"), "n": n,
                      "name": sp}
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
            "reason": str(getattr(g.llm, "reason", "") or ""),
            "fails": dict(getattr(g.llm, "job_fails", {})),
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


def _load_page():
    """Assemble the served page: the skeleton, the style, and three
    scripts joined in boot order (index -> style.css -> boot/scene/
    panels). The assembled single string is what the harness sees."""
    dd = os.path.join(os.path.dirname(__file__), "page")
    read = lambda name: open(os.path.join(dd, name)).read()
    return (read("index.html")
            .replace("{{STYLE}}", "\n" + read("style.css"))
            .replace("{{SCRIPT}}", read("boot.js") + read("scene.js")
                     + read("panels.js")))


PAGE = _load_page()

def _read_pid(handler):
    """Read {"id": N} from a POST body."""
    try:
        n = int(handler.headers.get("Content-Length", 0) or 0)
        return int(json.loads(handler.rfile.read(n).decode()).get("id"))
    except (ValueError, json.JSONDecodeError, TypeError):
        return 0


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
            elif path == "/api/tuning":
                with lock:
                    props = reviewer.pending(g.db, (g.world or {}).get(
                        "tick", 0) if g.world else 0)
                    hist = reviewer.history(g.db, 12)
                self._send(200, json.dumps({
                    "pending": [{"id": i, "week": wk, "rule": rp,
                                 "value": v, "why": wy, "status": st}
                                for i, wk, rp, v, wy, st in props],
                    "history": [{"id": i, "week": wk, "status": s,
                                 "rule": rp, "value": v}
                                for i, wk, s, rp, v in hist],
                    "auto_tune": bool(g.args.__dict__.get("auto_tune"))
                    if hasattr(g.args, "__dict__") else False,
                    "current": {sp: t.get("cap") for sp, t in
                                sorted(rules.R["animals"].items())},
                }), "application/json")
            elif path == "/api/tuning/accept":
                pid = _read_pid(self)
                with lock:
                    row = g.db.con.execute(
                        "SELECT rule, value FROM proposals WHERE id=? "
                        "AND status IN ('pending','offered')",
                        (pid,)).fetchone()
                    if row and isinstance(row[1], (int, float)):
                        reviewer.apply_amendment(g.db, rules, row[0],
                                                 row[1])
                        g.db.save_override(args.data, rules)
                self._send(200, json.dumps({"ok": True}),
                           "application/json")
            elif path == "/api/tuning/dismiss":
                pid = _read_pid(self)
                with lock:
                    reviewer.dismiss(g.db, pid)
                self._send(200, json.dumps({"ok": True}),
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
                        self._send(200, json.dumps(
                            {"answer": "the grove is wordless just now "
                                       "(LLM off)", "excerpts": []}),
                            "application/json")
                        return
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
        if g.llm and g.llm.enabled:
            emb.close()
