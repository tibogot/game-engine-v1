import * as THREE from "three";
import { Fn, attribute, saturate, uniform } from "three/tsl";

/**
 * Daylight falling through a tunnel mouth — the shaft you can see IN THE AIR.
 *
 * ── WHY THIS ONE IS GEOMETRY AND THE HEADLIGHT BEAMS ARE A MARCH ─────────────
 * The beams next door integrate scattering along the view ray, and their file
 * says why: you orbit a car's headlights at close range from every angle, and a
 * card only looks right from the angles it was tuned at.
 *
 * A portal shaft is a different problem. Its light arrives through ONE aperture
 * of known, fixed shape, and the shaft it makes is simply that aperture swept
 * along the sun. So the volume can be BUILT instead of integrated, and once
 * built its silhouette is right from every angle for nothing — the geometry IS
 * the shaft rather than a stand-in for it. That is not the cheap way out; it is
 * the same answer, reached more cheaply, because here the shadow caster is a
 * hole rather than an arbitrary scene.
 *
 * ── WHAT THE MARCHING VERSION COST, AND THE MEASUREMENT THAT SETTLED IT ──────
 * Parked in the mouth with the hull filling the screen: 1.12 ms at native
 * resolution. The telling number was the step sweep — 8 steps cost 1.15 ms and
 * 20 cost 1.34. Two and a half times the integration for fourteen percent more
 * time, which means the marching was never the expense: the loop bound is a
 * compile-time constant and the early break does not save the GPU any work, so
 * every fragment ran all 24 iterations whatever `steps` said. The cost was the
 * depth-buffer copy plus a heavy shader over a screen-filling hull, and there
 * was nothing left to tune. It also needed a dither to hide its banding, and
 * the dither was visible.
 *
 * ── HOW THE THICKNESS IS FAKED, AND WHY IT READS ─────────────────────────────
 * A volume looks like a volume because you see more of it through the middle
 * than at the edge. Rather than integrate that, the shaft is several NESTED
 * shells — the full aperture, then progressively smaller ones about the same
 * axis — each drawn additively at a fraction of the brightness. A sight line
 * through the centre crosses every shell; one grazing the rim crosses only the
 * outermost. The sum is a smooth falloff to the edge, which is what the
 * integral gives anyway, at a few hundred triangles and no per-pixel work.
 *
 * Two things fall out of building it rather than marching it. Depth testing can
 * stay ON, so the road, the walls and the traffic occlude the shaft properly —
 * the marching version could not afford that, because it shaded a hull's back
 * faces and would have been culled by the road it pointed at. And the far end
 * is clipped PER VERTEX to the carriageway, so the shaft lies down on the road
 * in a pool the way a real one does instead of ending in a flat wall.
 *
 * The one thing genuinely lost: a car standing in the shaft does not cut a
 * shadow through it. That needs the shadow map at every step, and it is not
 * worth 1.2 ms in a tunnel mouth.
 */

export const PORTAL_SHAFT_DEFAULTS = {
  /** Longest the shaft can be before the floor clip takes over, metres. */
  reach: 46,
  /**
   * Nested shells. More is smoother, and costs triangles rather than fill.
   *
   * Each one is a closed tube, so crossing it adds twice its weight — which
   * makes the profile across the shaft a staircase with this many steps. At 5
   * the steps were plainly visible as concentric arcs inside the mouth. 12
   * costs about 600 triangles, which is nothing, and the staircase disappears.
   */
  shells: 12,
  /** How far in the innermost shell sits, as a fraction of the aperture. */
  innerScale: 0.10,
  /**
   * Overall brightness, before the per-shell split.
   *
   * Low, because every shell adds: the sum through the middle is the whole of
   * it. At 0.5 the mouth went milky and swallowed the arch behind it.
   */
  intensity: 0.16,
  /** Curve on the fade along the shaft. 1 is a linear ramp and reads as a
   *  decal; 2 reads as air thinning out. */
  fadePower: 2.0,
  color: "#fff3dc",
  /**
   * How far the sun must move before the volume is rebuilt, as a chord on the
   * unit sphere. ~0.6 degrees: well below anything visible, and it keeps the
   * rebuild to a few times a minute instead of sixty times a second.
   */
  rebuildAngle: 0.01,
};

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./modularRoadCityUnderpass.js").underpassLayout>} opts.layout
 * @param {{inner: {x: number, y: number}[]}} opts.profiles the vault's own bore
 */
export function createPortalShafts({ layout, profiles, params = {} }) {
  if (!layout || !profiles?.inner?.length) return null;
  const P = { ...PORTAL_SHAFT_DEFAULTS, ...params };

  /*
   * THE APERTURE IS THE VAULT'S OWN BORE, closed into a loop. Taking it from
   * the profile the tunnel was actually swept from — rather than rebuilding the
   * formula here — is the rule the headwall follows too, for the same reason:
   * an aperture that disagrees with the hole puts light through concrete.
   */
  const rim = profiles.inner.map((q) => ({ x: q.x, y: q.y }));
  if (rim.length > 2) rim.push({ ...rim[0] });
  let cx = 0, cy = 0;
  for (const q of rim) { cx += q.x; cy += q.y; }
  cx /= rim.length; cy /= rim.length;

  const uIntensity = uniform(P.intensity);
  const uColor = uniform(new THREE.Color(P.color));
  const uPower = uniform(P.fadePower);

  /*
   * ── THE SHADER, WHICH IS FOUR LINES ────────────────────────────────────────
   *
   * Everything expensive was decided on the CPU when the volume was built.
   * `aFade` is 1 at the mouth and 0 at the far end; `aShell` is this shell's
   * share of the brightness. Both interpolate, so the falloff and the soft edge
   * come out of the rasteriser for free and — unlike a march — carry no noise
   * that has to be dithered away.
   */
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "CityPortalShaft";
  mat.colorNode = Fn(() => {
    const fade = saturate(attribute("aFade", "float"));
    const shell = attribute("aShell", "float");
    return uColor.mul(uIntensity).mul(fade.pow(uPower)).mul(shell);
  })();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.blending = THREE.AdditiveBlending;
  mat.fog = false;

  const group = new THREE.Group();
  group.name = "CityPortalShafts";
  const portals = [];
  for (const [along, into] of [[layout.cov0, 1], [layout.cov1, -1]]) {
    const geo = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "CityPortalShaft";
    // Rebuilt in place and its bounds swing with the sun, so leave culling to
    // the tunnel around it rather than to a sphere that is wrong half the day.
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    mesh.visible = false;
    group.add(mesh);
    portals.push({ along, into, geo, mesh });
  }

  const _sd = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _last = new THREE.Vector3(0, 0, 0);
  const _v0 = new THREE.Vector3();
  const _v1 = new THREE.Vector3();
  let lastStrength = -1;

  const atRim = (along, x, y, out) => out.set(
    layout.axis === "x" ? along : layout.across + x,
    layout.roadY + y,
    layout.axis === "x" ? layout.across + x : along,
  );

  function rebuild(portal, dir, strength) {
    const { along, geo } = portal;
    const n = rim.length;
    const shells = Math.max(1, Math.round(P.shells));
    const pos = [], fade = [], shell = [], idx = [];

    for (let s = 0; s < shells; s++) {
      const k = shells === 1 ? 0 : s / (shells - 1);
      const scale = 1 - k * (1 - P.innerScale);
      const w = strength / shells;
      const base = pos.length / 3;

      for (let i = 0; i < n; i++) {
        const q = rim[i];
        atRim(along, cx + (q.x - cx) * scale, cy + (q.y - cy) * scale, _v0);
        /*
         * HOW LONG THIS RIB IS. Light travels along -sun, so the shaft runs
         * that way in from the mouth, stopping at `reach` or sooner where it
         * meets the carriageway. Clipping PER VERTEX is what lays the far end
         * down on the road as a pool rather than ending it in a flat wall.
         */
        let len = P.reach;
        if (dir.y < -1e-3) len = Math.min(len, (layout.roadY + 0.03 - _v0.y) / dir.y);
        len = Math.max(0, len);
        _v1.copy(_v0).addScaledVector(dir, len);

        pos.push(_v0.x, _v0.y, _v0.z, _v1.x, _v1.y, _v1.z);
        fade.push(1, 0);
        shell.push(w, w);
      }
      for (let i = 0; i + 1 < n; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
    }

    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("aFade", new THREE.Float32BufferAttribute(fade, 1));
    geo.setAttribute("aShell", new THREE.Float32BufferAttribute(shell, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
  }

  return {
    group,
    stats: { draws: portals.length },
    /**
     * Point the shafts at the sun. Safe to call every frame: it rebuilds only
     * when the sun has actually moved, which on a day/night cycle is a few
     * times a minute.
     *
     * `strength` is how much sun there is — zero below the horizon, so a shaft
     * cannot hang in a midnight tunnel.
     */
    setSun(v, strength = 1) {
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return;
      _sd.copy(v);
      if (!(_sd.lengthSq() > 1e-8)) return;
      _sd.normalize();
      const moved = _sd.distanceToSquared(_last) > P.rebuildAngle * P.rebuildAngle;
      if (!moved && Math.abs(strength - lastStrength) < 0.02) return;
      _last.copy(_sd);
      lastStrength = strength;
      _dir.copy(_sd).multiplyScalar(-1);          // light travels away from the sun
      for (const p of portals) {
        /*
         * A SHAFT ONLY EXISTS AT THE MOUTH THE SUN CAN SEE INTO. `into` is
         * which way the tunnel runs from this portal, so the light has to have
         * a component that way or it is shining out of the mouth, not in — and
         * that is the far portal's shaft, not this one's.
         */
        const axial = layout.axis === "x" ? _dir.x * p.into : _dir.z * p.into;
        const lit = strength > 0.01 && axial > 0.02;
        p.mesh.visible = lit;
        if (lit) rebuild(p, _dir, strength);
      }
    },
    setParams(next = {}) {
      if (next.intensity != null) uIntensity.value = next.intensity;
      if (next.fadePower != null) uPower.value = next.fadePower;
      if (next.color != null) uColor.value.set(next.color);
      lastStrength = -1;                          // force the next setSun through
    },
    dispose() {
      for (const p of portals) p.geo.dispose();
      mat.dispose();
    },
  };
}
