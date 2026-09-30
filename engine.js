// Session state and commands (browser port of app.py's HTTP endpoints).
import { makeGeometry, UserError } from "./geometry.js";
import { makePockets } from "./pockets.js";

const CAD_ONLY = [".sldprt", ".sldasm", ".x_t", ".x_b", ".ipt", ".f3d"];

export function makeEngine(oc, geos) {
  const G = makeGeometry(oc);
  const { computePockets } = makePockets(geos);
  const S = { filename: null, base: null, result: null, mesh: null, profiles: new Map(), baseVolume: 0, originalVolume: 0 };
  const reset = () => { S.filename = null; S.base = null; S.result = null; S.mesh = null; S.profiles = new Map(); S.baseVolume = 0; S.originalVolume = 0; };
  const profileFor = (fid) => { let p = S.profiles.get(fid); if (!p) { p = G.faceProfile(S.base, fid); S.profiles.set(fid, p); } return p; };

  const commands = {
    load({ name, bytes }) {
      const ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      if (CAD_ONLY.includes(ext)) throw new UserError("SolidWorks/Parasolid files can't be read outside SolidWorks. In SolidWorks use File > Save As > STEP AP214 (*.step), then load that.");
      if (ext !== ".step" && ext !== ".stp") throw new UserError("Please load a .step or .stp file.");
      const shape = G.loadStep(new Uint8Array(bytes));
      reset();
      S.filename = name; S.base = shape;
      S.originalVolume = S.baseVolume = G.volume(shape);
      S.mesh = G.tessellate(shape);
      return { filename: name, mesh: S.mesh };
    },
    testPart() {
      reset();
      S.filename = "demo_gearbox_plate.step";
      S.base = G.demoPlate();
      S.originalVolume = S.baseVolume = G.volume(S.base);
      S.mesh = G.tessellate(S.base);
      return { filename: S.filename, mesh: S.mesh };
    },
    face({ faceId }) {
      if (!S.base) throw new UserError("Load a STEP file first.");
      const prof = G.faceProfile(S.base, faceId);
      S.profiles.set(faceId, prof);
      return prof;
    },
    preview({ faceId, params }) {
      const { pockets, stats } = computePockets(profileFor(faceId), params);
      return { pockets, stats };
    },
    generate({ faceId, params, depth }) {
      if (!S.base) throw new UserError("Load a STEP file first.");
      const prof = profileFor(faceId);
      const { pockets, stats } = computePockets(prof, params);
      if (!pockets.length) throw new UserError("No pockets to cut with these settings — try thinner walls or a larger cell size.");
      const d = depth ? Number(depth) : prof.throughDepth;
      const { shape, stats: cstats } = G.cutPockets(S.base, faceId, pockets, d);
      S.result = shape;
      const mesh = G.tessellate(shape);
      const v = G.volume(shape);
      return { mesh, stats: { ...stats, ...cstats, volumeBefore: S.baseVolume, volumeAfter: v, volumeOriginal: S.originalVolume } };
    },
    keep() {
      if (!S.result) throw new UserError("Nothing to keep yet — generate first.");
      S.base = S.result; S.result = null;
      S.baseVolume = G.volume(S.base);
      S.mesh = G.tessellate(S.base);
      S.profiles = new Map();
      return { mesh: S.mesh };
    },
    discard() { S.result = null; return { mesh: S.mesh }; },
    exportStep() {
      const shape = S.result || S.base;
      if (!shape) throw new UserError("Nothing to export.");
      const base = (S.filename || "part").replace(/\.[^.]+$/, "");
      return { name: `${base}_lightened.step`, bytes: G.saveStep(shape) };
    },
  };
  return { commands, UserError };
}
