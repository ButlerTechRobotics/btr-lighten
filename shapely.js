// A very small Shapely-like layer over GEOS (WebAssembly). Shapely itself is GEOS, so the pocket
// code can follow pockets.py step for step and get the same results.
// Every geometry made here is recorded in an arena; call arena.free() when a computation is done.

const JOIN = { round: 1, mitre: 2, bevel: 3 };
const CAP = { round: 1, flat: 2, square: 3 };

export function makeShapely(geos) {
  const M = geos.Module;
  const T = { POINT: 0, LINESTRING: 1, LINEARRING: 2, POLYGON: 3, MULTIPOINT: 4, MULTILINESTRING: 5, MULTIPOLYGON: 6, COLLECTION: 7 };
  const dbl = M._malloc(8);

  function arena() {
    const owned = [];
    const own = (g) => { if (!g) throw new Error("GEOS operation failed."); owned.push(g); return g; };
    const free = () => { for (const g of owned) geos.GEOSGeom_destroy(g); owned.length = 0; };

    const seq = (coords) => {
      const n = coords.length, buf = M._malloc(n * 16);
      const f = new Float64Array(n * 2);
      coords.forEach((p, i) => { f[2 * i] = p[0]; f[2 * i + 1] = p[1]; });
      M.HEAPF64.set(f, buf / 8);
      const s = geos.GEOSCoordSeq_copyFromBuffer(buf, n, 0, 0);
      M._free(buf);
      return s;
    };
    const closed = (c) => (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1]) ? [...c, c[0]] : c);
    const ptrArray = (ptrs) => { const p = M._malloc(4 * Math.max(1, ptrs.length)); M.HEAPU32.set(new Uint32Array(ptrs), p / 4); return p; };

    const Polygon = (shell, holes = []) => {
      const s = geos.GEOSGeom_createLinearRing(seq(closed(shell)));
      const hs = holes.map((h) => geos.GEOSGeom_createLinearRing(seq(closed(h))));
      const arr = hs.length ? ptrArray(hs) : 0;
      const g = geos.GEOSGeom_createPolygon(s, arr, hs.length);
      if (arr) M._free(arr);
      return own(g);
    };
    const LineString = (coords) => own(geos.GEOSGeom_createLineString(seq(coords)));
    const Point = (x, y) => own(geos.GEOSGeom_createPointFromXY(x, y));
    const collection = (type, parts) => {   // takes ownership of `parts`
      const arr = ptrArray(parts);
      const g = geos.GEOSGeom_createCollection(type, arr, parts.length);
      M._free(arr);
      return g;
    };
    const clone = (g) => geos.GEOSGeom_clone(g);
    const MultiPoint = (pts) => own(collection(T.MULTIPOINT, pts.map(([x, y]) => geos.GEOSGeom_createPointFromXY(x, y))));

    function buffer(g, dist, { join = "round", cap = "round", mitreLimit = 5.0, quadSegs = 16 } = {}) {
      const p = geos.GEOSBufferParams_create();
      geos.GEOSBufferParams_setEndCapStyle(p, CAP[cap]);
      geos.GEOSBufferParams_setJoinStyle(p, JOIN[join]);
      geos.GEOSBufferParams_setMitreLimit(p, mitreLimit);
      geos.GEOSBufferParams_setQuadrantSegments(p, quadSegs);
      const out = geos.GEOSBufferWithParams(g, p, dist);
      geos.GEOSBufferParams_destroy(p);
      return own(out);
    }
    const difference = (a, b) => own(geos.GEOSDifference(a, b));
    // unary_union of a list: copies the inputs into a collection first
    function unaryUnion(list) {
      const coll = own(collection(T.COLLECTION, list.map(clone)));
      return own(geos.GEOSUnaryUnion(coll));
    }
    const isEmpty = (g) => geos.GEOSisEmpty(g) === 1;
    const typeId = (g) => geos.GEOSGeomTypeId(g);
    const area = (g) => { geos.GEOSArea(g, dbl); return M.getValue(dbl, "double"); };
    const isValid = (g) => geos.GEOSisValid(g) === 1;
    const makeValid = (g) => own(geos.GEOSMakeValid(g));

    // children of a collection (owned by the parent: don't free them)
    const parts = (g) => { const n = geos.GEOSGetNumGeometries(g), out = []; for (let i = 0; i < n; i++) out.push(geos.GEOSGetGeometryN(g, i)); return out; };
    function asPolys(g) {
      if (isEmpty(g)) return [];
      const t = typeId(g);
      if (t === T.POLYGON) return [g];
      if (t === T.MULTIPOLYGON) return parts(g);
      if (t === T.COLLECTION) return parts(g).flatMap(asPolys);
      return [];
    }

    function seqCoords(s) {
      geos.GEOSCoordSeq_getSize(s, dbl);
      const n = M.getValue(dbl, "i32");
      if (!n) return [];
      const buf = M._malloc(n * 16);
      geos.GEOSCoordSeq_copyToBuffer(s, buf, 0, 0);
      const f = new Float64Array(M.HEAPF64.buffer, buf, n * 2), out = [];
      for (let i = 0; i < n; i++) out.push([f[2 * i], f[2 * i + 1]]);
      M._free(buf);
      return out;
    }
    const coords = (g) => seqCoords(geos.GEOSGeom_getCoordSeq(g));   // LineString / LinearRing / Point
    const exterior = (poly) => geos.GEOSGetExteriorRing(poly);          // owned by poly
    const interiors = (poly) => { const n = geos.GEOSGetNumInteriorRings(poly), out = []; for (let i = 0; i < n; i++) out.push(geos.GEOSGetInteriorRingN(poly, i)); return out; };
    function xy(pt) { const s = geos.GEOSGeom_getCoordSeq(pt); return seqCoords(s)[0]; }
    const centroid = (g) => xy(own(geos.GEOSGetCentroid(g)));
    const interpolateNormalized = (line, t) => xy(own(geos.GEOSInterpolateNormalized(line, t)));
    function bounds(g) {
      const pts = typeId(g) === T.POLYGON ? coords(exterior(g)) : coords(g);
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of pts) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
      return [minx, miny, maxx, maxy];
    }
    // Delaunay edges of a set of points, as [[x1,y1],[x2,y2]] pairs
    function delaunayEdges(pts) {
      const mp = MultiPoint(pts);
      const edges = own(geos.GEOSDelaunayTriangulation(mp, 0, 1));
      const t = typeId(edges);
      const lines = t === T.LINESTRING ? [edges] : t === T.MULTILINESTRING ? parts(edges) : [];
      return lines.map(coords);
    }

    return { Polygon, LineString, Point, MultiPoint, buffer, difference, unaryUnion, isEmpty, area, isValid, makeValid,
      asPolys, coords, exterior, interiors, centroid, interpolateNormalized, bounds, delaunayEdges, free, T };
  }
  return { arena };
}
