// Vertex-shader terrain draping — the shared recipe for ground decals.
//
// A decal that hugs the terrain used to be built on the CPU: subdivide a plane,
// call app.getWorldHeight() per vertex, upload the buffer. That's fine once, but
// it forces a UNIQUE geometry per decal, which means a unique mesh, which means a
// draw call each. Sampling the heightmap in the vertex shader instead lets every
// decal of a kind share ONE geometry and collapse into a single instanced draw.
//
// The heightmap node comes from the v3 app handle (app.heightTexNode). It's the
// shared TSL node whose .value sculptBrush swaps to the live ping-pong RT, so a
// decal draped through it keeps tracking the ground while the terrain is edited.
import { texture, vec2, vec3, float, step } from "three/tsl";
import { WORLD_SIZE, MAX_HEIGHT } from "../../v3/terrain/heightmapTexture.js";

/**
 * World Y of the terrain at a world XZ, as a TSL node — the GPU counterpart of
 * app.getWorldHeight(). Uses the SAME world→UV mapping as terrainLOD, so a draped
 * decal can never disagree with the surface it sits on.
 *
 * @param {object} heightTexNode — app.heightTexNode
 * @param {object} wx, wz — world-space X/Z nodes
 * @param {number} lift — metres above the ground, to stay off the surface
 */
export function drapeY(heightTexNode, wx, wz, lift = 0) {
  const u = wx.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  const v = wz.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  // Clamp-to-edge would smear the border height across everything off-map;
  // outside the heightmap the terrain reads 0, so match it.
  const inBounds = step(float(0), u).mul(step(u, float(1)))
    .mul(step(float(0), v)).mul(step(v, float(1)));
  return texture(heightTexNode, vec2(u, v)).r.mul(inBounds).mul(float(MAX_HEIGHT)).add(float(lift));
}

/** Convenience: the full draped world position for a decal vertex. */
export function drapedPosition(heightTexNode, wx, wz, lift = 0) {
  return vec3(wx, drapeY(heightTexNode, wx, wz, lift), wz);
}
