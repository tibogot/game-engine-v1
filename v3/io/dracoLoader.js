/**
 * THE ONE PLACE DRACO IS CONFIGURED.
 *
 * There were three, and they disagreed. `windmill.js` pulled the decoder from
 * jsdelivr (three@0.184), `foliage/glbLoader.js` from gstatic (Draco 1.5.7),
 * and `octahedral-v3.js` from gstatic again — so a single page load fetched
 * two complete decoder builds from two third-party origins, and the game
 * stalled on both if either CDN was slow. glbLoader also asked for
 * `{ type: "js" }`, which is a different 719 kB build again, so unifying the
 * ORIGIN alone would still have downloaded two decoders.
 *
 * Now: one decoder, served from `/draco/`, vendored from the three version
 * this project actually has installed. That is byte-identical to what jsdelivr
 * was serving (both three 0.184.0), so the windmill's decode path does not
 * change at all; the foliage and octahedral paths move from Draco 1.5.7 to
 * three 0.184's build, which reads the same bitstream — Draco decoders are
 * backward compatible, that is the point of a versioned bitstream.
 *
 * WASM, NOT THE JS BUILD. `type: "js"` is 719 kB against 345 kB and decodes
 * several times slower, and it carried no comment saying why. The windmill has
 * always used WASM successfully on the same page as the foliage loader, so
 * WASM working here is observed rather than assumed.
 *
 * The path is ABSOLUTE. Some v3 pages set `<base href="/v3/">`, which rewrites
 * relative URLs but leaves a leading slash alone.
 *
 * Vendored rather than CDN so a boot cannot stall on a third party, and so the
 * decoder can never drift out of step with the installed three.
 */
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

/** Where the decoder lives. `public/draco/` is served at the site root. */
export const DRACO_PATH = "/draco/";

let _shared = null;

/**
 * The shared DRACOLoader.
 *
 * One instance, because each one spins up its own worker pool and decoder
 * module; three of them meant three copies of a 285 kB WASM module in memory.
 * Callers hand it to `GLTFLoader.setDRACOLoader()`, which does not take
 * ownership, so sharing is safe.
 */
export function getDracoLoader() {
  if (_shared) return _shared;
  _shared = new DRACOLoader();
  _shared.setDecoderPath(DRACO_PATH);
  return _shared;
}

/**
 * Attach Draco decoding to a GLTFLoader. Returns the same loader, so it can be
 * used inline: `setupDraco(new GLTFLoader())`.
 */
export function setupDraco(gltfLoader) {
  gltfLoader.setDRACOLoader(getDracoLoader());
  return gltfLoader;
}
