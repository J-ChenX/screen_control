import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { readSettings } from "./config/environment.ts";

function origin(value: string | undefined): string {
  if (!value) return "";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SCREEN_CONTROL origin must be an exact HTTP(S) origin");
  }
  return url.origin;
}

function canonicalRedirect(canonicalDevOrigin: string, canonicalPreviewOrigin: string): Plugin {
  const install = (server: ViteDevServer | PreviewServer, canonicalOrigin: string) => {
    server.middlewares.use((request, response, next) => {
      const incoming = request as unknown as { headers: Record<string, string | string[] | undefined>; url?: string };
      const host = Array.isArray(incoming.headers.host) ? incoming.headers.host[0] : incoming.headers.host;
      const accept = Array.isArray(incoming.headers.accept) ? incoming.headers.accept.join(",") : incoming.headers.accept;
      const hostname = (host ?? "").split(":", 1)[0];
      const isLoopback = hostname === "127.0.0.1" || hostname === "localhost";
      const isNavigation = accept?.includes("text/html") ?? false;
      if (!canonicalOrigin || !isLoopback || !isNavigation || host === new URL(canonicalOrigin).host) {
        next();
        return;
      }
      response.statusCode = 308;
      response.setHeader("Location", `${canonicalOrigin}${incoming.url ?? "/"}`);
      response.end();
    });
  };
  return {
    name: "screen-control-canonical-origin",
    configureServer(server) { install(server, canonicalDevOrigin); },
    configurePreviewServer(server) { install(server, canonicalPreviewOrigin); },
  };
}

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:8787",
    changeOrigin: false,
    ws: true,
  },
};

export default defineConfig(() => {
  // 仅用于服务端配置。禁止通过 VITE_* 或 define 暴露私有设置。
  const env = readSettings(process.env, fileURLToPath(new URL("../.env", import.meta.url)));
  const devOrigin = origin(env.SCREEN_CONTROL_DEV_ORIGIN);
  const previewOrigin = origin(env.SCREEN_CONTROL_PREVIEW_ORIGIN);
  const hosts = (value: string) => value ? [new URL(value).hostname] : [];
  return {
  plugins: [canonicalRedirect(devOrigin, previewOrigin), react()],
  server: { proxy: apiProxy, allowedHosts: hosts(devOrigin) },
  preview: { proxy: apiProxy, allowedHosts: hosts(previewOrigin) },
  build: {
    outDir: "../dist/portal",
    emptyOutDir: true,
  },
  };
});
