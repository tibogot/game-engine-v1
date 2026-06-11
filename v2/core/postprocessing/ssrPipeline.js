import * as THREE from "three";
import {
  pass,
  mrt,
  output,
  normalView,
  metalness,
  roughness,
  vec2,
  sample,
  directionToColor,
  colorToDirection,
} from "three/tsl";
import { ssr } from "three/addons/tsl/display/SSRNode.js";

export class SSRPipeline {
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    // SSR parameters - tuned for racing game (car reflection on road)
    this.params = {
      quality: 0.35,      // Lower = faster, still good for nearby reflections
      blurQuality: 1,     // Minimal blur passes
      maxDistance: 0.4,   // Only trace nearby (car is close to road)
      opacity: 0.8,       // Blend factor
      thickness: 0.02,    // Depth tolerance
    };

    this._initPipeline();
  }

  _initPipeline() {
    const { renderer, scene, camera } = this;

    // Create render pipeline
    this.renderPipeline = new THREE.RenderPipeline(renderer);

    // Scene pass with MRT (Multiple Render Targets)
    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt({
        output: output,
        normal: directionToColor(normalView),
        metalrough: vec2(metalness, roughness),
      })
    );

    // Get texture nodes
    const scenePassColor = scenePass.getTextureNode("output");
    const scenePassNormal = scenePass.getTextureNode("normal");
    const scenePassDepth = scenePass.getTextureNode("depth");
    const scenePassMetalRough = scenePass.getTextureNode("metalrough");

    // Optimize bandwidth with lower precision
    const normalTexture = scenePass.getTexture("normal");
    normalTexture.type = THREE.UnsignedByteType;

    const metalRoughTexture = scenePass.getTexture("metalrough");
    metalRoughTexture.type = THREE.UnsignedByteType;

    // Convert normals from color to direction
    const sceneNormal = sample((uv) => {
      return colorToDirection(scenePassNormal.sample(uv));
    });

    // Create SSR pass
    this.ssrPass = ssr(
      scenePassColor,
      scenePassDepth,
      sceneNormal,
      scenePassMetalRough.r, // metalness
      scenePassMetalRough.g  // roughness
    );

    // Store for toggling
    this.scenePass = scenePass;
    this.scenePassColor = scenePassColor;

    // Output with SSR blended (SSR outputs premultiplied color)
    this.outputWithSSR = scenePassColor.add(this.ssrPass.rgb);
    this.outputWithoutSSR = scenePassColor;

    // Set initial output
    this.renderPipeline.outputNode = this.outputWithSSR;

    // Apply initial parameters
    this._updateParams();
  }

  _updateParams() {
    const { ssrPass, params } = this;
    ssrPass.quality.value = params.quality;
    ssrPass.blurQuality.value = params.blurQuality;
    ssrPass.maxDistance.value = params.maxDistance;
    ssrPass.opacity.value = params.opacity;
    ssrPass.thickness.value = params.thickness;
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (enabled) {
      this.renderPipeline.outputNode = this.outputWithSSR;
    } else {
      this.renderPipeline.outputNode = this.outputWithoutSSR;
    }
    this.renderPipeline.needsUpdate = true;
  }

  setQuality(quality) {
    this.params.quality = quality;
    this.ssrPass.quality.value = quality;
  }

  setMaxDistance(dist) {
    this.params.maxDistance = dist;
    this.ssrPass.maxDistance.value = dist;
  }

  setOpacity(opacity) {
    this.params.opacity = opacity;
    this.ssrPass.opacity.value = opacity;
  }

  setThickness(thickness) {
    this.params.thickness = thickness;
    this.ssrPass.thickness.value = thickness;
  }

  render() {
    this.renderPipeline.render();
  }

  dispose() {
    // Cleanup if needed
  }
}
