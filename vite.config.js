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
        editor: "v2/editor.html",
        play: "v2/play.html",
      },
    },
  },
});
