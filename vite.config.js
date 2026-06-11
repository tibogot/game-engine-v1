import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^three$/,
        replacement: "three/webgpu",
      },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        editor: "v2/editor.html",
        play: "v2/play.html",
      },
    },
  },
});
