import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { authenticate } from '@/middleware/auth';
import { requireKYCForTrading } from '@/middleware/kycMiddleware';
import { walletService } from '@/services/WalletService';
import { blockchainMonitoringService } from '@/services/BlockchainMonitoringService';
import { Withdrawal } from '@/models/Withdrawal';
import { Wallet } from '@/models/Wallet';
import { Transaction } from '@/models/Transaction';
import { logger, securityLogger } from '@/utils/logger';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * GET /api/wallet/addresses
 * Get user's multi-chain wallet addresses for deposits
 */
router.get('/addresses', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    const userId = req.user!.userId;

    // Get wallet for user (should have been created during registration)
    const wallet = await walletService.getWalletByUserId(userId);
    
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found. Please contact support.'
      });
    }

    const addresses = await walletService.getWalletAddresses(userId);

    return res.json({
      success: true,
      data: {
        addresses,
        networks: {
          ethereum: {
            name: 'Ethereum',
            symbol: 'ETH',
            tokens: ['USDT', 'USDC'],
            confirmations: 12
          },
          tron: {
            name: 'Tron',
            symbol: 'TRX',
            tokens: ['USDT', 'USDC'],
            confirmations: 19
          },
          bsc: {
            name: 'Binance Smart Chain',
            symbol: 'BNB',
            tokens: ['USDT', 'USDC'],
            confirmations: 15
          }
        }
      }
    });

  } catch (error) {
    logger.error('Failed to get wallet addresses:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get wallet addresses'
    });
  }
});

/**
 * GET /api/wallet/balances
 * Get user's multi-chain balances
 */
router.get('/balances', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    const userId = req.user!.userId;

    // Get wallet for user (don't create if doesn't exist)
    const wallet = await walletService.getWalletByUserId(userId);
    
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found. Please contact support to create your wallet.'
      });
    }

    const balances = await walletService.getMultiChainBalances(userId);

    return res.json({
      success: true,
      data: balances
    });

  } catch (error) {
    logger.error('Failed to get wallet balances:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get wallet balances'
    });
  }
});

/**
 * POST /api/wallet/sync-balances
 * Manually sync balances from blockchain
 */
router.post('/sync-balances', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    const userId = req.user!.userId;

    const balances = await walletService.syncBalancesFromBlockchain(userId);

    logger.info('Manual balance sync requested', { userId });

    return res.json({
      success: true,
      data: balances,
      message: 'Balance sync initiated'
    });

  } catch (error) {
    logger.error('Failed to sync balances:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync balances'
    });
  }
});

/**
 * GET /api/wallet/transactions
 * Get user's transaction history
 */
router.get('/transactions', 
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('type').optional().isIn(['deposit', 'withdrawal']).withMessage('Type must be deposit or withdrawal'),
    query('network').optional().isIn(['ethereum', 'tron', 'bsc']).withMessage('Invalid network'),
    query('status').optional().isIn(['pending', 'confirmed', 'failed']).withMessage('Invalid status'),
  ],
  async (req: express.Request, res: express.Response)=> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const userId = req.user!.userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const type = req.query.type as string;
      const network = req.query.network as string;
      const status = req.query.status as string;

      // Build filter
      const filter: any = { userId };
      if (type) filter.type = type;
      if (network) filter.network = network;
      if (status) filter.status = status;

      const skip = (page - 1) * limit;

      const [transactions, total] = await Promise.all([
        Transaction.find(filter)
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(skip)
          .lean(),
        Transaction.countDocuments(filter)
      ]);

      return res.json({
        success: true,
        data: {
          transactions,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get transaction history:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get transaction history'
      });
    }
  }
);

/**
 * POST /api/wallet/withdraw
 * Request cryptocurrency withdrawal (requires admin approval)
 */
router.post('/withdraw',
  authenticate,
  requireKYCForTrading, // Require KYC verification for withdrawals
  [
    body('network').isIn(['ethereum', 'tron', 'bsc']).withMessage('Invalid network'),
    body('token').isIn(['usdt', 'usdc']).withMessage('Invalid token'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be at least 0.01'),
    body('toAddress').notEmpty().withMessage('Destination address is required'),
    body('toAddress').custom((value, { req }) => {
      const network = req.body.network;
      if (network === 'ethereum' || network === 'bsc') {
        if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
          throw new Error('Invalid Ethereum/BSC address format');
        }
      } else if (network === 'tron') {
        if (!/^T[A-Za-z0-9]{33}$/.test(value)) {
          throw new Error('Invalid Tron address format');
        }
      }
      return true;
    }),
  ],
  async (req: express.Request, res: express.Response)=> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const userId = req.user!.userId;
      const { network, token, amount, toAddress } = req.body;
      const ipAddress = req.ip;
      const userAgent = req.get('User-Agent');

      // Get user's wallet
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: 'Wallet not found'
        });
        return;
      }

      // Calculate withdrawal fee
      const { feeService } = await import('@/services/FeeService');
      const withdrawalFee = await feeService.calculateWithdrawalFee(amount);
      const totalRequired = amount + withdrawalFee.amount;

      // Check if user has sufficient balance (including fees)
      const currentBalance = wallet.balances[token as 'usdt' | 'usdc'][network as 'ethereum' | 'tron' | 'bsc'];
      if (currentBalance < totalRequired) {
        return res.status(400).json({
          success: false,
          message: 'Insufficient balance (including withdrawal fee)',
          data: {
            requested: amount,
            withdrawalFee: withdrawalFee.amount,
            totalRequired,
            available: currentBalance
          }
        });
        return;
      }

      // Check for minimum withdrawal amount
      const minWithdrawal = 10; // $10 minimum
      if (amount < minWithdrawal) {
        return res.status(400).json({
          success: false,
          message: `Minimum withdrawal amount is $${minWithdrawal}`,
        });
      }

      // Check for maximum withdrawal amount (daily limit)
      const maxDailyWithdrawal = 10000; // $10,000 daily limit
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayWithdrawals = await Withdrawal.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(userId),
            requestedAt: { $gte: today },
            status: { $in: ['pending', 'approved', 'processing', 'completed'] }
          }
        },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$amount' }
          }
        }
      ]);

      const todayTotal = todayWithdrawals[0]?.totalAmount || 0;
      if (todayTotal + amount > maxDailyWithdrawal) {
        return res.status(400).json({
          success: false,
          message: `Daily withdrawal limit exceeded. Limit: $${maxDailyWithdrawal}, Used: $${todayTotal}`,
        });
      }

      // Simple fraud detection
      const fraudScore = await calculateFraudScore(userId, amount, toAddress, ipAddress);
      const fraudFlags = await getFraudFlags(userId, amount, toAddress, ipAddress);

      // Create withdrawal request
      const withdrawal = new Withdrawal({
        userId,
        walletId: wallet._id,
        network,
        token,
        amount,
        toAddress,
        status: 'pending',
        requestedAt: new Date(),
        ipAddress,
        userAgent,
        fraudScore,
        fraudFlags
      });

      await withdrawal.save();

      // Collect withdrawal fee immediately
      await feeService.collectWithdrawalFee(
        new mongoose.Types.ObjectId(userId),
        withdrawal._id as mongoose.Types.ObjectId,
        amount
      );

      // Temporarily hold the funds (reduce available balance by withdrawal amount only, fee already deducted)
      wallet.updateBalance(network, token, currentBalance - totalRequired);
      await wallet.save();

      logger.info('Withdrawal request created', {
        withdrawalId: withdrawal._id,
        userId,
        network,
        token,
        amount,
        toAddress,
        fraudScore
      });

      securityLogger.info('Withdrawal request', {
        withdrawalId: withdrawal._id,
        userId,
        network,
        token,
        amount,
        toAddress: toAddress.substring(0, 10) + '...',
        fraudScore,
        fraudFlags,
        ipAddress
      });

      return res.status(201).json({
        success: true,
        data: {
          withdrawalId: withdrawal._id,
          status: withdrawal.status,
          amount: withdrawal.amount,
          withdrawalFee: withdrawalFee.amount,
          totalDeducted: totalRequired,
          network: withdrawal.network,
          token: withdrawal.token,
          estimatedProcessingTime: '1-3 business days',
          message: 'Withdrawal request submitted for admin approval'
        }
      });

    } catch (error) {
      logger.error('Failed to create withdrawal request:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to create withdrawal request'
      });
    }
  }
);

/**
 * GET /api/wallet/withdrawals
 * Get user's withdrawal history
 */
router.get('/withdrawals',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('status').optional().isIn(['pending', 'approved', 'rejected', 'processing', 'completed', 'failed']).withMessage('Invalid status'),
  ],
  async (req: express.Request, res: express.Response)=> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const userId = req.user!.userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;

      // Build filter
      const filter: any = { userId };
      if (status) filter.status = status;

      const skip = (page - 1) * limit;

      const [withdrawals, total] = await Promise.all([
        Withdrawal.find(filter)
          .populate('reviewedBy', 'email')
          .sort({ requestedAt: -1 })
          .limit(limit)
          .skip(skip)
          .lean(),
        Withdrawal.countDocuments(filter)
      ]);

      return res.json({
        success: true,
        data: {
          withdrawals,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get withdrawal history:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get withdrawal history'
      });
    }
  }
);

/**
 * GET /api/wallet/withdrawal/:id
 * Get specific withdrawal details
 */
router.get('/withdrawal/:id',
  authenticate,
  [
    param('id').isMongoId().withMessage('Invalid withdrawal ID'),
  ],
  async (req: express.Request, res: express.Response)=> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const userId = req.user!.userId;
      const withdrawalId = req.params.id;

      const withdrawal = await Withdrawal.findOne({ 
        _id: withdrawalId, 
        userId 
      }).populate('reviewedBy', 'email');

      if (!withdrawal) {
        return res.status(404).json({
          success: false,
          message: 'Withdrawal not found'
        });
      }

      return res.json({
        success: true,
        data: withdrawal
      });

    } catch (error) {
      logger.error('Failed to get withdrawal details:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get withdrawal details'
      });
    }
  }
);

/**
 * POST /api/wallet/webhook
 * Webhook endpoint for blockchain transaction notifications
 */
router.post('/webhook', async (req: express.Request, res: express.Response)=> {
  try {
    // Verify webhook signature (implementation depends on provider)
    // const signature = req.headers['x-signature'];
    // if (!verifyWebhookSignature(req.body, signature)) {
    //   return res.status(401).json({ success: false, message: 'Invalid signature' });
    // }

    await blockchainMonitoringService.processWebhook(req.body);

    return res.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    logger.error('Webhook processing failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Webhook processing failed'
    });
  }
});

// Helper functions

/**
 * Calculate fraud score for withdrawal request
 */
async function calculateFraudScore(
  userId: string, 
  amount: number, 
  toAddress: string, 
  ipAddress?: string
): Promise<number> {
  let score = 0;

  try {
    // Check withdrawal frequency
    const recentWithdrawals = await Withdrawal.countDocuments({
      userId,
      requestedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    if (recentWithdrawals > 3) score += 20;
    if (recentWithdrawals > 5) score += 30;

    // Check amount patterns
    if (amount > 1000) score += 10;
    if (amount > 5000) score += 20;

    // Check address reuse
    const addressUsage = await Withdrawal.countDocuments({
      userId,
      toAddress,
      status: { $in: ['completed', 'processing'] }
    });

    if (addressUsage === 0) score += 15; // New address
    if (addressUsage > 10) score -= 10; // Frequently used address (lower risk)

    // Check IP address patterns (simplified)
    if (ipAddress) {
      const ipUsage = await Withdrawal.countDocuments({
        userId,
        ipAddress,
        requestedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      });

      if (ipUsage === 0) score += 10; // New IP
    }

    return Math.min(100, Math.max(0, score));

  } catch (error) {
    logger.error('Failed to calculate fraud score:', error);
    return 50; // Default medium risk
  }
}

/**
 * Get fraud flags for withdrawal request
 */
async function getFraudFlags(
  userId: string, 
  amount: number, 
  toAddress: string, 
  ipAddress?: string
): Promise<string[]> {
  const flags: string[] = [];

  try {
    // Check for high-frequency withdrawals
    const recentCount = await Withdrawal.countDocuments({
      userId,
      requestedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } // Last hour
    });

    if (recentCount > 2) flags.push('HIGH_FREQUENCY');

    // Check for large amounts
    if (amount > 5000) flags.push('LARGE_AMOUNT');

    // Check for new destination address
    const addressHistory = await Withdrawal.findOne({
      userId,
      toAddress,
      status: 'completed'
    });

    if (!addressHistory) flags.push('NEW_ADDRESS');

    // Check for round numbers (potential indicator of suspicious activity)
    if (amount % 100 === 0 && amount >= 1000) flags.push('ROUND_AMOUNT');

    return flags;

  } catch (error) {
    logger.error('Failed to get fraud flags:', error);
    return [];
  }
}

export default router;