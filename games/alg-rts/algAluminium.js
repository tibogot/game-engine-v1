// BARE METAL (2026-10-12, the Noratlas — algParadrop.js): the French transports over Algeria flew in
// natural aluminium, and the kit's atlas has no such surface (its steel is a dark gunmetal, its
// concrete beige, its white a whitewash). One small material of its own instead — a plane is one
// mesh, one draw. It reads the kit's per-vertex attributes: the material id (steel parts dark —
// windows, open doors, blades; paint olive — the radome), the tone (light or a shade darker) and the
// baked contact AO.
import * as THREE from "three";
import { abs, attribute, float, mix, step, vec3 } from "three/tsl";
import { MAT } from "../../v3/render/objects/rtsParts.js";

let _m = null;
export function aluminiumMaterial() {
  if (_m) return _m;
  const id = attribute("matId", "float"), tone = attribute("tone", "float"), ao = attribute("ao", "float");
  const is = (k) => step(abs(id.sub(k)), float(0.25));
  const alu = mix(vec3(0.26, 0.275, 0.29), vec3(0.42, 0.44, 0.46), tone);   // (linear) panels a shade apart
  const dark = vec3(0.025, 0.03, 0.035).mul(float(1).add(tone.mul(4)));
  const olive = vec3(0.12, 0.14, 0.07);
  const col = mix(mix(alu, dark, is(MAT.steel)), olive, is(MAT.paint)).mul(ao);
  _m = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.3 });
  _m.name = "Aluminium";
  _m.colorNode = col;
  return _m;
}
