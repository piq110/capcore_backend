import crypto from 'crypto';
import Web3 from 'web3';
import TronWeb from 'tronweb';
import { Wallet, IWallet, IWalletAddress, IWalletBalances, IWalletPrivateKeys } from '@/models/Wallet';
import { User } from '@/models/User';
import { logger, securityLogger } from '@/utils/logger';
import config from '@/config';
import mongoose from 'mongoose';

export interface MultiChainBalances {
  usdt: {
    ethereum: number;
    tron: number;
    bsc: number;
    total: number;
  };
  usdc: {
    ethereum: number;
    tron: number;
    bsc: number;
    total: number;
  };
  totalUSD: number;
}

export interface WalletGenerationResult {
  addresses: IWalletAddress;
  wallet: IWallet;
}

export interface GeneratedWalletData {
  address: string;
  privateKey: string;
}

export interface BlockchainNetwork {
  name: 'ethereum' | 'tron' | 'bsc';
  chainId?: number;
  rpcUrl: string;
  testnetRpcUrl: string;
}

class WalletService {
  private web3Ethereum: Web3;
  private web3BSC: Web3;
  private tronWeb: any;
  private encryptionKey: string;

  constructor() {
    // Initialize blockchain connections
    const ethereumRpc = config.nodeEnv === 'production' 
      ? config.blockchain.ethereum.rpcUrl 
      : config.blockchain.ethereum.testnetRpcUrl;
    
    const bscRpc = config.nodeEnv === 'production'
      ? config.blockchain.bsc.rpcUrl
      : config.blockchain.bsc.testnetRpcUrl;
    
    const tronRpc = config.nodeEnv === 'production'
      ? config.blockchain.tron.rpcUrl
      : config.blockchain.tron.testnetRpcUrl;

    this.web3Ethereum = new Web3(ethereumRpc);
    this.web3BSC = new Web3(bscRpc);
    
    // Initialize TronWeb
    this.tronWeb = new TronWeb({
      fullHost: tronRpc,
      headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY || '' },
      privateKey: process.env.TRON_PRIVATE_KEY || this.generateRandomPrivateKey()
    });

    // Encryption key for storing sensitive wallet data
    this.encryptionKey = config.encryption?.walletKey || process.env.WALLET_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

    if (!config.encryption?.walletKey && !process.env.WALLET_ENCRYPTION_KEY) {
      logger.warn('No WALLET_ENCRYPTION_KEY found in environment. Using generated key. This is NOT recommended for production!');
    }

    logger.info('WalletService initialized', {
      ethereumRpc: ethereumRpc.substring(0, 50) + '...',
      bscRpc: bscRpc.substring(0, 50) + '...',
      tronRpc: tronRpc.substring(0, 50) + '...',
      environment: config.nodeEnv,
      encryptionKeyConfigured: !!(config.encryption?.walletKey || process.env.WALLET_ENCRYPTION_KEY)
    });
  }

  /**
   * Generate a multi-chain wallet for a user
   */
  async generateMultiChainWallet(userId: string): Promise<WalletGenerationResult> {
    try {
      // Check if user exists
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check if wallet already exists
      const existingWallet = await Wallet.findOne({ userId });
      if (existingWallet) {
        throw new Error('Wallet already exists for this user');
      }

      // Generate addresses and private keys for each network
      const { addresses, privateKeys } = await this.generateAddressesForAllNetworks();

      // Create wallet record with encrypted private keys
      const wallet = new Wallet({
        userId,
        addresses,
        privateKeys,
        balances: {
          usdt: { ethereum: 0, tron: 0, bsc: 0 },
          usdc: { ethereum: 0, tron: 0, bsc: 0 }
        },
        totalBalanceUSD: 0,
        lastSyncAt: new Date()
      });

      await wallet.save();

      logger.info('Multi-chain wallet generated', {
        userId,
        walletId: wallet._id,
        addresses: {
          ethereum: addresses.ethereum,
          tron: addresses.tron,
          bsc: addresses.bsc
        }
      });

      securityLogger.info('Wallet generation', {
        userId,
        walletId: wallet._id,
        networksSupported: ['ethereum', 'tron', 'bsc'],
        privateKeysStored: true
      });

      return { addresses, wallet };

    } catch (error) {
      logger.error('Wallet generation failed:', error);
      throw error;
    }
  }

  /**
   * Get wallet addresses for a user
   */
  async getWalletAddresses(userId: string): Promise<IWalletAddress> {
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found for user');
      }

      return wallet.addresses;

    } catch (error) {
      logger.error('Failed to get wallet addresses:', error);
      throw error;
    }
  }

  /**
   * Get multi-chain balances for a user
   */
  async getMultiChainBalances(userId: string): Promise<MultiChainBalances> {
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        // Return zero balances if wallet doesn't exist yet
        return {
          usdt: {
            ethereum: 0,
            tron: 0,
            bsc: 0,
            total: 0
          },
          usdc: {
            ethereum: 0,
            tron: 0,
            bsc: 0,
            total: 0
          },
          totalUSD: 0
        };
      }

      const { usdt, usdc } = wallet.balances;

      const usdtTotal = usdt.ethereum + usdt.tron + usdt.bsc;
      const usdcTotal = usdc.ethereum + usdc.tron + usdc.bsc;
      const totalUSD = usdtTotal + usdcTotal;

      return {
        usdt: {
          ethereum: usdt.ethereum,
          tron: usdt.tron,
          bsc: usdt.bsc,
          total: usdtTotal
        },
        usdc: {
          ethereum: usdc.ethereum,
          tron: usdc.tron,
          bsc: usdc.bsc,
          total: usdcTotal
        },
        totalUSD: totalUSD
      };

    } catch (error) {
      logger.error('Failed to get multi-chain balances:', error);
      throw error;
    }
  }

  /**
   * Update balance for a specific network and token
   */
  async updateBalance(
    userId: string,
    network: 'ethereum' | 'tron' | 'bsc',
    token: 'usdt' | 'usdc',
    amount: number
  ): Promise<IWallet> {
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found for user');
      }

      const previousBalance = wallet.balances[token][network];
      
      // Update balance using the model method
      wallet.updateBalance(network, token, amount);
      await wallet.save();

      logger.info('Wallet balance updated', {
        userId,
        network,
        token,
        previousBalance,
        newBalance: amount,
        totalBalance: wallet.totalBalanceUSD
      });

      return wallet;

    } catch (error) {
      logger.error('Failed to update wallet balance:', error);
      throw error;
    }
  }

  /**
   * Get wallet by user ID
   */
  async getWalletByUserId(userId: string): Promise<IWallet | null> {
    try {
      return await Wallet.findOne({ userId });
    } catch (error) {
      logger.error('Failed to get wallet by user ID:', error);
      throw error;
    }
  }

  /**
   * Find wallet by address (any network)
   */
  async findWalletByAddress(address: string): Promise<IWallet | null> {
    try {
      const wallet = await Wallet.findOne({
        $or: [
          { 'addresses.ethereum': address },
          { 'addresses.tron': address },
          { 'addresses.bsc': address }
        ]
      }).populate('userId', 'email kycStatus');

      return wallet;

    } catch (error) {
      logger.error('Failed to find wallet by address:', error);
      throw error;
    }
  }

  /**
   * Sync balances from blockchain for a user
   */
  async syncBalancesFromBlockchain(userId: string): Promise<MultiChainBalances> {
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found for user');
      }

      // This will be implemented in task 5.2 with blockchain monitoring
      // For now, return current balances
      logger.info('Balance sync requested (will be implemented in blockchain monitoring)', {
        userId,
        addresses: wallet.addresses
      });

      return this.getMultiChainBalances(userId);

    } catch (error) {
      logger.error('Failed to sync balances from blockchain:', error);
      throw error;
    }
  }

  /**
   * Encrypt a private key using AES-256-GCM
   */
  private encryptPrivateKey(privateKey: string): { encryptedKey: string; iv: string } {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this.encryptionKey, 'hex').slice(0, 32), iv);
      
      let encrypted = cipher.update(privateKey, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encryptedKey: encrypted + authTag.toString('hex'),
        iv: iv.toString('hex')
      };
    } catch (error) {
      logger.error('Failed to encrypt private key:', error);
      throw new Error('Private key encryption failed');
    }
  }

  /**
   * Decrypt a private key using AES-256-GCM
   */
  decryptPrivateKey(encryptedKey: string, iv: string): string {
    try {
      const authTag = Buffer.from(encryptedKey.slice(-32), 'hex');
      const encryptedText = encryptedKey.slice(0, -32);
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.encryptionKey, 'hex').slice(0, 32), Buffer.from(iv, 'hex'));
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      logger.error('Failed to decrypt private key:', error);
      throw new Error('Private key decryption failed');
    }
  }

  /**
   * Generate addresses for all supported networks with private keys
   */
  private async generateAddressesForAllNetworks(): Promise<{ addresses: IWalletAddress; privateKeys: IWalletPrivateKeys }> {
    try {
      // Generate Ethereum account
      const ethereumAccount = this.web3Ethereum.eth.accounts.create();
      const ethereumAddress = ethereumAccount.address;
      const ethereumPrivateKey = ethereumAccount.privateKey;
      
      // BSC uses same account as Ethereum (same private key)
      const bscAddress = ethereumAddress;
      const bscPrivateKey = ethereumPrivateKey;

      // Generate Tron account
      const tronAccount = await this.tronWeb.createAccount();
      const tronAddress = tronAccount.address.base58;
      const tronPrivateKey = tronAccount.privateKey;

      // Validate generated addresses
      if (!this.isValidEthereumAddress(ethereumAddress)) {
        throw new Error('Invalid Ethereum address generated');
      }

      if (!this.isValidTronAddress(tronAddress)) {
        throw new Error('Invalid Tron address generated');
      }

      // Encrypt private keys
      const encryptedEthereumKey = this.encryptPrivateKey(ethereumPrivateKey);
      const encryptedBscKey = this.encryptPrivateKey(bscPrivateKey);
      const encryptedTronKey = this.encryptPrivateKey(tronPrivateKey);

      return {
        addresses: {
          ethereum: ethereumAddress,
          tron: tronAddress,
          bsc: bscAddress
        },
        privateKeys: {
          ethereum: encryptedEthereumKey,
          tron: encryptedTronKey,
          bsc: encryptedBscKey
        }
      };

    } catch (error) {
      logger.error('Failed to generate addresses for all networks:', error);
      throw new Error('Address generation failed');
    }
  }

  /**
   * Validate Ethereum address format
   */
  private isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Validate Tron address format
   */
  private isValidTronAddress(address: string): boolean {
    return /^T[A-Za-z0-9]{33}$/.test(address);
  }

  /**
   * Generate a random private key for TronWeb initialization
   */
  private generateRandomPrivateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(network: 'ethereum' | 'tron' | 'bsc'): BlockchainNetwork {
    const configs = {
      ethereum: {
        name: 'ethereum' as const,
        chainId: config.nodeEnv === 'production' ? 1 : 5, // Mainnet or Goerli
        rpcUrl: config.blockchain.ethereum.rpcUrl,
        testnetRpcUrl: config.blockchain.ethereum.testnetRpcUrl
      },
      tron: {
        name: 'tron' as const,
        rpcUrl: config.blockchain.tron.rpcUrl,
        testnetRpcUrl: config.blockchain.tron.testnetRpcUrl
      },
      bsc: {
        name: 'bsc' as const,
        chainId: config.nodeEnv === 'production' ? 56 : 97, // Mainnet or Testnet
        rpcUrl: config.blockchain.bsc.rpcUrl,
        testnetRpcUrl: config.blockchain.bsc.testnetRpcUrl
      }
    };

    return configs[network];
  }

  /**
   * Get wallet statistics for admin dashboard
   */
  async getWalletStatistics(): Promise<{
    totalWallets: number;
    walletsWithBalance: number;
    totalValueUSD: number;
    networkDistribution: {
      ethereum: { wallets: number; totalValue: number };
      tron: { wallets: number; totalValue: number };
      bsc: { wallets: number; totalValue: number };
    };
    recentWallets: number;
  }> {
    try {
      const [
        totalWallets,
        walletsWithBalance,
        totalValueResult,
        recentWallets,
        networkStats
      ] = await Promise.all([
        Wallet.countDocuments(),
        Wallet.countDocuments({ totalBalanceUSD: { $gt: 0 } }),
        Wallet.aggregate([
          { $group: { _id: null, totalValue: { $sum: '$totalBalanceUSD' } } }
        ]),
        Wallet.countDocuments({
          createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
        }),
        Wallet.aggregate([
          {
            $group: {
              _id: null,
              ethereumValue: { $sum: { $add: ['$balances.usdt.ethereum', '$balances.usdc.ethereum'] } },
              tronValue: { $sum: { $add: ['$balances.usdt.tron', '$balances.usdc.tron'] } },
              bscValue: { $sum: { $add: ['$balances.usdt.bsc', '$balances.usdc.bsc'] } },
              ethereumWallets: {
                $sum: {
                  $cond: [
                    { $gt: [{ $add: ['$balances.usdt.ethereum', '$balances.usdc.ethereum'] }, 0] },
                    1,
                    0
                  ]
                }
              },
              tronWallets: {
                $sum: {
                  $cond: [
                    { $gt: [{ $add: ['$balances.usdt.tron', '$balances.usdc.tron'] }, 0] },
                    1,
                    0
                  ]
                }
              },
              bscWallets: {
                $sum: {
                  $cond: [
                    { $gt: [{ $add: ['$balances.usdt.bsc', '$balances.usdc.bsc'] }, 0] },
                    1,
                    0
                  ]
                }
              }
            }
          }
        ])
      ]);

      const totalValueUSD = totalValueResult[0]?.totalValue || 0;
      const networkData = networkStats[0] || {};

      return {
        totalWallets,
        walletsWithBalance,
        totalValueUSD,
        networkDistribution: {
          ethereum: {
            wallets: networkData.ethereumWallets || 0,
            totalValue: networkData.ethereumValue || 0
          },
          tron: {
            wallets: networkData.tronWallets || 0,
            totalValue: networkData.tronValue || 0
          },
          bsc: {
            wallets: networkData.bscWallets || 0,
            totalValue: networkData.bscValue || 0
          }
        },
        recentWallets
      };

    } catch (error) {
      logger.error('Failed to get wallet statistics:', error);
      throw error;
    }
  }
}

export const walletService = new WalletService();