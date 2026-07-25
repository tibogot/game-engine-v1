// Free anchor rotation: a chain anchor may carry pitch/roll, every piece inherits
// it rigidly, and the orientation round-trips through select/save. Headless.
//
// The real gizmo only edits the anchor when its target is "chain" (an empty
// chain, or after selectChain) — riding the ghost is yaw-only by design. So the
// test grabs the chain before tilting, exactly as the UI does.
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(pathToFileURL(join(ROOT,"games/modular-road-v3/modularRoadBuilder.js")).href);

let fail=0; const check=(n,c,d="")=>{console.log(`${c?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`);if(!c)fail++;};
const R2D = THREE.MathUtils.radToDeg;

/** Minimal TransformControls stand-in — the builder only uses these members. */
function fakeGizmo() {
  return {
    visible:false, enabled:false, mode:"translate", dragging:true /* these fixtures simulate DRAGS */, axis:null,
    showX:true, showY:true, showZ:true,
    setMode(m){ this.mode = m; }, setSpace(){}, setSize(){},
    attach(){ this.object = arguments[0]; }, detach(){ this.object = null; },
    getHelper(){ return new THREE.Object3D(); },
    addEventListener(){}, removeEventListener(){},
  };
}
function fresh() {
  const b = new ModularRoadBuilder({
    scene:new THREE.Scene(), material:new THREE.MeshBasicMaterial(),
    railMaterial:new THREE.MeshBasicMaterial(), shellMaterial:new THREE.MeshBasicMaterial(),
    decorMaterial:new THREE.MeshBasicMaterial(),
  });
  b.snapEnabled = false;
  b.placementGizmo = fakeGizmo();
  return b;
}
/** Tilt the ACTIVE anchor: select the chain (target=chain), rotate the pivot,
 *  fire the change hook — the path a real gizmo drag takes. */
function tiltActiveAnchor(b, pitchDeg, rollDeg, yawDeg=0) {
  b.placementGizmo.mode = "rotate";
  b.placementGizmo.visible = true;
  b._gizmoTarget = "chain";
  const e = new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), THREE.MathUtils.degToRad(rollDeg), "YXZ");
  b.placementPivot.quaternion.setFromEuler(e);
  b._onPlacementGizmoChange();
}
const upOf  = (m)=>{ const e=m.elements; return new THREE.Vector3(e[4],e[5],e[6]); };
const fwdOf = (m)=>{ const e=m.elements; return new THREE.Vector3(-e[8],-e[9],-e[10]); };
function connected(b, chainId=0) {
  const ps=b.pieces.filter(p=>p.chainId===chainId); const a=new THREE.Vector3(),c=new THREE.Vector3();
  for(let i=1;i<ps.length;i++){a.setFromMatrixPosition(ps[i-1].connectorOut);c.setFromMatrixPosition(ps[i].connectorIn);if(a.distanceTo(c)>1e-6)return false;}
  return true;
}

{
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 0);
  for(let i=0;i<3;i++){ b.setActivePiece("straight"); b.place(); }
  const up = upOf(b.pieces[0].connectorIn);
  check("level baseline: pieces point +Y", Math.abs(up.y-1)<1e-6, `up.y ${up.y.toFixed(4)}`);
}
{
  // PITCH down 20°.
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 0);
  for(let i=0;i<3;i++){ b.setActivePiece("straight"); b.place(); }
  b.selectChain(b.activeChainId);
  tiltActiveAnchor(b, -20, 0);
  const t = b.anchorTiltDeg();
  check("anchor reports the pitch", Math.abs(t.pitch+20)<1e-4 && Math.abs(t.roll)<1e-4, `pitch ${t.pitch.toFixed(1)} roll ${t.roll.toFixed(1)}`);
  check("pitched strip travels downhill", fwdOf(b.pieces[0].connectorIn).y < -0.2, `fwd.y ${fwdOf(b.pieces[0].connectorIn).y.toFixed(3)}`);
  check("every piece inherits the same tilt", upOf(b.pieces[0].connectorIn).distanceTo(upOf(b.pieces[2].connectorIn)) < 1e-6);
  check("pitched chain stays connected", connected(b, b.activeChainId));
}
{
  // ROLL 15° → banked.
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 0);
  b.setActivePiece("straight"); b.place();
  b.selectChain(b.activeChainId);
  tiltActiveAnchor(b, 0, 15);
  const up = upOf(b.pieces[0].connectorIn);
  check("rolled anchor banks the strip sideways", Math.abs(up.x) > 0.2, `up.x ${up.x.toFixed(3)} up.y ${up.y.toFixed(3)}`);
  check("anchor reports the roll", Math.abs(b.anchorTiltDeg().roll-15)<1e-4, `roll ${b.anchorTiltDeg().roll.toFixed(1)}`);
}
{
  // ROUND-TRIP through selectChain.
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 30*Math.PI/180);
  b.setActivePiece("straight"); b.place();
  b.selectChain(b.activeChainId);
  tiltActiveAnchor(b, -12, 8, 30);
  const before = b._freeQuat.clone();
  const tiltedId = b.activeChainId;
  b.beginNewChain(new THREE.Vector3(50,40,0), 0); // switch away (new chain)
  b.selectChain(tiltedId);                        // ...and back to the tilted one
  check("selectChain restores the tilt", b._freeQuat.angleTo(before) < 1e-4, `angle ${R2D(b._freeQuat.angleTo(before)).toFixed(3)}°`);
  check("re-selected chain still connected + tilted", connected(b, b.activeChainId) && Math.abs(b.anchorTiltDeg().pitch+12)<0.5);
}
{
  // Q/E yaw PRESERVES tilt.
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 0);
  b.setActivePiece("straight"); b.place();
  b.selectChain(b.activeChainId);
  tiltActiveAnchor(b, -20, 10);
  const a = b.anchorTiltDeg();
  b.rotateFreeYaw(15*Math.PI/180);
  const c = b.anchorTiltDeg();
  check("Q/E yaw keeps pitch/roll", Math.abs(a.pitch-c.pitch)<0.5 && Math.abs(a.roll-c.roll)<0.5,
    `pitch ${a.pitch.toFixed(1)}->${c.pitch.toFixed(1)} roll ${a.roll.toFixed(1)}->${c.roll.toFixed(1)}`);
}
{
  // levelAnchor resets tilt, keeps yaw + connection.
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 45*Math.PI/180);
  for(let i=0;i<2;i++){ b.setActivePiece("straight"); b.place(); }
  b.selectChain(b.activeChainId);
  tiltActiveAnchor(b, -20, 12, 45);
  b.levelAnchor();
  const t = b.anchorTiltDeg();
  check("levelAnchor zeroes pitch/roll", Math.abs(t.pitch)<1e-4 && Math.abs(t.roll)<1e-4, `pitch ${t.pitch.toFixed(2)} roll ${t.roll.toFixed(2)}`);
  check("levelAnchor restores +Y up + connection", Math.abs(upOf(b.pieces[0].connectorIn).y-1)<1e-6 && connected(b, b.activeChainId));
}
{
  // The NEXT-PIECE (ghost) gizmo must stay yaw-only — a rolled pivot on the ghost
  // must not tilt anything.
  const b = fresh();
  b.beginNewChain(new THREE.Vector3(0,40,0), 0);
  b.setActivePiece("straight"); b.place(); // now target = ghost
  b._gizmoTarget = "ghost"; b.ghostDetached = true;
  b.placementGizmo.visible = true; b.placementGizmo.mode = "rotate";
  b._applyGizmoAxes();
  check("ghost rotate is yaw-only (X/Z hidden)", b.placementGizmo.showX===false && b.placementGizmo.showZ===false);
  check("chain rotate is full 3-axis", (()=>{ b._gizmoTarget="chain"; b._applyGizmoAxes(); return b.placementGizmo.showX && b.placementGizmo.showZ; })());
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
