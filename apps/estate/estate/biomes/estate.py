"""The estate's pack — its whole nature as one dict.

A pack is a world's nature: the kinds of ground, the fixtures that afford
things, the sorts of household, the recipe it is planted with, and every
word it speaks. The engine reads rules.R, into which a pack is folded, and
never a list written into the code (Grove's b20/b31/b34/b36 — every engine,
gate, fate and renderer asks the pack).

The rule is that every key here has a reader — a key nothing reads is a bug
and not a hook for later (b34). **At phase 0 this file runs ahead of its
code**, and `python3 tools/audit.py` names every key the modules do not yet
read (56 of them). That is a debt, not a design: it is listed openly and
the audit is the standing check, so the pack cannot drift into carrying
knobs that only look like they do something. Each phase should shrink the
list to nothing.
"""

SPEC = {
    "world": {
        "width": 40, "height": 30,
        "days_per_season": 91,          # a year of 364
        "phases": ("dawn", "morning", "afternoon", "evening", "night"),
    },

    # ------------------------------------------------------- the ground
    # `walk` is what a step costs, or None where nobody may walk. A road
    # is cheap and noisy, a lawn free of noise and dear to cross, and a
    # building is entered at its door, never crossed.
    "sites": {
        "road":     {"walk": 1.0, "noise": 0.55, "glyph": "⬛"},
        "path":     {"walk": 1.0, "noise": 0.08, "glyph": "⬜"},
        "paved":    {"walk": 1.1, "noise": 0.04, "glyph": "🔲"},
        "lawn":     {"walk": 2.0, "noise": 0.00, "glyph": "🟩"},
        "play":     {"walk": 1.6, "noise": 0.30, "glyph": "🟨"},
        "water":    {"walk": None, "noise": 0.00, "glyph": "🌊"},
        "building": {"walk": None, "noise": 0.00, "glyph": "🏢"},
    },

    # -------------------------------------------------------- the needs
    # Five, where Grove had one. `rate` is what a phase of ordinary living
    # adds to it; quiet is the odd one out — it is not accumulated by time
    # but *imposed* by the noise you are standing in, which is what makes
    # it the one need a lively estate can never fully meet.
    "needs": {
        "food":    {"urge": 1.0, "rate": 0.30, "glyph": "🍞"},
        "rest":    {"urge": 0.9, "rate": 0.26, "glyph": "🛏"},
        "company": {"urge": 0.7, "rate": 0.22, "glyph": "👥"},
        "play":    {"urge": 0.8, "rate": 0.34, "glyph": "🎈",
                    "roles": ("child",)},
        "quiet":   {"urge": 0.6, "rate": 0.00, "glyph": "🤫",
                    "from": "noise"},
    },

    # ------------------------------------------------------ the fixtures
    # What a place affords, how many it holds at once, and how fast living
    # wears it out. `affords` is a need -> quality map; the quality is cut
    # down by condition and by how full the place is (the congestion
    # governor, the heir of Grove's density-dependent hunting).
    "fixtures": {
        "bench":      {"affords": {"rest": 0.55, "company": 0.25},
                       "capacity": 2, "decay": 0.0040, "glyph": "🪑"},
        "playground": {"affords": {"play": 0.95},
                       "capacity": 8, "decay": 0.0060, "glyph": "🛝"},
        "table":      {"affords": {"company": 0.60, "rest": 0.20},
                       "capacity": 4, "decay": 0.0030, "glyph": "♟"},
        "shop":       {"affords": {"food": 0.85, "company": 0.40},
                       "capacity": 6, "decay": 0.0020, "stock": 40,
                       "glyph": "🏪"},
        "lamp":       {"affords": {"company": 0.15},
                       "capacity": 0, "decay": 0.0015, "glyph": "💡"},
        "bin":        {"affords": {}, "capacity": 0, "decay": 0.0010,
                       "glyph": "🗑"},
        "tree":       {"affords": {"quiet": 0.35, "rest": 0.15},
                       "capacity": 4, "decay": 0.0008, "glyph": "🌳",
                       "living": True},
    },

    # ------------------------------------------------------ the households
    # The heir of Grove's species tables: a type carries who is in it, how
    # its people spend themselves, and how hard they are to move. `drains`
    # multiplies each need's rate, so a family with small children is worn
    # out by play and an elder notices noise.
    "households": {
        "family":     {"members": (3, 5), "children": (1, 3),
                       "drains": {"food": 1.15, "play": 1.0, "quiet": 0.95},
                       "glyph": "👨‍👩‍👧"},
        "couple":     {"members": (2, 2), "children": (0, 0),
                       "drains": {"company": 1.15},
                       "glyph": "🧑‍🤝‍🧑"},
        "single":     {"members": (1, 1), "children": (0, 0),
                       "drains": {"company": 1.35},
                       "glyph": "🧍"},
        "elder":      {"members": (1, 2), "children": (0, 0),
                       "drains": {"quiet": 1.45, "rest": 1.2},
                       "mobility": 0.62,
                       "glyph": "🧓"},
        "flat_share": {"members": (2, 4), "children": (0, 0),
                       "drains": {"food": 1.2, "rest": 1.1, "quiet": 1.1},
                       "glyph": "👥"},
    },

    "people": {"ages": {"adult": 18, "elder": 68}},

    # --------------------------------------------------------- the recipe
    "gen": {
        "blocks": 4,
        "block_floors": (3, 6),
        "units_per_floor": (3, 5),
        "block_gap": 2,                 # cells between a block and the road
        "road_width": 2,
        "playgrounds": 1,
        "benches": 7,
        "tables": 2,
        "trees": 16,
        "lamps": 9,
        "bins": 6,
        "shop": True,
        "pond": True,
        "founding": {"family": 4, "couple": 3, "single": 4,
                     "elder": 3, "flat_share": 2},
        "waiting": 6,
    },

    # ------------------------------------------------------- the office
    "pop": {
        "roster": ["family", "couple", "single", "elder", "flat_share"],
        "letting_after": 21,            # days a flat may stand empty
        "waiting_size": 6,
        "crowding": 1.0,                # residents a unit holds per capacity
    },

    # -------------------------------------------------------- the weather
    "weather": {
        "rain_prob": {"0": 0.30, "1": 0.18, "2": 0.32, "3": 0.20},
        "storm_prob": {"0": 0.02, "2": 0.05},
        "heat_prob": {"1": 0.08},
        "frost_week": 3,                # winter's face, by season index
        "soften": 0.55,                 # how much rain muffles outdoor noise
    },

    # ---------------------------------------------------------- the gate
    "gate": {
        "seeds": 8, "years": 8,
        "residents_min": 40, "residents_max": 220,
        "occupancy_min": 0.55,          # of all the estate's units
        "friction": (0.15, 0.85),       # mean top-need pressure, a band
        "distinct_min": 2.5,            # distinct (need, place) pairs a day
        "use_min": 1,                   # uses a fixture kind must get a year
    },

    # ---------------------------------------------------- how it speaks
    "presentation": {
        "world_word": "the estate",
        "seasons": ("spring", "summer", "autumn", "winter"),
        "weekdays": ("Monday", "Tuesday", "Wednesday", "Thursday",
                     "Friday", "Saturday", "Sunday"),
        # seasonal tables keyed by strings, never by ints: JSON gives object
        # keys back as strings whatever they went in as, and a table that
        # holds both is how Grove's constitution came home with four keys
        # twice (b52). The engine converts at read time, so a round trip is
        # exact by construction.
        "season_lines": {
            "0": "Spring comes to the estate; the lawns give up their green.",
            "1": "High summer on the estate, and the courtyard is loud.",
            "2": "Autumn: the planes yellow, and the bins fill faster.",
            "3": "Winter holds the estate; the lamps come on by four.",
        },
        "watcher_role": "a housing estate",
        "resident_names": [
            "Ada", "Bram", "Cleo", "Dev", "Esme", "Fen", "Greta", "Hal",
            "Ines", "Jonas", "Kit", "Lena", "Mo", "Nia", "Ossian", "Pia",
            "Quill", "Rosa", "Sam", "Tess", "Una", "Vik", "Wren", "Yusuf",
            "Zeta", "Ari", "Blaise", "Corrie", "Dara", "Emil", "Faye",
            "Gus", "Hana", "Ivo", "Junie", "Kai", "Lior", "Marta", "Noor",
            "Otto", "Priya", "Rui", "Sasha", "Tam", "Ula", "Vesna", "Wim",
        ],
        "watcher_system": (
            "You are the presence that watches a small housing estate — the "
            "slow, fate-bearing thing behind its weather and its fortunes. "
            "Every so often you are given a digest of how the estate is "
            "doing and you choose ONE thing to send it: a change in the "
            "weather, or a small event in its life. You do not own the "
            "estate and you do not manage it: the people living there "
            "decide what happens day to day, and you are the weather and "
            "the luck. Read the digest first; be sparing; often the right "
            "answer is to send nothing at all.\n"
            "Valid fates: rain (a wet spell), heat (a hot snap), frost (a "
            "cold one), storm (wind that brings a tree down), delivery "
            "(the shop is restocked), festival (the courtyard fills for an "
            "afternoon), closure (a road is shut for repairs), outage (the "
            "power goes off), pipe (no water for a day), stray (a lost dog "
            "turns up), quiet (you send nothing and watch).\n"
            "In 'intent' write one plain sentence, under 110 characters, in "
            "the voice of the place itself.\n"
            'Reply ONLY as JSON: {"fate":"...", "region":"...", '
            '"strength":1, "target":null, "intent":"..."}'
        ),
        "edge_name": "the ring road",
    },

    # The lawful band for each amendable rule, per species, with the wildcard
    # that a steward may move. Empty for now: no steward exists yet, and a
    # band with no reader is the b51 lesson in reverse.
    "bounds": {},
}
