"""Grove CLI: create, watch, step and read a self-contained forest world.

  grove new [--seed 42] [--size 24]      create a world (no LLM involved)
  grove run  [--tick-seconds 8] [--offline]   live watch (LLM in background)
  grove step N [--narrate] [--offline]   advance N weeks in batch
  grove map                              render the saved map once
  grove chronicle [--tail 50] [--all]    print the chronicle
  grove status                           population history

Everything lives in ./grove_data (override with --data PATH).
"""

import argparse
import os
import queue
import random
import sys
import threading
import time

from . import chronicler
from . import db as dbm
from . import events as evm
from . import gen
from . import llm as llmm
from . import operator
from . import render
from . import sim
from . import voice
from . import world as W

CHRON_SCHEMA = {
    "type": "object",
    "properties": {
        "entries": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "string"},
                           "text": {"type": "string"}},
            "required": ["id", "text"]}},
    },
    "required": ["entries"],
}


# ------------------------------------------------------------------ worker

class SoulWorker(threading.Thread):
    """Processes LLM jobs in the background. Payloads are prebuilt prompt
    strings built on the main thread; all world/db mutation stays on the
    main thread. At most one job runs; excess submissions are dropped."""

    def __init__(self, client):
        super().__init__(daemon=True)
        self.client = client
        self.tasks = queue.Queue(maxsize=1)
        self.results = queue.Queue()
        self.busy = False

    def submit(self, job):
        try:
            self.tasks.put_nowait(dict(job))
        except queue.Full:
            return False
        self.busy = True
        return True

    def run(self):
        while True:
            job = self.tasks.get()
            ok, data = False, None
            t0 = time.time()
            try:
                data = self.client.chat_json(
                    job["system"], job["user"], job["schema"],
                    max_tokens=job.get("max_tokens", 160),
                    temperature=job.get("temperature", 0.8))
                ok = data is not None
            except Exception as e:   # the soul must never crash the world
                self.client.reason = f"worker error: {e}"
            self.results.put({"kind": job["kind"], "extra": job.get("extra"),
                              "ok": ok, "data": data,
                              "elapsed": time.time() - t0})
            self.busy = False


# ------------------------------------------------------------ orchestration

class Grove:
    def __init__(self, args):
        self.args = args
        self.db = dbm.DB(os.path.join(args.data, "grove.db"))
        self.world = None
        self.llm = None
        self.worker = None          # only in `run` mode
        self.soul_line = None
        self.soul_tick = -1
        self.pending_chron = {}     # eid -> chronicler batch item
        self.pending_since = -1
        self.eid = 0

    # -- lifecycle ----------------------------------------------------------
    def load_or_exit(self):
        self.world = self.db.load_world()
        if self.world is None:
            sys.exit(f"no world in '{self.args.data}'; run first: grove new")

    def init_llm(self):
        self.llm = None if self.args.offline else llmm.LLM(
            model=self.args.model, host=self.args.host)
        if self.llm and self.llm.enabled and self.args.cmd == "run":
            self.worker = SoulWorker(self.llm)
            self.worker.start()

    # -- one deterministic step ---------------------------------------------
    def step(self):
        w = self.world
        evs = sim.tick(w)
        notable = evm.notable(evs)
        self.db.add_events(evs)
        self.db.save_world(w)
        self.db.add_stats(w["tick"], W.counts(w), W.plant_counts(w))

        # template lines appear immediately, whatever the LLM is doing
        items = chronicler.batch(notable, w)
        for it in items:
            cached = self.db.cache_get(it["key"])
            if cached:
                self.db.record(it["key"], it["tick"], cached, "llm")
            else:
                self.db.record(it["key"], it["tick"], it["template"])
        if items and self.worker is not None:
            for it in items:
                self.eid += 1
                it["eid"] = f"e{self.eid}"
                if not self.pending_chron:
                    self.pending_since = w["tick"]
                self.pending_chron[it["eid"]] = it
        return evs, notable

    # -- scheduling (run mode) ----------------------------------------------
    def maybe_schedule(self, notable):
        if self.worker is None or not self.llm.enabled:
            return
        w = self.world
        if self.worker.busy:
            return
        # the soul is first; idle slots rotate between prose and naming
        if w["tick"] >= w["next_op"]:
            self._invite_operator()
            return
        if len(self.pending_chron) > 8:      # cap: drop oldest, keep fresh
            for eid in list(self.pending_chron)[:len(self.pending_chron) - 8]:
                del self.pending_chron[eid]
        chron_ready = bool(self.pending_chron) and (
            len(self.pending_chron) >= 6
            or w["tick"] - self.pending_since >= 4)
        self.slot_rot = (getattr(self, "slot_rot", 0) + 1) % 2
        if chron_ready and (self.slot_rot == 0
                            or len(self.pending_chron) >= 6):
            self._flush_chron()
            return
        if self._maybe_name(notable):
            return
        if chron_ready:
            self._flush_chron()

    def _flush_chron(self):
        items = list(self.pending_chron.values())
        extra = {"eids": [i["eid"] for i in items],
                 "keys": {i["eid"]: i["key"] for i in items}}
        self.pending_chron = {}
        self.worker.submit({"kind": "chron", "system": chronicler._SYSTEM,
                            "user": chronicler.build_prompt(items),
                            "schema": CHRON_SCHEMA, "max_tokens": 220,
                            "temperature": 0.9, "extra": extra})

    def _invite_operator(self):
        recent = [r[2] for r in self.db.chronicle_lines(5)]
        # provisional schedule; sim._apply_effect sets the real one on apply
        self.world["next_op"] = self.world["tick"] + 8
        self.worker.submit({
            "kind": "op", "system": operator.SYSTEM,
            "user": operator.digest(self.world, recent),
            "schema": operator.SCHEMA, "max_tokens": 140, "temperature": 0.8,
            "extra": {}})

    def _maybe_name(self, notable):
        w = self.world
        budget = w.get("name_budget", 0)
        if budget <= 0 or w.get("fawns_named", 0) >= 3 or self.worker.busy:
            return False
        pool = [kid for kid in w.get("name_pool", [])
                if str(kid) in w["animals"]]        # only the living
        births = [e for e in notable if e["kind"] == "birth"]
        elders = [e for e in notable if e["kind"] == "elder"]
        target_key = target_sp = target_kind = None
        if pool:
            target_key, target_sp, target_kind = pool[0], \
                w["animals"][str(pool[0])]["sp"], "creature"
        elif births:
            target_key = (births[0].get("kids") or [None])[0]
            target_sp, target_kind = births[0]["sp"], "creature"
        elif elders:
            target_key = elders[0].get("plant")
            target_sp, target_kind = elders[0]["sp"], "tree"
        if target_key is None:
            return False
        existing = list(w["names"].values())
        fallback = voice.fallback_name(existing, w["seed"], w["tick"])
        ask = voice.prompt_for(target_kind, target_sp)
        submitted = self.worker.submit({
            "kind": "voice", "system": voice.SYSTEM, "user": ask,
            "schema": voice.SCHEMA, "max_tokens": 60, "temperature": 0.9,
            "extra": {"kind": target_kind, "sp": target_sp, "key":
                      target_key, "fallback": fallback}})
        if submitted:
            w["name_budget"] -= 1
            w["fawns_named"] += 1
            if pool and target_key == pool[0]:
                w["name_pool"].pop(0)
        return submitted

    # -- LLM results (run mode) ---------------------------------------------
    def apply_results(self):
        if self.worker is None:
            return
        while True:
            try:
                res = self.worker.results.get_nowait()
            except queue.Empty:
                break
            kind = res["kind"]
            if kind == "op":
                effect = operator.validate(res["data"])
                self.world["pending_effect"] = effect
                self.soul_line = (f"{effect['action']} {effect['region']}"
                                  f" — {effect['intent']}")
                self.soul_tick = self.world["tick"]
            elif kind == "chron":
                if res["ok"] and isinstance(res["data"], dict):
                    eids = res["extra"]["eids"]
                    keys = res["extra"]["keys"]
                    pairs = chronicler.parse(res["data"],
                                             [{"eid": e} for e in eids])
                    for eid, text in pairs:
                        if text:
                            self.db.update_text(keys[eid], text)
            elif kind == "voice":
                self._apply_voice(res)

    def _apply_voice(self, res):
        w = self.world
        extra = res["extra"]
        name, diary = voice.parse(res["data"], extra["fallback"],
                                  list(w["names"].values()))
        if extra["key"] is not None:
            w["names"][str(extra["key"])] = name
        if extra["kind"] == "tree":
            line = f"The elder {extra['sp']} was named {name}."
        else:
            line = f"A newborn {extra['sp']} was named {name}."
        if diary:
            line = f"{line} {diary}"
        self.db.add_line(w["tick"], "rename", line)


# ---------------------------------------------------------------- run loop

def _readch(timeout):
    import select
    import termios
    import tty
    old = termios.tcgetattr(sys.stdin)
    try:
        tty.setcbreak(sys.stdin.fileno())
        r, _w, _e = select.select([sys.stdin], [], [], timeout)
        if not r:
            return ""
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            return "q"  # ESC quits, nothing fancy
        return ch
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)


def cmd_run(args):
    g = Grove(args)
    g.load_or_exit()
    g.init_llm()
    world = g.world
    paused = False
    tty = sys.stdin.isatty() and sys.stdout.isatty()
    clear = "\033[2J\033[H" if tty else ""
    if tty and g.llm and g.llm.enabled:
        print("waking the world soul… (model load can take a minute)",
              flush=True)
        time.sleep(1.0)
    try:
        while True:
            if not paused:
                _evs, notable = g.step()
                g.apply_results()
                g.maybe_schedule(notable)
            else:
                g.apply_results()
            # the soul's decision lands at the next tick boundary
            soul_line = None
            if g.soul_tick >= 0 and g.world.get("pending_effect"):
                soul_line = g.soul_line
            elif g.worker and g.worker.busy:
                soul_line = "listening…"
            frame = {"world": world,
                     "chron_rows": g.db.chronicle_lines(8),
                     "soul_line": soul_line,
                     "status": llmm.status_line(g.llm)}
            out = render.full(frame)
            if tty:
                sys.stdout.write(clear + out)
                sys.stdout.flush()
            else:
                print(out, flush=True)
                print("---", flush=True)
            wait = 0.12 if paused else args.tick_seconds
            if tty:
                ch = _readch(wait)   # select() provides the pacing in a tty
            else:
                time.sleep(wait)
                ch = ""
            if ch == "q":
                break
            if ch == " ":
                paused = not paused
            elif ch == "s" and paused:
                _evs, notable = g.step()
                g.apply_results()
                g.maybe_schedule(notable)
            elif ch == "n" and g.llm and g.llm.enabled:
                if g.worker and not g.worker.busy:
                    world["next_op"] = world["tick"]
                    g._invite_operator()
    finally:
        g.db.close()
        print("saved. see: grove chronicle | grove status")


def cmd_step(args):
    g = Grove(args)
    g.load_or_exit()
    g.init_llm()
    t0 = time.time()
    last_chron_week = -9
    for _ in range(args.n):
        evs, notable = g.step()
        if not (args.narrate and g.llm and g.llm.enabled):
            continue
        w = g.world
        # the pending soul decision applies at the next tick inside sim.tick
        if w["tick"] >= w["next_op"]:
            recent = [r[2] for r in g.db.chronicle_lines(5)]
            raw = g.llm.chat_json(operator.SYSTEM,
                                  operator.digest(w, recent),
                                  operator.SCHEMA, max_tokens=140,
                                  temperature=0.8)
            w["pending_effect"] = operator.validate(raw)
        items = chronicler.batch(notable, w)
        if items and w["tick"] - last_chron_week >= 4:
            for i, it in enumerate(items):
                it["eid"] = f"e{i}"
            raw = g.llm.chat_json(
                chronicler._SYSTEM, chronicler.build_prompt(items),
                CHRON_SCHEMA, max_tokens=220, temperature=0.9)
            last_chron_week = w["tick"]
            for (eid, text), item in zip(chronicler.parse(raw, items), items):
                if text:
                    g.db.cache_set(item["key"], text)
                    g.db.update_text(item["key"], text)
    g.db.close()
    print(f"stepped {args.n} weeks → tick {g.world['tick']} "
          f"in {time.time() - t0:.1f}s (LLM "
          f"{'on' if args.narrate and g.llm and g.llm.enabled else 'off'})")


def cmd_map(args):
    g = Grove(args)
    g.load_or_exit()
    print(render.header(g.world))
    print(render.render_map(g.world))


def cmd_chronicle(args):
    g = Grove(args)
    rows = g.db.chronicle_all() if args.all else g.db.chronicle(args.tail)
    for _ident, tick, _kind, source, text in rows:
        mark = {"llm": "☾", "voice": "☂", "template": "·"}.get(source, "?")
        print(f" wk{tick:>4} {mark} {text}")
    g.db.close()


def cmd_status(args):
    g = Grove(args)
    hist = g.db.history(args.ticks)
    if not hist:
        print("no history yet")
        return
    species = ["rabbit", "deer", "fox", "owl", "robin", "boar"]
    keys = [("pop", sp) for sp in species] + [("plants", sp)
                                              for sp in ("pine", "birch")]
    print(f"{'week':>6} " + " ".join(f"{k[1][:6]:>7}" for k in keys))
    for tick, data in hist[-args.width:]:
        print(f"{tick:>6} " + " ".join(
            f"{data.get(s, {}).get(sp, 0):>7}" for s, sp in keys))
    caps = {"rabbit": 80, "deer": 22, "fox": 14, "owl": 6, "robin": 60,
            "boar": 10, "pine": 250, "birch": 250}
    for _sect, sp in keys:
        series = [d.get(_sect, {}).get(sp, 0) for _t, d in hist[-args.width:]]
        print(f"  {sp:>6} {render.spark(series, caps.get(sp, 120))}")
    g.db.close()


def cmd_new(args):
    path = os.path.join(args.data, "grove.db")
    if os.path.exists(path):
        if not args.force:
            sys.exit(f"'{args.data}' already holds a world; "
                     f"use --force to start over")
        os.remove(path)   # a fresh world starts with a fresh ledger
    w = gen.generate(args.seed, args.size)
    db = dbm.DB(os.path.join(args.data, "grove.db"))
    db.save_world(w)
    db.close()
    print(f"new grove: seed {args.seed}, {args.size}×{args.size}, "
          f"{len(w['plants'])} plants, {len(w['animals'])} animals")
    print("watch it: grove run   · headless: grove step 100")


def _add_llm_flags(sp):
    sp.add_argument("--offline", action="store_true",
                    help="pure deterministic sim; no LLM calls")
    sp.add_argument("--model", default=None)
    sp.add_argument("--host", default=None)


def build_parser():
    p = argparse.ArgumentParser(prog="grove", description=__doc__)
    p.add_argument("--data", default="./grove_data")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("new", help="create a new world")
    sp.add_argument("--seed", type=int, default=None)
    sp.add_argument("--size", type=int, default=W.SIZE_DEFAULT)
    sp.add_argument("--force", action="store_true")
    sp.set_defaults(func=cmd_new, offline=True, model=None, host=None)
    sp = sub.add_parser("run", help="live watch mode")
    sp.add_argument("--tick-seconds", type=float, default=8.0)
    _add_llm_flags(sp)
    sp.set_defaults(func=cmd_run)
    sp = sub.add_parser("step", help="advance N weeks (batch)")
    sp.add_argument("n", type=int, nargs="?", default=16)
    sp.add_argument("--narrate", action="store_true",
                    help="call the LLM inline while stepping (slow)")
    _add_llm_flags(sp)
    sp.set_defaults(func=cmd_step)
    sp = sub.add_parser("map", help="render the current map once")
    sp.set_defaults(func=cmd_map, offline=True, model=None, host=None)
    sp = sub.add_parser("chronicle", help="print the chronicle")
    sp.add_argument("--tail", type=int, default=50)
    sp.add_argument("--all", action="store_true")
    sp.set_defaults(func=cmd_chronicle, offline=True, model=None, host=None)
    sp = sub.add_parser("status", help="population history")
    sp.add_argument("--ticks", type=int, default=48)
    sp.add_argument("--width", type=int, default=24)
    sp.set_defaults(func=cmd_status, offline=True, model=None, host=None)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.cmd == "new" and args.seed is None:
        args.seed = random.randint(1, 10_000)
    # subcommands that didn't set model/host inherit the defaults
    if getattr(args, "model", None) is None:
        args.model = llmm.DEFAULT_MODEL
    if getattr(args, "host", None) is None:
        args.host = llmm.DEFAULT_HOST
    args.func(args)


if __name__ == "__main__":
    main()