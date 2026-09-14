// Street furniture placed by rule from the road type — nothing hand-placed.
//
//   lamp        every type.lampSpacing m on the sidewalk / verge, sides staggered
//               (on the central barrier for divided motorways)
//   tree        every type.treeSpacing m in verges and on raised medians
//   signal      one pole per signalised approach, curb side, at the stop line
//   stopSign / yieldSign   same spot for stop / yield approaches
//
// Output items are { kind, x, z, y, th, roadId|nodeId } — plain data a 3D
// builder can instance directly.

import { evalAlignment } from "./roadAlignment.js";
import { layoutAt, layoutEdges } from "./roadCrossSection.js";
import { profileAt } from "./roadProfile.js";
import { armPoint } from "./roadJunction.js";

export function buildProps({ roads, nodes }) {
  const props = [];
  for (const rr of roads) {
    const type = rr.type;
    const margin = 10;
    const s0 = rr.s0 + margin, s1 = rr.s1 - margin;
    if (s1 <= s0) continue;
    const at = (s, tFn, kind, extra) => {
      const e = evalAlignment(rr.al, s);
      const lay = layoutAt(rr.stack, s, rr.L);
      const t = tFn(lay);
      if (t == null) return;
      const x = e.x + Math.sin(e.th) * t, z = e.z - Math.cos(e.th) * t;
      props.push({ kind, x, z, y: profileAt(rr.prof, s).y, th: e.th, roadId: rr.id, ...extra });
    };
    if (type.lampSpacing > 0) {
      const sp = type.lampSpacing;
      if (rr.stack.center.kind === "barrier" && rr.stack.center.width >= 1) {
        for (let s = s0; s <= s1; s += sp) at(s, () => 0, "lamp", { double: true });
      } else {
        for (const side of ["left", "right"]) {
          const off = side === "left" ? sp / 2 : 0;
          for (let s = s0 + off; s <= s1; s += sp) {
            at(s, (lay) => {
              const e = layoutEdges(lay);
              const sign = side === "left" ? 1 : -1;
              const curb = side === "left" ? e.curbL : e.curbR;
              const prop = side === "left" ? e.propL : e.propR;
              if (Math.abs(prop - curb) < 0.6) return null;
              return curb + sign * 0.7;
            }, "lamp", { side });
          }
        }
      }
    }
    if (type.treeSpacing > 0) {
      const sp = type.treeSpacing;
      for (const side of ["left", "right"]) {
        for (let s = s0 + sp / 2; s <= s1; s += sp) {
          at(s, (lay) => {
            const verge = lay[side].find((l) => l.type === "verge" && l.w > 1.0);
            return verge ? (verge.tIn + verge.tOut) / 2 : null;
          }, "tree", { side });
        }
      }
      if (rr.stack.center.kind === "raised" && rr.stack.center.width >= 3) {
        for (let s = s0 + sp / 4; s <= s1; s += sp) at(s, (lay) => (lay.cw >= 3 ? 0 : null), "tree", { side: "median" });
      }
    }
  }
  for (const node of nodes) {
    node.arms.forEach((a, armIndex) => {
      if (a.control === "none" || a.stopStation == null) return;
      const kind = a.control === "signal" ? "signal" : a.control === "stop" ? "stopSign" : "yieldSign";
      const s = node.kind === "roundabout" ? a.trim + 1 : a.stopStation + 0.6;
      const [x, z] = armPoint(a, s, a.edges.curbL + 0.7);
      props.push({ kind, x, z, y: node.y, th: a.th + Math.PI, nodeId: node.id, armIndex });
    });
  }
  return props;
}
