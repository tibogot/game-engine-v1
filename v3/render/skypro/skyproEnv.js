// SKY PRO — the sky as the scene's environment (diffuse + specular sky light), after Tidewater's sky/Environment.js
// (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE).
//
// Tidewater: a 128^2 cube of skyRadianceWithClouds( dir, withSun = false ) — the sky WITHOUT the sun
// disc (the sun arrives as the direct light) with the cloud PANORAMA composited (so a face is a
// texture lookup, not a march) — then GGX-prefiltered mips + SH9 irradiance, double-buffered, refreshed
// when the sun moves > 0.004 rad or every 3 s. Below the horizon it keeps the (near black) sky LUT and
// adds the ground's light through a separate ground-bounce map.
//
// Here (three.js): the same content into a 512x256 HDR equirect render target, handed to three as
// scene.environment; three's PMREM does the prefilter (specular) and irradiance (diffuse), re-run when
// the target is re-baked (texture.needsPMREMUpdate). Composite = the Sky Pro sky (skyBackground, no discs) x
// the clouds' transmittance + the Sky Pro panorama + the cirrus (clOver, as in the view).
// DIFFERENCE, deliberate: the lower hemisphere is the lit ground's radiance (a flat floor of the given
// albedo under the sun and the sky, times the cloud cover's mean shadow) instead of black + a bounce
// map, so a single environment lights undersides and walls. Good for flat-ish ground; a real terrain
// with its own shadows would want Tidewater's bounce map (GroundBounce.js) — not ported.

import * as THREE from "three/webgpu";
import { Fn, uniform, uv, vec3, vec4, float, cos, sin, max, mix, smoothstep } from "three/tsl";
import { clOver } from "./skyproCirrus.js";
import { STAR_REFLECTION } from "./skyproAtmosphere.js";

const W = 512, H = 256;

export function createSkyEnvironment({ renderer, atmosphere, clouds, cirrus, groundAlbedo = [0.33, 0.29, 0.22] }) {
  const rt = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  rt.texture.mapping = THREE.EquirectangularReflectionMapping;
  rt.texture.colorSpace = THREE.NoColorSpace;

  const uSunCol = uniform(new THREE.Vector3(1, 1, 1));
  const uLight = uniform(new THREE.Vector3(0, 1, 0));
  const uCloudMean = uniform(1); // mean cloud-shadow transmittance over the ground around the camera
  const uGround = uniform(new THREE.Vector3(...groundAlbedo)); // the lower hemisphere's floor albedo (live)

  // uv -> direction: the inverse of three's equirectUV (u = atan(z, x) / 2PI + 0.5, v = asin(y) / PI + 0.5),
  // written through the quad's own uv so three's sampler (which flips render targets) reads it back upright
  const bake = Fn(() => {
    const q = uv();
    const az = q.x.sub(0.5).mul(2 * Math.PI);
    const el = q.y.sub(0.5).mul(Math.PI);
    const dir = vec3(cos(el).mul(cos(az)), sin(el), cos(el).mul(sin(az))).toVar();
    // the sky without the sun disc, the clouds over it (panorama cumulus in front of the cirrus)
    const c = clOver(clouds.panoSample(dir), cirrus.sample(dir, float(2 * Math.PI / W)));
    // Tidewater skyRadianceWithClouds( dir, withSun = false ): the sky behind the clouds, no sun or moon
    // disc (they arrive as the direct light), only a trace of the stars (as its reflections)
    const sky = atmosphere.skyBackground(dir, float(STAR_REFLECTION)).mul(c.a).add(c.rgb);
    // the ground: a lit floor, Lambert (Tidewater's units: sun / PI, sky irradiance already / PI)
    const E = uSunCol.mul(max(uLight.y, 0.0)).mul(uCloudMean).div(Math.PI).add(atmosphere.irradianceNode);
    const ground = vec3(uGround).mul(E);
    return vec4(mix(ground, sky, smoothstep(-0.02, 0.0, dir.y)), 1.0);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fragmentNode = bake();
  const quad = new THREE.QuadMesh(mat);

  const lastLight = new THREE.Vector3();
  let frames = 0, baked = false;

  /** Re-bake when the key light moved (Tidewater: > 0.004 rad) or every `every` frames (clouds drift). */
  function update({ lightDir, sunColor, cloudMean = 1, groundAlbedo: ga = null, every = 90 }) {
    uSunCol.value.copy(sunColor);
    if (ga) uGround.value.set(ga[0], ga[1], ga[2]);
    uLight.value.copy(lightDir);
    uCloudMean.value = cloudMean;
    frames++;
    const moved = lightDir.angleTo(lastLight) > 0.004;
    if (baked && !moved && frames < every) return false;
    frames = 0;
    lastLight.copy(lightDir);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    renderer.setRenderTarget(prev);
    rt.texture.needsPMREMUpdate = true;
    baked = true;
    return true;
  }

  return { texture: rt.texture, update, target: rt };
}
