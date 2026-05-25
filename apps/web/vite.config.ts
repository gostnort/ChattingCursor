import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";


/** 本地开发时将根路径重定向到 GitHub Pages base */
function redirectRootPlugin(): Plugin {
  return {
    name: "redirect-root-to-base",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (url === "/" || url === "/index.html") {
          res.writeHead(302, { Location: "/ChattingCursor/" });
          res.end();
          return;
        }
        if (
          url.startsWith("/ChattingCursor/local/")
          || url.endsWith("/config")
          || url.endsWith("/terminal")
        ) {
          req.url = "/ChattingCursor/";
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
    port: 43210,
    host: "127.0.0.1",
  },
});
