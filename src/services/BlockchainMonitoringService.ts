import Web3 from 'web3';
import TronWeb from 'tronweb';
import { Transaction, ITransaction } from '@/models/Transaction';
import { Wallet } from '@/models/Wallet';
import { walletService } from './WalletService';
import { logger, securityLogger } from '@/utils/logger';
import config from '@/config';
import mongoose from 'mongoose';

export interface DepositEvent {
  txHash: string;
  network: 'ethereum' | 'tron' | 'bsc';
  token: 'usdt' | 'usdc';
  amount: number;
  fromAddress: string;
  toAddress: string;
  blockNumber: number;
  blockHash?: string;
  gasUsed?: number;
  gasFee?: number;
}

export interface TransactionStatus {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  confirmations: number;
  requiredConfirmations: number;
  blockNumber?: number;
  error?: string;
}

export interface WebhookData {
  network: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  token: string;
  blockNumber: number;
  confirmations: number;
  status: string;
}

class BlockchainMonitoringService {
  private web3Ethereum: Web3;
  private web3BSC: Web3;
  private tronWeb: any;
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isMonitoring: boolean = false;

  // Token contract addresses for each network
  private readonly tokenContracts = {
    ethereum: {
      usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      usdc: '0xA0b86a33E6441E6C7D3E4C7C5C6C7C5C6C7C5C6C' // Placeholder
    },
    bsc: {
      usdt: '0x55d398326f99059fF775485246999027B3197955',
      usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
    },
    tron: {
      usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      usdc: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'
    }
  };

  // Required confirmations for each network
  private readonly requiredConfirmations = {
    ethereum: 12,
    bsc: 15,
    tron: 19
  };

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
    
    this.tronWeb = new TronWeb({
      fullHost: tronRpc,
      headers: { "TRON-PRO-API-KEY": process.env.TRON_API_KEY || '' }
    });

    logger.info('BlockchainMonitoringService initialized', {
      networks: ['ethereum', 'bsc', 'tron'],
      environment: config.nodeEnv
    });
  }

  /**
   * Start monitoring blockchain transactions
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('Blockchain monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    logger.info('Starting blockchain transaction monitoring');

    // Start monitoring for each network
    this.startEthereumMonitoring();
    this.startBSCMonitoring();
    this.startTronMonitoring();

    // Start confirmation monitoring for pending transactions
    this.startConfirmationMonitoring();

    logger.info('Blockchain monitoring started for all networks');
  }

  /**
   * Stop monitoring blockchain transactions
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    
    // Clear all monitoring intervals
    this.monitoringIntervals.forEach((interval, key) => {
      clearInterval(interval);
      this.monitoringIntervals.delete(key);
    });

    logger.info('Blockchain monitoring stopped');
  }

  /**
   * Process webhook data from blockchain providers
   */
  async processWebhook(webhookData: WebhookData): Promise<void> {
    try {
      const { network, txHash, fromAddress, toAddress, amount, token, blockNumber, confirmations, status } = webhookData;

      // Validate webhook data
      if (!this.isValidNetwork(network as any) || !this.isValidToken(token as any)) {
        throw new Error(`Invalid webhook data: network=${network}, token=${token}`);
      }

      // Check if we're monitoring this address
      const wallet = await walletService.findWalletByAddress(toAddress);
      if (!wallet) {
        logger.debug('Webhook received for non-monitored address', { toAddress, txHash });
        return;
      }

      // Check if transaction already exists
      let transaction = await Transaction.findOne({ txHash });
      
      if (!transaction) {
        // Create new transaction record
        const newTransaction = await this.createTransactionRecord({
          txHash,
          network: network as any,
          token: token as any,
          amount: parseFloat(amount),
          fromAddress,
          toAddress,
          blockNumber,
          blockHash: undefined,
          gasUsed: undefined,
          gasFee: undefined
        }, wallet.userId);
        transaction = newTransaction;

        transaction.webhookReceived = true;
        transaction.webhookData = webhookData;
      }

      if (!transaction) {
        throw new Error('Transaction not found or created');
      }

      // Update transaction status and confirmations
      transaction.confirmations = confirmations;
      transaction.blockNumber = blockNumber;
      
      if (status === 'confirmed' && confirmations >= this.requiredConfirmations[network as keyof typeof this.requiredConfirmations]) {
        transaction.status = 'confirmed';
        transaction.confirmedAt = new Date();
      }

      await transaction.save();

      // Process deposit if confirmed and not yet processed
      if (transaction.canProcess()) {
        await this.processConfirmedDeposit(transaction);
      }

      logger.info('Webhook processed successfully', {
        txHash,
        network,
        token,
        amount,
        confirmations,
        status: transaction.status
      });

    } catch (error) {
      logger.error('Failed to process webhook:', error);
      throw error;
    }
  }

  /**
   * Manually detect deposit for a specific transaction hash
   */
  async detectDeposit(network: 'ethereum' | 'tron' | 'bsc', txHash: string): Promise<DepositEvent | null> {
    try {
      let depositEvent: DepositEvent | null = null;

      switch (network) {
        case 'ethereum':
          depositEvent = await this.detectEthereumDeposit(txHash);
          break;
        case 'bsc':
          depositEvent = await this.detectBSCDeposit(txHash);
          break;
        case 'tron':
          depositEvent = await this.detectTronDeposit(txHash);
          break;
      }

      if (depositEvent) {
        // Check if we're monitoring the destination address
        const wallet = await walletService.findWalletByAddress(depositEvent.toAddress);
        if (wallet) {
          // Create transaction record
          await this.createTransactionRecord(depositEvent, wallet.userId);
          
          logger.info('Deposit detected manually', {
            txHash,
            network,
            token: depositEvent.token,
            amount: depositEvent.amount,
            toAddress: depositEvent.toAddress
          });
        }
      }

      return depositEvent;

    } catch (error) {
      logger.error('Failed to detect deposit:', error);
      throw error;
    }
  }

  /**
   * Get transaction status by hash
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus | null> {
    try {
      const transaction = await Transaction.findOne({ txHash });
      if (!transaction) {
        return null;
      }

      return {
        txHash: transaction.txHash,
        status: transaction.status,
        confirmations: transaction.confirmations,
        requiredConfirmations: transaction.requiredConfirmations,
        blockNumber: transaction.blockNumber,
        error: transaction.errorMessage
      };

    } catch (error) {
      logger.error('Failed to get transaction status:', error);
      throw error;
    }
  }

  /**
   * Start monitoring Ethereum network
   */
  private startEthereumMonitoring(): void {
    const interval = setInterval(async () => {
      try {
        await this.scanEthereumBlocks();
      } catch (error) {
        logger.error('Ethereum monitoring error:', error);
      }
    }, 30000); // Check every 30 seconds

    this.monitoringIntervals.set('ethereum', interval);
  }

  /**
   * Start monitoring BSC network
   */
  private startBSCMonitoring(): void {
    const interval = setInterval(async () => {
      try {
        await this.scanBSCBlocks();
      } catch (error) {
        logger.error('BSC monitoring error:', error);
      }
    }, 15000); // Check every 15 seconds (BSC is faster)

    this.monitoringIntervals.set('bsc', interval);
  }

  /**
   * Start monitoring Tron network
   */
  private startTronMonitoring(): void {
    const interval = setInterval(async () => {
      try {
        await this.scanTronBlocks();
      } catch (error) {
        logger.error('Tron monitoring error:', error);
      }
    }, 10000); // Check every 10 seconds (Tron is fastest)

    this.monitoringIntervals.set('tron', interval);
  }

  /**
   * Start monitoring confirmations for pending transactions
   */
  private startConfirmationMonitoring(): void {
    const interval = setInterval(async () => {
      try {
        await this.updatePendingTransactionConfirmations();
      } catch (error) {
        logger.error('Confirmation monitoring error:', error);
      }
    }, 60000); // Check every minute

    this.monitoringIntervals.set('confirmations', interval);
  }

  /**
   * Scan recent Ethereum blocks for deposits
   */
  private async scanEthereumBlocks(): Promise<void> {
    // Implementation would scan recent blocks for USDT/USDC transfers to monitored addresses
    // This is a simplified version - in production, you'd use event filters or a service like Alchemy
    logger.debug('Scanning Ethereum blocks for deposits');
  }

  /**
   * Scan recent BSC blocks for deposits
   */
  private async scanBSCBlocks(): Promise<void> {
    // Similar to Ethereum scanning
    logger.debug('Scanning BSC blocks for deposits');
  }

  /**
   * Scan recent Tron blocks for deposits
   */
  private async scanTronBlocks(): Promise<void> {
    // Tron-specific block scanning
    logger.debug('Scanning Tron blocks for deposits');
  }

  /**
   * Update confirmations for pending transactions
   */
  private async updatePendingTransactionConfirmations(): Promise<void> {
    try {
      const pendingTransactions = await Transaction.find({ 
        status: 'pending',
        blockNumber: { $exists: true }
      }).limit(100);

      for (const transaction of pendingTransactions) {
        try {
          const currentConfirmations = await this.getCurrentConfirmations(
            transaction.network,
            transaction.blockNumber!
          );

          if (currentConfirmations !== transaction.confirmations) {
            transaction.confirmations = currentConfirmations;
            await transaction.save();

            // Process deposit if now confirmed
            if (transaction.canProcess()) {
              await this.processConfirmedDeposit(transaction);
            }
          }
        } catch (error) {
          logger.error(`Failed to update confirmations for transaction ${transaction.txHash}:`, error);
        }
      }

    } catch (error) {
      logger.error('Failed to update pending transaction confirmations:', error);
    }
  }

  /**
   * Get current confirmations for a transaction
   */
  private async getCurrentConfirmations(network: 'ethereum' | 'tron' | 'bsc', blockNumber: number): Promise<number> {
    try {
      let currentBlock: number;

      switch (network) {
        case 'ethereum':
          currentBlock = Number(await this.web3Ethereum.eth.getBlockNumber());
          break;
        case 'bsc':
          currentBlock = Number(await this.web3BSC.eth.getBlockNumber());
          break;
        case 'tron':
          // Tron uses different API
          const latestBlock = await this.tronWeb.trx.getCurrentBlock();
          currentBlock = latestBlock.block_header.raw_data.number;
          break;
        default:
          throw new Error(`Unsupported network: ${network}`);
      }

      return Math.max(0, currentBlock - blockNumber + 1);

    } catch (error) {
      logger.error(`Failed to get current confirmations for ${network}:`, error);
      return 0;
    }
  }

  /**
   * Detect Ethereum deposit
   */
  private async detectEthereumDeposit(txHash: string): Promise<DepositEvent | null> {
    try {
      const receipt = await this.web3Ethereum.eth.getTransactionReceipt(txHash);
      if (!receipt) {
        return null;
      }

      // Parse transaction logs for USDT/USDC transfers
      // This is simplified - in production, you'd decode the logs properly
      return null;

    } catch (error) {
      logger.error('Failed to detect Ethereum deposit:', error);
      return null;
    }
  }

  /**
   * Detect BSC deposit
   */
  private async detectBSCDeposit(txHash: string): Promise<DepositEvent | null> {
    // Similar to Ethereum
    return null;
  }

  /**
   * Detect Tron deposit
   */
  private async detectTronDeposit(txHash: string): Promise<DepositEvent | null> {
    // Tron-specific transaction parsing
    return null;
  }

  /**
   * Create transaction record in database
   */
  private async createTransactionRecord(depositEvent: DepositEvent, userId: mongoose.Types.ObjectId) {
    try {
      // Find user's wallet
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found for user');
      }

      // Check if transaction already exists
      const existingTransaction = await Transaction.findOne({ txHash: depositEvent.txHash });
      if (existingTransaction) {
        throw new Error('Transaction already exists');
      }

      // Create transaction record
      const transaction = new Transaction({
        userId,
        walletId: wallet._id,
        txHash: depositEvent.txHash,
        network: depositEvent.network,
        type: 'deposit',
        token: depositEvent.token,
        amount: depositEvent.amount,
        fromAddress: depositEvent.fromAddress,
        toAddress: depositEvent.toAddress,
        status: 'pending',
        confirmations: 0,
        requiredConfirmations: this.requiredConfirmations[depositEvent.network],
        blockNumber: depositEvent.blockNumber,
        blockHash: depositEvent.blockHash,
        gasUsed: depositEvent.gasUsed,
        gasFee: depositEvent.gasFee,
        detectedAt: new Date()
      });

      await transaction.save();

      logger.info('Transaction record created', {
        txHash: depositEvent.txHash,
        userId,
        network: depositEvent.network,
        token: depositEvent.token,
        amount: depositEvent.amount
      });

      return transaction;

    } catch (error) {
      throw error;
    }
  }

  /**
   * Process confirmed deposit by updating wallet balance
   */
  private async processConfirmedDeposit(transaction: ITransaction): Promise<void> {
    try {
      // Update wallet balance
      await walletService.updateBalance(
        transaction.userId.toString(),
        transaction.network,
        transaction.token,
        transaction.amount
      );

      // Mark transaction as processed
      transaction.processedAt = new Date();
      await transaction.save();

      logger.info('Deposit processed successfully', {
        txHash: transaction.txHash,
        userId: transaction.userId,
        network: transaction.network,
        token: transaction.token,
        amount: transaction.amount
      });

      securityLogger.info('Deposit processed', {
        txHash: transaction.txHash,
        userId: transaction.userId,
        network: transaction.network,
        token: transaction.token,
        amount: transaction.amount
      });

    } catch (error) {
      logger.error('Failed to process confirmed deposit:', error);
      throw error;
    }
  }

  /**
   * Validate network name
   */
  private isValidNetwork(network: string): network is 'ethereum' | 'tron' | 'bsc' {
    return ['ethereum', 'tron', 'bsc'].includes(network);
  }

  /**
   * Validate token name
   */
  private isValidToken(token: string): token is 'usdt' | 'usdc' {
    return ['usdt', 'usdc'].includes(token);
  }

  /**
   * Get monitoring statistics
   */
  async getMonitoringStatistics(): Promise<{
    isMonitoring: boolean;
    totalTransactions: number;
    pendingTransactions: number;
    confirmedTransactions: number;
    failedTransactions: number;
    totalDeposits: number;
    recentTransactions: number;
    networkBreakdown: {
      ethereum: { transactions: number; totalValue: number };
      tron: { transactions: number; totalValue: number };
      bsc: { transactions: number; totalValue: number };
    };
  }> {
    try {
      const [
        totalTransactions,
        pendingTransactions,
        confirmedTransactions,
        failedTransactions,
        totalDeposits,
        recentTransactions,
        networkStats
      ] = await Promise.all([
        Transaction.countDocuments(),
        Transaction.countDocuments({ status: 'pending' }),
        Transaction.countDocuments({ status: 'confirmed' }),
        Transaction.countDocuments({ status: 'failed' }),
        Transaction.countDocuments({ type: 'deposit', status: 'confirmed' }),
        Transaction.countDocuments({
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
        }),
        Transaction.aggregate([
          {
            $group: {
              _id: '$network',
              transactions: { $sum: 1 },
              totalValue: { $sum: '$amount' }
            }
          }
        ])
      ]);

      const networkBreakdown = {
        ethereum: { transactions: 0, totalValue: 0 },
        tron: { transactions: 0, totalValue: 0 },
        bsc: { transactions: 0, totalValue: 0 }
      };

      networkStats.forEach((stat: any) => {
        if (stat._id && networkBreakdown[stat._id as keyof typeof networkBreakdown]) {
          networkBreakdown[stat._id as keyof typeof networkBreakdown] = {
            transactions: stat.transactions,
            totalValue: stat.totalValue
          };
        }
      });

      return {
        isMonitoring: this.isMonitoring,
        totalTransactions,
        pendingTransactions,
        confirmedTransactions,
        failedTransactions,
        totalDeposits,
        recentTransactions,
        networkBreakdown
      };

    } catch (error) {
      logger.error('Failed to get monitoring statistics:', error);
      throw error;
    }
  }
}

export const blockchainMonitoringService = new BlockchainMonitoringService();