import { Connection, PublicKey, Transaction, Keypair } from '@solana/web3.js';
import { WalletService } from './walletService';
import { storage } from './storage';

/**
 * Sign a transaction using the user's custodial wallet
 */
export async function signTransaction(
  userPublicKey: string,
  transactionBase64: string
): Promise<string> {
  try {
    // Get user's wallet from storage
    const user = await storage.getUserByPublicKey(userPublicKey);
    if (!user || !user.privateKey) {
      throw new Error('User wallet not found');
    }

    // Decrypt the private key
    const privateKeyBytes = WalletService.decryptPrivateKey(user.privateKey);
    const keypair = Keypair.fromSecretKey(privateKeyBytes);

    // Deserialize the transaction
    const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));

    // Sign the transaction
    transaction.sign(keypair);

    // Serialize and return the signed transaction
    return Buffer.from(transaction.serialize()).toString('base64');
  } catch (error) {
    console.error('Transaction signing failed:', error);
    throw new Error('Failed to sign transaction');
  }
}

/**
 * Get user's wallet balance
 */
export async function getWalletBalance(userPublicKey: string): Promise<number> {
  try {
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
    const publicKey = new PublicKey(userPublicKey);
    const balance = await connection.getBalance(publicKey);
    return balance / 1e9; // Convert lamports to SOL
  } catch (error) {
    console.error('Failed to get wallet balance:', error);
    return 0;
  }
}

/**
 * Transfer SOL from user's wallet
 */
export async function transferSol(
  fromPublicKey: string,
  toPublicKey: string,
  amount: number
): Promise<string> {
  try {
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
    
    // Get user's wallet
    const user = await storage.getUserByPublicKey(fromPublicKey);
    if (!user || !user.privateKey) {
      throw new Error('User wallet not found');
    }

    // Decrypt the private key
    const privateKeyBytes = WalletService.decryptPrivateKey(user.privateKey);
    const keypair = Keypair.fromSecretKey(privateKeyBytes);

    // Create transfer transaction
    const transaction = new Transaction().add(
      // SystemProgram.transfer instruction would go here
      // For now, we'll return a mock transaction ID
    );

    // Sign and send the transaction
    transaction.sign(keypair);
    const signature = await connection.sendRawTransaction(transaction.serialize());

    return signature;
  } catch (error) {
    console.error('SOL transfer failed:', error);
    throw new Error('Failed to transfer SOL');
  }
}
