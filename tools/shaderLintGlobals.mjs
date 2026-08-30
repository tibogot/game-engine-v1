// Browser + WebGL/WebGPU globals the shader modules legitimately reach for.
// Kept as a plain map so the linter needs no extra dependency beyond eslint
// itself — `globals` the package would be a second one for a dozen names.
export default Object.fromEntries([
  // Core browser
  "window", "document", "console", "navigator", "location", "performance",
  "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "queueMicrotask", "structuredClone",
  "fetch", "Request", "Response", "Headers", "AbortController", "URL",
  "URLSearchParams", "Blob", "File", "FileReader", "FormData",
  "localStorage", "sessionStorage", "indexedDB", "crypto",
  "Image", "ImageData", "ImageBitmap", "createImageBitmap", "OffscreenCanvas",
  "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "HTMLInputElement",
  "CustomEvent", "Event", "EventTarget", "KeyboardEvent", "PointerEvent",
  "MouseEvent", "WheelEvent", "ResizeObserver", "MutationObserver",
  "Worker", "MessageChannel", "BroadcastChannel", "self", "globalThis",
  "TextEncoder", "TextDecoder", "DOMParser", "XMLHttpRequest",
  "innerWidth", "innerHeight", "devicePixelRatio", "matchMedia",
  "getComputedStyle", "alert", "confirm", "prompt", "atob", "btoa",
  "AudioContext", "GPUShaderStage", "GPUBufferUsage", "GPUTextureUsage",
  "WebGL2RenderingContext", "WebGLRenderingContext",
  "process",
].map((k) => [k, "readonly"]));
