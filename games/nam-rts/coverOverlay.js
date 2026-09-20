/**
 * THE COVER OVERLAY — showing the player ground they cannot see.
 *
 * Cover and concealment are the two rules on this map with no visual tell.
 * A unit that stops firing because a treeline swallowed its target looks
 * BROKEN rather than outplayed, and a player who cannot see which ground is
 * worth standing on will not fight for it. Company of Heroes solves this by
 * painting cover onto the terrain near the cursor, and so does this.
 *
 * ── LOCAL, NOT MAP-WIDE ─────────────────────────────────────────────────────
 *
 * A disc around the cursor, not the whole map. Two thirds of nam-valley grants
 * some concealment, so a map-wide repaint would be a green wash that says
 * nothing and hides the battle underneath it. The question a player is
 * actually asking is never "where is cover in general" — it is "what is the
 * ground like WHERE I AM ABOUT TO SEND THESE MEN", which is a circle a few
 * dozen metres across around the pointer.
 *
 * ── TWO COLOURS, BECAUSE THEY ARE TWO RULES ─────────────────────────────────
 *
 * Green for hard cover (you survive), cyan for concealment (you are not seen).
 * One colour for both would undo the distinction cover.js exists to make, and
 * a player would learn "green = good" instead of the two different things
 * green would have to mean.
 *
 * ── HELD, NOT TOGGLED ───────────────────────────────────────────────────────
 *
 * Hold V. A toggle gets left on and becomes wallpaper; a held key is asked for
 * at the moment the question arises and gets out of the way immediately after.
 * The key is matched on `e.key` — the PRINTED label — so it is the same V on
 * an AZERTY keyboard as on a QWERTY one.
 *
 * ── ONE RAYCAST PER FRAME ───────────────────────────────────────────────────
 *
 * The pointer position is recorded on move and turned into a ground point once
 * per frame in update(), rather than raycast on every pointermove. Mouse moves
 * arrive faster than frames and every one of them would be a raycast whose
 * answer is thrown away by the next.
 */
import * as THREE from "three";
import { Fn, float, max, mix, positionLocal, smoothstep, texture, uniform, varying, vec2 } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";
import { WORLD_SIZE } from "../../v3/engine.js";

/** How far around the cursor the ground is revealed, metres. */
const RADIUS = 46;
/** Subdivision. The disc drapes per vertex, so this is how closely it hugs. */
const SUBDIV = 56;

const COVER_COLOR = new THREE.Color(0x49e06a);   // you survive here
const CONCEAL_COLOR = new THREE.Color(0x3fd0d8); // you are not seen here

/**
 * @param {object} o
 *   app     engine handle (scene, renderer, heightTexNode, pickWorldAtClient)
 *   cover   createCover() — for its overlayTex
 *   isArmed () => should the overlay be allowed to show at all
 */
export function createCoverOverlay({ app, cover, isArmed = () => true }) {
  const dom = app.renderer.domElement;

  const uCenter = uniform(new THREE.Vector3());
  const uFade = uniform(0);          // 0..1, eased so it does not snap on
  const uCoverCol = uniform(COVER_COLOR.clone());
  const uConcealCol = uniform(CONCEAL_COLOR.clone());

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
  mat.name = "CoverOverlay";

  // World XZ and the distance from the disc's centre both have to reach the
  // fragment stage as VARYINGS. positionLocal is a vertex attribute; reading
  // it from a colour node is not the way to get an interpolated value.
  const vWorld = varying(vec2(0), "v_cov_w");
  const vRadial = varying(float(0), "v_cov_r");

  mat.positionNode = Fn(() => {
    const wx = positionLocal.x.add(uCenter.x);
    const wz = positionLocal.z.add(uCenter.z);
    vWorld.assign(vec2(wx, wz));
    vRadial.assign(positionLocal.xz.length().div(float(RADIUS)));
    // Lifted a little more than the crater decals so it reads ON TOP of them.
    return drapedPosition(app.heightTexNode, wx, wz, 0.25);
  })();

  /** What the ground under this pixel offers: cover 0..1, concealment 0..1. */
  const sampleHere = Fn(() => {
    const uv = vWorld.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
    const s = texture(cover.overlayTex, uv);
    // Below these floors the ground is not worth marking; without them the
    // whole disc glows faintly everywhere and stops meaning anything.
    return vec2(
      smoothstep(float(0.12), float(0.55), s.r),
      smoothstep(float(0.15), float(0.60), s.g),
    );
  });

  mat.colorNode = Fn(() => {
    const v = sampleHere();
    // Hard cover WINS where both are present. It is the stronger promise — it
    // keeps you alive rather than merely unseen — and blending the two would
    // produce a third colour that means neither.
    return mix(uConcealCol, uCoverCol, smoothstep(float(0.0), float(0.35), v.x));
  })();

  // ALPHA GOES THROUGH opacityNode, NOT through colorNode's .w.
  //
  // A node material's colorNode feeds diffuseColor.RGB only; its alpha is
  // discarded and the material's own opacity used instead. Returning
  // vec4(col, a) from colorNode therefore produced a disc at opacity 1 —
  // which, combined with it being parked at the world origin, is why the first
  // version appeared to render nothing at all rather than looking wrong.
  mat.opacityNode = Fn(() => {
    const v = sampleHere();
    // A soft rim, so the disc reads as a light being shone rather than as a
    // decal with an edge.
    const rim = float(1).sub(smoothstep(float(0.55), float(1.0), vRadial));
    // Cover reads STRONGER than concealment. Cover is rare and decisive —
    // eight percent of this map — while concealment covers two thirds of it,
    // so equal weights made the cyan a wash that buried the green inside it.
    // The overlay has to answer "where is the good ground" at a glance, and at
    // equal strength the rarer answer is the one that gets lost.
    const a = max(v.x, v.y.mul(0.62));
    return a.mul(rim).mul(uFade).mul(0.38);
  })();

  const geo = new THREE.PlaneGeometry(RADIUS * 2, RADIUS * 2, SUBDIV, SUBDIV).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 44;     // after the crater decals (42), before the smoke
  mesh.visible = false;
  mesh.name = "CoverOverlay";
  app.scene.add(mesh);

  let held = false;
  let pinned = false;        // the dev panel's always-on
  let px = 0, py = 0, havePointer = false;

  const onMove = (e) => { px = e.clientX; py = e.clientY; havePointer = true; };
  const onDown = (e) => { if (e.key?.toLowerCase() === "v" && !e.repeat) held = true; };
  const onUp = (e) => { if (e.key?.toLowerCase() === "v") held = false; };
  // Releasing V while the window is not focused never arrives, so the overlay
  // would be stuck on when the player came back.
  const onBlur = () => { held = false; };

  dom.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", onBlur);

  /** Somewhere sensible to point when the pointer has not been seen yet. */
  let fallback = null;

  return {
    mesh,
    /** Where to centre the disc before the pointer has moved (the selection). */
    setFallback(x, z) { fallback = { x, z }; },
    /** PER FRAME. Not the sim: this decides nothing, it only draws. */
    update(dt) {
      const want = (held || pinned) && isArmed();
      // Ease rather than snap. The overlay appears while the player is already
      // moving the mouse, and an instant full-strength wash under a moving
      // cursor reads as a flash.
      const target = want ? 1 : 0;
      uFade.value += (target - uFade.value) * Math.min(1, dt * 14);
      if (uFade.value < 0.01) { mesh.visible = false; return; }

      if (want) {
        const hit = havePointer ? app.pickWorldAtClient?.(px, py) : null;
        if (hit) uCenter.value.set(hit.point.x, 0, hit.point.z);
        // Without this the disc sits at the world ORIGIN until the mouse
        // happens to move — which on a map whose action is 300 m away means
        // the overlay is on, costing frames, and nowhere near the screen.
        else if (fallback) uCenter.value.set(fallback.x, 0, fallback.z);
      }
      mesh.visible = true;
    },
    setPinned(v) { pinned = !!v; },
    get pinned() { return pinned; },
    dispose() {
      dom.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      app.scene.remove(mesh);
      geo.dispose(); mat.dispose();
    },
  };
}
