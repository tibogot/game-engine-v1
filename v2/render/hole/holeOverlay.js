import * as THREE from "three";
import { chunkMinWorldX, chunkMinWorldZ, parseChunkKey } from "../../core/terrain/chunkMath.js";

export class HoleOverlay {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.group = new THREE.Group();
    this.group.renderOrder = 10;
    scene.add(this.group);
    /** @type {Map<string, THREE.Mesh>} */
    this.meshes = new Map();
    this._sharedGeo = new THREE.PlaneGeometry(
      config.world.chunkSize,
      config.world.chunkSize,
      1,
      1,
    );
    this._sharedGeo.rotateX(-Math.PI / 2);
    const uvs = this._sharedGeo.attributes.uv;
    for (let i = 0; i < uvs.count; i++) uvs.setY(i, 1 - uvs.getY(i));
  }

  sync(holeStore, visible, opacity) {
    this.group.visible = visible;
    if (!visible) return;

    for (const [key, entry] of holeStore.chunks) {
      let mesh = this.meshes.get(key);
      if (!mesh) {
        const mat = new THREE.MeshBasicMaterial({
          map: entry.tex,
          transparent: true,
          opacity,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          toneMapped: false,
          color: 0x111111,
        });
        mat.fog = false;
        mesh = new THREE.Mesh(this._sharedGeo, mat);
        const { cx, cz } = parseChunkKey(key);
        const cs = this.config.world.chunkSize;
        mesh.position.set(
          chunkMinWorldX(cx, this.config) + cs * 0.5,
          0.55,
          chunkMinWorldZ(cz, this.config) + cs * 0.5,
        );
        mesh.renderOrder = 10;
        this.group.add(mesh);
        this.meshes.set(key, mesh);
      } else {
        mesh.material.opacity = opacity;
      }
    }
  }

  clear() {
    for (const mesh of this.meshes.values()) {
      mesh.material.dispose();
      this.group.remove(mesh);
    }
    this.meshes.clear();
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this._sharedGeo.dispose();
  }
}
