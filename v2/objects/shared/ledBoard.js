import * as THREE from "three";
import {
  color,
  float,
  Fn,
  mix,
  mod,
  smoothstep,
  step,
  time,
  uv,
  vec2,
} from "three/tsl";

/**
 * Shared emissive LED-board material (used by the gantry + trackside billboard).
 * Dots are sized by a physical pitch (m/dot) so the panel reads the same at any
 * size; patterns (checker/chevron) are sized in metres so they scale too.
 *
 * Expected params (all optional, sensible fallbacks):
 *   boardMode   "checker" | "chevron" | "lights"
 *   boardShape  "round" | "square" | "diamond" | "solid"
 *   dotPitch, dotRadius, emissive, offLevel
 *   checkerSize, boardColorA, boardColorB
 *   chevronSpacing, chevronSkew, chevronDuty, chevronColor, panSpeed
 *   lightColor
 */
export function makeLedBoardMaterial(p, boardW, boardH) {
  const mode = p.boardMode || "checker";
  const shape = p.boardShape || "round";
  const pitch = Math.max(0.02, p.dotPitch ?? 0.085);
  const cols = Math.max(6, Math.round(boardW / pitch));
  const rows = Math.max(2, Math.round(boardH / pitch));
  const dotR = p.dotRadius ?? 0.36;
  const I = p.emissive ?? 6.0;
  const off = p.offLevel ?? 0.04;

  const chevCount = Math.max(1, Math.round(boardW / Math.max(0.2, p.chevronSpacing ?? 0.9)));
  const nx = Math.max(2, Math.round(boardW / Math.max(0.1, p.checkerSize ?? 0.55)));
  const ny = Math.max(1, Math.round(boardH / Math.max(0.1, p.checkerSize ?? 0.55)));

  const solid = shape === "solid";

  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  mat.emissiveNode = Fn(() => {
    const base = uv();
    const gx = base.x.mul(cols);
    const gy = base.y.mul(rows);
    const cxc = gx.floor().add(0.5);
    const cyc = gy.floor().add(0.5);

    const lx = gx.sub(cxc).abs();
    const ly = gy.sub(cyc).abs();
    let dot;
    if (solid) {
      dot = float(1.0);
    } else {
      const dist =
        shape === "square"
          ? lx.max(ly)
          : shape === "diamond"
            ? lx.add(ly)
            : vec2(lx, ly).length();
      dot = smoothstep(dotR, dotR - 0.06, dist);
    }

    const cu = solid ? base.x : cxc.div(cols);
    const cv = solid ? base.y : cyc.div(rows);
    const core = dot.mul(dot);

    let baseColor;
    let lit;
    if (mode === "chevron") {
      const dy = cv.sub(0.5).abs();
      const phase = cu.mul(chevCount).add(dy.mul(p.chevronSkew ?? 2.0)).sub(time.mul(p.panSpeed ?? 0.45));
      lit = smoothstep(p.chevronDuty ?? 0.5, (p.chevronDuty ?? 0.5) - 0.04, phase.fract());
      baseColor = color(p.chevronColor || "#ff8c1a");
    } else if (mode === "lights") {
      const colIdx = cu.mul(5.0).floor();
      const band = smoothstep(0.3, 0.26, cv.sub(0.5).abs());
      const ph = mod(time, 7.0);
      lit = step(colIdx, ph).mul(step(6.0, ph).oneMinus()).mul(band);
      baseColor = color(p.lightColor || "#ff2418");
    } else {
      const sq = mod(cu.mul(nx).floor().add(cv.mul(ny).floor()), 2.0);
      baseColor = mix(color(p.boardColorB || "#0d0d12"), color(p.boardColorA || "#ffffff"), sq);
      lit = float(1.0);
    }

    const ledColor = baseColor.mul(mix(float(0.55), float(1.3), core));
    const brightness = dot.mul(lit.mul(I).add(off));
    return ledColor.mul(brightness);
  })();

  return mat;
}
