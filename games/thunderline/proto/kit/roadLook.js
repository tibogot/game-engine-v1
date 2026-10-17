// Road look v0 (PIECES.md §5). One material for every road piece; what a face is (deck, kerb, side,
// underside) and what it does (lip, landing, chevron, boost) come from vertex attributes, so the
// whole track is one material and one shader. No textures (the 16-sampler lesson).
//   deck: dark asphalt, fine streaks ALONG the road, white edge lines (the Apex Rush screenshot target)
//   kerb: blocks every 4 m — the speed rhythm the old guardrail posts gave, for no geometry
//   marks: kicker lips orange, landings white bars, brake turns orange chevrons, boost glowing blue
import * as THREE from "three";
import {
  attribute, uv, vec3, float, color, mix, abs, min, fract, step, smoothstep, fwidth, select, oneMinus, mx_noise_float,
} from "three/tsl";

export const LOOK = {
  asphalt: 0x23262d, line: 0xf2f4f7, kerbA: 0xf2f4f7, kerbB: 0x2bb8ff, side: 0x15203a, under: 0x4a5468,
  signal: 0xff7a1a, bolt: 0x3fd2ff,
};

export function createRoadLook() {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const zone = attribute("zone", "float");
  const mark = attribute("mark", "float");
  const u = uv().x;
  const v = uv().y; // metres along the piece

  // ---- deck ----
  const streak = mx_noise_float(vec3(u.mul(120), v.mul(0.06), 0)).mul(0.5).add(0.5);
  const grain = mx_noise_float(vec3(u.mul(500), v.mul(3), 7)).mul(0.5).add(0.5);
  const asphalt = color(LOOK.asphalt).mul(streak.mul(0.55).add(0.72)).mul(grain.mul(0.3).add(0.85));
  // antialiased bands: 1 inside [c - w, c + w] along `x`
  const band = (x, c, w) => {
    const d = abs(x.sub(c));
    const aa = fwidth(x).mul(0.75);
    return oneMinus(smoothstep(w.sub(aa), w.add(aa), d));
  };
  const edges = band(u, float(0.022), float(0.006)).add(band(u, float(0.978), float(0.006))).min(1);
  let deck = mix(asphalt, color(LOOK.line), edges);

  // marks
  const lipStripes = step(0.5, fract(v.mul(0.5).add(u.mul(5))));
  const landingBars = step(0.72, fract(v.div(6)));
  const chevrons = step(0.72, fract(v.div(7).add(abs(u.sub(0.5)).mul(1.6))));
  const boostChev = step(0.6, fract(v.div(4).add(abs(u.sub(0.5)).mul(1.2))));
  const inner = band(u, float(0.5), float(0.43)); // keep the edge lines clear of marks
  const isMark = (k) => step(abs(mark.sub(k)), 0.5);
  deck = mix(deck, color(LOOK.signal), isMark(1).mul(lipStripes).mul(inner));
  deck = mix(deck, color(LOOK.line).mul(0.85), isMark(2).mul(landingBars).mul(inner));
  deck = mix(deck, color(LOOK.signal), isMark(3).mul(chevrons).mul(inner).mul(0.9));
  deck = mix(deck, color(LOOK.bolt), isMark(4).mul(boostChev).mul(inner));

  // ---- kerb: 4 m blocks ----
  const kerb = mix(color(LOOK.kerbA), color(LOOK.kerbB), step(0.5, fract(v.div(8))));
  // ---- side and underside (seen from below while flying): ribs every 4 m ----
  const ribs = band(fract(v.div(4)), float(0.5), float(0.06));
  const under = mix(color(LOOK.under), color(LOOK.under).mul(0.55), ribs);
  const side = color(LOOK.side);

  // ---- barrier (guarded pieces): white panel, a bolt-blue band, post marks every 4 m (speed rhythm) ----
  const posts = band(fract(v.div(4)), float(0.5), float(0.025));
  const stripe = band(u, float(0.62), float(0.11));
  const barrier = mix(mix(color(LOOK.line).mul(0.82), color(LOOK.kerbB), stripe), color(LOOK.side), posts.mul(0.85));
  const barrierTop = color(LOOK.under).mul(1.4);

  m.colorNode = select(zone.lessThan(0.5), deck, select(zone.lessThan(1.5), kerb, select(zone.lessThan(2.5), side,
    select(zone.lessThan(3.5), under, select(zone.lessThan(4.5), barrier, barrierTop)))));
  m.roughnessNode = select(zone.lessThan(0.5), float(0.88).sub(edges.mul(0.3)), float(0.55));
  m.emissiveNode = color(LOOK.bolt).mul(isMark(4).mul(boostChev).mul(inner).mul(zone.lessThan(0.5)).mul(1.4));
  return m;
}
