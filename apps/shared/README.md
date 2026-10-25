# apps/shared

Code more than one app uses, kept once.

## page3d/

What the estate's and the grove's 3D views share. Each app's server serves
its own `page3d/` first and this folder second, both under `/3d/`, so a
page names every file the same way whichever folder it lives in.

| file | role |
|---|---|
| `vendor/` | Three.js r170 (`three.module.min.js`, `OrbitControls.js`) and its licence |
| `clock.js` | the day clock: a continuous day fraction paced to the server's tick, its five phases, and the light at any moment (`Page3DClock`) |
| `walk.js` | the router: a walk grid, A* round solids, and a route sampled by distance (`Page3DWalk`) |
| `field.js` | the light-field painter: a server's 0..9 per-cell field painted into one soft canvas (`Page3DField`) |

All three scripts are classic scripts that publish one global, so they load
in the page and in the apps' Node checks alike. Nothing here reads a world:
the apps hand them plain numbers.
