// ── Horse lab: sign boards, all in ONE draw ──────────────────────────────────
// Every label of a level is packed into one canvas texture (shelf packing) and
// drawn as flat boards in one mesh: a front quad and a back quad (its u
// flipped, so the text never reads mirrored). They face a fixed direction like
// real number boards (sprites cost one draw each: 30 on the parkour).
//
//   const signs = createSigns();
//   signs.add("3 · 1.00 m", x, y, z, yaw, h);   // yaw: the way the text faces
//   signs.build(scene);
import * as THREE from "three";

export function createSigns() {
  const list = [];
  return {
    add(text, x, y, z, yaw = 0, h = 0.6) { list.push({ text, x, y, z, yaw, h }); },
    build(scene) {
      if (!list.length) return null;
      const FONT = "700 64px system-ui, sans-serif", RH = 92, PAD = 22, W = 2048;
      const cv = document.createElement("canvas"), ctx = cv.getContext("2d");
      ctx.font = FONT;
      // shelf packing
      let x = 0, y = 0;
      for (const s of list) {
        s.w = Math.ceil(ctx.measureText(s.text).width) + PAD * 2;
        if (x + s.w > W) { x = 0; y += RH + 4; }
        s.px = x; s.py = y; x += s.w + 4;
      }
      cv.width = W; cv.height = THREE.MathUtils.ceilPowerOfTwo(y + RH);
      ctx.font = FONT; ctx.textBaseline = "middle";
      for (const s of list) {
        ctx.fillStyle = "rgba(24,28,34,0.9)"; ctx.beginPath(); ctx.roundRect(s.px, s.py, s.w, RH, 18); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.fillText(s.text, s.px + PAD, s.py + RH / 2 + 3);
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      // the quads
      const pos = [], uv = [], idx = [];
      const quad = (s, back) => {
        const w = s.h * s.w / RH, hw = w / 2, hh = s.h / 2;
        const nx = Math.sin(s.yaw), nz = Math.cos(s.yaw);               // the face's normal
        const rx = back ? -nz : nz, rz = back ? nx : -nx;              // its right (viewer's right)
        const off = back ? -0.004 : 0.004;
        const u0 = s.px / cv.width, u1 = (s.px + s.w) / cv.width, v0 = 1 - (s.py + RH) / cv.height, v1 = 1 - s.py / cv.height;
        const b = pos.length / 3;
        for (const [a, c, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]]) {
          const sx = back ? -nx : nx, sz = back ? -nz : nz;
          pos.push(s.x + rx * hw * a + sx * off, s.y + hh * c, s.z + rz * hw * a + sz * off);
          uv.push(u, v);
        }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      };
      for (const s of list) { quad(s, false); quad(s, true); }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, toneMapped: false, fog: true }));
      m.name = "signs";
      scene.add(m);
      return m;
    },
  };
}
