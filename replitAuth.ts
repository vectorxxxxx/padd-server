import type { Express, RequestHandler } from "express";
import session from "express-session";
import passport from "passport";
import { storage } from "./storage";

const isDevelopment = process.env.NODE_ENV === "development";

if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET environment variable is not set, using fallback for development");
  process.env.SESSION_SECRET = "dev-session-secret-not-secure";
}

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week

  // Use in-memory sessions (no database required)
  return session({
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: !isDevelopment,
      maxAge: sessionTtl,
    },
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", async (req, res) => {
    if (!isDevelopment) {
      return res.status(501).json({ message: "Login is disabled" });
    }

    const mockUser = {
      id: "dev-user-123",
      email: "dev@example.com",
      firstName: "Dev",
      lastName: "User",
      profileImageUrl: "https://via.placeholder.com/150",
      claims: {
        sub: "dev-user-123",
        email: "dev@example.com",
        first_name: "Dev",
        last_name: "User",
        profile_image_url: "https://via.placeholder.com/150",
      },
    };

    try {
      await storage.upsertUser({
        id: mockUser.id,
        email: mockUser.email,
        firstName: mockUser.firstName,
        lastName: mockUser.lastName,
        profileImageUrl: mockUser.profileImageUrl,
      });
    } catch (error) {
      console.error("Failed to persist mock user:", error);
      return res.status(500).json({ message: "Unable to create mock user" });
    }

    req.login(mockUser as any, (err) => {
      if (err) {
        console.error("Mock login error:", err);
        return res.status(500).json({ message: "Login failed" });
      }
      return res.redirect("/");
    });
  });

  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect("/");
    });
  });
}

export const isAuthenticated: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  return res.status(401).json({ message: "Unauthorized" });
};
