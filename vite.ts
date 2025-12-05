import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createLogger, createServer as createViteServer } from "vite";

// Attempt to dynamically load a root-level Vite config if present. Static import
// causes Node to throw when the file is missing, so use dynamic import with
// fallbacks for common extensions. If no config is found, return an empty
// object so the server can still run in development mode without the client.
async function loadRootViteConfig(): Promise<Record<string, any>> {
  const root = path.resolve(import.meta.dirname, "..");
  const candidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

  for (const name of candidates) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) {
      try {
        // Use file:// URL for dynamic import
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = await import(pathToFileURL(p).href);
        return mod.default ?? mod;
      } catch (e) {
        // If import failed, log and continue to next candidate
        viteLogger.warn(`Failed to import ${p}: ${(e as Error).message}`);
      }
    }
  }

  return {};
}

// helper to get file:// URL
import { pathToFileURL } from "url";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  // If the client index.html isn't present (standalone server), don't attempt to create a Vite server
  const clientTemplate = path.resolve(import.meta.dirname, "..", "client", "index.html");
  if (!fs.existsSync(clientTemplate)) {
    viteLogger.warn(`client index.html not found at ${clientTemplate}, serving placeholder pages`);

    // minimal middleware so API still works and root route returns a helpful page
    app.use("*", (_req, res) => {
      res
        .status(200)
        .set({ "Content-Type": "text/html" })
        .end(`<!doctype html><html><head><meta charset="utf-8"><title>SLAB Server</title></head><body><h1>SLAB server running (no client present)</h1><p>The server is running in development mode but the frontend files were not found. Place the frontend next to the server in a folder named <code>client</code> to enable the full app.</p></body></html>`);
    });

    return;
  }

  try {
    const rootViteConfig = await loadRootViteConfig();

    const vite = await createViteServer({
      ...rootViteConfig,
      configFile: false,
      customLogger: {
        // Use Vite's logger but avoid forcing the node process to exit
        ...viteLogger as any,
        error: (msg: any, options?: any) => {
          viteLogger.error(msg as any, options);
        },
      },
      server: serverOptions,
      appType: "custom",
    });

    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      const url = req.originalUrl;

      try {
        // always reload the index.html file from disk incase it changes
        let template = await fs.promises.readFile(clientTemplate, "utf-8");
        template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${nanoid()}"`);
        const page = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(page);
      } catch (e) {
        try { vite.ssrFixStacktrace(e as Error); } catch { }
        next(e);
      }
    });
  } catch (err) {
    viteLogger.error("Failed to create Vite server, falling back to placeholder frontend.", err as any);
    app.use("*", (_req, res) => {
      res
        .status(200)
        .set({ "Content-Type": "text/html" })
        .end(`<!doctype html><html><head><meta charset="utf-8"><title>SLAB Server</title></head><body><h1>SLAB server running (vite failed)</h1><p>Vite failed to start; the server continues to run but the frontend is unavailable. Check server logs for details.</p></body></html>`);
    });
  }
}

export function serveStatic(app: Express): boolean {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    log(
      `[static] Skipping client assets - build directory not found at ${distPath}`,
      "express",
    );
    return false;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });

  log(`[static] Serving client assets from ${distPath}`, "express");
  return true;
}
