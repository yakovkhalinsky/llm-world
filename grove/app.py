"""Shared world-running machinery: the Grove orchestrator and the
background LLM worker. Used by the CLI (grove/__main__.py) and the web
dashboard (grove/web.py).
"""

import json
import os
import queue
import random
import sys
import threading
import time

from . import chronicler
from . import db as dbm
from . import events as evm
from . import operator
from . import llm as llmm
from . import sim
from . import voice
from . import world as W


CHRON_SCHEMA = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
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
                    temperature=job.get("temperature", 0.8),
                    retries=job.get("retries", 1),
                    job=job.get("kind", "chron"))
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
        self.worker = None          # only in `run`/`web` mode
        self.soul_line = None
        self.soul_tick = -1
        self.pending_chron = {}     # eid -> chronicler batch item
        self.pending_since = -1
        self.eid = 0
        # live counters, exposed on the dashboard for diagnosis
        self.jobs = {"op": 0, "chron": 0, "voice": 0,
                     "op_applied": 0, "chron_ok": 0, "chron_rejected": 0,
                     "last_reject": None}

    # -- lifecycle ----------------------------------------------------------
    def load_or_exit(self):
        self.world = self.db.load_world()
        if self.world is None:
            sys.exit(f"no world in '{self.args.data}'; run first: grove new")

    def init_llm(self):
        self.llm = None if self.args.offline else llmm.LLM(
            model=self.args.model, tier=getattr(self.args, "tier", "auto"),
            host=self.args.host)
        if self.llm and self.llm.enabled and self.args.cmd in ("run", "web"):
            self.worker = SoulWorker(self.llm)
            self.worker.start()

    # -- one deterministic step ---------------------------------------------
    def step(self):
        w = self.world
        # remember where each creature stood at the start of this week so
        # the web view can glide them between weekly states
        for a in w["animals"].values():
            a["px"], a["py"] = a["x"], a["y"]
        evs = sim.tick(w)
        notable = evm.notable(evs)
        self.db.add_events(evs)
        self.db.save_world(w)
        self.db.add_stats(w["tick"], W.counts(w), W.plant_counts(w))

        # template lines appear immediately, whatever the LLM is doing;
        # the soul's own events (op + prophecy fulfillments) speak for
        # themselves; natural happenings get template-then-LLM lines
        items = chronicler.batch(notable, w)
        llm_items = []
        for it in items:
            cached = self.db.cache_get(it["key"])
            if it["slot"].get("kind") in ("op", "destiny", "destiny_lost"):
                self.db.record(it["key"], it["tick"], it["template"], "soul")
            elif cached:
                self.db.record(it["key"], it["tick"], cached, "llm")
            else:
                self.db.record(it["key"], it["tick"], it["template"])
            if it["slot"].get("kind") not in ("op", "destiny", "destiny_lost"):
                llm_items.append(it)
        if llm_items and self.worker is not None:
            for it in llm_items:
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
        # the soul is first; then prose follows its backlog; naming fills
        # the rest. A fast (cloud) tier speaks far more often.
        if w["tick"] >= w["next_op"] and \
                time.time() >= getattr(self, "next_op_wall", 0):
            self._invite_operator()
            self.next_op_wall = time.time() + self.llm.soul_gap()
            return
        if len(self.pending_chron) > 8:      # cap: drop oldest, keep fresh
            for eid in list(self.pending_chron)[:len(self.pending_chron) - 8]:
                del self.pending_chron[eid]
        chron_ready = bool(self.pending_chron)
        need = 1 if self.llm.is_cloud() else 2
        self.slot_rot = (getattr(self, "slot_rot", 0) + 1) % 3
        if chron_ready and (len(self.pending_chron) >= need
                            and self.slot_rot < 2):
            self._flush_chron()
            return
        if self._maybe_name(notable):
            return
        if chron_ready:
            self._flush_chron()

    def _flush_chron(self):
        # small models handle single events far better than event arrays:
        # narrate the OLDEST pending event in its own tiny call
        eid = next(iter(self.pending_chron))
        item = self.pending_chron.pop(eid)
        item["eid"] = "e0"           # the prompt and the parser agree
        self.jobs["chron"] += 1
        self.worker.submit({
            "kind": "chron", "system": chronicler.SYSTEM,
            "user": chronicler.build_prompt(item),
            "schema": CHRON_SCHEMA, "max_tokens": 60, "temperature": 0.9,
            "extra": {"base": item["template"], "key": item["key"],
                      "tick": item["tick"]},
            "retries": 2})

    def _invite_operator(self):
        recent = [r[2] for r in self.db.chronicle_lines(5)]
        # provisional schedule; sim._apply_effect sets the real one on apply
        self.world["next_op"] = self.world["tick"] + 8
        self.jobs["op"] += 1
        self.worker.submit({
            "kind": "op", "system": operator.SYSTEM,
            "user": operator.digest(self.world, recent),
            "schema": operator.SCHEMA, "max_tokens": 140, "temperature": 0.8,
            "extra": {}})

    def _maybe_name(self, notable):
        w = self.world
        budget = w.get("name_budget", 0)
        if budget <= 0 or w.get("fawns_named", 0) >= 8 or self.worker.busy:
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
            self.jobs["voice"] += 1
            if pool and target_key == pool[0]:
                w["name_pool"].pop(0)
        return submitted

    # -- LLM results (run/web mode) -----------------------------------------
    def apply_results(self):
        if self.worker is None:
            return
        while True:
            try:
                res = self.worker.results.get_nowait()
            except queue.Empty:
                break
            # one bad result must never take down the drain loop
            try:
                self._apply_one(res)
            except Exception as e:
                self.jobs["handler_errors"] = \
                    self.jobs.get("handler_errors", 0) + 1
                print(f"grove: result handler error: {e}", file=sys.stderr)

    def _apply_one(self, res):
        kind = res["kind"]
        if kind == "op":
            effect = operator.validate(res["data"])
            self.world["pending_effect"] = effect
            self.soul_line = (f"{effect['action']} {effect['region']}"
                              f" — {effect['intent']}")
            self.soul_tick = self.world["tick"]
            self.jobs["op_applied"] += 1
        elif kind == "chron":
            text = None
            if res["ok"]:
                text = chronicler.parse_single(
                    res["data"], "e0", res["extra"]["base"])
            if text:
                self.db.cache_set(res["extra"]["key"], text)
                self.db.update_text(res["extra"]["key"], text)
                self.jobs["chron_ok"] += 1
            else:
                self.jobs["chron_rejected"] += 1
                self.jobs["last_reject"] = {
                    "base": res["extra"]["base"][:110],
                    "ok": res["ok"],
                    "reason": getattr(self.llm, "reason", ""),
                    "reply": (json.dumps(res["data"]) if res["data"]
                              else getattr(self.llm, "last_raw", "")
                              or "")[:150],
                }
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
