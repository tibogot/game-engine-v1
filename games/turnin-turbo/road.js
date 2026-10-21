// THE SCREEN — the toy's lit road film, drawn by one TSL shader on a plane.
//
// The real film (front photo, close crop): a pale frosted grey, brighter in the middle, the red shell bleeding in
// from the right; NO road surface — just cream dashed lines (two edges, a centre line) curving gently; a sparse green
// ladder grid beside the road; soft blob trees; a big yellow sports car ahead, painted from behind and a little above.
// The player's red car (the same painting, on a clear sticker in front of the film) is steered to stay on the road.
//
// The film is a pseudo-3D strip: a screen row v (0 = bottom, 1 = top) looks d(v) metres down the road, at a lateral
// scale sc(v). The same maths runs here in JS (off-road test, the rival car's place) and in the shader.
import * as THREE from "three";
import { Fn, Loop, abs, exp, float, floor, fract, max, min, mix, sin, smoothstep, step, texture, uniform, uv, vec2, vec3 } from "three/tsl";

export const ROAD = {
  VH: 1.22,         // a true perspective: the horizon just above the top (v = VH), so the road narrows nearly to a
  D0: 2.6,          //   point there (photos); a row v looks d = D0 v / (VH - v) down the road, scaled sc = (VH - v) / VH
  K: 0.2,           // screen widths per road unit at the bottom: the road is 40 % of the screen wide there
  W: 1,             // road half width (3 lanes: four lines)
  CAM: 0.5,         // the view follows half the road's wander: the bottom drifts, the car must follow
  CAR_V: 0.12,      // the player car's row
  ASPECT: 0.13 / 0.09,
  CAR_W: 0.2,       // the cars' width on screen at the bottom row (photo: the red car ~16 % of the screen)
};

export const curve = (s) => 0.55 * Math.sin(0.21 * s) + 0.3 * Math.sin(0.47 * s + 1.3);
export const depthAt = (v) => (ROAD.D0 * v) / (ROAD.VH - v);
export const rowAt = (d) => (ROAD.VH * d) / (d + ROAD.D0);
export const scaleAt = (v) => (ROAD.VH - v) / ROAD.VH;

// screen x (0..1) of a lateral road position X at row v, with the film scrolled to s
export const screenX = (X, v, s) => 0.5 + (X - ROAD.CAM * curve(s)) * ROAD.K * scaleAt(v);
// the road centre and half width (screen units) at the player car's row
export function roadAtCar(s) {
  const v = ROAD.CAR_V;
  return { x: screenX(curve(s + depthAt(v)), v, s), half: ROAD.W * ROAD.K * scaleAt(v) };
}

// --- the cars on the film (screen photos): a rear-engined sports car from behind and above — wide rear wings, a
// narrower rounded cabin, the rear window, the engine lid with its grille, a tail-light band, the tyres at the corners —
// soft, as painted on film behind frosted plastic. `long`: the car ahead, seen more from above (longer).
export function createCarSprite(body, band, light, blur = 3, long = false) {
  const S = 256;
  const src = document.createElement("canvas"); src.width = src.height = S;
  const c = src.getContext("2d");
  c.save(); c.scale(S, S);
  const k = long ? 1.25 : 1;            // vertical stretch for the car ahead
  const Y = (y) => 0.98 - (0.98 - y) * k;
  // tyres
  c.fillStyle = band;
  for (const x of [0.07, 0.79]) { c.beginPath(); c.roundRect(x, Y(0.74), 0.14, 0.22 * k, 0.03); c.fill(); }
  // body: wide hips, waist in at the cabin
  c.fillStyle = body;
  c.beginPath();
  c.moveTo(0.1, Y(0.9));
  c.bezierCurveTo(0.03, Y(0.86), 0.02, Y(0.62), 0.07, Y(0.52));     // left rear wing
  c.bezierCurveTo(0.1, Y(0.46), 0.18, Y(0.44), 0.22, Y(0.42));
  c.bezierCurveTo(0.24, Y(0.26), 0.3, Y(0.14), 0.5, Y(0.13));       // cabin up to the roof
  c.bezierCurveTo(0.7, Y(0.14), 0.76, Y(0.26), 0.78, Y(0.42));
  c.bezierCurveTo(0.82, Y(0.44), 0.9, Y(0.46), 0.93, Y(0.52));
  c.bezierCurveTo(0.98, Y(0.62), 0.97, Y(0.86), 0.9, Y(0.9));
  c.closePath(); c.fill();
  // roof highlight, rear window
  c.fillStyle = light; c.beginPath(); c.ellipse(0.5, Y(0.2), 0.16, 0.045 * k, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = band; c.beginPath();
  c.moveTo(0.3, Y(0.42)); c.bezierCurveTo(0.31, Y(0.3), 0.38, Y(0.25), 0.5, Y(0.25));
  c.bezierCurveTo(0.62, Y(0.25), 0.69, Y(0.3), 0.7, Y(0.42)); c.closePath(); c.fill();
  // engine lid + grille slats
  c.fillStyle = light; c.globalAlpha = 0.5;
  c.beginPath(); c.roundRect(0.33, Y(0.47), 0.34, 0.12 * k, 0.04); c.fill();
  c.globalAlpha = 1; c.fillStyle = band;
  for (let i = 0; i < 4; i++) c.fillRect(0.38, Y(0.495 + i * 0.025), 0.24, 0.009 * k);
  // tail-light band, bumper
  c.fillStyle = "#ff3a26"; c.beginPath(); c.roundRect(0.12, Y(0.64), 0.76, 0.07 * k, 0.02); c.fill();
  c.fillStyle = band; c.beginPath(); c.roundRect(0.4, Y(0.65), 0.2, 0.05 * k, 0.01); c.fill();
  c.beginPath(); c.roundRect(0.1, Y(0.76), 0.8, 0.06 * k, 0.03); c.fill();
  c.restore();
  const out = document.createElement("canvas"); out.width = out.height = S;
  const o = out.getContext("2d");
  o.filter = `blur(${blur}px)`; o.drawImage(src, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// --- the trees on the film (photos): a painted pine — a ragged, layered silhouette, wider low down, a short trunk
export function createTreeSprite() {
  const W = 192, H = 256;
  const src = document.createElement("canvas"); src.width = W; src.height = H;
  const c = src.getContext("2d");
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  c.fillStyle = "#48f0b4";
  c.fillRect(W * 0.46, H * 0.82, W * 0.08, H * 0.16);                 // trunk
  for (let k = 0; k < 5; k++) {                                        // five layers, wide at the bottom
    const y0 = H * (0.88 - k * 0.15), y1 = y0 - H * 0.32, half = W * (0.5 - k * 0.07);
    c.beginPath(); c.moveTo(W / 2 - half, y0);
    for (let i = 1; i <= 8; i++) {                                     // ragged edge, up the left side to the tip
      const t = i / 8; c.lineTo(W / 2 - half * (1 - t) * (0.8 + rnd() * 0.4), y0 - (y0 - y1) * t + (rnd() - 0.5) * H * 0.05);
    }
    for (let i = 7; i >= 0; i--) {                                     // and down the right
      const t = i / 8; c.lineTo(W / 2 + half * (1 - t) * (0.8 + rnd() * 0.4), y0 - (y0 - y1) * t + (rnd() - 0.5) * H * 0.05);
    }
    c.closePath(); c.fill();
  }
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const o = out.getContext("2d"); o.filter = "blur(5px)"; o.drawImage(src, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createScreen() {
  const uS = uniform(0);          // film scroll (road units)
  const uOn = uniform(0);         // backlight 0..1
  const uFlash = uniform(0);      // off-road: the bulb blinks (0..1)
  const uRival = uniform(new THREE.Vector4(0.5, 2, 0.05, 0)); // x, v, width, visible
  const treeTex = createTreeSprite();
  const rivalTex = createCarSprite("#f4cf52", "#9a6a14", "#fff0b0", 2.5, true);

  const { VH, D0, K, W, CAM, ASPECT } = ROAD;
  const curveT = (s) => sin(s.mul(0.21)).mul(0.55).add(sin(s.mul(0.47).add(1.3)).mul(0.3));
  const hash = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  // a bright core and a soft halo: light through film and a frosted panel
  const glow = (dist, w) => exp(dist.div(w).pow2().negate()).add(exp(abs(dist).div(w.mul(4)).negate()).mul(0.15));

  const color = Fn(() => {
    const p = vec2(uv().x, uv().y.oneMinus());
    const v = p.y;
    const sc = float(VH).sub(v).div(VH);
    const d = v.mul(D0).div(float(VH).sub(v));
    const s = uS;
    const camX = curveT(s).mul(CAM);
    const u = p.x.sub(0.5).div(sc.mul(K)).add(camX).sub(curveT(s.add(d))); // lateral, road units, 0 = centre
    const au = abs(u);
    const col = vec3(0).toVar();

    // cream dashed lines: two edges and the centre. Glow measured on SCREEN, so a dash glows round its ends.
    const latS = sc.mul(K * ASPECT);
    const alongS = float(VH * D0).div(d.add(D0).pow2());   // screen height per road unit, along
    const dashGlow = (lat, phase, len, w) => {
      const f = fract(s.add(d).mul(0.8).add(phase));
      const along = max(abs(f.sub(len / 2)).sub(len / 2), 0).div(0.8).mul(alongS);
      const r = vec2(lat.mul(latS), along).length();
      const ww = sc.mul(w);
      return exp(r.div(ww).pow2().negate()).add(exp(r.div(ww.mul(3)).negate()).mul(0.1));
    };
    const lines = dashGlow(abs(au.sub(W / 3)), 0, 0.5, 0.013).add(dashGlow(abs(au.sub(W)), 0.25, 0.5, 0.014));
    col.addAssign(vec3(1.0, 0.82, 0.5).mul(lines));

    // the green ladder grid: two rails beside the road (left), rungs between; a few rungs on the right
    // the green grid: a faint perspective grid filling both sides beyond the road (photos), fading outwards
    const off = au.sub(W + 0.25);
    const side = smoothstep(0.0, 0.15, off).mul(smoothstep(3.2, 0.8, off));
    const gz = fract(s.add(d).mul(0.5));
    const rungs = exp(min(gz, gz.oneMinus()).div(0.5).mul(alongS).div(sc.mul(0.006).max(0.0015)).pow2().negate());
    const gx = fract(off.div(0.7));
    const rails = exp(min(gx, gx.oneMinus()).mul(0.7).mul(latS).div(sc.mul(0.006)).pow2().negate());
    col.addAssign(vec3(0.2, 0.9, 0.6).mul(rungs.add(rails).min(1.0)).mul(side).mul(0.26));

    // trees: soft green blobs (three overlapping circles), either side
    const sp = 2.6;
    const base = floor(s.div(sp));
    Loop(7, ({ i }) => {
      const idx = base.add(float(i));
      const t = idx.mul(sp).add(hash(idx).mul(1.2));
      const dT = t.sub(s);
      const vT = float(VH).mul(dT).div(dT.add(D0));
      const scT = float(VH).sub(vT).div(VH);
      const tside = step(0.5, hash(idx.add(7.3))).mul(2).sub(1);
      const X = curveT(t).add(tside.mul(hash(idx.add(2.1)).mul(1.2).add(W + 0.7)));
      const xs = X.sub(camX).mul(K).mul(scT).add(0.5);
      const tw = scT.mul(0.22), th = tw.mul(ASPECT * 1.33);          // the sprite: 192 x 256
      const tuv = vec2(p.x.sub(xs).div(tw).mul(tside).add(0.5), v.sub(vT).div(th));   // mirrored on one side
      const tin = step(0, tuv.x).mul(step(tuv.x, 1)).mul(step(0, tuv.y)).mul(step(tuv.y, 1));
      const lit = texture(treeTex, tuv).a.mul(tin).mul(0.85);
      col.addAssign(vec3(0.15, 0.85, 0.55).mul(lit).mul(step(-1.0, dT)));
    });

    // the frosted backlight: pale grey, brighter up the middle, the red shell bleeding in from the right
    const c = p.sub(vec2(0.45, 0.6)).mul(vec2(1.0, 1.1));
    const vig = float(1).sub(c.dot(c).mul(1.3)).clamp(0.35, 1);
    const back = mix(vec3(0.5, 0.49, 0.47), vec3(0.6, 0.2, 0.19), smoothstep(0.62, 1.0, p.x).mul(0.6));   // warm pale grey (photos)
    const film = back.mul(vig).add(col.mul(1.05)).toVar();

    // the yellow car ahead (placed by the game, uRival: x centre, v bottom, width): painted on the film
    const rw = uRival.z.mul(1.0), rh = uRival.z.mul(ASPECT);   // seen more from above: a little longer
    const ruv = vec2(p.x.sub(uRival.x).div(rw).add(0.5), v.sub(uRival.y).div(rh));
    const inside = step(0, ruv.x).mul(step(ruv.x, 1)).mul(step(0, ruv.y)).mul(step(ruv.y, 1)).mul(uRival.w);
    const car = texture(rivalTex, ruv);
    const a = car.a.mul(inside);
    film.assign(mix(film, car.rgb.mul(vig.mul(0.3).add(0.85)), a.mul(0.9)));

    const unlit = film.mul(0.1).add(vec3(0.08, 0.08, 0.082));   // off: room light on the frosted panel, the film faint
    const on = mix(unlit, film, uOn.mul(float(1).sub(uFlash.mul(0.65))));
    return on;
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = color();
  material.toneMapped = false;
  return { material, uS, uOn, uFlash, uRival };
}
