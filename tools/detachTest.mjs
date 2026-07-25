// Per-piece EDGES and DETACH (free-placing one piece without dragging the chain).
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(pathToFileURL(join(ROOT,"games/modular-road-v3/modularRoadBuilder.js")).href);
const { guardrailParams } = await import(pathToFileURL(join(ROOT,"games/modular-road-v3/modularRoadKit.js")).href);

let fail=0; const check=(n,c,d="")=>{console.log(`${c?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`);if(!c)fail++;};
const P=(m)=>new THREE.Vector3().setFromMatrixPosition(m);
function fresh(n=5){
  const b=new ModularRoadBuilder({scene:new THREE.Scene(),material:new THREE.MeshBasicMaterial(),
    railMaterial:new THREE.MeshBasicMaterial(),shellMaterial:new THREE.MeshBasicMaterial(),decorMaterial:new THREE.MeshBasicMaterial()});
  b.snapEnabled=false;
  for(let i=0;i<n;i++){ b.setActivePiece("straight"); b.place(); }
  return b;
}
const connected=(b)=>{const a=new THREE.Vector3(),c=new THREE.Vector3();
  for(let i=1;i<b.pieces.length;i++){a.setFromMatrixPosition(b.pieces[i-1].connectorOut);
  c.setFromMatrixPosition(b.pieces[i].connectorIn);if(a.distanceTo(c)>1e-6)return false;}return true;};

console.log("=== PER-PIECE EDGES ===");
{
  const b=fresh();
  check("pieces build with rails by default", !!b.pieces[2].railMesh);
  b.setPieceEdges(b.pieces[2], false);
  check("edges off removes THAT piece's rail", !b.pieces[2].railMesh);
  check("...and leaves its neighbours alone", !!b.pieces[1].railMesh && !!b.pieces[3].railMesh);
  b.setPieceEdges(b.pieces[2], true);
  check("edges back on restores it", !!b.pieces[2].railMesh);
}
{
  // The bug: the GLOBAL toggle used to strip rails from every piece on rebuild.
  const b=fresh();
  const prev=guardrailParams.enabled;
  guardrailParams.enabled=false;        // palette "Edges Off" — affects NEW pieces only
  b.rebuildAll();
  check("global Edges-Off no longer strips existing pieces",
    !!b.pieces[0].railMesh && !!b.pieces[4].railMesh);
  guardrailParams.enabled=prev;
}

console.log("\n=== DETACH ===");
{
  const b=fresh();
  const before=b.pieces.map(p=>P(p.connectorIn).clone());
  const p=b.pieces[2];
  b.detachPiece(p);
  p.pinnedIn.setPosition(P(p.pinnedIn).add(new THREE.Vector3(0,6,0))); // lift 6m
  b.rebuildAll();
  check("the detached piece moved", Math.abs(P(p.connectorIn).y-before[2].y-6)<1e-6,
    `y ${before[2].y.toFixed(1)} -> ${P(p.pieces?.connectorIn??p.connectorIn).y.toFixed(1)}`);
  check("pieces BEFORE it did not move", P(b.pieces[0].connectorIn).distanceTo(before[0])<1e-6
    && P(b.pieces[1].connectorIn).distanceTo(before[1])<1e-6);
  check("pieces AFTER it did not move", P(b.pieces[3].connectorIn).distanceTo(before[3])<1e-6
    && P(b.pieces[4].connectorIn).distanceTo(before[4])<1e-6);
}
{
  const b=fresh();
  const before=P(b.pieces[2].connectorIn).clone();
  const p=b.pieces[2];
  b.detachPiece(p);
  p.pinnedIn.setPosition(P(p.pinnedIn).add(new THREE.Vector3(3,6,0)));
  b.rebuildAll();
  b.attachPiece(p);
  check("re-attach snaps back onto the chain", P(b.pieces[2].connectorIn).distanceTo(before)<1e-6);
  check("chain is fully connected again", connected(b));
}
{
  // Save / load must keep a free-placed piece where it was.
  const b=fresh();
  const p=b.pieces[2];
  b.detachPiece(p);
  p.pinnedIn.setPosition(P(p.pinnedIn).add(new THREE.Vector3(0,9,0)));
  b.rebuildAll();
  const want=b.pieces.map(q=>P(q.connectorIn).clone());
  const entries=b.exportTrackPieces();
  check("export records the detached flag", entries[2].detached===true && Array.isArray(entries[2].pinnedIn));
  b.importTrackPieces(entries);
  const got=b.pieces.map(q=>P(q.connectorIn).clone());
  check("reload reproduces every piece position",
    want.every((w,i)=>w.distanceTo(got[i])<1e-4),
    `piece2 y ${want[2].y.toFixed(2)} -> ${got[2].y.toFixed(2)}`);
  b.rebuildAll();
  check("a later rebuild keeps it (didn't snap back)",
    P(b.pieces[2].connectorIn).distanceTo(want[2])<1e-4);
}

console.log("\n=== SELECTING MUST NOT MOVE ANYTHING ===");
{
  // Attaching the gizmo writes mode/enabled/showX/showY/showZ, and
  // TransformControls dispatches "change" on each of those. That setup used to
  // arrive in the handler looking like a drag and detach+grid-snap the piece,
  // so it visibly jumped the moment you right-clicked it.
  const b=fresh();
  b.placementGizmo={visible:false,enabled:false,mode:"translate",dragging:false,axis:null,
    showX:1,showY:1,showZ:1,setMode(m){this.mode=m;},setSpace(){},setSize(){},
    attach(o){this.object=o;},detach(){this.object=null;},getHelper(){return new THREE.Object3D();},
    addEventListener(){},removeEventListener(){}};
  const before=b.pieces.map(q=>P(q.connectorIn).clone());
  b.selectPiece(b.pieces[2]);
  b._onPlacementGizmoChange();          // the setup-time event (dragging === false)
  const after=b.pieces.map(q=>P(q.connectorIn).clone());
  check("right-clicking a piece moves nothing", before.every((v,i)=>v.distanceTo(after[i])<1e-9),
    `piece2 moved ${before[2].distanceTo(after[2]).toFixed(4)}m`);
  check("...and does not detach it", !b.pieces[2].detached);
  // A real drag still works.
  b.placementGizmo.dragging=true;
  b.placementPivot.position.copy(before[2]).add(new THREE.Vector3(0,4,0));
  b._onPlacementGizmoChange();
  check("a real drag still moves the piece",
    Math.abs(P(b.pieces[2].connectorIn).y-before[2].y-4)<1e-4);
  check("...and pieces after it stay put", P(b.pieces[4].connectorIn).distanceTo(before[4])<1e-6);
}
{
  // WITH GRID SNAP ON — the case that actually bit. Pieces sit where the chain
  // put them (a straight is 22 m) which is almost never on the 8 m grid, so
  // snapping their ABSOLUTE position teleported them by up to half a cell the
  // instant the gizmo was touched. Both TransformControls' translationSnap and
  // our own snapPos did it. Now the DRAG DELTA is snapped instead.
  const b=fresh();
  b.placementGizmo={visible:false,enabled:false,mode:"translate",dragging:false,axis:null,
    showX:1,showY:1,showZ:1,translationSnap:null,rotationSnap:null,
    setMode(m){this.mode=m;},setSpace(){},setSize(){},attach(o){this.object=o;},
    detach(){this.object=null;},getHelper(){return new THREE.Object3D();},
    addEventListener(){},removeEventListener(){}};
  b.snapEnabled=true; b.snapStep=8;
  const p=b.pieces[2];
  const start=P(p.connectorIn).clone();
  const offGrid=Math.abs(start.z-Math.round(start.z/8)*8);
  check("the piece really is off-grid (so this test is meaningful)", offGrid>0.5,
    `z ${start.z.toFixed(1)}, ${offGrid.toFixed(1)}m off the nearest cell`);
  b.selectPiece(p);
  check("TransformControls' absolute snap is off while editing a piece",
    b.placementGizmo.translationSnap === null);
  // grab the gizmo without moving it
  b.placementGizmo.dragging=true;
  b._dragStartPos.copy(b.placementPivot.position);
  b._dragStartQuat.copy(b.placementPivot.quaternion);
  b._onPlacementGizmoChange();
  check("touching the gizmo does not shift the piece",
    P(b.pieces[2].connectorIn).distanceTo(start)<1e-6,
    `moved ${P(b.pieces[2].connectorIn).distanceTo(start).toFixed(4)}m`);
  // now drag, and confirm it moves on the grid with no sideways drift
  b.placementPivot.position.copy(b._dragStartPos).add(new THREE.Vector3(0,5,0));
  b._onPlacementGizmoChange();
  const moved=P(b.pieces[2].connectorIn);
  check("dragging moves in grid steps with no drift on the other axes",
    Math.abs(moved.y-start.y-8)<1e-4 && Math.hypot(moved.x-start.x, moved.z-start.z)<1e-6,
    `dy ${(moved.y-start.y).toFixed(1)}m`);
}
console.log(fail?`\n${fail} FAILURE(S)`:"\nall green");
process.exit(fail?1:0);
