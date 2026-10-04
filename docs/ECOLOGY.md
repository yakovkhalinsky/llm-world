# Grove — how the biome's mechanics work

> A field guide to the living engine: what makes the forest grow, what
> feeds the animals, and which four handshakes keep the web from
> collapsing. All of it lives in `grove/sim.py` (the tick), `grove/gen.py`
> (birth) and `grove/world.py` (the species tables); every number here is
> a knob in `grove/rules.py` and gated by `tools/balance.py`.
> Written 2026-10-04 against the ruleset as it stands.

## Birth: worldgen

Three smoothed **value-noise octaves** (coarse 6-cell grids, bilinearly
upsampled with fine jitter, 1/n amplitude stacking) draw three maps:
elevation, fertility, wetness. Elevation's quantiles decide the terrain —
the lowest slice becomes **water** (the pond, in the lowest basin), the
top slice **rock**, the rest soil. Moisture starts from the wet noise,
then gains a bonus within Manhattan-2 of water: the pond's edge is
permanently lush.

The initial forest plants where moisture and fertility clear thresholds —
pine and birch in equal measure, at random ages spread across their life
stages, so the world does not start as a monoculture of saplings.
Willows ring the pond (`near_water`); berries take bare spots by
fertility; **ferns take only shade** — seeded after the first shading is
computed, where the young canopy's light falls under 0.55. Animals
scatter on land per the founding table (rabbit 26, deer 8, fox 4, owl 3,
robin 14, boar 5); up to six founding souls receive their names from the
resident pool.

The world is handed over **at the close of week 1** — a fresh grove's
history begins mid-stride.

## A week in the grove (the tick order)

1. Week counter; a season turn triggers the **robin migration** and
   clears the season's namings; the naming budget refills at the tick's
   end, every week.
2. The **queued operator effect** lands — the soul speaks at tick
   boundaries, validated then applied deterministically.
3. Weather rolls with persistence: rain soaks one week, storms two
   (natural storms are autumnal rarities; the soul can invite one
   anywhere), winter is all frost. The **sky remembers**: consecutive
   wet weeks build a wet-streak whose soak bonus feeds grass regrowth
   and mushrooms — wet seasons are fat seasons.
4. **Light** is rebuilt from the canopy before anything reads it: a
   mature tree shades its own cell and neighbors in two strengths
   (`shade_self`/`shade_adjacent`), saplings shade lighter.
5. **Cells**: rain/storm raise moisture, a seasonal decay drains it,
   droughts bleed regionally. Grass regrows as season × moisture × light
   (needs moisture > 0.12 and light > 0.30 — a closed canopy starves the
   floor); frost shaves it 7%/week. **Mushrooms** boom after rain on
   grassy or humus-rich cells (humus multiplies the bloom 2.5×) and last
   three weeks. Carcasses decay on a timer.
6. **Plants** age through seed → sapling → mature → old → log. HP is the
   currency — blight burns 1.2/week (1.6 on ferns and birch), drought
   0.5/week on dry cells, frost by `frost_hp`, ferns scorch in full sun.
   The unwounded heal on moisture, with a humus bonus: **a dead trunk
   feeds the ground beneath it for the next tree**. Weather wounds fall
   trees by stage in storms; death names the pressure that bit it.
7. **Animals** drain hunger (heavier in winter), forage, hunt, flee,
   breed, age and starve. Old age and starvation leave a **carcass**;
   predation doesn't — the prey is eaten.
8. The seed bank settles itself: 0.5% of its memory decays every fourth
   week.
9. **Destiny checks** resolve the soul's watches (water-adjacent, or a
   creature grown old); a death ends the watch unheard.
10. **Recolonization**: a base resident absent 16+ weeks returns in a
    small group from beyond the edge.

## The plant economy

Six species, one loop. **Seed rain**: three tries within `seed_radius`; a
landing must find bare soil, respect the **one-tree-per-cell** rule, and
the pocket rule — at most **two understory per cell**. A shade-tolerant
seed may still try under an existing canopy, but rarely takes. Every
failed landing — shaded, crowded, on water — goes to the **seed bank**
(capped at 90), never consumed: when a species falls below
`germinate_min_alive` (3 alive), autumn lets the bank speak — 3–8 seeds
sprout into **enumerated suitable spots** (real light, water and crowding
checks, no gambling). The bank only loses mass to its own decay.

Ferns spread by spores (twice per mature fern, neighbors only, failures
banked); berry bushes fruit once each spring and **root-sucker** clones
next door. The pond's willows are anchored: their seedlings cannot leave
the water's ring.

Succession is the shape: **birch** is the pioneer that opens ground,
**pine** is slow and shade-tolerant and wins it in the end, **willow**
holds the shore, fern holds the shade, berry holds the sun's edges.

## The animal economy

Everyone spends hunger weekly (×1.4 in winter); over 9, hp bleeds. One
meal restores −7 hunger, +2 energy, +0.6 hp.

| soul | its week |
|---|---|
| **rabbit** | grazes when the grass reads 0.12+, else walks toward grass; the only fleeing animal — within 3 cells of a fox or wolf it scatters four cells away. It never flees owls. |
| **deer** | grazes, but when truly hungry browses **tree saplings** (−1.5 hp) — the forest's pruning hand; it never touches ferns or bushes |
| **robin** | berries first (the bush loses its berries and 1 hp), then mushrooms (cleared), then a nibble of grass |
| **boar** | the scavenger: mushrooms → carrion → grass, in that order — the *humus → mushroom → boar* chain is how a dead tree feeds pigs two winters later |
| **fox** | pursuit: senses a rabbit within its scan, walks to it, pounces from a cell's distance (50%) |
| **owl** | ambush: nothing until hunger > 4, then any rabbit within its strike range has a flat weekly chance — no chase, no density feedback, no fleeing possible |
| **wolf** (visitor) | the fox loop, plus a chance at a stag when starving |

**Breeding** is the energy cycle: not starving, energy enough, in the
breeding seasons and under the **soft cap** → a two-week pregnancy → a
litter beside the mother, the kids joining the name pool (the voice
names them one at a time; the pool holds eight).

**The density governor** (`sim._behave`): a chaser's kill chance scales
with the world's prey population over its `hunting_density_scale`,
clamped into `[hunt_prob_min, 1.0]` — a thin warren makes every fox miss
more. This is the boom-bust loop that keeps a prey collapse from
cascading. At a 24×24 world, global density ≈ local density, so the
governor reads the true warren.

## The four safety nets

1. **Soft caps** — no breeding above a species' `cap`; the cap, not the
   food, is what holds boars at five.
2. **Density-dependent hunting** (chasers; the owl's ambush is capped by
   its own flat chance and its hunger gate).
3. **The seed bank** — plants can never be lost forever.
4. **Recolonization** — base residents only; visitors are transient by
   design and can never return on their own.

Plus the **robins' covenant**: leave at the frost, return in spring
three springs in four, at least half the flock that left.

## The measured equilibrium

From the gate (8 seeds × ~19 years, pure engine): every world ends with
rabbits 24–26 (at cap), deer 10 (at cap), fox 5–6, owl 2–3, boar 5
(pinned), robin 14 (returned), and a canopy of pine 369–453 with birch
140–235 — pine wins late succession, birch persists as the
gap-opportunist. Ferns hold roughly 230–350 understory pockets.
Recolonization fires 20–29 times per run: the nets are in use, not
decoration.

## The tensions worth knowing (characteristics, not bugs)

- **The density governor is world-wide**, not warren-local — honest at
  a 24×24 biome; if the world ever grows, local pockets could collapse
  independently.
- **Owl ambush has no density feedback** and no prey flight — its
  pressure is bounded only by `strike_prob` and the hunger gate.
- **Deer prune only tree saplings** — nothing grazes ferns or bushes;
  the understory's only hand is the robin's pruning of berries.
- **Berries fruit one week a year** — a glade's spring moment is the
  whole year's fruit.
- **Boars live pinned at their cap** on every seed — to make them
  boom-bust, tune their `cap`, not their food.

These are the places the World Soul could later act meaningfully: the
governor, the ambush, the glade's spring, the boar's ceiling.