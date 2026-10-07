"""Highfield CLI: plant an estate, step it, read it.

  estate new [--seed 42] [--size 40x30]     plant an estate (no LLM)
  estate step N                             advance N days in batch
  estate map                                draw the plan once
  estate web [--port 8790]                  serve the dashboard (pixijs)
  estate status                             census history
  estate rules [--template FILE]            the live ruleset

Everything lives in ./estate_data (override with --data PATH).
"""

import argparse
import json
import os
import random
import sys
import time

from . import db as dbm
from . import gen
from . import render
from . import rules
from . import sim
from . import web as webm
from . import world as W


def _open(args):
    path = os.path.join(args.data, "estate.db")
    if not os.path.exists(path):
        sys.exit(f"no estate in '{args.data}'; plant one first: "
                 f"estate new")
    db = dbm.DB(path)
    world = db.load_world()
    if world is None:
        sys.exit(f"no world in '{path}'")
    # the estate's nature rides its save: re-fold its pack so a restart
    # speaks the same world the ground was born with
    if world.get("biome"):
        rules.select_biome(world["biome"])
    return db, world


def cmd_new(args):
    path = os.path.join(args.data, "estate.db")
    if os.path.exists(path):
        if not args.force:
            sys.exit(f"'{args.data}' already holds an estate; "
                     f"use --force to start over")
        # archived, not destroyed — the old estate's record outlives it
        stamp = time.strftime("%Y%m%d-%H%M%S")
        old = "?"
        try:
            old = dbm.DB(path).load_world()["day"]
        except Exception:
            pass
        archive = os.path.join(args.data, f"archive-{stamp}-d{old}.db")
        os.rename(path, archive)
        print(f"previous estate archived at {archive}")
    w, h = (args.size or "40x30").lower().split("x")
    world = gen.generate(args.seed, int(w), int(h), biome=args.biome)
    db = dbm.DB(path)
    db.save_world(world)
    db.close()
    census = _census(world)
    print(f"new estate: seed {world['seed']}, {world['width']}×"
          f"{world['height']}, {len(world['buildings'])} blocks, "
          f"{len(world['units'])} flats, {len(world['households'])} "
          f"households, {len(world['residents'])} people")
    print("  " + " ".join(f"{k} {v}" for k, v in sorted(census.items())))
    print("watch it: estate step 100   ·   estate map")


def _census(world):
    """Households by type — what the roster law is judged on."""
    out = {}
    for h in world["households"].values():
        if world["units"].get(str(h["unit"]), {}).get("household") == h["id"]:
            out[h["kind"]] = out.get(h["kind"], 0) + 1
    return out


def cmd_step(args):
    db, world = _open(args)
    t0 = time.time()
    for _ in range(args.n):
        sim.tick(world)
    db.save_world(world)
    db.add_stats(world["day"], _census(world))
    db.close()
    print(f"stepped {args.n} days → day {world['day']} "
          f"in {time.time() - t0:.1f}s")


def _readch(timeout):
    """One keypress, or nothing. A tty only — a pipe gets no termios."""
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
        return "q" if ch == "\x1b" else ch
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)


def cmd_run(args):
    """Watch the estate live. space pauses, s steps a day, q quits."""
    db, world = _open(args)
    paused = False
    tty = sys.stdin.isatty() and sys.stdout.isatty()
    clear = "\033[2J\033[H" if tty else ""
    try:
        while True:
            if not paused:
                sim.tick(world)
                db.save_world(world)
                db.add_stats(world["day"], _census(world))
            if tty:
                sys.stdout.write(clear + render.full(_frame(world, paused)))
                sys.stdout.flush()
            else:
                print(render.full(_frame(world, paused)), flush=True)
                print("---", flush=True)
            wait = 0.15 if paused else args.tick_seconds
            ch = _readch(wait) if tty else (time.sleep(wait) or "")
            if ch == "q":
                break
            if ch == " ":
                paused = not paused
            elif ch == "s" and paused:
                sim.tick(world)
                db.save_world(world)
    finally:
        db.close()
        print(f"stopped at day {world['day']} — nothing is lost")


def _frame(world, paused):
    day = world["day"]
    return {"world": world,
            "status": ("paused · " if paused else "") +
                      f"{W.weekday_name(day)} · no watcher yet",
            "watcher_line": None,
            "chronicle": []}


def cmd_map(args):
    _db, world = _open(args)
    print(render.header(world))
    print(render.render_map(world))


def cmd_status(args):
    db, world = _open(args)
    hist = db.history(args.days)
    if not hist:
        print("no history yet")
        return
    kinds = rules.R["pop"]["roster"]
    print(f"{'day':>4} " + " ".join(f"{k[:7]:>7}" for k in kinds))
    for day, census in hist[-args.width:]:
        print(f"{day:>4} " + " ".join(f"{census.get(k, 0):>7}"
                                      for k in kinds))
    db.close()


def cmd_web(args):
    webm.cmd_web(args)


def cmd_rules(args):
    if args.template:
        print("wrote", rules.dump_template(args.template))
        return
    print(json.dumps(rules.R, indent=1, sort_keys=True, default=str))


def build_parser():
    p = argparse.ArgumentParser(prog="estate", description=__doc__)
    p.add_argument("--data", default="./estate_data")
    p.add_argument("--rules", default=None,
                   help="a JSON rules override")
    p.add_argument("--biome", default="estate")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("new", help="plant a new estate")
    sp.add_argument("--seed", type=int, default=None)
    sp.add_argument("--size", default=None, help="WxH, e.g. 40x30")
    sp.add_argument("--force", action="store_true")
    sp.set_defaults(func=cmd_new)
    sp = sub.add_parser("run", help="watch the estate live")
    sp.add_argument("--tick-seconds", type=float, default=3.0,
                    help="wall seconds per day")
    sp.set_defaults(func=cmd_run)
    sp = sub.add_parser("step", help="advance N days")
    sp.add_argument("n", type=int, nargs="?", default=7)
    sp.set_defaults(func=cmd_step)
    sp = sub.add_parser("map", help="draw the plan once")
    sp.set_defaults(func=cmd_map)
    sp = sub.add_parser("status", help="census history")
    sp.add_argument("--days", type=int, default=64)
    sp.add_argument("--width", type=int, default=20)
    sp.set_defaults(func=cmd_status)
    sp = sub.add_parser("web", help="serve the dashboard")
    sp.add_argument("--port", type=int, default=8790)
    sp.add_argument("--tick-seconds", type=float, default=6.0)
    sp.add_argument("--public", action="store_true",
                    help="bind the LAN, not just loopback")
    sp.add_argument("--offline", action="store_true",
                    help="no model, no watcher — the estate alone")
    sp.add_argument("--model", default="auto",
                    help="pin one model instead of the chain")
    sp.add_argument("--tier", default="cloud", choices=("cloud", "local"),
                    help="cloud-first with local fallback, or all local")
    sp.set_defaults(func=cmd_web)
    sp = sub.add_parser("rules", help="print the live ruleset")
    sp.add_argument("--template", metavar="FILE")
    sp.set_defaults(func=cmd_rules)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.rules:
        rules.load_override(args.rules)
        print(f"rules override: {args.rules}")
    if getattr(args, "biome", None):
        rules.select_biome(args.biome)
    if args.cmd == "new" and args.seed is None:
        args.seed = random.randint(1, 10_000)
    args.func(args)


if __name__ == "__main__":
    main()
