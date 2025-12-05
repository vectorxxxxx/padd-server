import "dotenv/config";
import express, { NextFunction, type Request, Response } from "express";
import fs from "fs";
import path from "path";
import { registerRoutes } from "./routes";
import { log, serveStatic, setupVite } from "./vite";

// If a service account JSON is provided via environment, write it to
// `serviceacc.json` in the current working directory and set
// `GOOGLE_APPLICATION_CREDENTIALS` so Google SDKs pick it up.
// Supported env names (checked in order):
// - SERVICE_ACCOUNT_BASE64 (base64-encoded JSON)
// - SERVICEACC_B64
// - SERVICE_JSON_B64
// - SERVICE_ACCOUNT_JSON (raw JSON string)
try {
  const candidates = [
    process.env.SERVICE_ACCOUNT_BASE64,
    process.env.SERVICEACC_B64,
    process.env.SERVICE_JSON_B64,
    process.env.SERVICE_ACCOUNT_JSON,
  ];

  const found = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
  if (found) {
    const outPath = path.resolve(process.cwd(), "serviceacc.json");

    // Heuristics: if it starts with '{' it's raw JSON, otherwise try base64 decode.
    let content: string;
    const trimmed = found.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      content = trimmed;
    } else {
      // Try to decode as base64. If decoding fails or the result is not JSON,
      // fall back to writing the original string to aid debugging.
      try {
        const decoded = Buffer.from(trimmed, "base64").toString("utf8");
        // quick JSON sanity check
        JSON.parse(decoded);
        content = decoded;
      } catch (err) {
        console.warn("SERVICE_ACCOUNT env value doesn't look like JSON and base64 decode failed — writing raw value for inspection");
        content = trimmed;
      }
    }

    fs.writeFileSync(outPath, content, { encoding: "utf8", mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = outPath;
    console.log("Wrote service account JSON from env to:", outPath);
  }
} catch (err) {
  console.error("Failed to write service account JSON from env:", err);
}

const serverOnlyMode = process.env.SERVER_ONLY === "true";
const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: false, limit: "15mb" }));

// Basic CORS middleware to allow requests from the frontend during local dev.
// This sets permissive defaults. In production you may want to tighten this to
// only allow the known frontend origin.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOW_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

let apiOnlyHomeRegistered = false;
const registerApiOnlyHome = () => {
  if (apiOnlyHomeRegistered) {
    return;
  }
  apiOnlyHomeRegistered = true;
  app.get("/", (_req, res) => {
    res.json({
      status: "ok",
      mode: "api-only",
      timestamp: new Date().toISOString(),
    });
  });
};

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  const env = app.get("env");
  if (serverOnlyMode) {
    registerApiOnlyHome();
    log("SERVER_ONLY=true - skipping Vite middleware and static assets");
  } else if (env === "development") {
    await setupVite(app, server);
  } else {
    const served = serveStatic(app);
    if (!served) {
      registerApiOnlyHome();
      log("No client build detected - continuing in API-only mode");
    }
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
})();
