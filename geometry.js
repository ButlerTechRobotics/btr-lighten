// OpenCascade side of BTR Lighten (browser port of geometry.py).
// All geometry is handled in millimetres internally (STEP is imported as mm).

export function makeGeometry(oc) {
  const TA = oc.TopAbs_ShapeEnum;
  const PR = () => new oc.Message_ProgressRange();

  // ---------------------------------------------------------------- loading / saving
  function loadStep(bytes) {
    const path = "/in_" + Date.now() + ".step";
    oc.FS.writeFile(path, bytes);
    try {
      const reader = new oc.STEPControl_Reader();
      const status = reader.ReadFile(path);
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new UserError("Could not read STEP file. Is it a valid .step/.stp export?");
      reader.TransferRoots(PR());
      const shape = reader.OneShape();
      if (shape.IsNull()) throw new UserError("STEP file contained no geometry.");
      return shape;
    } finally { try { oc.FS.unlink(path); } catch (e) {} }
  }

  function saveStep(shape) {
    const path = "/out_" + Date.now() + ".step";
    const writer = new oc.STEPControl_Writer();
    oc.Interface_Static.SetCVal("write.step.schema", "AP214");
    writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, PR());
    const status = writer.Write(path);
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("STEP export failed.");
    const data = oc.FS.readFile(path);
    try { oc.FS.unlink(path); } catch (e) {}
    return data;
  }

  // ---------------------------------------------------------------- faces
  function faces(shape) {
    const ex = new oc.TopExp_Explorer(shape, TA.TopAbs_FACE);
    const out = [];
    while (ex.More()) { out.push(oc.TopoDS.Face(ex.Current())); ex.Next(); }
    ex.delete();
    return out;
  }

  function faceNormal(face) {
    const surf = new oc.BRepAdaptor_Surface(face, true);
    try {
      if (surf.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return { normal: null, pln: null };
      const pln = surf.Plane();
      const n = pln.Axis().Direction();
      let v = [n.X(), n.Y(), n.Z()];
      if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) v = v.map((c) => -c);
      return { normal: v, pln };
    } finally { surf.delete(); }
  }

  function faceArea(face) {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, props);
    const m = props.Mass(); props.delete(); return m;
  }
  function faceCenter(face) {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, props);
    const p = props.CentreOfMass(); const c = [p.X(), p.Y(), p.Z()];
    p.delete(); props.delete(); return c;
  }

  // Mesh the shape and return per-face triangle data for the viewer.
  function tessellate(shape, deflection = 0.05) {
    new oc.BRepMesh_IncrementalMesh(shape, deflection, false, 0.35, true);
    const positions = [], faceIds = [], facesMeta = [];
    faces(shape).forEach((face, fid) => {
      const { normal } = faceNormal(face);
      facesMeta.push({ id: fid, planar: normal !== null, area: faceArea(face), normal, center: faceCenter(face) });
      const loc = new oc.TopLoc_Location();
      const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
      if (!tri || (tri.IsNull && tri.IsNull())) { loc.delete(); return; }
      const trsf = loc.Transformation();
      const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      const nodes = [];
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p0 = tri.Node(i), p = p0.Transformed(trsf);
        nodes.push([p.X(), p.Y(), p.Z()]);
        p0.delete(); p.delete();
      }
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = tri.Triangle(i);
        let a = t.Value(1), b = t.Value(2), c = t.Value(3);
        t.delete();
        if (reversed) [b, c] = [c, b];
        for (const idx of [a, b, c]) positions.push(...nodes[idx - 1]);
        faceIds.push(fid);
      }
      loc.delete();
    });
    return { positions: new Float32Array(positions), faceIds: new Int32Array(faceIds), faces: facesMeta };
  }

  // ---------------------------------------------------------------- 2D profile of a face
  function frameForFace(face) {
    const { normal, pln } = faceNormal(face);
    if (!normal) throw new UserError("Selected face is not planar. Lightening only works on flat faces.");
    const n = new oc.gp_Dir(normal[0], normal[1], normal[2]);
    const ax = new oc.gp_Ax3(pln.Location(), n);
    const xd = ax.XDirection(), yd = ax.YDirection();
    const frame = { origin: faceCenter(face), xdir: [xd.X(), xd.Y(), xd.Z()], ydir: [yd.X(), yd.Y(), yd.Z()], normal };
    ax.delete(); n.delete();
    return frame;
  }
  const to2d = (f, p) => { const d = [p.X() - f.origin[0], p.Y() - f.origin[1], p.Z() - f.origin[2]]; return [d[0] * f.xdir[0] + d[1] * f.xdir[1] + d[2] * f.xdir[2], d[0] * f.ydir[0] + d[1] * f.ydir[1] + d[2] * f.ydir[2]]; };
  const to3d = (f, x, y, z = 0) => new oc.gp_Pnt(
    f.origin[0] + x * f.xdir[0] + y * f.ydir[0] + z * f.normal[0],
    f.origin[1] + x * f.xdir[1] + y * f.ydir[1] + z * f.normal[1],
    f.origin[2] + x * f.xdir[2] + y * f.ydir[2] + z * f.normal[2]);

  const close = (a, b, tol = 1e-4) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

  function discretizeEdge(edge, frame) {
    const curve = new oc.BRepAdaptor_Curve(edge);
    // Explicit parameter range: the short overloads are ambiguous in the JS binding and pick the wrong one.
    const disc = new oc.GCPnts_TangentialDeflection(curve, curve.FirstParameter(), curve.LastParameter(), 0.1, 0.02, 2, 1e-9, 1e-7);
    const pts = [];
    for (let i = 1; i <= disc.NbPoints(); i++) { const p = disc.Value(i); pts.push(to2d(frame, p)); p.delete(); }
    disc.delete(); curve.delete();
    if (edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) pts.reverse();
    return pts;
  }

  // Closed list of 2D points, plus circle data if the wire is a single circle.
  // (No BRepTools_WireExplorer in this build, so edges are chained by their end points.)
  function wireTo2d(wire, frame) {
    const segs = [];
    let circle = null, nEdges = 0;
    const ex = new oc.TopExp_Explorer(wire, TA.TopAbs_EDGE);
    while (ex.More()) {
      const edge = oc.TopoDS.Edge(ex.Current());
      nEdges++;
      const curve = new oc.BRepAdaptor_Curve(edge);
      if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        const circ = curve.Circle();
        circle = { c: to2d(frame, circ.Location()), r: circ.Radius() };
      }
      curve.delete();
      const s = discretizeEdge(edge, frame);
      if (s.length) segs.push(s);
      ex.Next();
    }
    ex.delete();
    // chain
    const pts = [];
    if (segs.length) {
      const left = segs.slice(1);
      pts.push(...segs[0]);
      const tol = 1e-3;
      while (left.length) {
        const end = pts[pts.length - 1];
        let k = left.findIndex((s) => close(s[0], end, tol)), rev = false;
        if (k < 0) { k = left.findIndex((s) => close(s[s.length - 1], end, tol)); rev = k >= 0; }
        if (k < 0) {   // not connected: take the nearest start
          let best = 0, bd = Infinity;
          left.forEach((s, i) => { const d = Math.hypot(s[0][0] - end[0], s[0][1] - end[1]); if (d < bd) { bd = d; best = i; } });
          k = best;
        }
        let s = left.splice(k, 1)[0];
        if (rev) s = s.slice().reverse();
        if (close(s[0], end)) s = s.slice(1);
        pts.push(...s);
      }
    }
    if (pts.length && close(pts[0], pts[pts.length - 1])) pts.pop();
    const isCircle = circle && nEdges <= 2 && pts.every(([x, y]) => Math.abs(Math.hypot(x - circle.c[0], y - circle.c[1]) - circle.r) < 1e-3 * Math.max(1, circle.r));
    return { pts, circle: isCircle ? circle : null };
  }

  const signedArea = (pts) => { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n]; a += x0 * y1 - x1 * y0; } return a / 2; };
  const centroid = (pts) => { let a = 0, cx = 0, cy = 0; for (let i = 0, n = pts.length; i < n; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n], f = x0 * y1 - x1 * y0; a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f; } return [cx / (3 * a), cy / (3 * a)]; };

  // Outer boundary, inner loops (holes), frame and through-all depth.
  function faceProfile(shape, faceId) {
    const fs = faces(shape);
    if (faceId < 0 || faceId >= fs.length) throw new UserError("Face id out of range.");
    const face = fs[faceId];
    const frame = frameForFace(face);
    const outerWire = oc.BRepTools.OuterWire(face);
    const { pts: outerPts } = wireTo2d(outerWire, frame);
    if (outerPts.length < 3) throw new UserError("Could not read the face outline.");
    if (signedArea(outerPts) < 0) outerPts.reverse();

    const holes = [];
    const ex = new oc.TopExp_Explorer(face, TA.TopAbs_WIRE);
    let hid = 0;
    while (ex.More()) {
      const w = oc.TopoDS.Wire(ex.Current());
      if (!w.IsSame(outerWire)) {
        const { pts, circle } = wireTo2d(w, frame);
        if (pts.length >= 3) {
          if (signedArea(pts) < 0) pts.reverse();
          holes.push({
            id: hid++, points: pts,
            circle: circle ? { cx: circle.c[0], cy: circle.c[1], r: circle.r } : null,
            area: Math.abs(signedArea(pts)), center: centroid(pts),
          });
        }
      }
      ex.Next();
    }
    ex.delete();
    return { faceId, frame, outer: outerPts, holes, throughDepth: throughDepth(shape, frame), area: faceArea(face) };
  }

  // Distance from the face plane to the far side of the body, measured along -normal.
  function throughDepth(shape, frame) {
    const trsf = new oc.gp_Trsf();
    const o = new oc.gp_Pnt(...frame.origin), n = new oc.gp_Dir(...frame.normal), x = new oc.gp_Dir(...frame.xdir);
    const axLocal = new oc.gp_Ax3(o, n, x);
    trsf.SetTransformation(axLocal);            // world -> local (face plane is z=0, normal is +z)
    const moved = new oc.BRepBuilderAPI_Transform(shape, trsf, true, false).Shape();
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.Add(moved, box, false);
    const zmin = box.CornerMin().Z();
    box.delete(); axLocal.delete(); trsf.delete();
    return Math.max(0, -zmin);                  // material lies on the -normal side of an outward-facing face
  }

  // ---------------------------------------------------------------- cutting pockets
  function circleFrom3(p1, p2, p3) {
    const [ax, ay] = p1, [bx, by] = p2, [cx, cy] = p3;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
  }

  // Closed polyline -> segments ["L", p0, p1] or ["A", p0, pmid, p1]. Greedy: extend a run while all its points sit on one circle.
  function fitArcs(pts, tol = 0.01, maxR = 5000) {
    const n = pts.length, segs = [];
    let i = 0;
    while (i < n) {
      let bestJ = null, j = i + 2;
      while (j <= n) {
        const run = []; for (let k = i; k <= j; k++) run.push(pts[k % n]);
        const circ = circleFrom3(run[0], run[run.length >> 1], run[run.length - 1]);
        if (!circ || circ.r > maxR || circ.r < 0.05) break;
        if (run.every(([x, y]) => Math.abs(Math.hypot(x - circ.c[0], y - circ.c[1]) - circ.r) <= tol)) { bestJ = j; j++; }
        else break;
      }
      if (bestJ !== null && bestJ - i >= 3) {
        const run = []; for (let k = i; k <= bestJ; k++) run.push(pts[k % n]);
        segs.push(["A", run[0], run[run.length >> 1], run[run.length - 1]]);
        i = bestJ;
      } else { segs.push(["L", pts[i], pts[(i + 1) % n]]); i++; }
    }
    return segs;
  }

  function lineEdge(frame, a, b, z) {
    const p = to3d(frame, a[0], a[1], z), q = to3d(frame, b[0], b[1], z);
    const e = new oc.BRepBuilderAPI_MakeEdge(p, q).Edge();
    p.delete(); q.delete(); return e;
  }

  // Closed wire from 2D points, with runs of points on a circle turned into true arcs.
  function ringToWire(ring, frame, z) {
    const mw = new oc.BRepBuilderAPI_MakeWire();
    for (const seg of fitArcs(ring)) {
      if (seg[0] === "L") {
        const [, a, b] = seg;
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue;
        mw.Add(lineEdge(frame, a, b, z));
      } else {
        const [, a, m, b] = seg;
        const pa = to3d(frame, a[0], a[1], z), pm = to3d(frame, m[0], m[1], z), pb = to3d(frame, b[0], b[1], z);
        const arc = new oc.GC_MakeArcOfCircle(pa, pm, pb);
        if (arc.IsDone()) mw.Add(new oc.BRepBuilderAPI_MakeEdge(arc.Value()).Edge());
        else mw.Add(lineEdge(frame, a, b, z));
        arc.delete(); pa.delete(); pm.delete(); pb.delete();
      }
    }
    if (!mw.IsDone()) throw new Error("Could not build a pocket outline wire.");
    const w = mw.Wire(); mw.delete(); return w;
  }

  function dedupeRing(coords, tol = 1e-5) {
    const out = [];
    for (const p of coords) if (!out.length || Math.abs(p[0] - out[out.length - 1][0]) > tol || Math.abs(p[1] - out[out.length - 1][1]) > tol) out.push([p[0], p[1]]);
    if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < tol && Math.abs(out[0][1] - out[out.length - 1][1]) < tol) out.pop();
    return out;
  }

  // Planar face (with holes) from a pocket polygon in the face frame.
  function makePocketFace(poly, frame, z) {
    const outer = dedupeRing(poly.outer);
    if (outer.length < 3) return null;
    if (signedArea(outer) < 0) outer.reverse();
    const mf = new oc.BRepBuilderAPI_MakeFace(ringToWire(outer, frame, z), true);
    for (const interior of poly.holes) {
      const ring = dedupeRing(interior);
      if (ring.length < 3) continue;
      if (signedArea(ring) > 0) ring.reverse();
      mf.Add(ringToWire(ring, frame, z));
    }
    const face = mf.Face();
    const fixer = new oc.ShapeFix_Face(face);
    fixer.Perform(PR());
    const fixed = fixer.Face();
    mf.delete();
    return fixed;
  }

  // polygons: pocket polygons (already rounded) in the face's 2D frame. Returns { shape, stats }.
  function cutPockets(shape, faceId, polygons, depth) {
    const face = faces(shape)[faceId];
    const frame = frameForFace(face);
    const eps = 0.5;   // start the cutter a little above the face so booleans are clean
    const tls = new oc.NCollection_List_TopoDS_Shape();
    let nTools = 0;
    const [nx, ny, nz] = frame.normal, L = depth + 2 * eps;
    const vec = new oc.gp_Vec(-nx * L, -ny * L, -nz * L);
    for (const poly of polygons) {
      const pface = makePocketFace(poly, frame, eps);
      if (!pface) continue;
      tls.Append(new oc.BRepPrimAPI_MakePrism(pface, vec, true, true).Shape());
      nTools++;
    }
    if (!nTools) throw new UserError("No pockets to cut with these settings.");

    const args = new oc.NCollection_List_TopoDS_Shape(); args.Append(shape);
    const cut = new oc.BRepAlgoAPI_Cut();
    cut.SetArguments(args);
    cut.SetTools(tls);
    cut.SetFuzzyValue(1e-4);
    cut.Build(PR());
    if (!cut.IsDone()) throw new UserError("Boolean cut failed. Try a larger 'clean-up' value or fewer/larger pockets.");
    let result = cut.Shape();
    const unify = new oc.ShapeUpgrade_UnifySameDomain(result, true, true, true);
    unify.Build();
    result = unify.Shape();
    return { shape: result, stats: { pockets: nTools } };
  }

  function volume(shape) {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, props);
    const m = props.Mass(); props.delete(); return m;
  }

  // A 6 in x 4 in x 1/4 in gearbox-style plate with a few holes, for trying the tool.
  function demoPlate() {
    const IN = 25.4;
    let plate = new oc.BRepPrimAPI_MakeBox(6 * IN, 4 * IN, 0.25 * IN).Shape();
    const holes = [[0.5, 0.5, 0.1], [5.5, 0.5, 0.1], [0.5, 3.5, 0.1], [5.5, 3.5, 0.1],
      [3, 2, 0.55], [1.5, 2, 0.2], [4.5, 2, 0.2], [3, 3.3, 0.15], [3, 0.7, 0.15]];
    for (const [x, y, r] of holes) {
      const ax = new oc.gp_Ax2(new oc.gp_Pnt(x * IN, y * IN, -1), new oc.gp_Dir(0, 0, 1));
      const cyl = new oc.BRepPrimAPI_MakeCylinder(ax, r * IN, 20).Shape();
      plate = new oc.BRepAlgoAPI_Cut(plate, cyl, PR()).Shape();
    }
    return plate;
  }

  return { loadStep, saveStep, tessellate, faceProfile, cutPockets, volume, demoPlate, fitArcs };
}

// Errors meant for the user (bad input), as opposed to crashes.
export class UserError extends Error {}
