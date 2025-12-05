import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";

// Fail fast if encryption key is missing
if (!process.env.WALLET_ENCRYPTION_KEY) {
  console.warn("WALLET_ENCRYPTION_KEY environment variable is not set, using fallback for development");
  process.env.WALLET_ENCRYPTION_KEY = "dev-key-not-secure-change-in-production";
}

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY;
const ALGORITHM = "aes-256-cbc";

/**
 * Wallet service for managing custodial Solana wallets
 */
export class WalletService {
  /**
   * Generate a new Solana keypair
   */
  static generateKeypair(): Keypair {
    return Keypair.generate();
  }

  /**
   * Encrypt a private key for secure storage
   */
  static encryptPrivateKey(privateKey: Uint8Array): string {
    const key = crypto.createHash("sha256").update(ENCRYPTION_KEY).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    const privateKeyBase58 = bs58.encode(privateKey);
    let encrypted = cipher.update(privateKeyBase58, "utf8", "hex");
    encrypted += cipher.final("hex");
    
    return iv.toString("hex") + ":" + encrypted;
  }

  /**
   * Decrypt a private key from storage
   */
  static decryptPrivateKey(encryptedData: string): Uint8Array {
    const key = crypto.createHash("sha256").update(ENCRYPTION_KEY).digest();
    const parts = encryptedData.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = parts[1];
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    
    return bs58.decode(decrypted);
  }

  /**
   * Create a new custodial wallet for a user
   */
  static createWallet(): {
    publicKey: string;
    encryptedPrivateKey: string;
  } {
    const keypair = this.generateKeypair();
    const publicKey = keypair.publicKey.toBase58();
    const encryptedPrivateKey = this.encryptPrivateKey(keypair.secretKey);
    
    return { publicKey, encryptedPrivateKey };
  }

  /**
   * Export the private key in base58 format (for user to backup)
   */
  static exportPrivateKey(encryptedPrivateKey: string): string {
    const privateKey = this.decryptPrivateKey(encryptedPrivateKey);
    return bs58.encode(privateKey);
  }

  /**
   * Get keypair from encrypted private key
   */
  static getKeypair(encryptedPrivateKey: string): Keypair {
    const privateKey = this.decryptPrivateKey(encryptedPrivateKey);
    return Keypair.fromSecretKey(privateKey);
  }
}
