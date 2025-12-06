import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { load as cheerioLoad } from 'cheerio';
import type { Express } from "express";
import admin from 'firebase-admin';
import fs from 'fs';
import { createServer, type Server } from "http";
import path from 'path';
import puppeteer from 'puppeteer';
import { gmgnService } from "./gmgnService";
import { jupiterService } from "./jupiterService";
import { jupiterTopTrendingService } from "./jupiterTopTrendingService";
import launchpadRoutes from "./launchpadRoutes";
import { priceService } from "./priceService";
import { isAuthenticated, setupAuth } from "./replitAuth";
import { fetchChartCandles } from "./services/chartService";
import { fetchJupiterQuoteServer } from "./services/jupiterService";
import { storage } from "./storage";
import { WalletService } from "./walletService";
import { getWalletBalance, signTransaction, transferSol } from "./walletSigning";

// Solana connection (devnet for now)
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication middleware
  await setupAuth(app);
  await jupiterService.start();
  await jupiterTopTrendingService.start();
  await priceService.start();
  gmgnService.start();

  // Simple in-memory cache for proxied GMGN pages to reduce fetch frequency
  const gmgnCache = new Map<string, { html: string; expiresAt: number }>();
  // Launch a persistent Puppeteer browser at startup to render GMGN pages.
  // If launching fails, we will fall back to a plain fetch approach.
  let browser: puppeteer.Browser | null = null;
  try {
    const profileDir = process.env.PUPPETEER_PROFILE_DIR ? path.resolve(process.env.PUPPETEER_PROFILE_DIR) : path.resolve(process.cwd(), '.local', 'puppeteer_profile');
    const PUPPETEER_ARGS = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-gpu',
    ];

    await fs.promises.mkdir(profileDir, { recursive: true }).catch(() => { });

    browser = await puppeteer.launch({ headless: true, userDataDir: profileDir, args: PUPPETEER_ARGS });
    console.log('Puppeteer launched for GMGN rendering (profileDir=', profileDir, ')');
  } catch (err) {
    console.warn('Failed to launch Puppeteer; proxy will return 502 when rendering fails', err);
    browser = null;
  }

  // Wallet connection endpoint - creates user session with wallet info
  app.post("/api/auth/wallet-connect", async (req: any, res) => {
    try {
      const { publicKey, walletType } = req.body;
      const normalizedWalletType = typeof walletType === "string" ? walletType.toLowerCase() : "unknown";

      if (!publicKey || !walletType) {
        return res.status(400).json({ message: "Public key and wallet type are required" });
      }

      // Create a user ID based on the public key (in production, you might want more sophisticated logic)
      const walletSessionId = `wallet_session_${Math.random().toString(36).slice(2)}`;
      const userId = req.user?.id || walletSessionId;

      // Create/update user with wallet info
      const userData = {
        id: userId,
        email: req.user?.email || `${publicKey.slice(0, 8)}@wallet.local`,
        firstName: "Wallet",
        lastName: "User",
        profileImageUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${publicKey}`,
      };

      const user = await storage.upsertUser(userData);

      const sessionUser = {
        id: userId,
        email: userData.email,
        firstName: userData.firstName,
        lastName: userData.lastName,
        profileImageUrl: userData.profileImageUrl,
        claims: { sub: userId, email: userData.email },
      };

      await new Promise<void>((resolve, reject) => {
        req.login(sessionUser as any, (err: any) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // Create or get user's wallet
      let wallet = await storage.getUserWallet(userId);
      if (!wallet) {
        // Create wallet with the connected public key
        wallet = await storage.createAdditionalWallet({
          userId,
          name: `Connected Wallet (${normalizedWalletType.toUpperCase()})`,
          publicKey,
          encryptedPrivateKey: "external-wallet",
          balance: "0",
          isPrimary: "true",
          isArchived: "false"
        });
      }

      // Create a simple session (in production, use proper session management)
      if (req.session) {
        req.session.user = {
          id: userId,
          publicKey,
          walletType,
          email: userData.email,
        };
      }

      res.json({
        success: true,
        user: {
          ...user,
          wallet: {
            publicKey: wallet.publicKey,
            balance: wallet.balance
          }
        }
      });
    } catch (error) {
      console.error("Wallet connection error:", error);
      res.status(500).json({ message: "Failed to connect wallet" });
    }
  });

  // Auth routes - Return null if not authenticated (don't use isAuthenticated middleware)
  app.get("/api/auth/user", async (req: any, res) => {
    try {
      // If not authenticated via passport or session, return null (not 401)
      if (!req.isAuthenticated() && !req.session?.user) {
        return res.json(null);
      }

      // Handle both development and production user objects, and session-based wallet auth
      const userId = req.user?.claims?.sub || req.user?.id || req.session?.user?.id;

      if (!userId) {
        return res.json(null);
      }

      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get or create user's wallet
      let wallet = await storage.getUserWallet(userId);
      if (!wallet) {
        wallet = await storage.createWallet(userId);
      }

      // Return user with wallet info (but not private key)
      res.json({
        ...user,
        wallet: {
          publicKey: wallet.publicKey,
          balance: wallet.balance,
        },
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Get wallet balance from blockchain
  app.get("/api/wallet/balance", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const wallet = await storage.getUserWallet(userId);

      if (!wallet) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      // Fetch balance from Solana blockchain
      const publicKey = new PublicKey(wallet.publicKey);
      const balance = await connection.getBalance(publicKey);
      const balanceInSol = balance / LAMPORTS_PER_SOL;

      // Update stored balance
      await storage.updateWalletBalance(wallet.id, balanceInSol.toString());

      res.json({ balance: balanceInSol });
    } catch (error) {
      console.error("Error fetching wallet balance:", error);
      res.status(500).json({ message: "Failed to fetch balance" });
    }
  });

  // Export private key (IMPORTANT: User must be authenticated)
  app.get("/api/wallet/export-key", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const wallet = await storage.getUserWallet(userId);

      if (!wallet) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      // Decrypt and return private key in base58 format
      const privateKey = WalletService.exportPrivateKey(wallet.encryptedPrivateKey);

      res.json({ privateKey });
    } catch (error) {
      console.error("Error exporting private key:", error);
      res.status(500).json({ message: "Failed to export private key" });
    }
  });

  // Create wallet (in case user wants to regenerate)
  app.post("/api/wallet/create", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;

      // Check if wallet already exists
      const existingWallet = await storage.getUserWallet(userId);
      if (existingWallet) {
        return res.status(400).json({ message: "Wallet already exists" });
      }

      // Create new wallet
      const wallet = await storage.createWallet(userId);

      res.json({
        publicKey: wallet.publicKey,
        balance: wallet.balance,
      });
    } catch (error) {
      console.error("Error creating wallet:", error);
      res.status(500).json({ message: "Failed to create wallet" });
    }
  });

  // Withdraw SOL from custodial wallet
  app.post("/api/wallet/withdraw", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const { recipientAddress, amount } = req.body;

      // Validate inputs
      if (!recipientAddress || !amount) {
        return res.status(400).json({ message: "Recipient address and amount are required" });
      }

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      // Get user's wallet
      const wallet = await storage.getUserWallet(userId);
      if (!wallet) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      // Validate recipient address
      let recipientPubKey: PublicKey;
      try {
        recipientPubKey = new PublicKey(recipientAddress);
      } catch (error) {
        return res.status(400).json({ message: "Invalid recipient address" });
      }

      // Get keypair from encrypted private key
      const keypair = WalletService.getKeypair(wallet.encryptedPrivateKey);

      // Check balance
      const balance = await connection.getBalance(keypair.publicKey);
      const balanceInSol = balance / LAMPORTS_PER_SOL;

      // Estimate transaction fee (5000 lamports is typical for simple transfer)
      const estimatedFee = 5000 / LAMPORTS_PER_SOL;

      if (balanceInSol < amountNum + estimatedFee) {
        return res.status(400).json({
          message: "Insufficient balance",
          balance: balanceInSol,
          required: amountNum + estimatedFee
        });
      }

      // Create transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipientPubKey,
          lamports: Math.floor(amountNum * LAMPORTS_PER_SOL),
        })
      );

      // Send transaction
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [keypair],
        { commitment: "confirmed" }
      );

      // Update balance in database
      const newBalance = await connection.getBalance(keypair.publicKey);
      const newBalanceInSol = newBalance / LAMPORTS_PER_SOL;
      await storage.updateWalletBalance(wallet.id, newBalanceInSol.toString());

      res.json({
        success: true,
        signature,
        newBalance: newBalanceInSol,
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
      });
    } catch (error) {
      console.error("Error withdrawing SOL:", error);
      res.status(500).json({
        message: "Failed to withdraw SOL",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // ========== MULTI-WALLET MANAGEMENT ENDPOINTS ==========

  // List all wallets for authenticated user
  app.get("/api/wallets", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const allWallets = await storage.getAllUserWallets(userId);

      // Don't expose encrypted private keys in list view
      const sanitizedWallets = allWallets.map((w: any) => ({
        id: w.id,
        name: w.name,
        publicKey: w.publicKey,
        balance: w.balance,
        isPrimary: w.isPrimary,
        isArchived: w.isArchived,
        createdAt: w.createdAt,
      }));

      res.json(sanitizedWallets);
    } catch (error) {
      console.error("Error fetching wallets:", error);
      res.status(500).json({ message: "Failed to fetch wallets" });
    }
  });

  // Create additional wallet for authenticated user
  app.post("/api/wallets", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const { name } = req.body;

      if (!name || typeof name !== "string" || name.length === 0) {
        return res.status(400).json({ message: "Wallet name is required" });
      }

      // Create new wallet
      const { publicKey, encryptedPrivateKey } = WalletService.createWallet();

      const newWallet = await storage.createAdditionalWallet({
        userId,
        name,
        publicKey,
        encryptedPrivateKey,
        balance: "0",
        isPrimary: "false",
        isArchived: "false",
      });

      // Don't expose encrypted private key
      res.json({
        id: newWallet.id,
        name: newWallet.name,
        publicKey: newWallet.publicKey,
        balance: newWallet.balance,
        isPrimary: newWallet.isPrimary,
        isArchived: newWallet.isArchived,
      });
    } catch (error) {
      console.error("Error creating wallet:", error);
      res.status(500).json({ message: "Failed to create wallet" });
    }
  });

  // Update wallet (rename or archive)
  app.patch("/api/wallets/:walletId", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const { walletId } = req.params;
      const { name, isArchived } = req.body;

      const wallet = await storage.getWalletById(walletId);

      if (!wallet || wallet.userId !== userId) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      const updatedWallet = await storage.updateWallet(walletId, {
        name: name || wallet.name,
        isArchived: isArchived !== undefined ? isArchived : wallet.isArchived,
      });

      res.json({
        id: updatedWallet.id,
        name: updatedWallet.name,
        publicKey: updatedWallet.publicKey,
        balance: updatedWallet.balance,
        isPrimary: updatedWallet.isPrimary,
        isArchived: updatedWallet.isArchived,
      });
    } catch (error) {
      console.error("Error updating wallet:", error);
      res.status(500).json({ message: "Failed to update wallet" });
    }
  });

  // Refresh specific wallet balance from blockchain
  app.get("/api/wallets/:walletId/balance", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const { walletId } = req.params;

      const wallet = await storage.getWalletById(walletId);

      if (!wallet || wallet.userId !== userId) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      // Fetch balance from Solana blockchain
      const publicKey = new PublicKey(wallet.publicKey);
      const balance = await connection.getBalance(publicKey);
      const balanceInSol = balance / LAMPORTS_PER_SOL;

      // Update cached balance in database
      await storage.updateWalletBalance(wallet.id, balanceInSol.toString());

      res.json({
        balance: balanceInSol,
        publicKey: wallet.publicKey
      });
    } catch (error) {
      console.error("Error fetching wallet balance:", error);
      res.status(500).json({ message: "Failed to fetch balance" });
    }
  });

  // Export private key for a specific wallet
  app.get("/api/wallets/:walletId/export-key", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims?.sub || req.user.id;
      const { walletId } = req.params;

      const wallet = await storage.getWalletById(walletId);

      if (!wallet || wallet.userId !== userId) {
        return res.status(404).json({ message: "Wallet not found" });
      }

      const privateKey = WalletService.exportPrivateKey(wallet.encryptedPrivateKey);

      res.json({ privateKey });
    } catch (error) {
      console.error("Error exporting private key:", error);
      res.status(500).json({ message: "Failed to export private key" });
    }
  });

  // Wallet signing routes
  app.post("/api/wallet/sign-transaction", isAuthenticated, async (req: any, res) => {
    try {
      const { transaction, publicKey } = req.body;

      if (!transaction || !publicKey) {
        return res.status(400).json({ error: "Missing transaction or publicKey" });
      }

      const signedTransaction = await signTransaction(publicKey, transaction);
      res.json({ signedTransaction });
    } catch (error) {
      console.error("Transaction signing error:", error);
      res.status(500).json({ error: "Failed to sign transaction" });
    }
  });

  app.get("/api/wallet/balance/:publicKey", isAuthenticated, async (req: any, res) => {
    try {
      const { publicKey } = req.params;
      const balance = await getWalletBalance(publicKey);
      res.json({ balance });
    } catch (error) {
      console.error("Balance fetch error:", error);
      res.status(500).json({ error: "Failed to get balance" });
    }
  });

  app.post("/api/wallet/transfer", isAuthenticated, async (req: any, res) => {
    try {
      const { fromPublicKey, toPublicKey, amount } = req.body;

      if (!fromPublicKey || !toPublicKey || !amount) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signature = await transferSol(fromPublicKey, toPublicKey, amount);
      res.json({ signature });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(500).json({ error: "Failed to transfer SOL" });
    }
  });

  // Jupiter recent tokens (cached snapshot)
  app.get("/api/jupiter/recent", (_req, res) => {
    res.json(jupiterService.getSnapshot());
  });

  // Image proxy endpoint to handle CORS/content-type issues for GIFs and other remote images
  app.get("/api/proxy-image", async (req, res) => {
    // Proxy remote images, with retries and a short timeout. Some hosts return 404
    // to non-browser agents; we retry using a browser UA and a Referer header.
    try {
      const imageUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
      if (!imageUrl) {
        return res.status(400).json({ error: "URL parameter is required" });
      }

      // Basic URL validation
      let parsed: URL;
      try {
        parsed = new URL(imageUrl);
      } catch {
        return res.status(400).json({ error: "Invalid URL format" });
      }

      const DEFAULT_TIMEOUT = 20000; // ms
      const tryFetch = async (url: string, headers: Record<string, string> = {}) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
        try {
          const resp = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
          clearTimeout(timeout);
          return resp;
        } catch (err) {
          clearTimeout(timeout);
          throw err;
        }
      };

      // Attempt sequence: 1) simple agent, 2) browser UA + Referer
      const orig = imageUrl;
      let response: Response | null = null;
      try {
        response = await tryFetch(orig, { 'User-Agent': 'Mozilla/5.0 (compatible; SLAB/1.0)' });
      } catch (err) {
        // swallow and try fallback
        console.warn('/api/proxy-image first fetch failed, will retry with browser UA', { url: orig, err: String(err) });
      }

      if (!response || !response.ok) {
        // Retry with a common browser UA and a Referer (some hosts require it)
        try {
          const referer = `${parsed.protocol}//${parsed.host}/`;
          response = await tryFetch(orig, {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Referer: referer,
            Accept: '*/*',
          });
        } catch (err) {
          console.warn('/api/proxy-image retry fetch failed', { url: orig, err: String(err) });
          response = null;
        }
      }

      if (!response) {
        return res.status(502).json({ error: 'Failed to fetch image (network error or timeout)' });
      }

      if (!response.ok) {
        // If the remote returned 404/403/etc., surface a helpful message
        const status = response.status;
        console.warn('/api/proxy-image remote returned non-ok', { url: orig, status });
        return res.status(status === 404 ? 404 : 502).json({ error: `Remote responded ${status}` });
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      let contentType = response.headers.get('content-type') || 'application/octet-stream';
      const urlLower = orig.toLowerCase();
      if (!contentType || contentType === 'application/octet-stream') {
        if (urlLower.endsWith('.gif')) contentType = 'image/gif';
        else if (urlLower.endsWith('.png')) contentType = 'image/png';
        else if (urlLower.endsWith('.webp')) contentType = 'image/webp';
        else if (urlLower.endsWith('.svg')) contentType = 'image/svg+xml';
        else if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) contentType = 'image/jpeg';
      }

      res.set({
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });

      res.send(buffer);
    } catch (err) {
      console.error('/api/proxy-image error:', err);
      if ((err as any)?.name === 'AbortError') return res.status(504).json({ error: 'Timed out fetching remote image' });
      res.status(500).json({ error: 'Failed to proxy image' });
    }
  });

  // Jupiter recent tokens stream (Server-Sent Events)
  app.get("/api/jupiter/recent/stream", (req, res) => {
    jupiterService.handleStream(req, res);
  });

  // Jupiter token search
  app.get("/api/jupiter/search", async (req, res) => {
    try {
      const query = (req.query.query || req.query.q) as string | undefined;
      const tokens = await jupiterService.searchTokens(query);

      res.json({
        success: true,
        tokens: tokens,
        query: query || null,
        count: tokens.length
      });
    } catch (error) {
      console.error("Error searching Jupiter tokens:", error);
      res.status(500).json({
        success: false,
        message: "Failed to search tokens",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Jupiter Ultra proxy - forward order (GET) and execute (POST) through our server
  // This avoids cross-origin POST preflight issues and centralizes retries/rate-limit handling.
  const JUPITER_ULTRA_BASE = "https://lite-api.jup.ag/ultra/v1";
  const DEFAULT_ULTRA_TIMEOUT_MS = 15000;

  app.get("/api/jupiter/ultra/order", async (req, res) => {
    try {
      const query = req.url.split('?')[1] ?? '';
      const url = `${JUPITER_ULTRA_BASE}/order${query ? `?${query}` : ''}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_ULTRA_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "slab-trade/1.0 (+https://slab.trade)",
          Accept: "application/json",
        },
      });
      clearTimeout(timeout);

      const text = await response.text();
      try {
        const json = JSON.parse(text);
        res.status(response.status).json(json);
      } catch {
        res.status(response.status).send(text);
      }
    } catch (err) {
      console.error("/api/jupiter/ultra/order proxy error:", err);
      if ((err as any)?.name === 'AbortError') {
        return res.status(504).json({ success: false, error: 'Jupiter Ultra request timed out' });
      }
      res.status(502).json({ success: false, error: (err instanceof Error) ? err.message : 'Proxy error' });
    }
  });

  // Chart service (pump.fun) candles proxy
  app.get("/api/chart/:coin/candles", async (req, res) => {
    try {
      const coin = String(req.params.coin || '');
      const interval = typeof req.query.interval === 'string' ? req.query.interval : undefined;
      const limit = req.query.limit !== undefined ? req.query.limit : undefined;
      const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;
      const rawCreated = req.query.createdTs;
      let createdTs: number | undefined = undefined;
      if (rawCreated === undefined || rawCreated === null || String(rawCreated).trim() === '') {
        // If client didn't supply a usable createdTs, use current time immediately
        createdTs = Date.now();
      } else {
        const num = Number(rawCreated);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
          createdTs = Math.floor(num);
        } else {
          // Fallback to current time if parsing fails
          createdTs = Date.now();
        }
      }
      const program = typeof req.query.program === 'string' ? req.query.program : undefined;

      let result = await fetchChartCandles(coin, { interval, limit, currency, createdTs, program });

      // If pump returns a Bad Request about `createdTs` not being an integer,
      // try a best-effort retry by supplying the current timestamp (ms).
      if (result.status === 400 && typeof result.rawText === 'string' && result.rawText.toLowerCase().includes('createdts')) {
        console.warn('/api/chart/:coin/candles - pump returned 400 related to createdTs, retrying with current timestamp', { coin, interval, limit, currency, program });
        try {
          const fallbackCreated = Date.now();
          result = await fetchChartCandles(coin, { interval, limit, currency, createdTs: fallbackCreated, program });
        } catch (err) {
          console.error('/api/chart/:coin/candles - retry with createdTs failed', err);
        }
      }

      if (result.json !== null) {
        return res.status(result.status).json(result.json);
      }

      // Fallback: return raw text if JSON parse failed
      res.status(result.status).send(result.rawText);
    } catch (err) {
      console.error("/api/chart/:coin/candles proxy error:", err);
      if ((err as any)?.name === 'AbortError') return res.status(504).json({ success: false, error: 'Chart request timed out' });
      res.status(502).json({ success: false, error: (err instanceof Error) ? err.message : 'Proxy error' });
    }
  });

  // Jupiter quote (ultra/order) with server-side rate limiting/caching
  app.get("/api/jupiter/quote", async (req, res) => {
    console.log('[api/jupiter/quote] incoming request', {
      inputMint: req.query.inputMint || req.query.inMint,
      outputMint: req.query.outputMint || req.query.outMint,
      amount: req.query.amount,
      taker: req.query.taker,
    });
    try {
      const inMint = String(req.query.inputMint || req.query.inMint || '');
      const outMint = String(req.query.outputMint || req.query.outMint || '');
      const amount = String(req.query.amount || '');
      const taker = req.query.taker ? String(req.query.taker) : undefined;

      const result = await fetchJupiterQuoteServer({ inMint, outMint, amount, taker });
      if (!result) return res.status(400).json({ ok: false, error: 'invalid params' });
      return res.status(result.status).json(result.raw);
    } catch (err) {
      console.error('/api/jupiter/quote error:', err);
      res.status(502).json({ ok: false, error: 'server quote error' });
    }
  });

  app.post("/api/jupiter/ultra/execute", async (req, res) => {
    try {
      const url = `${JUPITER_ULTRA_BASE}/execute`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_ULTRA_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          "User-Agent": "slab-trade/1.0 (+https://slab.trade)",
          Accept: 'application/json',
        },
        body: JSON.stringify(req.body),
      });
      clearTimeout(timeout);

      const text = await response.text();
      try {
        const json = JSON.parse(text);
        res.status(response.status).json(json);
      } catch {
        res.status(response.status).send(text);
      }
    } catch (err) {
      console.error("/api/jupiter/ultra/execute proxy error:", err);
      if ((err as any)?.name === 'AbortError') {
        return res.status(504).json({ success: false, error: 'Jupiter Ultra execute timed out' });
      }
      res.status(502).json({ success: false, error: (err instanceof Error) ? err.message : 'Proxy error' });
    }
  });

  // Jupiter top traded tokens (cached snapshot)
  app.get("/api/jupiter/top-trending", (_req, res) => {
    res.json(jupiterTopTrendingService.getSnapshot());
  });

  // Jupiter top trending tokens stream (Server-Sent Events)
  app.get("/api/jupiter/top-trending/stream", (req, res) => {
    jupiterTopTrendingService.handleStream(req, res);
  });

  // ========== GMGN TOKEN SERVICE ENDPOINTS ==========

  app.get("/api/gmgn/tokens", (_req, res) => {
    res.json(gmgnService.getSnapshot());
  });

  app.get("/api/gmgn/tokens/stream", (req, res) => {
    gmgnService.handleStream(req, res);
  });

  app.post("/api/gmgn/polling/start", (_req, res) => {
    gmgnService.start();
    const status = gmgnService.getStatus();
    res.json({ success: true, message: "GMGN polling started", ...status });
  });

  app.post("/api/gmgn/polling/stop", (_req, res) => {
    gmgnService.stop();
    const status = gmgnService.getStatus();
    res.json({ success: true, message: "GMGN polling stopped", ...status });
  });

  app.get("/api/gmgn/polling/status", (_req, res) => {
    res.json(gmgnService.getStatus());
  });

  app.post("/api/gmgn/cache/clear", (_req, res) => {
    gmgnService.clear();
    const status = gmgnService.getStatus();
    res.json({ success: true, message: "GMGN cache cleared", ...status });
  });

  app.get("/api/gmgn/search", async (req, res) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q : req.query.query;
      const chain = typeof req.query.chain === "string" ? req.query.chain : "sol";

      if (!query || typeof query !== "string" || !query.trim()) {
        return res.status(400).json({ success: false, error: "Query parameter 'q' is required" });
      }

      const results = await gmgnService.search(query, chain);
      res.json({ success: true, data: results });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[GMGN] Search error:", message);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.get("/api/gmgn/test", async (_req, res) => {
    try {
      const json = await gmgnService.testFetch();
      res.json(json);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ success: false, error: message });
    }
  });

  // GMGN v3 direct lookup route - used by Market page for token-by-mint
  app.get("/api/gmgn/lookup", async (req, res) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q : typeof req.query.query === 'string' ? req.query.query : undefined;
      const chain = typeof req.query.chain === "string" ? req.query.chain : "sol";

      if (!query || typeof query !== "string" || !query.trim()) {
        return res.status(400).json({ success: false, error: "Query parameter 'q' is required" });
      }

      const coins = await gmgnService.lookup(query.trim(), chain);
      if (!coins) {
        return res.json({ success: true, data: { coins: [] } });
      }

      // Normalize the primary coin(s) into a compact response the front-end expects
      const normalized = (coins as any[]).map((c) => {
        // Defensive mappings: GMGN responses and the puppeteer fallback use
        // inconsistent field names across versions. Try many fallbacks and
        // coerce types to the shapes the frontend expects.
        const chainOut = c.chain ?? chain;
        const addressOut = c.address ?? c.id ?? c.mint ?? c.token ?? null;

        const nameOut = c.name ?? c.title ?? c.token_name ?? c.symbol ?? null;
        const symbolOut = c.symbol ?? c.ticker ?? c.token_symbol ?? null;

        const logoOut = c.logo ?? c.icon ?? c.thumb ?? c.image ?? c.avatar ?? null;

        const priceOut = (() => {
          const p = c.price ?? c.usdPrice ?? c.current_price ?? c.last_price ?? c.price_usd ?? null;
          return p == null ? null : (typeof p === 'string' ? Number(p) : p);
        })();

        const holderCountOut = c.holder_count ?? c.holderCount ?? c.holders ?? null;

        const liquidityOut = c.liquidity ?? c.liq ?? c.liquid ?? null;

        const marketCapOut = (() => {
          const m = c.mcp ?? c.mcap ?? c.market_cap ?? c.marketCap ?? c.marketCapUsd ?? null;
          return m == null ? null : (typeof m === 'string' ? Number(m) : m);
        })();

        return {
          chain: chainOut,
          address: addressOut,
          name: nameOut,
          symbol: symbolOut,
          logo: logoOut,
          price: priceOut,
          holder_count: holderCountOut,
          liquidity: liquidityOut,
          market_cap: marketCapOut,
          original: c,
        };
      });

      res.json({ success: true, data: { coins: normalized } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[GMGN] lookup route error:", message);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Fetch token trades for a given mint via GMGN
  app.get("/api/gmgn/trades/:mint", async (req, res) => {
    try {
      const { mint } = req.params as { mint: string };
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
      const maker = typeof req.query.maker === "string" ? req.query.maker : undefined;

      if (!mint || typeof mint !== "string") {
        return res.status(400).json({ success: false, error: "Mint parameter is required" });
      }

      const json = await gmgnService.getTokenTrades(mint, { limit, maker });

      res.json({ success: true, data: json });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[GMGN] token trades error:", message);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Fetch token holders for a given mint via GMGN
  app.get("/api/gmgn/holders/:mint", async (req, res) => {
    try {
      const { mint } = req.params as { mint: string };
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
      const orderby = typeof req.query.orderby === "string" ? req.query.orderby : undefined;
      const direction = typeof req.query.direction === "string" ? req.query.direction : undefined;
      const cost = typeof req.query.cost === "string" ? parseInt(req.query.cost, 10) : undefined;

      if (!mint || typeof mint !== "string") {
        return res.status(400).json({ success: false, error: "Mint parameter is required" });
      }

      const json = await gmgnService.getTokenHolders(mint, { limit, orderby, direction, cost });

      res.json({ success: true, data: json });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[GMGN] token holders error:", message);
      res.status(500).json({ success: false, error: message });
    }
  });

  // Proxy GMGN embed page and strip branding / powered-by anchor
  // Example: /embed/gmgn/sol/:mint?theme=light&interval=15
  app.get("/embed/gmgn/:chain/:mint", async (req, res) => {
    try {
      const chain = String(req.params.chain || "sol");
      const mint = String(req.params.mint || "");
      if (!mint) return res.status(400).send("Missing mint parameter");

      // Build target URL with forwarded query params
      const base = `https://www.gmgn.cc/kline/${encodeURIComponent(chain)}/${encodeURIComponent(mint)}`;
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === 'string') qs.set(k, v);
      }
      const target = qs.toString() ? `${base}?${qs.toString()}` : base;

      // Simple cache key
      const cacheKey = target;
      const now = Date.now();
      const cached = gmgnCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30' });
        return res.send(cached.html);
      }

      let rawHtml: string;

      if (browser) {
        // Use Puppeteer to render the page like a real browser
        let page: puppeteer.Page | null = null;
        try {
          page = await browser.newPage();
          // match gmgnService headers/UA
          const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
          await page.setUserAgent(UA);
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-CH-UA': '"Google Chrome";v="120", "Chromium";v="120", "Not=A?Brand";v="24"',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-CH-UA-Mobile': '?0',
          });
          await page.setViewport({ width: 1200, height: 800 });
          // avoid webdriver flag
          await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

          await page.goto(target, { waitUntil: 'networkidle2', timeout: 60_000 });
          await page.waitForTimeout(3_000);
          rawHtml = await page.content();
        } catch (err) {
          console.warn('/embed/gmgn puppeteer render failed, falling back to HTTP fetch', err);
          if (page) try { await page.close(); } catch (_) { }
          // fallback to fetch below
          rawHtml = '';
        } finally {
          if (page) try { await page.close(); } catch (_) { }
        }
      } else {
        rawHtml = '';
      }

      // If Puppeteer did not produce HTML, DO NOT fallback to HTTP fetch.
      // Return a clear error so the caller can detect Puppeteer failures.
      if (!rawHtml) {
        const msg = '/embed/gmgn: Puppeteer failed to render page and HTTP fallback is disabled';
        console.error(msg);
        return res.status(502).send(msg);
      }

      // Load with cheerio for robust DOM manipulation
      const $ = cheerioLoad(rawHtml, { decodeEntities: false });

      // Ensure <base> is present so relative URLs resolve correctly
      if ($('head base[href]').length === 0) {
        $('head').prepend('<base href="https://www.gmgn.cc/">');
      }

      // Rewrite root-relative and protocol-relative src/href to absolute gmgn URLs
      $('*[src], *[href]').each((_, el) => {
        const attribs: Array<'src' | 'href'> = ['src', 'href'];
        attribs.forEach((a) => {
          const val = $(el).attr(a);
          if (!val) return;
          if (val.startsWith('//')) {
            $(el).attr(a, 'https:' + val);
          } else if (val.startsWith('/')) {
            $(el).attr(a, `https://www.gmgn.cc${val}`);
          }
        });
      });

      // Remove powered-by anchors/images reliably
      // Remove anchors that contain an image with the powered logo
      $('a').filter((_, el) => $(el).find('img[src*="ic_powered_by_logo"]').length > 0).remove();
      // Remove anchors that link to gmgn.ai
      $('a[href*="gmgn.ai"]').remove();
      // Remove anchors with the known class
      $('a.css-14cme0a').remove();
      // Remove any powered-by images directly
      $('img[src*="ic_powered_by_logo"]').remove();

      // Inject a small cleanup script to remove any branding added dynamically
      const cleanupScript = `
<script>/** Remove GMGN powered-by anchors/images if dynamically inserted */(function(){function r(){try{document.querySelectorAll('a[href*="gmgn.ai"]').forEach(e=>e.remove());document.querySelectorAll('img[src*="ic_powered_by_logo"]').forEach(e=>e.remove());document.querySelectorAll('a.css-14cme0a').forEach(e=>e.remove());}catch(e){} }document.addEventListener('DOMContentLoaded',r);setTimeout(r,800);setInterval(r,2500);})();</script>`;
      $('body').append(cleanupScript);

      const finalHtml = $.html();

      // Cache for short TTL (30s)
      gmgnCache.set(cacheKey, { html: finalHtml, expiresAt: Date.now() + 30_000 });

      res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30' });
      return res.send(finalHtml);
    } catch (err) {
      console.error('/embed/gmgn proxy error:', err);
      if ((err as any)?.name === 'AbortError') return res.status(504).send('Timed out fetching remote page');
      return res.status(502).send('Failed to proxy GMGN page');
    }
  });

  // ========== PRICE SERVICE ENDPOINTS ==========

  // Get all crypto prices (BTC, ETH, SOL)
  app.get("/api/prices", (_req, res) => {
    try {
      const prices = priceService.getAllPrices();
      res.json({
        success: true,
        data: prices,
        isStale: priceService.isStale()
      });
    } catch (error) {
      console.error("Error fetching prices:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch prices"
      });
    }
  });

  // Get specific crypto price
  app.get("/api/prices/:symbol", (req, res) => {
    try {
      const { symbol } = req.params;
      const price = priceService.getPrice(symbol);

      if (!price) {
        return res.status(404).json({
          success: false,
          message: `Price data not found for ${symbol.toUpperCase()}`
        });
      }

      res.json({
        success: true,
        data: price,
        isStale: priceService.isStale(symbol)
      });
    } catch (error) {
      console.error("Error fetching price:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch price"
      });
    }
  });

  // Get multiple crypto prices
  app.post("/api/prices/batch", (req, res) => {
    try {
      const { symbols } = req.body;

      if (!Array.isArray(symbols)) {
        return res.status(400).json({
          success: false,
          message: "Symbols must be an array"
        });
      }

      const prices = priceService.getPrices(symbols);

      res.json({
        success: true,
        data: prices,
        requested: symbols,
        found: Object.keys(prices)
      });
    } catch (error) {
      console.error("Error fetching batch prices:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch batch prices"
      });
    }
  });

  // Force refresh prices (admin endpoint)
  app.post("/api/prices/refresh", async (_req, res) => {
    try {
      await priceService.refresh();
      const prices = priceService.getAllPrices();

      res.json({
        success: true,
        message: "Prices refreshed successfully",
        data: prices
      });
    } catch (error) {
      console.error("Error refreshing prices:", error);
      res.status(500).json({
        success: false,
        message: "Failed to refresh prices"
      });
    }
  });

  // Get price service status
  app.get("/api/prices/status", (_req, res) => {
    try {
      const status = priceService.getStatus();
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      console.error("Error fetching price service status:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch service status"
      });
    }
  });

  // Temporary debug endpoint to echo headers/body for troubleshooting auth/header forwarding.
  app.all("/api/debug/echo", (req: any, res) => {
    try {
      console.log('[API][DEBUG][ECHO] incoming', { path: req.path, method: req.method, headers: req.headers });
      const body = req.body;
      return res.json({ ok: true, headers: req.headers, body: body });
    } catch (err) {
      console.error('[API][DEBUG][ECHO] error', err);
      return res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // Get user info (try local storage then Firebase admin). Returns { id, username }
  app.get('/api/users/:id', async (req, res) => {
    try {
      const { id } = req.params as { id: string };
      if (!id) return res.status(400).json({ success: false, error: 'id required' });

      // First try local storage
      try {
        const user = await storage.getUser(id);
        if (user) {
          const username = `${user.firstName || ''}${user.lastName ? ' ' + user.lastName : ''}`.trim() || user.email || user.id;
          return res.json({ success: true, data: { id: user.id, username } });
        }
      } catch (e) {
        // continue to firebase fallback
      }

      // Try Firebase Admin / Realtime Database to lookup username by uid
      try {
        if (!admin.apps || admin.apps.length === 0) {
          try {
            // Prefer server-only env vars (do NOT use NEXT_PUBLIC_ prefixes for secrets)
            const loadSvc = () => {
              // 1) raw JSON in env
              const rawJson = process.env.SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
              if (rawJson) {
                try { return JSON.parse(rawJson); } catch (e) { /* fallthrough */ }
              }
              // 2) base64-encoded JSON
              const b64 = process.env.SERVICE_ACCOUNT_BASE64 || process.env.SERVICEACC_B64 || process.env.SERVICE_JSON_B64;
              if (b64) {
                try {
                  const decoded = Buffer.from(b64, 'base64').toString('utf8');
                  return JSON.parse(decoded);
                } catch (e) {
                  // continue to file fallback
                }
              }
              // 3) filesystem fallback (existing serviceacc.json file)
              try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                return require('../serviceacc.json');
              } catch (e) {
                return null;
              }
            };

            const svc = loadSvc();
            if (svc) {
              admin.initializeApp({ credential: admin.credential.cert(svc as any), databaseURL: process.env.FIREBASE_DATABASE_URL });
            } else {
              try { admin.initializeApp(); } catch { }
            }
          } catch (e) {
            try { admin.initializeApp(); } catch { }
          }
        }

        // First try Realtime Database users/{uid}/username which your screenshot shows
        try {
          if (typeof admin.database === 'function') {
            const db = admin.database();
            const snap = await db.ref(`users/${id}/username`).get();
            if (snap && snap.exists()) {
              const username = snap.val();
              return res.json({ success: true, data: { id, username } });
            }
          }
        } catch (dbErr) {
          // ignore DB read errors and fall back to auth lookup
          console.warn('/api/users/:id rtdb read failed', dbErr);
        }

        // Fallback to auth displayName/email
        const f = await admin.auth().getUser(id);
        const username = f.displayName || f.email || f.uid;
        return res.json({ success: true, data: { id: f.uid, username } });
      } catch (fbErr) {
        // Not found in Firebase auth or other errors
        return res.status(404).json({ success: false, error: 'user_not_found' });
      }
    } catch (err) {
      console.error('/api/users/:id error', err);
      return res.status(500).json({ success: false, error: 'server_error' });
    }
  });

  // Register launchpad routes
  // Close long position (calls shared engine implementation in padd-ui)
  // Uses server `priceService` as the authoritative source for SOL price (no other fallback for SOL).
  app.post("/api/engine/close-long", async (req: any, res) => {
    try {
      console.log('[API][ENGINE][CLOSE_LONG] incoming request', { path: req.path, headers: Object.keys(req.headers || {}).filter(k => ['authorization', 'host', 'content-type'].includes(k.toLowerCase())) });
      // Allow either session-based auth (passport) OR a Firebase ID token in Authorization: Bearer <idToken>
      let uid: string | undefined | null = undefined;
      if (req.isAuthenticated && typeof req.isAuthenticated === 'function' && req.isAuthenticated()) {
        uid = req.user?.claims?.sub || req.user?.id;
        console.log('[API][ENGINE][CLOSE_LONG] session auth detected', { uid });
      } else {
        const auth = (req.headers?.authorization || '') as string;
        console.log('[API][ENGINE][CLOSE_LONG] authorization header present?', { hasAuthHeader: !!auth });
        if (auth.startsWith('Bearer ')) {
          const idToken = auth.replace('Bearer ', '');
          try {
            // Initialize firebase-admin with service account if not already
            if (!admin.apps || admin.apps.length === 0) {
              try {
                const loadSvc = () => {
                  const rawJson = process.env.SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
                  if (rawJson) {
                    try { return JSON.parse(rawJson); } catch (e) { }
                  }
                  const b64 = process.env.SERVICE_ACCOUNT_BASE64 || process.env.SERVICEACC_B64 || process.env.SERVICE_JSON_B64;
                  if (b64) {
                    try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch (e) { }
                  }
                  try { return require('../serviceacc.json'); } catch (e) { return null; }
                };
                const svc = loadSvc();
                if (svc) {
                  admin.initializeApp({ credential: admin.credential.cert(svc as any) });
                } else {
                  try { admin.initializeApp(); } catch { }
                }
              } catch (e) {
                try { admin.initializeApp(); } catch { }
              }
            }
            const decoded = await admin.auth().verifyIdToken(idToken);
            uid = decoded?.uid;
            console.log('[API][ENGINE][CLOSE_LONG] firebase token verified', { uid });
          } catch (e) {
            console.error('[API][ENGINE][CLOSE_LONG] Firebase token verification failed', e);
            uid = null;
          }
        }
      }
      const { mint, posId, markUsd: bodyMark } = req.body || {};

      if (!uid) return res.status(401).json({ success: false, error: 'unauthenticated' });
      if (!mint || !posId) return res.status(400).json({ success: false, error: 'mint and posId are required' });

      // Fetch SOL price from our in-process price service and treat it as authoritative
      const solPriceData = priceService.getPrice('SOL');
      if (!solPriceData || typeof solPriceData.price !== 'number' || solPriceData.price <= 0) {
        console.error('[API][ENGINE][CLOSE_LONG] SOL price unavailable from priceService', { solPriceData });
        return res.status(503).json({ success: false, error: 'sol_price_unavailable' });
      }
      const solPriceUsd = solPriceData.price;

      // Allow the frontend to provide `markUsd` directly (the page already shows the token price).
      // If not provided, fall back to GMGN lookup as before.
      let markUsd: number | null = null;
      if (bodyMark != null) {
        const n = Number(bodyMark);
        if (Number.isFinite(n) && n > 0) {
          markUsd = n;
        }
      }
      if (markUsd == null) {
        try {
          const coins = await gmgnService.lookup(mint, 'sol');
          const coin = Array.isArray(coins) && coins.length ? coins[0] : null;
          if (coin) {
            const candidates = [
              coin.price_usd, coin.priceUsd, coin.price, coin.usd_price, coin.last_price, coin.last_price_usd, coin.price_usd_display,
              coin.market_price, coin.price_usd_native
            ];
            for (const v of candidates) {
              if (v == null) continue;
              const nn = Number(v);
              if (Number.isFinite(nn) && nn > 0) {
                markUsd = nn;
                break;
              }
            }
            try {
              if (markUsd == null && coin.data && typeof coin.data.price === 'number') markUsd = coin.data.price;
            } catch { /* ignore */ }
          }
        } catch (gmgnErr) {
          console.warn('[API][ENGINE][CLOSE_LONG] gmgn lookup failed', gmgnErr);
        }
        if (!markUsd) {
          console.warn('[API][ENGINE][CLOSE_LONG] token mark price unavailable from GMGN and no page-supplied price; falling back to cache/engine lookup', { mint, markUsd });
        }
      }

      // Import the engine implementation from the frontend package so we share logic
      const engine = await import('../padd-ui/engine/engine');
      if (!engine || typeof engine.closeLong !== 'function') {
        return res.status(500).json({ success: false, error: 'engine.closeLong unavailable' });
      }

      // Pass server-provided SOL and mark prices explicitly so engine uses them
      const result = await engine.closeLong(uid, mint, posId, { liquidated: false, solPriceUsd, markUsd: markUsd ?? undefined });
      return res.json(result);
    } catch (err: any) {
      console.error('/api/engine/close-long error', err);
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  app.use("/api/launchpad", launchpadRoutes);

  const httpServer = createServer(app);
  return httpServer;
}
