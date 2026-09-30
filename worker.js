// Runs the CAD kernel off the main thread so the page stays responsive while it cuts.
import init from "./vendor/replicad_single.js";
import initGeos from "./vendor/geos.js";
import { makeEngine } from "./engine.js";

const ready = Promise.all([
  init({ locateFile: (f) => new URL("./vendor/" + f, import.meta.url).href }),
  initGeos(),
]).then(([oc, geos]) => makeEngine(oc, geos));

ready.then(() => postMessage({ type: "ready" }), (err) => postMessage({ type: "fatal", error: String(err && err.message || err) }));

onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  let engine;
  try { engine = await ready; } catch (err) { postMessage({ id, error: "The geometry engine failed to load: " + (err && err.message || err) }); return; }
  try {
    const data = engine.commands[cmd](args || {});
    const transfer = data && data.bytes ? [data.bytes.buffer] : [];   // meshes are copied: the engine keeps its own
    postMessage({ id, data }, transfer);
  } catch (err) {
    const user = err instanceof engine.UserError;
    let msg = err && err.message ? err.message : String(err);
    if (typeof err === "number") msg = "OpenCascade error " + err;
    postMessage({ id, error: user ? msg : `${(err && err.name) || "Error"}: ${msg}`, user });
    if (!user) console.error(err);
  }
};
