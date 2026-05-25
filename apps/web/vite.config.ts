import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";


/** 本地开发时将根路径重定向到 GitHub Pages base */
function redirectRootPlugin(): Plugin {
  return {
    name: "redirect-root-to-base",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/" || req.url === "/index.html") {
          res.writeHead(302, { Location: "/ChattingCursor/" });
          res.end();
          return;
        }
        next();
      });
    },
  };
}


export default defineConfig({
  plugins: [react(), redirectRootPlugin()],
  base: "/ChattingCursor/",
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});
