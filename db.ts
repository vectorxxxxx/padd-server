// Simple in-memory storage - no database required
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Wallet {
  id: string;
  userId: string;
  publicKey: string;
  encryptedPrivateKey: string;
  name?: string;
  balance?: string;
  isPrimary?: string;
  isArchived?: string;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory storage
const users = new Map<string, User>();
const wallets = new Map<string, Wallet>();

export const memoryDB = {
  users,
  wallets,
};
