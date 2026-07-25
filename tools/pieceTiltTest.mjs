// Per-piece entry tilt: banks a piece and everything downstream, chain stays
// connected, tilt reads back via base⁻¹·pose, and survives save/load recovery.
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(pathToFileURL(join(ROOT,"games/modular-road-v3/modularRoadBuilder.js")).href);

let fail=0; const check=(n,c,d="")=>{console.log(`${c?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`);if(!c)fail++;};
const D2R = THREE.MathUtils.degToRad;
const upOf = (m)=>{ const e=m.elements; return new THREE.Vector3(e[4],e[5],e[6]); };
function fresh(){
  const b=new ModularRoadBuilder({scene:new THREE.Scene(),material:new THREE.MeshBasicMaterial(),
    railMaterial:new THREE.MeshBasicMaterial(),shellMaterial:new THREE.MeshBasicMaterial(),decorMaterial:new THREE.MeshBasicMaterial()});
  b.snapEnabled=false;
  for(let i=0;i<5;i++){ b.setActivePiece("straight"); b.place(); }
  return b;
}
function connected(b){
  const a=new THREE.Vector3(),c=new THREE.Vector3();
  for(let i=1;i<b.pieces.length;i++){a.setFromMatrixPosition(b.pieces[i-1].connectorOut);c.setFromMatrixPosition(b.pieces[i].connectorIn);if(a.distanceTo(c)>1e-6)return false;}
  return true;
}
/** Roll about the connector's travel axis: local Z (socket z = -travel). */
const rollQuat=(deg)=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),D2R(deg));
const pitchQuat=(deg)=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),D2R(deg));

{
  const b=fresh();
  check("baseline flat + connected", Math.abs(upOf(b.pieces[0].connectorIn).y-1)<1e-6 && connected(b));
}
{
  // Roll piece 2 by 25° → piece 2..4 banked, pieces 0..1 stay flat.
  const b=fresh();
  b.setPieceTilt(b.pieces[2], rollQuat(25));
  check("upstream pieces stay flat", Math.abs(upOf(b.pieces[1].connectorIn).y-1)<1e-6);
  const up2=upOf(b.pieces[2].connectorIn);
  check("tilted piece is banked", Math.abs(up2.x)>0.3, `up.x ${up2.x.toFixed(3)}`);
  check("bank propagates downstream", Math.abs(upOf(b.pieces[4].connectorIn).x-up2.x)<1e-6);
  check("chain stays connected (no gap)", connected(b));
  const t=b.pieceTiltDeg(b.pieces[2]);
  check("tilt reads back as ~25° roll", Math.abs(t.roll-25)<1e-3 && Math.abs(t.pitch)<1e-3, `pitch ${t.pitch.toFixed(1)} roll ${t.roll.toFixed(1)}`);
}
{
  // Two tilts compound: roll 20 at piece1, then pitch -10 at piece3.
  const b=fresh();
  b.setPieceTilt(b.pieces[1], rollQuat(20));
  b.setPieceTilt(b.pieces[3], pitchQuat(-10));
  check("compound tilts stay connected", connected(b));
  const fwd4=(m=>{const e=m.elements;return new THREE.Vector3(-e[8],-e[9],-e[10]);})(b.pieces[4].connectorIn);
  check("downstream both banks and descends", Math.abs(upOf(b.pieces[4].connectorIn).x)>0.2 && fwd4.y<-0.05,
    `up.x ${upOf(b.pieces[4].connectorIn).x.toFixed(2)} fwd.y ${fwd4.y.toFixed(2)}`);
}
{
  // levelPiece removes a tilt; downstream re-levels from there.
  const b=fresh();
  b.setPieceTilt(b.pieces[1], rollQuat(30));
  b.levelPiece(b.pieces[1]);
  check("levelPiece re-flattens", Math.abs(upOf(b.pieces[4].connectorIn).y-1)<1e-6 && connected(b));
}
{
  // Delete a tilted piece → downstream re-derives correctly (still connected).
  const b=fresh();
  b.setPieceTilt(b.pieces[2], rollQuat(15));
  b.deletePiece(b.pieces[2]);
  check("delete a tilted piece keeps chain connected", connected(b) && b.pieces.length===4);
}
{
  // SAVE/LOAD recovery: a tilted track, exported to entries + re-imported, must
  // reproduce the tilt AND remain editable (a later rebuildAll must not flatten).
  const b=fresh();
  b.setPieceTilt(b.pieces[2], rollQuat(25));
  const upBefore = upOf(b.pieces[4].connectorIn).clone();
  // Build the entry list the way exportTrack does (id/chainId/pp/edges/connectorIn).
  const entries = b.pieces.map(p=>({ id:p.id, chainId:p.chainId, pp:{...p.pp}, edges:p.edges,
    connectorIn: p.connectorIn.clone().elements.slice() }));
  b.importTrackPieces(entries);
  check("loaded track reproduces the bank", upOf(b.pieces[4].connectorIn).distanceTo(upBefore)<1e-5,
    `up ${upOf(b.pieces[4].connectorIn).toArray().map(v=>v.toFixed(2))}`);
  check("recovered tilt is ~25° roll", Math.abs(b.pieceTiltDeg(b.pieces[2]).roll-25)<0.5);
  // now edit upstream and confirm the bank still flows (didn't flatten)
  b.rebuildAll();
  check("a later rebuild keeps the bank (recovery worked)",
    upOf(b.pieces[4].connectorIn).distanceTo(upBefore)<1e-5 && connected(b));
}

// ── GIZMO-DRIVEN path (_onPieceGizmoChange) ────────────────────────────────
function fakeGizmo(){return{visible:false,enabled:false,mode:"translate",dragging:true /* these fixtures simulate DRAGS */,axis:null,showX:1,showY:1,showZ:1,setMode(m){this.mode=m},setSpace(){},setSize(){},attach(o){this.object=o},detach(){this.object=null},getHelper(){return new THREE.Object3D()},addEventListener(){},removeEventListener(){}};}
{
  const b = fresh(); b.placementGizmo = fakeGizmo();
  const p = b.pieces[2];
  b.selectPiece(p); // attaches gizmo at p.connectorIn, target="piece"
  check("selecting a piece targets it with the gizmo", b._gizmoTarget === "piece" && b.placementGizmo.visible);
  // ROTATE: set the pivot to a 20° roll of the piece's base orientation, fire hook.
  b.placementGizmo.mode = "rotate";
  const baseRot = new THREE.Matrix4().extractRotation(p._baseIn);
  const baseQ = new THREE.Quaternion().setFromRotationMatrix(baseRot);
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), D2R(20));
  b.placementPivot.quaternion.copy(baseQ).multiply(roll); // base · roll
  b._onPlacementGizmoChange();
  const t = b.pieceTiltDeg(p);
  check("gizmo rotate sets the piece tilt", Math.abs(t.roll-20)<0.6, `roll ${t.roll.toFixed(1)}`);
  check("gizmo tilt banks the piece + downstream, still connected",
    Math.abs(upOf(b.pieces[4].connectorIn).x)>0.2 && connected(b));
  check("pivot re-seats on the moved piece", b.placementPivot.position.distanceTo(new THREE.Vector3().setFromMatrixPosition(p.connectorIn))<1e-6);
}
{
  // TRANSLATE now DETACHES the piece and moves it ALONE. (It used to shift the
  // whole chain, which meant a piece had no position of its own to edit — the
  // thing that made the builder feel stuck.) Moving the whole run is still
  // available by selecting the chain rather than a piece.
  const b = fresh(); b.placementGizmo = fakeGizmo();
  const p = b.pieces[2];
  b.selectPiece(p);
  const before = b.pieces.map(q => new THREE.Vector3().setFromMatrixPosition(q.connectorIn));
  b.placementGizmo.mode = "translate";
  b.placementPivot.position.copy(before[2]).add(new THREE.Vector3(5, 3, 0)); // drag +5x +3y
  b._onPlacementGizmoChange();
  const after = b.pieces.map(q => new THREE.Vector3().setFromMatrixPosition(q.connectorIn));
  check("translate detaches the piece", p.detached === true);
  check("the dragged piece moved by the delta",
    Math.abs(after[2].x - before[2].x - 5) < 1e-4 && Math.abs(after[2].y - before[2].y - 3) < 1e-4,
    `d ${(after[2].x-before[2].x).toFixed(2)},${(after[2].y-before[2].y).toFixed(2)}`);
  check("no other piece moved",
    [0,1,3,4].every(i => after[i].distanceTo(before[i]) < 1e-6));
}

// ── EMPTY-SPACE (gap) round-trip ───────────────────────────────────────────
{
  const b = fresh(); b.placementGizmo = fakeGizmo();
  const p = b.pieces[2];
  b.replacePiece(p, "gap");
  check("piece becomes a gap (noRender/noCollision)",
    p.id==="gap" && p.mesh.userData.noRender && p.mesh.userData.noCollision);
  check("gap uses the marker material + stays visible in build",
    p.mesh.material === b.gapMaterial && p.mesh.visible === true);
  check("gap keeps the chain connected", connected(b));
  // A gap must remain selectable so it's reversible.
  const targets = [];
  for (const q of b.pieces) if (q.mesh?.geometry?.attributes?.position) targets.push(q.mesh);
  check("gap road mesh is in the pick target set", targets.includes(p.mesh));
  // makeGap keeps downstream in place (flat spacer), unlike the raw dropping gap.
  {
    const b2=fresh(); b2.placementGizmo=fakeGizmo();
    const before=new THREE.Vector3().setFromMatrixPosition(b2.pieces[4].connectorOut).clone();
    b2.makeGap(b2.pieces[2]);
    const after=new THREE.Vector3().setFromMatrixPosition(b2.pieces[4].connectorOut);
    check('makeGap is a FLAT spacer — downstream does not move', before.distanceTo(after)<1e-4,
      `moved ${before.distanceTo(after).toFixed(2)}m`);
    check('makeGap piece is a gap', b2.pieces[2].id==='gap' && b2.pieces[2].mesh.userData.noRender);
  }
  // Fill it back in with a straight.
  b.replacePiece(p, "straight");
  check("replacing a gap back restores a real piece",
    p.id==="straight" && !p.mesh.userData.noRender && p.mesh.material===b.material && connected(b));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
