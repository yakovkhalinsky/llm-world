"""Grove CLI: create, watch, step and read a self-contained forest world.

  grove new [--seed 42] [--size 24]      create a world (no LLM involved)
  grove run  [--tick-seconds 8] [--offline]   live watch (LLM in background)
  grove web  [--port 8787] [--public]    dashboard for phone/another machine
  grove step N [--narrate] [--offline]   advance N weeks in batch
  grove map                              render the saved map once
  grove chronicle [--tail 50] [--all]    print the chronicle
  grove status                           population history

Everything lives in ./grove_data (override with --data PATH).
"""

import argparse
import json
import os
import random
import sys
import time

from . import chronicler
from . import db as dbm
from . import rules
from . import events as evm
from . import gen
from . import llm as llmm
from . import operator
from . import render
from . import sim
from . import world as W
from .app import CHRON_SCHEMA, Grove
from .web import cmd_web


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
            try:
                if not paused:
                    _evs, notable = g.step()
                    g.apply_results()
                    g.maybe_schedule(notable)
                else:
                    g.apply_results()
            except Exception as e:
                # the grove survives its own bad weeks (and our diagnostics)
                import traceback
                traceback.print_exc()
                time.sleep(1.0)
                continue
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
            raw = g.llm.chat_json(operator.system(),
                                  operator.digest(w, recent),
                                  operator.schema(), max_tokens=140,
                                  temperature=0.8)
            w["pending_effect"] = operator.validate(raw)
        items = chronicler.batch(notable, w)
        if items and w["tick"] - last_chron_week >= 4:
            for item in items[:5]:    # one flat call per event
                item["eid"] = "e0"
                recents = [r[2] for r in g.db.chronicle_lines(5)]
                raw = g.llm.chat_json(
                    chronicler.SYSTEM,
                    chronicler.build_prompt(item, recents),
                    CHRON_SCHEMA, max_tokens=60, temperature=0.9, retries=2)
                text = chronicler.parse_single(raw, "e0", item["template"],
                                               recents=recents)
                if text and text.strip().lower() != \
                        item["template"].strip().lower():
                    g.db.cache_set(item["narr_key"], text)
                    g.db.update_text(item["key"], text)
            last_chron_week = w["tick"]
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
    rows = g.db.chronicle_all() if args.all else list(
        reversed(g.db.chronicle(args.tail)))   # newest first, like a feed
    for _ident, tick, _kind, source, text in rows:
        mark = {"llm": "☾", "soul": "☾", "voice": "☂",
                "template": "·"}.get(source, "?")
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
    caps = {"rabbit": 24, "deer": 10, "fox": 6, "owl": 3, "robin": 14,
            "boar": 5, "pine": 500, "birch": 250}
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
        # the old grove is archived, not destroyed: its chronicle
        # and history outlive the reset
        stamp = time.strftime("%Y%m%d-%H%M%S")
        old_tick = "?"
        try:
            db = dbm.DB(path)
            w = db.load_world()
            old_tick = w and w["tick"]
            db.close()
        except Exception:
            pass
        archive = os.path.join(args.data, f"archive-{stamp}-wk{old_tick}.db")
        os.rename(path, archive)
        print(f"previous grove archived at {archive}")
    w = gen.generate(args.seed, args.size, biome=args.biome)
    db = dbm.DB(os.path.join(args.data, "grove.db"))
    db.save_world(w)
    db.close()
    print(f"new grove: seed {args.seed}, {w['size']}×{w['size']}, "
          f"{len(w['plants'])} plants, {len(w['animals'])} animals")
    print("watch it: grove run   · headless: grove step 100")


def _add_llm_flags(sp):
    sp.add_argument("--offline", action="store_true",
                    help="pure deterministic sim; no LLM calls")
    sp.add_argument("--model", default="auto",
                    help='a model name, or "auto" (cloud-first with '
                         'local fallback)')
    sp.add_argument("--tier", choices=("local", "cloud", "hybrid"),
                    default="cloud",
                    help='"cloud" (default) = every job on one cloud '
                         'model (glm-5.3-flash) with local fallback; '
                         '"local" = fully offline, the forest on the '
                         'llama; "hybrid" = like cloud (kept for old '
                         'scripts)')
    sp.add_argument("--token-budget", type=int, default=None,
                    help="max cloud tokens per day; over it the grove "
                         "thins to local narration and slows the soul")
    sp.add_argument("--auto-tune", action="store_true",
                    help="the steward's accepted proposals apply "
                         "themselves (one rule a year, bounded)")
    sp.add_argument("--host", default=None)


def build_parser():
    p = argparse.ArgumentParser(prog="grove", description=__doc__)
    p.add_argument("--data", default="./grove_data")
    p.add_argument("--rules", default=None,
                   help="a JSON rules override (see docs/TUNING.md)")
    p.add_argument("--biome", default="grove",
                   help="the world's nature pack (grove; a desert is coming)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("new", help="create a new world")
    sp.add_argument("--seed", type=int, default=None)
    sp.add_argument("--size", type=int, default=None,
                    help="map width/height (the ruleset's default when "
                         "unset)")
    sp.add_argument("--force", action="store_true")
    sp.set_defaults(func=cmd_new, offline=True, model=None, host=None)
    sp = sub.add_parser("run", help="live watch mode")
    sp.add_argument("--tick-seconds", type=float, default=12.0,
                    help="wall seconds per simulated week")
    _add_llm_flags(sp)
    sp.set_defaults(func=cmd_run)
    sp = sub.add_parser("web", help="live dashboard for other devices")
    sp.add_argument("--port", type=int, default=8787)
    sp.add_argument("--public", action="store_true",
                    help="bind 0.0.0.0 so other devices can reach it")
    sp.add_argument("--tick-seconds", type=float, default=12.0,
                    help="wall seconds per simulated week")
    _add_llm_flags(sp)
    sp.set_defaults(func=cmd_web)
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
    sp = sub.add_parser("rules", help="print the biome's ruleset")
    sp.add_argument("--template", metavar="FILE",
                    help="write the current ruleset as a JSON template")
    sp.set_defaults(func=cmd_rules)
    sp = sub.add_parser("status", help="population history")
    sp.add_argument("--ticks", type=int, default=48)
    sp.add_argument("--width", type=int, default=24)
    sp.set_defaults(func=cmd_status, offline=True, model=None, host=None)
    return p


def cmd_rules(args):
    if args.template:
        path = rules.dump_template(args.template)
        print("wrote", path)
        return
    print(json.dumps(rules.R, indent=1, sort_keys=True, default=str))


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.rules:
        rules.load_override(args.rules)
        print(f"rules override: {args.rules}")
    # the world's own constitution: the amendments the steward accepted
    own = os.path.join(args.data, "world_rules.json")
    if os.path.exists(own):
        rules.load_override(own)
        print(f"world constitution: {own}")
    if getattr(args, "auto_tune", False):
        rules.R["review"]["auto_tune"] = True
    if args.cmd == "new" and args.seed is None:
        args.seed = random.randint(1, 10_000)
    # subcommands that didn't set model/host inherit the defaults
    if getattr(args, "model", None) is None:   # 'auto'/tier resolved later
        args.model = "auto"
    if getattr(args, "host", None) is None:
        args.host = llmm.DEFAULT_HOST
    args.func(args)


if __name__ == "__main__":
    main()
