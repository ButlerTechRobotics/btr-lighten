// 2D pocket layout, in the selected face's own 2D frame, in mm.
// Line-for-line port of pockets.py. Shapely calls go to GEOS (the library Shapely is built on) via shapely.js.
import { makeShapely } from "./shapely.js";

const ARC_SEGS = 16;   // segments per quarter circle when rounding

export const DEFAULTS = {
  outerWall: 3.81,      // 0.15 in
  ribWidth: 2.54,       // 0.10 in
  holeWall: 2.54,       // 0.10 in
  cellSize: 31.75,      // 1.25 in
  angle: 0.0,
  offsetX: 0.0,
  offsetY: 0.0,
  pattern: "isogrid",   // isogrid | hex | square | diamond | auto | none
  filletRadius: 1.5875, // 1/16 in  (1/8 in end mill)
  cleanup: 1.0,         // "fillet processing": removes slivers narrower than this
  minArea: 40.0,        // drop pockets smaller than this (mm^2)
  customRibs: [],       // [[x1,y1,x2,y2], ...]
  haloHoles: null,      // list of hole ids that get walls; null = all
  islandSpokes: 2,      // ribs added to tie floating hole walls in
  roundReflex: true,    // also round the pocket's outside (reflex) corners
};

const rad = (d) => (d * Math.PI) / 180;

export function makePockets(geos) {
  const { arena } = makeShapely(geos);

  // Lines covering `bounds` for the requested pattern: [{pts, closed}]
  function patternLines(kind, bounds, cell, angleDeg, ox, oy) {
    const [minx, miny, maxx, maxy] = bounds;
    const cx = (minx + maxx) / 2 + ox, cy = (miny + maxy) / 2 + oy;
    const span = Math.hypot(maxx - minx, maxy - miny) * 1.2 + cell * 2;
    const lines = [];
    const family = (thetaDeg, spacing, phase = 0) => {
      const t = rad(thetaDeg), d = [Math.cos(t), Math.sin(t)], nrm = [-d[1], d[0]];
      const n = Math.floor(span / spacing) + 2;
      for (let k = -n; k <= n; k++) {
        const off = k * spacing + phase, px = cx + nrm[0] * off, py = cy + nrm[1] * off;
        lines.push([[px - d[0] * span, py - d[1] * span], [px + d[0] * span, py + d[1] * span]]);
      }
    };
    if (kind === "isogrid") {
      const h = (cell * Math.sqrt(3)) / 2;           // equilateral triangles: line spacing = triangle height
      for (const a of [0, 60, 120]) family(angleDeg + a, h);
    } else if (kind === "square") { family(angleDeg, cell); family(angleDeg + 90, cell); }
    else if (kind === "diamond") { family(angleDeg + 45, cell); family(angleDeg + 135, cell); }
    else if (kind === "hex") lines.push(...hexGrid(cx, cy, span, cell, angleDeg, bounds));
    return lines;
  }

  // Honeycomb: `cell` is the across-flats width of each hexagon (pointy-top).
  function hexGrid(cx, cy, span, cell, angleDeg, bounds) {
    const R = cell / Math.sqrt(3), w = cell, hstep = 1.5 * R;
    const n = Math.floor(span / Math.min(w, hstep)) + 3;
    const t = rad(angleDeg), ct = Math.cos(t), st = Math.sin(t);
    const rot = (x, y) => [cx + x * ct - y * st, cy + x * st + y * ct];
    const [minx, miny, maxx, maxy] = bounds, pad = 2 * R;
    const lines = [];
    for (let row = -n; row <= n; row++) {
      const y = row * hstep, xoff = Math.abs(row % 2) === 1 ? w / 2 : 0;
      for (let col = -n; col <= n; col++) {
        const x = col * w + xoff;
        const [hx, hy] = rot(x, y);
        // Hexagons that can't reach the part are skipped (pockets.py builds them all; same result, much faster here).
        if (hx < minx - pad || hx > maxx + pad || hy < miny - pad || hy > maxy + pad) continue;
        const pts = [];
        for (let k = 0; k < 6; k++) { const a = rad(60 * k + 30); pts.push(rot(x + R * Math.cos(a), y + R * Math.sin(a))); }
        pts.push(pts[0]);
        lines.push(pts);
      }
    }
    return lines;
  }

  function computePockets(profile, params, rounded = true) {
    const p = { ...DEFAULTS };
    for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) p[k] = v;
    const A = arena();
    try {
      const warnings = [];
      let outer = A.Polygon(profile.outer);
      if (!A.isValid(outer)) outer = A.buffer(outer, 0);
      const faceArea = A.area(outer) - profile.holes.reduce((s, h) => s + h.area, 0);

      let region0 = A.buffer(outer, -p.outerWall, { join: "mitre", mitreLimit: 20.0 });
      if (A.isEmpty(region0)) {
        return { pockets: [], stats: { faceArea, removedArea: 0, pockets: 0, warnings: ["Outer wall is thicker than the part — nothing left to pocket."], autoRibs: [] } };
      }

      const haloIds = p.haloHoles;
      const keepOut = [];
      for (const h of profile.holes) {
        const haloed = haloIds === null || haloIds === undefined || haloIds.includes(h.id);
        if (haloed) keepOut.push(halo(A, h, p.holeWall));
        // un-haloed holes simply become part of the void
      }
      if (keepOut.length) region0 = A.difference(region0, A.unaryUnion(keepOut));

      // ribs
      const ribLines = [];
      const kind = p.pattern;
      if (["isogrid", "hex", "square", "diamond"].includes(kind)) {
        for (const l of patternLines(kind, A.bounds(outer), Math.max(p.cellSize, 1.0), p.angle, p.offsetX, p.offsetY)) ribLines.push(A.LineString(l));
      } else if (kind === "auto") {
        if (profile.holes.length >= 2) for (const e of A.delaunayEdges(profile.holes.map((h) => h.center))) ribLines.push(A.LineString(e));
      }
      for (const seg of p.customRibs || []) if (seg.length === 4) ribLines.push(A.LineString([[seg[0], seg[1]], [seg[2], seg[3]]]));

      const autoRibs = [];
      const ribW = p.ribWidth;
      const nSpokes = parseInt(p.islandSpokes ?? 2, 10) || 0;
      const cutRibs = (lines) => {
        if (!lines.length) return region0;
        const ribs = A.unaryUnion(lines.map((l) => A.buffer(l, ribW / 2, { cap: "flat" })));
        return A.difference(region0, ribs);
      };

      let region = cutRibs(ribLines);

      // Floating islands (a hole wall not touching any rib) would fall out of the part. Tie them in with spokes.
      for (let pass = 0; pass < 4; pass++) {
        const islands = [];
        for (const poly of A.asPolys(region)) for (const ring of A.interiors(poly)) islands.push([A.coords(A.exterior(poly)), A.coords(ring)]);
        if (!islands.length || nSpokes <= 0) break;
        const newSegs = [];
        for (const [ext, isl] of islands) newSegs.push(...spokesForIsland(A, ext, isl, nSpokes, ribW));
        if (!newSegs.length) break;
        autoRibs.push(...newSegs);
        for (const s of newSegs) ribLines.push(A.LineString([[s[0], s[1]], [s[2], s[3]]]));
        region = cutRibs(ribLines);
      }

      const pockets = [];
      let droppedIslands = 0;
      for (let poly of A.asPolys(region)) {
        const ints = A.interiors(poly);
        if (ints.length) { droppedIslands += ints.length; poly = A.Polygon(A.coords(A.exterior(poly))); }   // merge the island into the void
        const g = removeThin(A, poly, p.cleanup);
        for (const q of A.asPolys(g)) {
          if (A.area(q) < p.minArea) continue;
          if (p.filletRadius > 0) {
            const probe = A.buffer(q, -p.filletRadius * 0.999, { join: "mitre", mitreLimit: 20 });
            if (A.isEmpty(probe)) continue;
          }
          if (rounded) {
            const rq = roundCorners(A, q, p.filletRadius, p.roundReflex ?? true);
            for (const rr of A.asPolys(rq)) if (A.area(rr) >= p.minArea) pockets.push(rr);
          } else pockets.push(q);
        }
      }
      if (droppedIslands) warnings.push(`${droppedIslands} hole wall(s) could not be tied in and were merged into the void.`);

      const removedArea = pockets.reduce((s, q) => s + A.area(q), 0);
      return {
        pockets: pockets.map((q) => ({ outer: A.coords(A.exterior(q)), holes: A.interiors(q).map(A.coords) })),
        stats: { faceArea, removedArea, pockets: pockets.length, warnings, autoRibs },
      };
    } finally { A.free(); }
  }

  // Shrink/grow with mitre joins to delete features thinner than `width`.
  function removeThin(A, poly, width) {
    if (width <= 0) return poly;
    const g = A.buffer(poly, -width / 2, { join: "mitre", mitreLimit: 5.0 });
    if (A.isEmpty(g)) return g;
    return A.buffer(g, width / 2, { join: "mitre", mitreLimit: 5.0 });
  }

  // 2D fillets. Mitre in / round out gives exact arcs (radius r) on the pocket's inside corners,
  // which the STEP writer later turns back into true circular arcs.
  function roundCorners(A, poly, r, reflexToo = true) {
    if (r <= 0) return poly;
    let g = A.buffer(poly, -r, { join: "mitre", mitreLimit: 20.0 });
    if (A.isEmpty(g)) return g;
    g = A.buffer(g, r, { join: "round", quadSegs: ARC_SEGS });
    if (reflexToo && !A.isEmpty(g)) {
      let g2 = A.buffer(g, r, { join: "mitre", mitreLimit: 20.0 });
      g2 = A.buffer(g2, -r, { join: "round", quadSegs: ARC_SEGS });
      if (!A.isEmpty(g2)) g = g2;
    }
    return g;
  }

  // Exact circle for round holes (clean arcs later), polygon otherwise.
  function halo(A, h, wall) {
    if (h.circle) return A.buffer(A.Point(h.circle.cx, h.circle.cy), h.circle.r + wall, { quadSegs: ARC_SEGS });
    let hp = A.Polygon(h.points);
    if (!A.isValid(hp)) hp = A.buffer(hp, 0);
    return A.buffer(hp, wall, { join: "round", quadSegs: ARC_SEGS });
  }

  // Rib segments that tie a floating island (hole wall) back to the surrounding material.
  function spokesForIsland(A, exteriorRing, islandRing, nSpokes, ribW) {
    const [cx, cy] = A.centroid(A.Polygon(islandRing));
    const ext = A.LineString(exteriorRing);
    const samples = [];
    for (let i = 0; i < 120; i++) samples.push(A.interpolateNormalized(ext, i / 120));
    const chosen = [];
    const minSep = nSpokes > 1 ? rad(Math.max(360.0 / Math.max(nSpokes, 1) - 35.0, 60.0)) : 0.0;
    const dist = (q) => Math.hypot(q[0] - cx, q[1] - cy);
    const cands = samples.map((q, i) => [q, i]).sort((a, b) => dist(a[0]) - dist(b[0]) || a[1] - b[1]).map((a) => a[0]);   // stable, like Python's sorted
    for (const q of cands) {
      const ang = Math.atan2(q[1] - cy, q[0] - cx);
      let ok = true;
      for (const r of chosen) {
        const qa = Math.atan2(r[1] - cy, r[0] - cx);
        let m = (ang - qa + Math.PI) % (2 * Math.PI); if (m < 0) m += 2 * Math.PI;   // Python's % is never negative
        if (Math.abs(m - Math.PI) < minSep) { ok = false; break; }
      }
      if (ok) chosen.push(q);
      if (chosen.length >= nSpokes) break;
    }
    return chosen.map((q) => {
      const dx = q[0] - cx, dy = q[1] - cy, L = Math.hypot(dx, dy) || 1.0, ux = dx / L, uy = dy / L;
      return [cx, cy, q[0] + ux * ribW, q[1] + uy * ribW];   // extend past the exterior boundary so the rib bridges the gap
    });
  }

  return { computePockets };
}
