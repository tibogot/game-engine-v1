// ESM resolve hook: bare `three` -> `three/webgpu`.
//
// vite.config.js aliases these for the app (`find: /^three$/` ->
// `three/webgpu`), so every module in this repo says `from "three"` and means
// the WebGPU build. Node has no idea about that alias and hands back the core
// build, where `MRTNode`, the NodeMaterial classes and the TSL entry points do
// not exist — so anything touching a node material dies at import time with
// "Class extends value undefined".
//
// Tests used to work around it by rewriting the module text into a temp file and
// stubbing whatever exploded. That tests the stub. This resolves the same module
// graph the browser gets, so headless tests exercise the real materials.
//
// Usage, before any dynamic import of engine code:
//     import { register } from "node:module";
//     register("./threeWebgpuHook.mjs", import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier === "three") return next("three/webgpu", context);
  return next(specifier, context);
}
