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
        # `phases` is what gives a day its shape rather than its length: an
        # unlisted phase counts 1.0, so food leans on the mealtimes, the
        # children come out after lunch, and the estate wants its quiet at
        # night — which is also when the roads are quietest, so it is
        # satisfiable then and hardly ever during the day
        "food":    {"urge": 1.0, "rate": 0.30, "glyph": "🍞",
                    "phases": {"dawn": 1.7, "morning": 1.3,
                               "evening": 1.7, "night": 0.4}},
        "rest":    {"urge": 0.9, "rate": 0.26, "glyph": "🛏",
                    "phases": {"afternoon": 0.8, "night": 2.3}},
        "company": {"urge": 0.7, "rate": 0.22, "glyph": "👥",
                    "phases": {"afternoon": 1.2, "evening": 1.7}},
        "play":    {"urge": 0.8, "rate": 0.34, "glyph": "🎈",
                    "roles": ("child",),
                    "phases": {"afternoon": 1.9, "evening": 1.1,
                               "night": 0.1}},
        "quiet":   {"urge": 0.6, "rate": 0.00, "glyph": "🤫",
                    "from": "noise", "phases": {"night": 1.9}},
    },

    # ------------------------------------------------------ the fixtures
    # What a place affords, how many it holds at once, and how fast living
    # wears it out. `affords` is a need -> quality map; the quality is cut
    # down by condition and by how full the place is (the congestion
    # governor, the heir of Grove's density-dependent hunting).
    #
    # `upkeep` is how well the estate looks after this sort of thing, and
    # it is not the same for every sort because the sorts are not the
    # same: a shop has someone who runs it, and a bench has nobody. Without
    # it the estate's arithmetic had no answer for growth — a single shop
    # served 171 errands a day once the flats filled, its equilibrium
    # condition was 0.08, and the estate spent a season with a shop that
    # broke every few days. A kind the estate cannot keep up with still
    # fails; it just has to be used past what its own upkeep can carry.
    "fixtures": {
        "bench":      {"affords": {"rest": 0.55, "company": 0.25},
                       "capacity": 2, "decay": 0.00030, "loud": 0.015,
                       "carry": 2,
                       "upkeep": 1.0, "break_prob": 0.0012, "glyph": "🪑"},
        "playground": {"affords": {"play": 0.95},
                       "capacity": 12, "decay": 0.00040, "loud": 0.110, "carry": 12,
                       "upkeep": 1.6, "break_prob": 0.0010, "glyph": "🛝"},
        "table":      {"affords": {"company": 0.60, "rest": 0.20},
                       "capacity": 4, "decay": 0.00025, "loud": 0.030, "carry": 3,
                       "upkeep": 1.0, "break_prob": 0.0008, "glyph": "♟"},
        "shop":       {"affords": {"food": 0.85, "company": 0.40},
                       "capacity": 12, "decay": 0.00020, "stock": 150,
                       "restock": 90, "loud": 0.035, "carry": 5, "upkeep": 3.0, "break_prob": 0.0002,
                       "glyph": "🏪"},
        # a lamp affords nothing by itself: it lights, and what it lights
        # is worth more in the evening. A place that affords nothing but
        # state is decoration pretending to be a place.
        "lamp":       {"affords": {}, "capacity": 0, "decay": 0.00012,
                       "light": 0.55, "upkeep": 1.2, "break_prob": 0.0006, "glyph": "💡"},
        # A tree affords nothing, and that is not a gap — it is what a tree
        # is. It *shades*: the field `build_shade` makes is read by the heat
        # bonus and the quiet bonus where a person is sitting, so a bench
        # under a plane is a better bench than a bench in the open, and the
        # tree is the reason. It was written with `quiet: 0.35, rest: 0.15`
        # and never once chosen in a year: its own cell is only 0.30 shaded,
        # so under the shade term it was worth 0.36 against a flat's 0.62 —
        # and quiet only presses at night, when everyone is indoors anyway.
        # The gate said "a place the law offers and nobody wants"; the
        # honest answer was that the law should not have offered it. A lamp
        # lights and a tree shades, and neither is somewhere you go.
        "tree":       {"affords": {}, "decay": 0.00006, "storm_fall": 0.02,
                       "glyph": "🌳", "living": True},
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
        "shop": True,
        "pond": True,
        "founding": {"family": 4, "couple": 3, "single": 4,
                     "elder": 3, "flat_share": 2},
        "waiting": 6,
    },

    # ------------------------------------------------------- the office
    "pop": {
        "roster": ["family", "couple", "single", "elder", "flat_share"],
        "letting_after": 21,            # days a flat may stand empty before
                                        # the office looks at it
        "waiting_size": 6,              # households outside wanting a flat
        "crowding": 1.0,                # residents a unit holds per capacity
        "fill_to": 0.8,                 # the share of its own flats the
                                        # estate means to keep let — what
                                        # the letting office aims at, and
                                        # so what bounds the population
        "birth_prob": 0.22,             # per household per year, where there
                                        # is room — the estate's own growth
        "death_prob": 0.06,             # per elder per year, past 76
        "unhappy_rise": 0.5,            # how fast a frayed household sours
        "unhappy_decay": 0.97,          # and how fast it settles again
        "emigrate_at": 3.0,             # how sour a household has to get
                                        # before it leaves the estate
    },

    # -------------------------------------------------------- the weather
    "weather": {
        "rain_prob": {"0": 0.30, "1": 0.18, "2": 0.32, "3": 0.20},
        "storm_prob": {"0": 0.02, "2": 0.05},
        "heat_prob": {"1": 0.08},
        "frost_week": 3,                # winter's face, by season index
        "soften": 0.55,                 # how much rain muffles outdoor noise
    },

    # ------------------------------------------------------- the regions
    # Named rectangles of the plan, so a fate can be about *somewhere*
    # rather than everywhere — "roadworks" is not a thing that happens to
    # a whole estate. A region is only in this table if the menu below
    # names it; a region nothing can be sent to would be a key nothing
    # reads, which is the fault this project keeps catching (b34).
    "regions": {
        "all":       {},
        "north":     {"y": (0, 13)},
        "courtyard": {"y": (13, 17)},
        "south":     {"y": (17, 30)},
    },

    # ---------------------------------------------------------- the fates
    # What the watcher may send: the sky, and small events in the estate's
    # life. Each says what it does, and every key here is read at the
    # moment of use — `weather` sets the sky, `stock` fills the shop, the
    # `*_mult` keys are read by world.fate_mult, and `days` is how long
    # the thing lasts before it ages out. A fate whose effect nothing read
    # would be a menu item that does nothing, which is worse than no menu.
    "fates": {
        "rain":     {"weather": "rain", "days": (1, 3), "glyph": "🌧",
                     "why": "the sky opens over the estate"},
        "storm":    {"weather": "storm", "days": (1, 2), "glyph": "⛈",
                     "why": "a storm crosses the estate"},
        "heat":     {"weather": "heat", "days": (2, 4), "glyph": "🔥",
                     "why": "a still, close heat settles on the estate"},
        "frost":    {"weather": "frost", "days": (1, 3), "glyph": "❄",
                     "why": "the estate wakes white"},
        "delivery": {"stock": True, "days": (1, 1), "glyph": "📦",
                     "why": "the shop is restocked, shelves full"},
        "roadworks": {"walk_mult": 2.2, "days": (4, 9), "glyph": "🚧",
                      "regions": ("all", "north", "south"),
                      "why": "the road is up and the way round is long"},
        "power_cut": {"stair_mult": 2.0, "days": (1, 3), "glyph": "🔌",
                      "regions": ("all", "north", "south"),
                      "why": "the power is out and the lifts are down"},
        "tranquillity": {"noise_mult": 0.45, "days": (2, 5),
                         "glyph": "🤫",
                         "why": "the estate goes quiet for a few days"},
        "damage":   {"damage": 0.6, "days": (1, 1), "glyph": "🛠",
                     "regions": ("all", "courtyard"),
                     "why": "something breaks and the estate notices"},
        "quiet":    {"days": (1, 1), "glyph": "·",
                     "why": "nothing — the estate is left to its own day"},
    },

    # ---------------------------------------------------------- the gate
    "gate": {
        "seeds": 8, "years": 3,
        "residents_min": 40, "residents_max": 220,
        "occupancy_min": 0.55,          # of all the estate's units

        # Mean top-need pressure, and the band is derived rather than
        # fitted. The statistic is urge × need × phase-multiplier × drains,
        # so on a need at its ceiling of 4.0 the pressure is roughly 4 ×
        # the multiplier — about 5 across a day. That is a famine, and the
        # top of the band sits under it. The bottom sits above nothing:
        # needs at zero give zero, and an estate where nothing presses
        # anywhere is a utopia, which is the other way this model dies.
        # Written at phase 0 as (0.15, 0.85) — numbers chosen before an
        # estate existed to have them, and which a perfectly living estate
        # of 130 people failed at 1.7.
        "friction": (0.6, 3.0),
        "distinct_min": 2.5,            # distinct (need, place) pairs a day
        "use_min": 1,                   # uses a fixture kind must get
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
        # The voice and the discipline only. The *menu* is deliberately
        # not written here: it is the `fates` table above, and a prompt
        # that lists its own fates is a second copy of that table which
        # drifts from it the first time a fate is added — which is exactly
        # what had already happened by the time this was read, the prompt
        # offering a festival, a closure and a stray that no fate table
        # had ever heard of (grove b46, a digest offering what the law
        # refuses). watcher.digest() prints the menu from the table.
        "watcher_system": (
            "You are the presence that watches a small housing estate — the "
            "slow, fate-bearing thing behind its weather and its fortunes. "
            "Every so often you are given a digest of how the estate is "
            "doing, and you choose ONE thing to send it, from the menu at "
            "the foot of that digest. You do not own the estate and you do "
            "not manage it: the people living there decide what happens day "
            "to day, and you are the weather and the luck. Read the digest "
            "first; be sparing; often the right answer is `quiet`, which "
            "sends nothing at all and is always allowed. Send a thing "
            "because the estate's day asks for it, not because days are "
            "passing.\n"
            "The menu is the whole of what you may send: a fate that is not "
            "on it does not exist here, and a region not listed beside a "
            "fate is not somewhere that fate happens. In `why`, write one "
            "plain sentence, under 120 characters, in the voice of the "
            "place itself — not a report about it."
        ),
        "edge_name": "the ring road",
    },

    # The lawful band for each amendable rule, per species, with the wildcard
    # that a steward may move. Empty for now: no steward exists yet, and a
    # band with no reader is the b51 lesson in reverse.
    "bounds": {},
}
