// The ghost memo must be invisible: same pose, same shape, no freed buffers.
//
// Built on the same Object.create(prototype) trick the river-mode tests use —
// ModularRoadBuilder's constructor wants a renderer, a DOM element and orbit
// controls, none of which exist here, and none of which refreshGhost touches.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

// Count disposals so a double-free or a leak is visible rather than latent.
const freed = new Map();
const realDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () {
  freed.set(this, (freed.get(this) ?? 0) + 1);
  return realDispose.call(this);
};

/** A builder with only the fields refreshGhost + the memo actually read. */
function makeBuilder(pieceId = "straight") {
  const b = Object.create(ModularRoadBuilder.prototype);
  b.activePieceId = pieceId;
  b.activeParams = { ...KIT.pieceParams };
  b.currentConnector = KIT.initialConnector();
  b._gizmoTarget = "chain";
  b.ghostDetached = false;
  b.ghostEnd = "tail";
  b._localXfCache = new Map();
  b._ghostGeoCache = new Map();
  b._ghostOrphanGeo = null;
  b._ghostPlaceholderGeo = new THREE.BufferGeometry();
  b.ghost = new THREE.Mesh(b._ghostPlaceholderGeo, new THREE.MeshBasicMaterial());
  b.ghost.matrixAutoUpdate = false;
  b.isBuildMode = () => true;
  return b;
}

// ── 1. The pose is identical to what a full buildPiece would have produced ──
{
  let worstPos = 0, worstAll = 0, worstVerts = 0;
  for (const def of KIT.PIECE_CATALOG) {
    const b = makeBuilder(def.id);
    for (const [x, y, z, yaw] of [[0, 0, 0, 0], [37, 5, -12, 1.1], [-90, -3, 44, -2.4]]) {
      b.currentConnector = new THREE.Matrix4()
        .makeRotationY(yaw).setPosition(x, y, z);
      let ref;
      try {
        ref = KIT.buildPiece(def.id, b.currentConnector, b.activeParams,
          undefined, undefined, KIT.guardrailParams.enabled);
      } catch { continue; }
      b.refreshGhost();
      for (let i = 0; i < 16; i++) {
        worstAll = Math.max(worstAll, Math.abs(b.ghost.matrix.elements[i] - ref.world.elements[i]));
      }
      worstPos = Math.max(worstPos,
        Math.hypot(b.ghost.matrix.elements[12] - ref.world.elements[12],
          b.ghost.matrix.elements[13] - ref.world.elements[13],
          b.ghost.matrix.elements[14] - ref.world.elements[14]));
      const gv = b.ghost.geometry.getAttribute("position")?.count ?? 0;
      const rv = ref.geometry.getAttribute("position")?.count ?? 0;
      worstVerts = Math.max(worstVerts, Math.abs(gv - rv));
    }
  }
  check("ghost world matrix matches a full buildPiece", worstAll < 1e-9,
    `max element error ${worstAll.toExponential(2)}, max position error ${worstPos.toExponential(2)} m`);
  check("ghost geometry matches a full buildPiece", worstVerts === 0);
}

// ── 2. Moving the ghost reuses the buffer (the drag case) ───────────────────
{
  const b = makeBuilder("loop");
  b.refreshGhost();
  const first = b.ghost.geometry;
  for (let i = 0; i < 120; i++) {
    b.currentConnector = new THREE.Matrix4().setPosition(i * 0.1, 0, 0);
    b.refreshGhost();
  }
  check("120 drag frames reuse ONE geometry", b.ghost.geometry === first);
  check("120 drag frames free nothing", (freed.get(first) ?? 0) === 0);
  check("cache holds exactly one entry for one shape", b._ghostGeoCache.size === 1);
}

// ── 3. Switching shape caches both, and switching back is a hit ─────────────
{
  const b = makeBuilder("straight");
  b.refreshGhost();
  const straight = b.ghost.geometry;
  b.activePieceId = "curve";
  b.refreshGhost();
  const curve = b.ghost.geometry;
  b.activePieceId = "straight";
  b.refreshGhost();
  check("switching back hits the cache", b.ghost.geometry === straight);
  check("both shapes retained", b._ghostGeoCache.size === 2 && curve !== straight);
  check("nothing freed while cached", (freed.get(straight) ?? 0) === 0 && (freed.get(curve) ?? 0) === 0);
}

// ── 4. In-place param mutation must NOT be served a stale shape ─────────────
//     (toggleCurveDirection writes activeParams.curveDir directly, which is why
//      the key is JSON.stringify and not object identity.)
{
  const b = makeBuilder("curve");
  b.refreshGhost();
  const before = b.ghost.geometry;
  b.activeParams.curveDir = b.activeParams.curveDir >= 0 ? -1 : 1;
  b.refreshGhost();
  check("in-place curveDir flip rebuilds the ghost", b.ghost.geometry !== before);
}

// ── 5. Invalidation: a global param change must not be served a stale shape ─
{
  const b = makeBuilder("straight");
  b.refreshGhost();
  const before = b.ghost.geometry;
  const beforeVerts = before.getAttribute("position").count;

  const savedWidth = KIT.roadParams.width;
  KIT.roadParams.width = savedWidth * 2;
  b._invalidateShapeCaches();   // what rebuildAll({reuse:false}) does
  b.refreshGhost();

  check("global width change rebuilds the ghost", b.ghost.geometry !== before);
  // The orphan is released at the END of that same refresh — by then the ghost
  // has already been repointed, so holding it any longer would just be a leak.
  check("orphan freed exactly once, after the ghost was repointed",
    (freed.get(before) ?? 0) === 1);
  // ...and not again on subsequent refreshes.
  b.refreshGhost();
  b.refreshGhost();
  check("orphan not freed twice", (freed.get(before) ?? 0) === 1);

  // Eviction DURING a refresh (the size cap trips on the miss branch) must not
  // leave a stale orphan pointer behind for the next call to free again.
  const live = b.ghost.geometry;
  b._evictGhostGeoCache();          // parks `live`
  b._ghostGeoCache.set("junk", { geometry: new THREE.BufferGeometry(), fromConn: new THREE.Matrix4() });
  b.activePieceId = "curve";
  b.refreshGhost();                 // miss + orphan release in one call
  b.refreshGhost();
  b.refreshGhost();
  check("eviction mid-refresh frees the orphan once", (freed.get(live) ?? 0) === 1);
  check("no stale orphan pointer left", b._ghostOrphanGeo === null);
  b.activePieceId = "straight";

  KIT.roadParams.width = savedWidth;
  b._invalidateShapeCaches();
  b.refreshGhost();
  check("restoring width restores the original vertex count",
    b.ghost.geometry.getAttribute("position").count === beforeVerts);
}

// ── 6. Eviction never frees what is on screen ──────────────────────────────
{
  const b = makeBuilder("straight");
  const shapes = KIT.PIECE_CATALOG.slice(0, 40).map((d) => d.id);
  for (const id of shapes) { b.activePieceId = id; b.refreshGhost(); }
  check("cache stays bounded past its limit", b._ghostGeoCache.size <= 33,
    `size ${b._ghostGeoCache.size}`);
  check("the on-screen geometry survived eviction",
    (freed.get(b.ghost.geometry) ?? 0) === 0);
  check("no geometry was freed twice", [...freed.values()].every((n) => n <= 1));
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
