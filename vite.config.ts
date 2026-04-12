import { defineConfig } from "vite";

function fromRoot(relativePath: string): string {
  return new URL(relativePath, import.meta.url).pathname;
}

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        options: fromRoot("./options.html"),
        popup: fromRoot("./popup.html"),
        background: fromRoot("./src/background.ts"),
        content: fromRoot("./src/content.ts")
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "background" || chunkInfo.name === "content") {
            return "[name].js";
          }

          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"]
  }
});
