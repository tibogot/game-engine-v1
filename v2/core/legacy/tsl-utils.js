/**
 * TSL noise and matrix helpers — shared by grass and terrain materials.
 * Used by index.html (terrain) and grass.js (grass blades).
 */
import {
  Fn,
  vec2,
  vec3,
  vec4,
  floor,
  fract,
  sin,
  cos,
  dot,
  mix,
  pow,
  sub,
  add,
  mul,
  negate,
  normalize,
  clamp,
  mat3,
} from "three/tsl";

export const hash12 = Fn(([p]) =>
  fract(sin(dot(vec2(p), vec2(127.1, 311.7))).mul(43758.5453)),
);
export const noise12 = Fn(([p_in]) => {
  const p = vec2(p_in),
    i = floor(p),
    f = fract(p),
    u = f.mul(f).mul(sub(3.0, f.mul(2.0)));
  return mix(
    mix(hash12(i), hash12(add(i, vec2(1, 0))), u.x),
    mix(hash12(add(i, vec2(0, 1))), hash12(add(i, vec2(1, 1))), u.x),
    u.y,
  );
});
export const hash42 = Fn(([p_in]) => {
  const p = vec2(p_in),
    p4 = fract(
      vec4(p.x, p.y, p.x, p.y).mul(
        vec4(443.897, 441.423, 437.195, 429.123),
      ),
    ),
    d = dot(p4, p4.wzxy.add(19.19)),
    r = p4.add(d);
  return fract(r.xxyz.add(r.yzzw).mul(r.zywx));
});
export const hash22 = Fn(([p_in]) => {
  const p = vec2(p_in),
    p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(443.897, 441.423, 437.195))),
    d = dot(p3, p3.yzx.add(19.19)),
    r = p3.add(d);
  return fract(r.xx.add(r.yz).mul(r.zy));
});

export const saturate = Fn(([x]) => clamp(x, 0, 1));
export const remap = Fn(([v, a, b, c, d]) =>
  mix(c, d, sub(v, a).div(sub(b, a))),
);
export const easeOut = Fn(([x, t]) => sub(1, pow(sub(1, x), t)));
export const easeIn = Fn(([x, t]) => pow(x, t));
export const rotateY_mat = Fn(([th]) => {
  const c = cos(th),
    s = sin(th);
  return mat3(c, 0, s, 0, 1, 0, negate(s), 0, c);
});
export const rotateX_mat = Fn(([th]) => {
  const c = cos(th),
    s = sin(th);
  return mat3(1, 0, 0, 0, c, negate(s), 0, s, c);
});
export const rotateAxis_mat = Fn(([ax_in, ang]) => {
  const ax = normalize(vec3(ax_in)),
    s = sin(ang),
    c = cos(ang),
    oc = sub(1, c);
  return mat3(
    add(mul(oc, ax.x, ax.x), c),
    add(mul(oc, ax.x, ax.y), mul(ax.z, s)),
    sub(mul(oc, ax.z, ax.x), mul(ax.y, s)),
    sub(mul(oc, ax.x, ax.y), mul(ax.z, s)),
    add(mul(oc, ax.y, ax.y), c),
    add(mul(oc, ax.y, ax.z), mul(ax.x, s)),
    add(mul(oc, ax.z, ax.x), mul(ax.y, s)),
    sub(mul(oc, ax.y, ax.z), mul(ax.x, s)),
    add(mul(oc, ax.z, ax.z), c),
  );
});
