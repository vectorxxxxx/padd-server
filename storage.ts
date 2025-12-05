import { memoryDB, type User, type Wallet } from "./db";
import { WalletService } from "./walletService";

// Define types
export type UpsertUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl?: string;
};

export type InsertWallet = {
  userId: string;
  publicKey: string;
  encryptedPrivateKey: string;
  name?: string;
  balance?: string;
  isPrimary?: string;
  isArchived?: string;
};

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;

  // Wallet operations
  getUserWallet(userId: string): Promise<Wallet | undefined>;
  createWallet(userId: string): Promise<Wallet>;
  updateWalletBalance(walletId: string, balance: string): Promise<Wallet>;

  // Multi-wallet operations
  getAllUserWallets(userId: string): Promise<Wallet[]>;
  createAdditionalWallet(wallet: InsertWallet): Promise<Wallet>;
  getWalletById(walletId: string): Promise<Wallet | undefined>;
  updateWallet(walletId: string, updates: { name?: string; isArchived?: string }): Promise<Wallet>;
  // Find a user/wallet by a public key (used by wallet signing helpers)
  getUserByPublicKey(publicKey: string): Promise<({ privateKey?: string } & (User | Wallet)) | undefined>;
}
class MemoryStorage implements IStorage {
  private nextWalletId = 1;

  // User operations
  async getUser(id: string): Promise<User | undefined> {
    return memoryDB.users.get(id);
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const existing = memoryDB.users.get(userData.id);
    const user: User = {
      ...userData,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    };
    memoryDB.users.set(userData.id, user);
    return user;
  }

  // Wallet operations
  async getUserWallet(userId: string): Promise<Wallet | undefined> {
    const wallets = Array.from(memoryDB.wallets.values());
    return wallets.find(wallet => wallet.userId === userId);
  }

  async createWallet(userId: string): Promise<Wallet> {
    const { publicKey, encryptedPrivateKey } = WalletService.createWallet();

    const wallet: Wallet = {
      id: `wallet-${this.nextWalletId++}`,
      userId,
      publicKey,
      encryptedPrivateKey,
      name: "Main Wallet",
      balance: "0",
      isPrimary: "true",
      isArchived: "false",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    memoryDB.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async updateWalletBalance(walletId: string, balance: string): Promise<Wallet> {
    const wallet = memoryDB.wallets.get(walletId);
    if (!wallet) {
      throw new Error(`Wallet ${walletId} not found`);
    }

    const updated: Wallet = {
      ...wallet,
      balance,
      updatedAt: new Date(),
    };

    memoryDB.wallets.set(walletId, updated);
    return updated;
  }

  // Multi-wallet operations
  async getAllUserWallets(userId: string): Promise<Wallet[]> {
    const wallets = Array.from(memoryDB.wallets.values());
    return wallets.filter(wallet => wallet.userId === userId);
  }

  async createAdditionalWallet(walletData: InsertWallet): Promise<Wallet> {
    const wallet: Wallet = {
      id: `wallet-${this.nextWalletId++}`,
      name: walletData.name || `Wallet ${this.nextWalletId}`,
      balance: walletData.balance || "0",
      isPrimary: walletData.isPrimary || "false",
      isArchived: walletData.isArchived || "false",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...walletData,
    };

    memoryDB.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async getWalletById(walletId: string): Promise<Wallet | undefined> {
    return memoryDB.wallets.get(walletId);
  }

  // Find a wallet (and associated user info) by public key
  async getUserByPublicKey(publicKey: string): Promise<({ privateKey?: string } & (User | Wallet)) | undefined> {
    // Search wallets map for matching publicKey
    const wallets = Array.from(memoryDB.wallets.values());
    const wallet = wallets.find(w => w.publicKey === publicKey);

    if (wallet) {
      // Return wallet with encrypted private key under `privateKey` to keep compatibility
      return {
        ...wallet,
        // some callers expect a `privateKey` property referencing the encrypted private key
        privateKey: (wallet as any).encryptedPrivateKey,
      } as any;
    }

    // Optionally try to find a user by id that contains wallet info
    const users = Array.from(memoryDB.users.values());
    const user = users.find(u => u.id === publicKey || u.email === publicKey);
    if (user) return user as any;

    return undefined;
  }

  async updateWallet(walletId: string, updates: { name?: string; isArchived?: string }): Promise<Wallet> {
    const wallet = memoryDB.wallets.get(walletId);
    if (!wallet) {
      throw new Error(`Wallet ${walletId} not found`);
    }

    const updated: Wallet = {
      ...wallet,
      ...updates,
      updatedAt: new Date(),
    };

    memoryDB.wallets.set(walletId, updated);
    return updated;
  }

  async updateWalletBalanceAtomic(walletId: string, updateFn: (cur: number) => number, opts?: { attempts?: number; backoffMs?: number }): Promise<{ committed: boolean; newVal?: number }> {
    const attempts = opts?.attempts ?? 6;
    const backoffMs = opts?.backoffMs ?? 50;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const wallet = memoryDB.wallets.get(walletId);
      if (!wallet) throw new Error(`Wallet ${walletId} not found`);
      const cur = parseFloat(wallet.balance || '0') || 0;
      let nextVal: number;
      try {
        nextVal = updateFn(cur);
      } catch (e) {
        return { committed: false };
      }
      if (typeof nextVal !== 'number' || !Number.isFinite(nextVal)) {
        return { committed: false };
      }

      // write-back (simple optimistic): check that the stored balance hasn't changed
      const before = parseFloat((memoryDB.wallets.get(walletId)?.balance) || '0') || 0;
      if (before !== cur) {
        // someone changed it concurrently; retry after backoff
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }

      const updated: Wallet = {
        ...wallet,
        balance: String(nextVal),
        updatedAt: new Date(),
      };
      memoryDB.wallets.set(walletId, updated);
      return { committed: true, newVal: nextVal };
    }

    return { committed: false };
  }
}

export const storage = new MemoryStorage();
