# BTR Lighten

Pocket and isogrid lightening for flat plates, for **Butler Tech Robotics** (FRC 144 and FRC 325). It does what the Onshape *Lighten / Part Lighten / Enlighten* scripts do, without Onshape.

**STEP in → pick a face → set walls and a rib pattern (or draw your own ribs) → STEP out.**

**Open it:** https://butlertechrobotics.github.io/btr-lighten/

It runs in the browser (Chrome, Edge, Firefox or Safari, Chromebooks included). There's nothing to install and no account. Your part never leaves your laptop: the CAD engine runs inside the page. The first visit downloads the engine (about 25 MB); after that it opens straight away.

## Round trip with SolidWorks

1. SolidWorks: `File > Save As > STEP AP214 (*.step)`
2. Lighten: **Open STEP**, click the face, tune, **Generate**, **Export STEP**
3. SolidWorks: `Insert > Features > Imported` (or `File > Open` the STEP)

`.sldprt` files can only be opened by SolidWorks, so always export STEP first.

## Using it

**1. Pick the face.** Click a flat face in the 3D view. The app reads its outline and every hole and measures the material behind it: that's the through-all depth.

**2. Walls** (defaults in inches):

| Setting | Default | Meaning |
|---|---|---|
| Outer wall | 0.150 | material left around the outside edge |
| Rib width | 0.100 | width of every rib |
| Hole wall | 0.100 | ring left around each hole |
| Corner radius | 0.0625 | inside-corner radius of each pocket; use half your end-mill diameter |
| Round outside corners too | on | also rounds the pocket's reflex corners |

**3. Rib pattern.** Isogrid (triangles), Honeycomb, Square, Diamond, *Connect holes* (ribs run between hole centers, like Lighten), or *Custom ribs only*. Cell size, angle and X/Y shift preview live in the Sketch tab.

**4. Sketch tab.**
- *Select holes*: click a hole to drop its wall so the hole opens into the pocket. Click again to restore it.
- *Draw rib* (`R`): click start, click end. Snaps to hole centers; hold Shift for 15° angles; Shift-click to chain ribs. `Esc` cancels.
- *Erase rib* (`E`): click a rib.
- Scroll to zoom, right- or middle-drag to pan.

A hole wall that touches no rib would fall out of the part, so those get automatic tie-in spokes (blue dashed). *Tie-in ribs per floating hole* sets how many (0 merges the hole into the pocket instead).

**5. Clean-up.** *Min feature* drops slivers narrower than that width (Enlighten's "fillet processing"). *Min pocket area* drops tiny pockets.

**6. Depth.** *Through all* by default. *Set depth* leaves a floor.

**Generate** cuts the part and shows it in 3D with the mass reduction. **Undo** goes back. **Keep & do another face** commits the cut so you can pocket a second face. **Export STEP** downloads `<name>_lightened.step`. Pocket arcs are written as true circles, so the STEP is clean in SolidWorks and CAM.

## Limits

- Flat (planar) faces only, same as the Onshape scripts.
- *Through all* cuts everything behind the face, including bosses on the far side. Use *Set depth* for those, or pocket from the other side.
- Non-round holes (slots, hex) work but get polygon walls; round holes get exact rings.
- One part at a time; export assemblies as single parts.

## Feedback

Click **Feedback** in the app. It opens the team Google Form with your note filled in (the form's "App details" line says it came from Lighten); press **Submit** there.

## How it works

Version 1 was *Lighten Desktop*: a Python program (OpenCascade through `cadquery-ocp`, plus Shapely) that ran a local web server. Version 2 runs the same engines as WebAssembly inside the page:

| File | What it does |
|---|---|
| `index.html`, `app.js` | the page: 3D viewer (three.js), sketch editor, settings |
| `worker.js` | runs the geometry engine in the background so the page stays responsive |
| `engine.js` | load / face / preview / generate / keep / export commands |
| `geometry.js` | STEP read and write, meshing, face outlines, the pocket cut (OpenCascade) |
| `pockets.js` | 2D pocket layout: walls, halos, rib patterns, custom ribs, tie-ins, rounding |
| `shapely.js` | a small Shapely-style layer over GEOS, so `pockets.js` follows the original Python step for step |
| `vendor/` | three.js, OpenCascade (replicad build) and GEOS, unchanged |

The port was checked against the Python version on the demo plate: every pattern gives the same pocket count and removed area, and the cut part has the same volume and the same STEP arc count.

To update the site, replace the files and commit; GitHub Pages republishes in about a minute. Bump `APP_VERSION` in `app.js` for each release.

## Licenses

- OpenCascade Technology: LGPL 2.1 with the OCCT exception (via [replicad-opencascadejs](https://github.com/sgenoud/replicad))
- GEOS: LGPL 2.1 (via [geos-wasm](https://github.com/chrispahm/geos-wasm))
- three.js: MIT
