// THE SCREEN — the toy's lit road film, drawn by one TSL shader on a plane.
//
// The real toy shows a printed road scene, lit from behind through a frosted panel: orange
// dashed lane lines, a green grid and green pines on the sides, a yellow car ahead. The road
// wanders left and right; the player's red car (a sticker on its own plane, in front of the
// film) is steered to stay on it.
//
// The film is a pseudo-3D strip: a screen row v (0 = bottom, 1 = top) looks d(v) metres down
// the road, at a lateral scale sc(v). The same maths runs here in JS (off-road test, the rival
// car's position) and in the shader, so what you see is what the game tests.
import * as THREE from "three";
import { Fn, Loop, abs, exp, float, floor, fract, max, min, mix, sin, smoothstep, sqrt, step, uniform, uv, vec2, vec3 } from "three/tsl";

export const ROAD = {
  L: 6, M: 8,       // d(v) = L v + M v²: 0 at the bottom, 14 at the top
  A: 1.9,           // sc(v) = 1 / (1 + A v): the road narrows to a third at the top
  K: 0.24,          // screen widths per road unit at the bottom
  W: 1,             // road half width (3 lanes)
  CAM: 0.5,         // the view follows half the road's wander: the bottom drifts, the car must follow
  CAR_V: 0.12,      // the player car's row
  ASPECT: 0.13 / 0.09,
};

export const curve = (s) => 0.85 * Math.sin(0.21 * s) + 0.45 * Math.sin(0.47 * s + 1.3);
export const depthAt = (v) => ROAD.L * v + ROAD.M * v * v;
export const rowAt = (d) => (Math.sqrt(Math.max(ROAD.L * ROAD.L + 4 * ROAD.M * d, 0)) - ROAD.L) / (2 * ROAD.M);
export const scaleAt = (v) => 1 / (1 + ROAD.A * v);

// screen x (0..1) of a lateral road position X at row v, with the film scrolled to s
export const screenX = (X, v, s) => 0.5 + (X - ROAD.CAM * curve(s)) * ROAD.K * scaleAt(v);
// the road centre and half width (screen units) at the player car's row
export function roadAtCar(s) {
  const v = ROAD.CAR_V;
  return { x: screenX(curve(s + depthAt(v)), v, s), half: ROAD.W * ROAD.K * scaleAt(v) };
}

export function createScreen() {
  const uS = uniform(0);          // film scroll (road units)
  const uOn = uniform(0);         // backlight 0..1
  const uFlash = uniform(0);      // off-road flash 0..1
  const uRival = uniform(new THREE.Vector4(0.5, 2, 0.05, 0)); // x, v, size, visible

  const { L, M, A, K, W, CAM, ASPECT } = ROAD;
  const curveT = (s) => sin(s.mul(0.21)).mul(0.85).add(sin(s.mul(0.47).add(1.3)).mul(0.45));
  const hash = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  // a bright core and a soft halo: light through film and a frosted panel
  const glow = (dist, w) => exp(dist.div(w).pow2().negate()).add(exp(abs(dist).div(w.mul(5)).negate()).mul(0.22));

  const color = Fn(() => {
    const p = vec2(uv().x, uv().y.oneMinus());
    const v = p.y;
    const sc = float(1).div(v.mul(A).add(1));
    const d = v.mul(L).add(v.mul(v).mul(M));
    const s = uS;
    const camX = curveT(s).mul(CAM);
    const u = p.x.sub(0.5).div(sc.mul(K)).add(camX).sub(curveT(s.add(d))); // lateral, road units, 0 = centre
    const au = abs(u);
    const col = vec3(0).toVar();

    // lane dividers and edges: orange dashes. The glow is measured on SCREEN (height units), across
    // the line and along it to the dash, so a dash glows round its ends and the halo never bands.
    const latS = sc.mul(K * ASPECT);                  // screen per road unit, across
    const alongS = float(1).div(v.mul(2 * M).add(L)); // screen per road unit, along
    const dashGlow = (lat, phase, len, w) => {
      const f = fract(s.add(d).mul(0.9).add(phase));
      const along = max(abs(f.sub(len / 2)).sub(len / 2), 0).div(0.9).mul(alongS);
      const r = vec2(lat.mul(latS), along).length();
      const ww = sc.mul(w);
      return exp(r.div(ww).pow2().negate()).add(exp(r.div(ww.mul(4)).negate()).mul(0.2));
    };
    const lanes = dashGlow(abs(au.sub(W / 3)), 0, 0.5, 0.012);
    const edges = dashGlow(abs(au.sub(W)), 0.3, 0.62, 0.012);
    col.addAssign(vec3(1.0, 0.6, 0.12).mul(lanes.add(edges.mul(0.9))));

    // green grid beside the road, fading outwards
    const off = au.sub(W + 0.18);
    const outside = smoothstep(0.0, 0.12, off).mul(smoothstep(4.5, 1.5, off));
    const gz = fract(s.add(d).mul(0.3));
    const gridH = glow(min(gz, gz.oneMinus()).div(0.3), float(0.05));
    const gx = fract(off.div(1.1));
    const gridV = glow(min(gx, gx.oneMinus()).mul(1.1), float(0.04));
    col.addAssign(vec3(0.15, 0.95, 0.45).mul(gridH.add(gridV)).mul(outside).mul(0.38));

    // pines, one every few metres, either side
    const sp = 2.4;
    const base = floor(s.div(sp));
    Loop(9, ({ i }) => {
      const idx = base.add(float(i));
      const t = idx.mul(sp).add(hash(idx).mul(0.9));
      const dT = t.sub(s);
      const vT = sqrt(max(dT.mul(4 * M).add(L * L), 0)).sub(L).div(2 * M);
      const scT = float(1).div(vT.mul(A).add(1));
      const side = step(0.5, hash(idx.add(7.3))).mul(2).sub(1);
      const X = curveT(t).add(side.mul(hash(idx.add(2.1)).mul(0.8).add(W + 0.75)));
      const xs = X.sub(camX).mul(K).mul(scT).add(0.5);
      const size = scT.mul(0.12);
      const q = vec2(p.x.sub(xs).mul(ASPECT), v.sub(vT)).div(size);
      const tri = max(abs(q.x).sub(q.y.oneMinus().add(0.6).mul(0.42)), max(q.y.negate().add(0.25), q.y.sub(1.6)));
      const trunk = max(abs(q.x).sub(0.08), max(q.y.negate(), q.y.sub(0.3)));
      const dd = min(tri, trunk);
      const lit = smoothstep(0.1, 0.0, dd).add(exp(max(dd, 0).mul(-3)).mul(0.18));
      col.addAssign(vec3(0.2, 1.0, 0.5).mul(lit).mul(step(-1.0, dT)));
    });

    // the yellow car ahead (placed by the game, uRival)
    const rq = vec2(p.x.sub(uRival.x).mul(ASPECT), v.sub(uRival.y)).div(uRival.z);
    const body = max(abs(rq.x).sub(0.5), abs(rq.y.sub(0.7)).sub(0.7));
    const glass = max(abs(rq.x).sub(0.32), abs(rq.y.sub(0.95)).sub(0.18));
    const rd = max(body, glass.negate());
    const rlit = smoothstep(0.12, 0.0, rd).add(exp(max(body, 0).mul(-3)).mul(0.25));
    col.addAssign(vec3(1.0, 0.82, 0.2).mul(rlit).mul(uRival.w));

    // the frosted backlight: a pale grey film, brighter in the middle
    const c = p.sub(0.5).mul(vec2(1.0, 1.25));
    const vig = float(1).sub(c.dot(c).mul(1.6)).clamp(0.25, 1);
    // the film is lit from inside the red shell: pale pink-grey, the red bleeding in from the right
    const back = mix(vec3(0.33, 0.3, 0.3), vec3(0.42, 0.1, 0.08), smoothstep(0.55, 1.0, p.x).mul(0.55));
    const lit = back.mul(vig).add(col.mul(1.35));
    const on = mix(vec3(0.025, 0.028, 0.027), lit, uOn);
    return mix(on, vec3(1.5, 1.45, 1.32), uFlash);
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = color();
  material.toneMapped = false;
  return { material, uS, uOn, uFlash, uRival };
}
