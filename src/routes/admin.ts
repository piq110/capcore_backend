import express from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { kycService } from '@/services/KYCService';
import { KYCSubmission } from '@/models/KYC';
import { Withdrawal } from '@/models/Withdrawal';
import { Wallet, IWalletBalances, ITokenBalance } from '@/models/Wallet';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { User } from '@/models/User';
import { Portfolio } from '@/models/Portfolio';
import { Transaction } from '@/models/Transaction';
import { Trade } from '@/models/Trade';
import { Order } from '@/models/Order';
import { AuditLog, createAuditLog } from '@/models/AuditLog';
import { PlatformConfig, getActiveConfig, createDefaultConfig } from '@/models/PlatformConfig';
import { authenticate, authorize } from '@/middleware/auth';
import { logger, securityLogger } from '@/utils/logger';
import mongoose from 'mongoose';

const router = express.Router();

// Helper function to handle validation errors
const handleValidationErrors = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.type === 'field' ? err.path : 'unknown',
        message: err.msg,
      })),
    });
    return;
  }
  next();
};

/**
 * GET /api/admin/users
 * Get users with pagination and filtering for admin management
 */
router.get('/users',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
    query('status')
      .optional()
      .isIn(['active', 'suspended', 'deactivated'])
      .withMessage('Invalid status'),
    query('kycStatus')
      .optional()
      .isIn(['not_started', 'pending', 'approved', 'rejected'])
      .withMessage('Invalid KYC status'),
    query('role')
      .optional()
      .isIn(['user', 'admin', 'issuer'])
      .withMessage('Invalid role'),
    query('emailVerified')
      .optional()
      .isBoolean()
      .withMessage('Email verified must be boolean'),
    query('mfaEnabled')
      .optional()
      .isBoolean()
      .withMessage('MFA enabled must be boolean'),
    query('accreditedInvestor')
      .optional()
      .isBoolean()
      .withMessage('Accredited investor must be boolean'),
    query('search')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Search term must be between 1-100 characters'),
    query('sortBy')
      .optional()
      .isIn(['email', 'createdAt', 'lastLoginAt', 'kycStatus', 'status'])
      .withMessage('Invalid sort field'),
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const {
        limit = 50,
        offset = 0,
        status,
        kycStatus,
        role,
        emailVerified,
        mfaEnabled,
        accreditedInvestor,
        search,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter
      const filter: any = {};
      if (status) filter.status = status;
      if (kycStatus) filter.kycStatus = kycStatus;
      if (role) filter.role = role;
      if (emailVerified !== undefined) filter.emailVerified = emailVerified === 'true';
      if (mfaEnabled !== undefined) filter.mfaEnabled = mfaEnabled === 'true';
      if (accreditedInvestor !== undefined) filter.accreditedInvestor = accreditedInvestor === 'true';
      
      // Add search functionality
      if (search) {
        filter.$or = [
          { email: { $regex: search, $options: 'i' } },
        ];
      }

      // Build sort
      const sort: any = {};
      sort[sortBy as string] = sortOrder === 'asc' ? 1 : -1;

      const [users, total] = await Promise.all([
        User.find(filter)
          .sort(sort)
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .select('-passwordHash -mfaSecret -mfaBackupCodes -emailVerificationToken -passwordResetToken')
          .lean(),
        User.countDocuments(filter)
      ]);

      // Get wallet balances for each user
      const userIds = users.map(user => user._id);
      const wallets = await Wallet.find({ userId: { $in: userIds } })
        .select('userId totalBalanceUSD')
        .lean();
      
      const walletMap = new Map(wallets.map(wallet => [wallet.userId.toString(), wallet.totalBalanceUSD]));

      // Get portfolio values for each user
      const portfolios = await Portfolio.find({ userId: { $in: userIds } })
        .select('userId totalValue')
        .lean();
      
      const portfolioMap = new Map(portfolios.map(portfolio => [portfolio.userId.toString(), portfolio.totalValue]));

      logger.info('Admin accessed user management', {
        adminId: req.user.userId,
        filters: { status, kycStatus, role, search },
        resultCount: users.length,
        total
      });

      res.json({
        success: true,
        data: {
          users: users.map(user => ({
            id: user._id,
            email: user.email,
            emailVerified: user.emailVerified,
            mfaEnabled: user.mfaEnabled,
            kycStatus: user.kycStatus,
            accreditedInvestor: user.accreditedInvestor,
            role: user.role,
            status: user.status,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            // Additional computed fields
            walletBalance: walletMap.get(user._id.toString()) || 0,
            portfolioValue: portfolioMap.get(user._id.toString()) || 0,
            totalValue: (walletMap.get(user._id.toString()) || 0) + (portfolioMap.get(user._id.toString()) || 0),
            accountAge: Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)), // days
            isActive: user.status === 'active' && user.emailVerified,
          })),
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < total,
          },
          summary: {
            totalUsers: total,
            activeUsers: await User.countDocuments({ status: 'active' }),
            suspendedUsers: await User.countDocuments({ status: 'suspended' }),
            deactivatedUsers: await User.countDocuments({ status: 'deactivated' }),
            verifiedUsers: await User.countDocuments({ emailVerified: true }),
            kycApprovedUsers: await User.countDocuments({ kycStatus: 'approved' }),
            mfaEnabledUsers: await User.countDocuments({ mfaEnabled: true }),
            accreditedInvestors: await User.countDocuments({ accreditedInvestor: true }),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get users for admin:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load users'
      });
    }
  }
);

/**
 * PUT /api/admin/users/:id/status
 * Update user status (active, suspended, deactivated)
 */
router.put('/users/:id/status',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid user ID'),
    body('status')
      .isIn(['active', 'suspended', 'deactivated'])
      .withMessage('Status must be active, suspended, or deactivated'),
    body('reason')
      .optional()
      .isString()
      .isLength({ min: 1, max: 500 })
      .withMessage('Reason must be between 1-500 characters'),
    body('notes')
      .optional()
      .isString()
      .isLength({ max: 1000 })
      .withMessage('Notes must be less than 1000 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const userId = req.params.id;
      const { status, reason, notes } = req.body;

      // Prevent admin from changing their own status
      if (userId === req.user.userId) {
        res.status(400).json({
          error: 'Cannot modify own status',
          message: 'Administrators cannot change their own account status'
        });
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: 'User not found'
        });
        return;
      }

      // Prevent changing status of other admins (unless admin functionality is needed)
      if (user.role === 'admin' && req.user.role !== 'admin') {
        res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Cannot modify admin user status'
        });
        return;
      }

      const oldStatus = user.status;
      user.status = status;
      await user.save();

      logger.info('User status changed by admin', {
        adminId: req.user.userId,
        targetUserId: userId,
        targetUserEmail: user.email,
        oldStatus,
        newStatus: status,
        reason,
        notes,
      });

      securityLogger.info('User status change', {
        adminId: req.user.userId,
        targetUserId: userId,
        targetUserEmail: user.email,
        oldStatus,
        newStatus: status,
        reason,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        success: true,
        message: `User status changed from ${oldStatus} to ${status}`,
        data: {
          userId,
          email: user.email,
          oldStatus,
          newStatus: status,
          updatedAt: user.updatedAt,
        }
      });

    } catch (error) {
      logger.error('Failed to update user status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update user status'
      });
    }
  }
);

/**
 * PUT /api/admin/users/:id/balance
 * Adjust user wallet balance (admin only - for corrections/adjustments)
 */
router.put('/users/:id/balance',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid user ID'),
    body('network')
      .isIn(['ethereum', 'tron', 'bsc'])
      .withMessage('Network must be ethereum, tron, or bsc'),
    body('token')
      .isIn(['usdt', 'usdc'])
      .withMessage('Token must be usdt or usdc'),
    body('amount')
      .isFloat({ min: 0 })
      .withMessage('Amount must be non-negative'),
    body('operation')
      .isIn(['set', 'add', 'subtract'])
      .withMessage('Operation must be set, add, or subtract'),
    body('reason')
      .notEmpty()
      .isString()
      .isLength({ min: 1, max: 500 })
      .withMessage('Reason is required and must be between 1-500 characters'),
    body('notes')
      .optional()
      .isString()
      .isLength({ max: 1000 })
      .withMessage('Notes must be less than 1000 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const userId = req.params.id;
      const { network, token, amount, operation, reason, notes } = req.body;

      const user = await User.findById(userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: 'User not found'
        });
        return;
      }

      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        res.status(404).json({
          success: false,
          message: 'User wallet not found'
        });
        return;
      }

      const oldBalance = wallet.balances[token as keyof IWalletBalances][network as keyof ITokenBalance];
      let newBalance: number;

      switch (operation) {
        case 'set':
          newBalance = amount;
          break;
        case 'add':
          newBalance = oldBalance + amount;
          break;
        case 'subtract':
          newBalance = Math.max(0, oldBalance - amount);
          break;
        default:
          res.status(400).json({
            error: 'Invalid operation',
            message: 'Operation must be set, add, or subtract'
          });
          return;
      }

      // Update the balance
      wallet.updateBalance(network, token, newBalance);
      await wallet.save();

      logger.info('User balance adjusted by admin', {
        adminId: req.user.userId,
        targetUserId: userId,
        targetUserEmail: user.email,
        network,
        token,
        operation,
        oldBalance,
        newBalance,
        amount,
        reason,
        notes,
      });

      securityLogger.info('Balance adjustment', {
        adminId: req.user.userId,
        targetUserId: userId,
        targetUserEmail: user.email,
        network,
        token,
        operation,
        oldBalance,
        newBalance,
        amount,
        reason,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        success: true,
        message: `User balance ${operation}ed successfully`,
        data: {
          userId,
          email: user.email,
          network,
          token,
          operation,
          oldBalance,
          newBalance,
          adjustment: newBalance - oldBalance,
          updatedAt: wallet.updatedAt,
        }
      });

    } catch (error) {
      logger.error('Failed to adjust user balance:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to adjust user balance'
      });
    }
  }
);

/**
 * GET /api/admin/users/:id
 * Get detailed user information for admin review
 */
router.get('/users/:id',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid user ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const userId = req.params.id;

      const user = await User.findById(userId)
        .select('-passwordHash -mfaSecret -mfaBackupCodes -emailVerificationToken -passwordResetToken');

      if (!user) {
        res.status(404).json({
          success: false,
          message: 'User not found'
        });
        return;
      }

      // Get wallet information
      const wallet = await Wallet.findOne({ userId }).lean();
      
      // Get portfolio information
      const portfolio = await Portfolio.findOne({ userId }).lean();

      // Get KYC information
      const kycSubmission = await KYCSubmission.findOne({ userId })
        .select('status submittedAt reviewedAt reviewedBy firstName lastName')
        .populate('reviewedBy', 'email')
        .lean();

      // Get recent withdrawals
      const recentWithdrawals = await Withdrawal.find({ userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('amount network token status createdAt')
        .lean();

      logger.info('Admin accessed user details', {
        adminId: req.user.userId,
        targetUserId: userId,
        targetUserEmail: user.email,
      });

      res.json({
        success: true,
        data: {
          user: {
            id: user._id,
            email: user.email,
            emailVerified: user.emailVerified,
            mfaEnabled: user.mfaEnabled,
            kycStatus: user.kycStatus,
            accreditedInvestor: user.accreditedInvestor,
            role: user.role,
            status: user.status,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            accountAge: Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
          },
          wallet: wallet ? {
            addresses: wallet.addresses,
            balances: wallet.balances,
            totalBalanceUSD: wallet.totalBalanceUSD,
            lastSyncAt: wallet.lastSyncAt,
          } : null,
          portfolio: portfolio ? {
            holdings: portfolio.holdings,
            totalValue: portfolio.totalValue,
            totalInvested: portfolio.totalInvested,
            totalPnL: portfolio.totalPnL,
            updatedAt: portfolio.updatedAt,
          } : null,
          kyc: kycSubmission ? {
            status: kycSubmission.status,
            submittedAt: kycSubmission.submittedAt,
            reviewedAt: kycSubmission.reviewedAt,
            reviewedBy: kycSubmission.reviewedBy,
            firstName: kycSubmission.firstName,
            lastName: kycSubmission.lastName,
          } : null,
          recentWithdrawals: recentWithdrawals.map(withdrawal => ({
            id: withdrawal._id,
            amount: withdrawal.amount,
            network: withdrawal.network,
            token: withdrawal.token,
            status: withdrawal.status,
            createdAt: withdrawal.createdAt,
          })),
          summary: {
            totalValue: (wallet?.totalBalanceUSD || 0) + (portfolio?.totalValue || 0),
            isFullyVerified: user.emailVerified && user.kycStatus === 'approved',
            riskLevel: calculateUserRiskLevel(user, wallet, recentWithdrawals),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get user details for admin:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load user details'
      });
    }
  }
);

// Helper function to calculate user risk level
function calculateUserRiskLevel(user: any, wallet: any, recentWithdrawals: any[]): 'low' | 'medium' | 'high' {
  let riskScore = 0;
  
  // Account verification factors
  if (!user.emailVerified) riskScore += 20;
  if (user.kycStatus !== 'approved') riskScore += 30;
  if (!user.mfaEnabled) riskScore += 15;
  
  // Account age factor
  const accountAgeDays = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24));
  if (accountAgeDays < 7) riskScore += 25;
  else if (accountAgeDays < 30) riskScore += 10;
  
  // Balance and activity factors
  const totalBalance = wallet?.totalBalanceUSD || 0;
  if (totalBalance > 10000) riskScore += 10;
  
  // Recent withdrawal activity
  const recentWithdrawalCount = recentWithdrawals.length;
  if (recentWithdrawalCount > 3) riskScore += 15;
  
  // Status factors
  if (user.status === 'suspended') riskScore += 50;
  
  if (riskScore >= 60) return 'high';
  if (riskScore >= 30) return 'medium';
  return 'low';
}

/**
 * GET /api/admin/transactions
 * Get all transactions with comprehensive filtering for monitoring
 */
router.get('/transactions',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
    query('type')
      .optional()
      .isIn(['deposit', 'withdrawal', 'trade', 'all'])
      .withMessage('Type must be deposit, withdrawal, trade, or all'),
    query('status')
      .optional()
      .isIn(['pending', 'confirmed', 'failed', 'settled'])
      .withMessage('Invalid status'),
    query('network')
      .optional()
      .isIn(['ethereum', 'tron', 'bsc'])
      .withMessage('Invalid network'),
    query('token')
      .optional()
      .isIn(['usdt', 'usdc'])
      .withMessage('Invalid token'),
    query('minAmount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Minimum amount must be non-negative'),
    query('maxAmount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Maximum amount must be non-negative'),
    query('userId')
      .optional()
      .isMongoId()
      .withMessage('Invalid user ID'),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be valid ISO8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be valid ISO8601 date'),
    query('sortBy')
      .optional()
      .isIn(['createdAt', 'amount', 'status', 'executedAt'])
      .withMessage('Invalid sort field'),
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const {
        limit = 50,
        offset = 0,
        type = 'all',
        status,
        network,
        token,
        minAmount,
        maxAmount,
        userId,
        startDate,
        endDate,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      // Build date filter
      const dateFilter: any = {};
      if (startDate) dateFilter.$gte = new Date(startDate as string);
      if (endDate) dateFilter.$lte = new Date(endDate as string);

      // Build amount filter
      const amountFilter: any = {};
      if (minAmount) amountFilter.$gte = parseFloat(minAmount as string);
      if (maxAmount) amountFilter.$lte = parseFloat(maxAmount as string);

      let allTransactions: any[] = [];
      let totalCount = 0;

      // Get blockchain transactions (deposits/withdrawals)
      if (type === 'all' || type === 'deposit' || type === 'withdrawal') {
        const blockchainFilter: any = {};
        if (type !== 'all') blockchainFilter.type = type;
        if (status && ['pending', 'confirmed', 'failed'].includes(status as string)) {
          blockchainFilter.status = status;
        }
        if (network) blockchainFilter.network = network;
        if (token) blockchainFilter.token = token;
        if (Object.keys(amountFilter).length > 0) blockchainFilter.amount = amountFilter;
        if (userId) blockchainFilter.userId = userId;
        if (Object.keys(dateFilter).length > 0) blockchainFilter.createdAt = dateFilter;

        const [blockchainTxs, blockchainCount] = await Promise.all([
          Transaction.find(blockchainFilter)
            .populate('userId', 'email')
            .sort({ [sortBy as string]: sortOrder === 'asc' ? 1 : -1 })
            .limit(parseInt(limit as string))
            .skip(parseInt(offset as string))
            .lean(),
          Transaction.countDocuments(blockchainFilter)
        ]);

        allTransactions = allTransactions.concat(
          blockchainTxs.map(tx => ({
            id: tx._id,
            type: tx.type,
            userId: tx.userId,
            user: (tx as any).userId,
            amount: tx.amount,
            token: tx.token,
            network: tx.network,
            status: tx.status,
            txHash: tx.txHash,
            fromAddress: tx.fromAddress,
            toAddress: tx.toAddress,
            confirmations: tx.confirmations,
            createdAt: tx.createdAt,
            confirmedAt: tx.confirmedAt,
            processedAt: tx.processedAt,
            failedAt: tx.failedAt,
            errorMessage: tx.errorMessage,
            category: 'blockchain',
          }))
        );
        totalCount += blockchainCount;
      }

      // Get trading transactions
      if (type === 'all' || type === 'trade') {
        const tradeFilter: any = {};
        if (status && ['pending', 'settled', 'failed'].includes(status as string)) {
          tradeFilter.status = status;
        }
        if (Object.keys(amountFilter).length > 0) tradeFilter.totalAmount = amountFilter;
        if (userId) {
          tradeFilter.$or = [{ buyerId: userId }, { sellerId: userId }];
        }
        if (Object.keys(dateFilter).length > 0) tradeFilter.executedAt = dateFilter;

        const [trades, tradeCount] = await Promise.all([
          Trade.find(tradeFilter)
            .populate('buyerId', 'email')
            .populate('sellerId', 'email')
            .populate('productId', 'name symbol')
            .sort({ [sortBy === 'createdAt' ? 'executedAt' : sortBy as string]: sortOrder === 'asc' ? 1 : -1 })
            .limit(parseInt(limit as string))
            .skip(parseInt(offset as string))
            .lean(),
          Trade.countDocuments(tradeFilter)
        ]);

        allTransactions = allTransactions.concat(
          trades.map(trade => ({
            id: trade._id,
            type: 'trade',
            buyerId: trade.buyerId,
            sellerId: trade.sellerId,
            buyer: (trade as any).buyerId,
            seller: (trade as any).sellerId,
            product: (trade as any).productId,
            amount: trade.totalAmount,
            quantity: trade.quantity,
            pricePerShare: trade.pricePerShare,
            buyerFees: trade.buyerFees,
            sellerFees: trade.sellerFees,
            status: trade.status,
            executedAt: trade.executedAt,
            settledAt: trade.settledAt,
            failedAt: trade.failedAt,
            failureReason: trade.failureReason,
            custodialStatus: trade.custodialStatus,
            createdAt: trade.executedAt,
            category: 'trading',
          }))
        );
        totalCount += tradeCount;
      }

      // Sort combined results if needed
      if (type === 'all') {
        allTransactions.sort((a, b) => {
          const aValue = a[sortBy as string] || a.createdAt;
          const bValue = b[sortBy as string] || b.createdAt;
          return sortOrder === 'asc' 
            ? new Date(aValue).getTime() - new Date(bValue).getTime()
            : new Date(bValue).getTime() - new Date(aValue).getTime();
        });
      }

      // Log audit entry
      await createAuditLog({
        adminId: req.user.userId,
        action: 'view_transactions',
        resource: 'transactions',
        details: {
          filters: { type, status, network, token, userId, startDate, endDate },
          resultCount: allTransactions.length,
          totalCount
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
      });

      logger.info('Admin accessed transaction monitoring', {
        adminId: req.user.userId,
        filters: { type, status, network, token, userId },
        resultCount: allTransactions.length,
        totalCount
      });

      res.json({
        success: true,
        data: {
          transactions: allTransactions,
          pagination: {
            total: totalCount,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < totalCount,
          },
          summary: {
            totalTransactions: totalCount,
            pendingTransactions: await Transaction.countDocuments({ status: 'pending' }) + 
                               await Trade.countDocuments({ status: 'pending' }),
            confirmedTransactions: await Transaction.countDocuments({ status: 'confirmed' }),
            settledTrades: await Trade.countDocuments({ status: 'settled' }),
            failedTransactions: await Transaction.countDocuments({ status: 'failed' }) + 
                              await Trade.countDocuments({ status: 'failed' }),
            totalVolume24h: await calculateDailyVolume(),
            totalFees24h: await calculateDailyFees(),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get transactions for admin:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load transactions'
      });
    }
  }
);

/**
 * GET /api/admin/audit-logs
 * Get audit logs for compliance and monitoring
 */
router.get('/audit-logs',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
    query('category')
      .optional()
      .isIn(['auth', 'user_management', 'trading', 'wallet', 'kyc', 'admin', 'system', 'security'])
      .withMessage('Invalid category'),
    query('severity')
      .optional()
      .isIn(['low', 'medium', 'high', 'critical'])
      .withMessage('Invalid severity'),
    query('success')
      .optional()
      .isBoolean()
      .withMessage('Success must be boolean'),
    query('userId')
      .optional()
      .isMongoId()
      .withMessage('Invalid user ID'),
    query('adminId')
      .optional()
      .isMongoId()
      .withMessage('Invalid admin ID'),
    query('action')
      .optional()
      .isString()
      .trim()
      .withMessage('Action must be a string'),
    query('resource')
      .optional()
      .isString()
      .trim()
      .withMessage('Resource must be a string'),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be valid ISO8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be valid ISO8601 date'),
    query('ipAddress')
      .optional()
      .isIP()
      .withMessage('Invalid IP address'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const {
        limit = 50,
        offset = 0,
        category,
        severity,
        success,
        userId,
        adminId,
        action,
        resource,
        startDate,
        endDate,
        ipAddress
      } = req.query;

      // Build filter
      const filter: any = {};
      if (category) filter.category = category;
      if (severity) filter.severity = severity;
      if (success !== undefined) filter.success = success === 'true';
      if (userId) filter.userId = userId;
      if (adminId) filter.adminId = adminId;
      if (action) filter.action = { $regex: action, $options: 'i' };
      if (resource) filter.resource = { $regex: resource, $options: 'i' };
      if (ipAddress) filter.ipAddress = ipAddress;

      // Date filter
      if (startDate || endDate) {
        filter.timestamp = {};
        if (startDate) filter.timestamp.$gte = new Date(startDate as string);
        if (endDate) filter.timestamp.$lte = new Date(endDate as string);
      }

      const [auditLogs, total] = await Promise.all([
        AuditLog.find(filter)
          .populate('userId', 'email')
          .populate('adminId', 'email')
          .sort({ timestamp: -1 })
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean(),
        AuditLog.countDocuments(filter)
      ]);

      // Log this audit access
      await createAuditLog({
        adminId: req.user.userId,
        action: 'view_audit_logs',
        resource: 'audit_logs',
        details: {
          filters: { category, severity, success, userId, adminId, action, resource },
          resultCount: auditLogs.length,
          total
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
      });

      logger.info('Admin accessed audit logs', {
        adminId: req.user.userId,
        filters: { category, severity, success },
        resultCount: auditLogs.length,
        total
      });

      res.json({
        success: true,
        data: {
          auditLogs: auditLogs.map(log => ({
            id: log._id,
            userId: log.userId,
            adminId: log.adminId,
            user: (log as any).userId,
            admin: (log as any).adminId,
            action: log.action,
            resource: log.resource,
            resourceId: log.resourceId,
            details: log.details,
            ipAddress: log.ipAddress,
            userAgent: log.userAgent,
            timestamp: log.timestamp,
            severity: log.severity,
            category: log.category,
            success: log.success,
            errorMessage: log.errorMessage,
            metadata: log.metadata,
          })),
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < total,
          },
          summary: {
            totalLogs: total,
            criticalLogs: await AuditLog.countDocuments({ severity: 'critical' }),
            highSeverityLogs: await AuditLog.countDocuments({ severity: 'high' }),
            failedActions: await AuditLog.countDocuments({ success: false }),
            securityLogs: await AuditLog.countDocuments({ category: 'security' }),
            last24hLogs: await AuditLog.countDocuments({
              timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get audit logs for admin:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load audit logs'
      });
    }
  }
);

/**
 * GET /api/admin/reports/compliance
 * Generate compliance reports with daily/weekly summaries
 */
router.get('/reports/compliance',
  authenticate,
  authorize('admin'),
  [
    query('period')
      .isIn(['daily', 'weekly', 'monthly'])
      .withMessage('Period must be daily, weekly, or monthly'),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be valid ISO8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be valid ISO8601 date'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const { period, startDate, endDate } = req.query;

      // Calculate date range based on period
      let start: Date, end: Date;
      const now = new Date();

      if (startDate && endDate) {
        start = new Date(startDate as string);
        end = new Date(endDate as string);
      } else {
        switch (period) {
          case 'daily':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
            break;
          case 'weekly':
            const dayOfWeek = now.getDay();
            start = new Date(now.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
            start.setHours(0, 0, 0, 0);
            end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
            break;
          case 'monthly':
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            break;
          default:
            start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            end = now;
        }
      }

      const dateFilter = { $gte: start, $lte: end };

      // Generate comprehensive compliance report
      const [
        userStats,
        kycStats,
        transactionStats,
        tradeStats,
        withdrawalStats,
        auditStats,
        securityEvents
      ] = await Promise.all([
        // User statistics
        Promise.all([
          User.countDocuments({ createdAt: dateFilter }),
          User.countDocuments({ createdAt: dateFilter, emailVerified: true }),
          User.countDocuments({ createdAt: dateFilter, kycStatus: 'approved' }),
          User.countDocuments({ createdAt: dateFilter, mfaEnabled: true }),
        ]),
        // KYC statistics
        Promise.all([
          KYCSubmission.countDocuments({ submittedAt: dateFilter }),
          KYCSubmission.countDocuments({ reviewedAt: dateFilter, status: 'approved' }),
          KYCSubmission.countDocuments({ reviewedAt: dateFilter, status: 'rejected' }),
        ]),
        // Transaction statistics
        Promise.all([
          Transaction.countDocuments({ createdAt: dateFilter }),
          Transaction.countDocuments({ createdAt: dateFilter, status: 'confirmed' }),
          Transaction.countDocuments({ createdAt: dateFilter, status: 'failed' }),
          Transaction.aggregate([
            { $match: { createdAt: dateFilter, status: 'confirmed' } },
            { $group: { _id: null, totalVolume: { $sum: '$amount' } } }
          ]),
        ]),
        // Trade statistics
        Promise.all([
          Trade.countDocuments({ executedAt: dateFilter }),
          Trade.countDocuments({ settledAt: dateFilter }),
          Trade.countDocuments({ failedAt: dateFilter }),
          Trade.aggregate([
            { $match: { executedAt: dateFilter } },
            { $group: { _id: null, totalVolume: { $sum: '$totalAmount' }, totalFees: { $sum: { $add: ['$buyerFees', '$sellerFees'] } } } }
          ]),
        ]),
        // Withdrawal statistics
        Promise.all([
          Withdrawal.countDocuments({ createdAt: dateFilter }),
          Withdrawal.countDocuments({ approvedAt: dateFilter }),
          Withdrawal.countDocuments({ rejectedAt: dateFilter }),
          Withdrawal.aggregate([
            { $match: { createdAt: dateFilter } },
            { $group: { _id: null, totalAmount: { $sum: '$amount' } } }
          ]),
        ]),
        // Audit log statistics
        Promise.all([
          AuditLog.countDocuments({ timestamp: dateFilter }),
          AuditLog.countDocuments({ timestamp: dateFilter, success: false }),
          AuditLog.countDocuments({ timestamp: dateFilter, severity: 'critical' }),
          AuditLog.countDocuments({ timestamp: dateFilter, severity: 'high' }),
        ]),
        // Security events
        AuditLog.find({
          timestamp: dateFilter,
          category: 'security',
          severity: { $in: ['high', 'critical'] }
        }).limit(10).sort({ timestamp: -1 }).lean()
      ]);

      // Log report generation
      await createAuditLog({
        adminId: req.user.userId,
        action: 'generate_compliance_report',
        resource: 'compliance_report',
        details: {
          period,
          startDate: start,
          endDate: end,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
      });

      logger.info('Admin generated compliance report', {
        adminId: req.user.userId,
        period,
        startDate: start,
        endDate: end,
      });

      res.json({
        success: true,
        data: {
          reportPeriod: {
            period,
            startDate: start,
            endDate: end,
            generatedAt: new Date(),
            generatedBy: req.user.userId,
          },
          userActivity: {
            newRegistrations: userStats[0],
            emailVerifications: userStats[1],
            kycApprovals: userStats[2],
            mfaSetups: userStats[3],
          },
          kycActivity: {
            submissionsReceived: kycStats[0],
            approved: kycStats[1],
            rejected: kycStats[2],
            approvalRate: kycStats[0] > 0 ? ((kycStats[1] / kycStats[0]) * 100).toFixed(2) : '0.00',
          },
          transactionActivity: {
            totalTransactions: transactionStats[0],
            confirmedTransactions: transactionStats[1],
            failedTransactions: transactionStats[2],
            totalVolume: transactionStats[3][0]?.totalVolume || 0,
            successRate: transactionStats[0] > 0 ? ((transactionStats[1] / transactionStats[0]) * 100).toFixed(2) : '0.00',
          },
          tradingActivity: {
            totalTrades: tradeStats[0],
            settledTrades: tradeStats[1],
            failedTrades: tradeStats[2],
            totalVolume: tradeStats[3][0]?.totalVolume || 0,
            totalFees: tradeStats[3][0]?.totalFees || 0,
            settlementRate: tradeStats[0] > 0 ? ((tradeStats[1] / tradeStats[0]) * 100).toFixed(2) : '0.00',
          },
          withdrawalActivity: {
            totalRequests: withdrawalStats[0],
            approved: withdrawalStats[1],
            rejected: withdrawalStats[2],
            totalAmount: withdrawalStats[3][0]?.totalAmount || 0,
            approvalRate: withdrawalStats[0] > 0 ? ((withdrawalStats[1] / withdrawalStats[0]) * 100).toFixed(2) : '0.00',
          },
          auditActivity: {
            totalLogs: auditStats[0],
            failedActions: auditStats[1],
            criticalEvents: auditStats[2],
            highSeverityEvents: auditStats[3],
            errorRate: auditStats[0] > 0 ? ((auditStats[1] / auditStats[0]) * 100).toFixed(2) : '0.00',
          },
          securityEvents: securityEvents.map(event => ({
            id: event._id,
            action: event.action,
            resource: event.resource,
            severity: event.severity,
            timestamp: event.timestamp,
            ipAddress: event.ipAddress,
            details: event.details,
          })),
          complianceMetrics: {
            kycComplianceRate: kycStats[0] > 0 ? ((kycStats[1] / kycStats[0]) * 100).toFixed(2) : '0.00',
            transactionSuccessRate: transactionStats[0] > 0 ? ((transactionStats[1] / transactionStats[0]) * 100).toFixed(2) : '0.00',
            systemReliability: auditStats[0] > 0 ? (((auditStats[0] - auditStats[1]) / auditStats[0]) * 100).toFixed(2) : '100.00',
            securityIncidents: auditStats[2] + auditStats[3],
          }
        }
      });

    } catch (error) {
      logger.error('Failed to generate compliance report:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to generate compliance report'
      });
    }
  }
);

// Helper functions for transaction monitoring
async function calculateDailyVolume(): Promise<number> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const [transactionVolume, tradeVolume] = await Promise.all([
    Transaction.aggregate([
      { 
        $match: { 
          createdAt: { $gte: yesterday },
          status: 'confirmed'
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Trade.aggregate([
      { 
        $match: { 
          executedAt: { $gte: yesterday },
          status: { $in: ['settled', 'pending'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ])
  ]);

  return (transactionVolume[0]?.total || 0) + (tradeVolume[0]?.total || 0);
}

async function calculateDailyFees(): Promise<number> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const tradeFeesResult = await Trade.aggregate([
    { 
      $match: { 
        executedAt: { $gte: yesterday },
        status: { $in: ['settled', 'pending'] }
      }
    },
    { 
      $group: { 
        _id: null, 
        total: { $sum: { $add: ['$buyerFees', '$sellerFees'] } }
      }
    }
  ]);

  return tradeFeesResult[0]?.total || 0;
}

/**
 * GET /api/admin/config
 * Get current platform configuration
 */
router.get('/config',
  authenticate,
  authorize('admin'),
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const activeConfig = await getActiveConfig();
      
      if (!activeConfig) {
        // Create default config if none exists
        const defaultConfig = await createDefaultConfig(req.user.userId);
        
        logger.info('Created default platform configuration', {
          adminId: req.user.userId,
          configId: defaultConfig._id,
        });

        res.json({
          success: true,
          data: {
            config: defaultConfig,
            isDefault: true,
          }
        });
        return;
      }

      await createAuditLog({
        adminId: req.user.userId,
        action: 'view_platform_config',
        resource: 'platform_config',
        resourceId: String(activeConfig._id),
        details: {
          configVersion: activeConfig.configVersion,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
      });

      logger.info('Admin accessed platform configuration', {
        adminId: req.user.userId,
        configId: activeConfig._id,
        configVersion: activeConfig.configVersion,
      });

      res.json({
        success: true,
        data: {
          config: activeConfig,
          isDefault: false,
        }
      });

    } catch (error) {
      logger.error('Failed to get platform configuration:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load platform configuration'
      });
    }
  }
);

/**
 * PUT /api/admin/config/fees
 * Update fee configuration
 */
router.put('/config/fees',
  authenticate,
  authorize('admin'),
  [
    body('transactionFee.percentage')
      .optional()
      .isFloat({ min: 0, max: 10 })
      .withMessage('Transaction fee percentage must be between 0-10%'),
    body('transactionFee.flatFee')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Transaction flat fee must be non-negative'),
    body('depositFee.percentage')
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage('Deposit fee percentage must be between 0-5%'),
    body('withdrawalFee.percentage')
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage('Withdrawal fee percentage must be between 0-5%'),
    body('withdrawalFee.flatFee')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Withdrawal flat fee must be non-negative'),
    body('tradingFee.buyerFeePercentage')
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage('Buyer fee percentage must be between 0-5%'),
    body('tradingFee.sellerFeePercentage')
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage('Seller fee percentage must be between 0-5%'),
    body('listingFee.flatFee')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Listing flat fee must be non-negative'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const activeConfig = await getActiveConfig();
      if (!activeConfig) {
        res.status(404).json({
          success: false,
          message: 'No active configuration found'
        });
        return;
      }

      // Create backup before updating
      const backup = activeConfig.createBackup();
      await backup.save();

      // Update fee configuration
      const feeUpdates = req.body;
      Object.keys(feeUpdates).forEach(feeType => {
        if (activeConfig.fees[feeType as keyof typeof activeConfig.fees]) {
          Object.assign(activeConfig.fees[feeType as keyof typeof activeConfig.fees], feeUpdates[feeType]);
        }
      });

      activeConfig.lastUpdatedBy = new mongoose.Types.ObjectId(req.user.userId);
      activeConfig.configVersion = `v${Date.now()}`;

      // Validate and save
      if (!activeConfig.validateConfig()) {
        res.status(400).json({
          success: false,
          message: 'Invalid fee configuration'
        });
        return;
      }

      await activeConfig.save();

      await createAuditLog({
        adminId: req.user.userId,
        action: 'update_fee_config',
        resource: 'platform_config',
        resourceId: String(activeConfig._id),
        details: {
          configVersion: activeConfig.configVersion,
          updates: feeUpdates,
          backupId: backup._id,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity: 'medium',
      });

      logger.info('Admin updated fee configuration', {
        adminId: req.user.userId,
        configId: activeConfig._id,
        configVersion: activeConfig.configVersion,
        updates: Object.keys(feeUpdates),
      });

      res.json({
        success: true,
        message: 'Fee configuration updated successfully',
        data: {
          config: activeConfig,
          backupId: backup._id,
        }
      });

    } catch (error) {
      logger.error('Failed to update fee configuration:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update fee configuration'
      });
    }
  }
);

/**
 * PUT /api/admin/config/trading-rules
 * Update trading rules configuration
 */
router.put('/config/trading-rules',
  authenticate,
  authorize('admin'),
  [
    body('minimumOrderSize')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Minimum order size must be at least 1'),
    body('maximumOrderSize')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Maximum order size must be at least 1'),
    body('minimumTradeAmount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Minimum trade amount must be at least 0.01'),
    body('maximumTradeAmount')
      .optional()
      .isFloat({ min: 1 })
      .withMessage('Maximum trade amount must be at least 1'),
    body('dailyTradingLimit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Daily trading limit must be non-negative'),
    body('monthlyTradingLimit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Monthly trading limit must be non-negative'),
    body('priceDeviationLimit')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Price deviation limit must be between 0-100%'),
    body('orderExpirationHours')
      .optional()
      .isInt({ min: 1, max: 8760 })
      .withMessage('Order expiration must be between 1-8760 hours'),
    body('maxOpenOrdersPerUser')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Max open orders per user must be at least 1'),
    body('tradingHours.enabled')
      .optional()
      .isBoolean()
      .withMessage('Trading hours enabled must be boolean'),
    body('tradingHours.startTime')
      .optional()
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Start time must be in HH:MM format'),
    body('tradingHours.endTime')
      .optional()
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('End time must be in HH:MM format'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const activeConfig = await getActiveConfig();
      if (!activeConfig) {
        res.status(404).json({
          success: false,
          message: 'No active configuration found'
        });
        return;
      }

      // Create backup before updating
      const backup = activeConfig.createBackup();
      await backup.save();

      // Update trading rules
      const ruleUpdates = req.body;
      Object.assign(activeConfig.tradingRules, ruleUpdates);

      activeConfig.lastUpdatedBy = new mongoose.Types.ObjectId(req.user.userId);
      activeConfig.configVersion = `v${Date.now()}`;

      // Validate and save
      if (!activeConfig.validateConfig()) {
        res.status(400).json({
          success: false,
          message: 'Invalid trading rules configuration'
        });
        return;
      }

      await activeConfig.save();

      await createAuditLog({
        adminId: req.user.userId,
        action: 'update_trading_rules',
        resource: 'platform_config',
        resourceId: String(activeConfig._id),
        details: {
          configVersion: activeConfig.configVersion,
          updates: ruleUpdates,
          backupId: backup._id,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity: 'medium',
      });

      logger.info('Admin updated trading rules', {
        adminId: req.user.userId,
        configId: activeConfig._id,
        configVersion: activeConfig.configVersion,
        updates: Object.keys(ruleUpdates),
      });

      res.json({
        success: true,
        message: 'Trading rules updated successfully',
        data: {
          config: activeConfig,
          backupId: backup._id,
        }
      });

    } catch (error) {
      logger.error('Failed to update trading rules:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update trading rules'
      });
    }
  }
);

/**
 * PUT /api/admin/config/system-settings
 * Update system settings including maintenance mode
 */
router.put('/config/system-settings',
  authenticate,
  authorize('admin'),
  [
    body('maintenanceMode.enabled')
      .optional()
      .isBoolean()
      .withMessage('Maintenance mode enabled must be boolean'),
    body('maintenanceMode.message')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Maintenance message must be less than 500 characters'),
    body('maintenanceMode.scheduledStart')
      .optional()
      .isISO8601()
      .withMessage('Scheduled start must be valid ISO8601 date'),
    body('maintenanceMode.scheduledEnd')
      .optional()
      .isISO8601()
      .withMessage('Scheduled end must be valid ISO8601 date'),
    body('registrationEnabled')
      .optional()
      .isBoolean()
      .withMessage('Registration enabled must be boolean'),
    body('kycRequired')
      .optional()
      .isBoolean()
      .withMessage('KYC required must be boolean'),
    body('mfaRequired')
      .optional()
      .isBoolean()
      .withMessage('MFA required must be boolean'),
    body('emailVerificationRequired')
      .optional()
      .isBoolean()
      .withMessage('Email verification required must be boolean'),
    body('maxLoginAttempts')
      .optional()
      .isInt({ min: 1, max: 10 })
      .withMessage('Max login attempts must be between 1-10'),
    body('sessionTimeoutMinutes')
      .optional()
      .isInt({ min: 5, max: 1440 })
      .withMessage('Session timeout must be between 5-1440 minutes'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const activeConfig = await getActiveConfig();
      if (!activeConfig) {
        res.status(404).json({
          success: false,
          message: 'No active configuration found'
        });
        return;
      }

      // Create backup before updating
      const backup = activeConfig.createBackup();
      await backup.save();

      // Update system settings
      const settingsUpdates = req.body;
      
      // Handle nested updates for maintenance mode
      if (settingsUpdates.maintenanceMode) {
        Object.assign(activeConfig.systemSettings.maintenanceMode, settingsUpdates.maintenanceMode);
        delete settingsUpdates.maintenanceMode;
      }
      
      // Handle nested updates for password policy
      if (settingsUpdates.passwordPolicy) {
        Object.assign(activeConfig.systemSettings.passwordPolicy, settingsUpdates.passwordPolicy);
        delete settingsUpdates.passwordPolicy;
      }
      
      // Handle nested updates for rate limiting
      if (settingsUpdates.rateLimiting) {
        Object.assign(activeConfig.systemSettings.rateLimiting, settingsUpdates.rateLimiting);
        delete settingsUpdates.rateLimiting;
      }

      // Apply remaining updates
      Object.assign(activeConfig.systemSettings, settingsUpdates);

      activeConfig.lastUpdatedBy = new mongoose.Types.ObjectId(req.user.userId);
      activeConfig.configVersion = `v${Date.now()}`;

      // Validate and save
      if (!activeConfig.validateConfig()) {
        res.status(400).json({
          success: false,
          message: 'Invalid system settings configuration'
        });
        return;
      }

      await activeConfig.save();

      const severity = activeConfig.systemSettings.maintenanceMode.enabled ? 'high' : 'medium';

      await createAuditLog({
        adminId: req.user.userId,
        action: 'update_system_settings',
        resource: 'platform_config',
        resourceId: String(activeConfig._id),
        details: {
          configVersion: activeConfig.configVersion,
          updates: req.body,
          backupId: backup._id,
          maintenanceModeEnabled: activeConfig.systemSettings.maintenanceMode.enabled,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity,
      });

      logger.info('Admin updated system settings', {
        adminId: req.user.userId,
        configId: activeConfig._id,
        configVersion: activeConfig.configVersion,
        updates: Object.keys(req.body),
        maintenanceMode: activeConfig.systemSettings.maintenanceMode.enabled,
      });

      res.json({
        success: true,
        message: 'System settings updated successfully',
        data: {
          config: activeConfig,
          backupId: backup._id,
          maintenanceModeActive: activeConfig.systemSettings.maintenanceMode.enabled,
        }
      });

    } catch (error) {
      logger.error('Failed to update system settings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update system settings'
      });
    }
  }
);

/**
 * PUT /api/admin/config/withdrawal-limits
 * Update withdrawal limits configuration
 */
router.put('/config/withdrawal-limits',
  authenticate,
  authorize('admin'),
  [
    body('dailyLimit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Daily limit must be non-negative'),
    body('weeklyLimit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Weekly limit must be non-negative'),
    body('monthlyLimit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Monthly limit must be non-negative'),
    body('minimumAmount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Minimum amount must be at least 0.01'),
    body('maximumAmount')
      .optional()
      .isFloat({ min: 1 })
      .withMessage('Maximum amount must be at least 1'),
    body('requiresApprovalAbove')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Requires approval above must be non-negative'),
    body('autoApprovalLimit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Auto approval limit must be non-negative'),
    body('cooldownPeriodHours')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Cooldown period must be non-negative'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const activeConfig = await getActiveConfig();
      if (!activeConfig) {
        res.status(404).json({
          success: false,
          message: 'No active configuration found'
        });
        return;
      }

      // Create backup before updating
      const backup = activeConfig.createBackup();
      await backup.save();

      // Update withdrawal limits
      const limitUpdates = req.body;
      Object.assign(activeConfig.withdrawalLimits, limitUpdates);

      activeConfig.lastUpdatedBy = new mongoose.Types.ObjectId(req.user.userId);
      activeConfig.configVersion = `v${Date.now()}`;

      // Validate and save
      if (!activeConfig.validateConfig()) {
        res.status(400).json({
          success: false,
          message: 'Invalid withdrawal limits configuration'
        });
        return;
      }

      await activeConfig.save();

      await createAuditLog({
        adminId: req.user.userId,
        action: 'update_withdrawal_limits',
        resource: 'platform_config',
        resourceId: String(activeConfig._id),
        details: {
          configVersion: activeConfig.configVersion,
          updates: limitUpdates,
          backupId: backup._id,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity: 'medium',
      });

      logger.info('Admin updated withdrawal limits', {
        adminId: req.user.userId,
        configId: activeConfig._id,
        configVersion: activeConfig.configVersion,
        updates: Object.keys(limitUpdates),
      });

      res.json({
        success: true,
        message: 'Withdrawal limits updated successfully',
        data: {
          config: activeConfig,
          backupId: backup._id,
        }
      });

    } catch (error) {
      logger.error('Failed to update withdrawal limits:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update withdrawal limits'
      });
    }
  }
);

/**
 * GET /api/admin/config/history
 * Get configuration change history
 */
router.get('/config/history',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be non-negative'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      const [configs, total] = await Promise.all([
        PlatformConfig.find({})
          .populate('lastUpdatedBy', 'email')
          .sort({ lastUpdatedAt: -1 })
          .limit(limit)
          .skip(offset)
          .select('configVersion isActive lastUpdatedBy lastUpdatedAt createdAt')
          .lean(),
        PlatformConfig.countDocuments({})
      ]);

      await createAuditLog({
        adminId: req.user.userId,
        action: 'view_config_history',
        resource: 'platform_config',
        details: {
          resultCount: configs.length,
          total
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
      });

      logger.info('Admin accessed configuration history', {
        adminId: req.user.userId,
        resultCount: configs.length,
        total
      });

      res.json({
        success: true,
        data: {
          configs: configs.map(config => ({
            id: config._id,
            configVersion: config.configVersion,
            isActive: config.isActive,
            lastUpdatedBy: (config as any).lastUpdatedBy,
            lastUpdatedAt: config.lastUpdatedAt,
            createdAt: config.createdAt,
          })),
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get configuration history:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load configuration history'
      });
    }
  }
);

/**
 * POST /api/admin/config/:id/restore
 * Restore a previous configuration
 */
router.post('/config/:id/restore',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid configuration ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const configId = req.params.id;
      const configToRestore = await PlatformConfig.findById(configId);

      if (!configToRestore) {
        res.status(404).json({
          success: false,
          message: 'Configuration not found'
        });
        return;
      }

      // Create backup of current active config
      const currentConfig = await getActiveConfig();
      if (currentConfig) {
        const backup = currentConfig.createBackup();
        await backup.save();
      }

      // Apply the restored configuration
      await configToRestore.applyConfig();

      await createAuditLog({
        adminId: req.user.userId,
        action: 'restore_config',
        resource: 'platform_config',
        resourceId: configId,
        details: {
          restoredConfigVersion: configToRestore.configVersion,
          previousConfigId: currentConfig?._id,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity: 'high',
      });

      logger.info('Admin restored configuration', {
        adminId: req.user.userId,
        restoredConfigId: configId,
        restoredConfigVersion: configToRestore.configVersion,
      });

      res.json({
        success: true,
        message: 'Configuration restored successfully',
        data: {
          restoredConfig: configToRestore,
        }
      });

    } catch (error) {
      logger.error('Failed to restore configuration:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to restore configuration'
      });
    }
  }
);

/**
 * GET /api/admin/kyc/statistics
 * Get KYC statistics for admin dashboard
 */
router.get('/kyc/statistics',
  authenticate,
  authorize('admin'),
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const statistics = await kycService.getKYCStatistics();

      logger.info('Admin accessed KYC statistics', {
        adminId: req.user.userId,
      });

      res.json({
        statistics,
        generatedAt: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Failed to get KYC statistics:', error);
      res.status(500).json({
        error: 'Failed to get statistics',
        message: 'An error occurred while retrieving KYC statistics',
      });
    }
  }
);

/**
 * GET /api/admin/kyc/pending
 * Get pending KYC submissions for admin review
 */
router.get('/kyc/pending',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await kycService.getPendingSubmissions(limit, offset);

      logger.info('Admin accessed pending KYC submissions', {
        adminId: req.user.userId,
        count: result.submissions.length,
        total: result.total,
      });

      res.json({
        submissions: result.submissions.map(submission => ({
          id: submission._id,
          userId: submission.userId,
          user: (submission as any).userId, // Populated user data
          status: submission.status,
          submittedAt: submission.submittedAt,
          firstName: submission.firstName,
          lastName: submission.lastName,
          dateOfBirth: submission.dateOfBirth,
          nationality: submission.nationality,
          phoneNumber: submission.phoneNumber,
          address: submission.address,
          accreditedInvestor: {
            claimed: submission.accreditedInvestor.claimed,
            type: submission.accreditedInvestor.type,
            annualIncome: submission.accreditedInvestor.annualIncome,
            netWorth: submission.accreditedInvestor.netWorth,
            professionalCertification: submission.accreditedInvestor.professionalCertification,
            entityType: submission.accreditedInvestor.entityType,
            verificationDocsCount: submission.accreditedInvestor.verificationDocuments?.length || 0,
          },
          documents: submission.documents.map(doc => ({
            type: doc.type,
            filename: doc.filename,
            originalName: doc.originalName,
            mimeType: doc.mimeType,
            size: doc.size,
            uploadedAt: doc.uploadedAt,
          })),
          documentsCount: submission.documents.length,
          auditLogCount: submission.auditLog.length,
          lastAuditAction: submission.auditLog[submission.auditLog.length - 1]?.action,
        })),
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: offset + limit < result.total,
        },
      });

    } catch (error) {
      logger.error('Failed to get pending KYC submissions:', error);
      res.status(500).json({
        error: 'Failed to get pending submissions',
        message: 'An error occurred while retrieving pending KYC submissions',
      });
    }
  }
);

/**
 * GET /api/admin/kyc/:id
 * Get detailed KYC submission for admin review
 */
router.get('/kyc/:id',
  authenticate,
  authorize('admin'),
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const { id } = req.params;

      const submission = await KYCSubmission.findById(id)
        .populate('userId', 'email createdAt lastLoginAt')
        .populate('reviewedBy', 'email');

      if (!submission) {
        res.status(404).json({
          error: 'Submission not found',
          message: 'The KYC submission could not be found',
        });
        return;
      }

      logger.info('Admin accessed KYC submission details', {
        adminId: req.user.userId,
        submissionId: id,
        userId: submission.userId,
      });

      res.json({
        submission: {
          id: submission._id,
          userId: submission.userId,
          user: (submission as any).userId, // Populated user data
          status: submission.status,
          submittedAt: submission.submittedAt,
          reviewedAt: submission.reviewedAt,
          reviewedBy: submission.reviewedBy,
          
          // Personal Information
          firstName: submission.firstName,
          lastName: submission.lastName,
          dateOfBirth: submission.dateOfBirth,
          nationality: submission.nationality,
          phoneNumber: submission.phoneNumber,
          address: submission.address,
          
          // Accredited Investor Information
          accreditedInvestor: submission.accreditedInvestor,
          
          // Documents
          documents: submission.documents.map((doc: any) => ({
            type: doc.type,
            filename: doc.filename,
            originalName: doc.originalName,
            mimeType: doc.mimeType,
            size: doc.size,
            uploadedAt: doc.uploadedAt,
          })),
          
          // Review Information
          reviewNotes: submission.reviewNotes,
          rejectionReason: submission.rejectionReason,
          additionalInfoRequired: submission.additionalInfoRequired,
          
          // Audit Trail
          auditLog: submission.auditLog.map((entry: any) => ({
            action: entry.action,
            performedBy: entry.performedBy,
            timestamp: entry.timestamp,
            details: entry.details,
            ipAddress: entry.ipAddress,
          })),
        },
      });

    } catch (error) {
      logger.error('Failed to get KYC submission details:', error);
      res.status(500).json({
        error: 'Failed to get submission details',
        message: 'An error occurred while retrieving the KYC submission details',
      });
    }
  }
);

/**
 * PUT /api/admin/kyc/:id/approve
 * Approve a KYC submission
 */
router.put('/kyc/:id/approve',
  authenticate,
  authorize('admin'),
  [
    body('notes')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Notes must be less than 1000 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const { id } = req.params;
      const { notes } = req.body;

      const submission = await kycService.approveKYC(
        id,
        req.user.userId,
        notes,
        req.ip
      );

      logger.info('KYC submission approved by admin', {
        submissionId: id,
        adminId: req.user.userId,
        userId: submission.userId,
      });

      securityLogger.info('KYC approval', {
        submissionId: id,
        adminId: req.user.userId,
        userId: submission.userId,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        message: 'KYC submission approved successfully',
        submission: {
          id: submission._id,
          status: submission.status,
          reviewedAt: submission.reviewedAt,
          reviewedBy: submission.reviewedBy,
          reviewNotes: submission.reviewNotes,
        },
      });

    } catch (error) {
      logger.error('Failed to approve KYC submission:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            error: 'Submission not found',
            message: 'The KYC submission could not be found',
          });
          return;
        }
        
        if (error.message.includes('not in pending status')) {
          res.status(400).json({
            error: 'Invalid status',
            message: 'Only pending KYC submissions can be approved',
          });
          return;
        }
      }

      res.status(500).json({
        error: 'Failed to approve KYC',
        message: 'An error occurred while approving the KYC submission',
      });
    }
  }
);

/**
 * PUT /api/admin/kyc/:id/reject
 * Reject a KYC submission
 */
router.put('/kyc/:id/reject',
  authenticate,
  authorize('admin'),
  [
    body('reason')
      .notEmpty()
      .isLength({ min: 1, max: 500 })
      .withMessage('Rejection reason is required and must be between 1-500 characters'),
    body('notes')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Notes must be less than 1000 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const { id } = req.params;
      const { reason, notes } = req.body;

      const submission = await kycService.rejectKYC(
        id,
        req.user.userId,
        reason,
        notes,
        req.ip
      );

      logger.info('KYC submission rejected by admin', {
        submissionId: id,
        adminId: req.user.userId,
        userId: submission.userId,
        reason,
      });

      securityLogger.info('KYC rejection', {
        submissionId: id,
        adminId: req.user.userId,
        userId: submission.userId,
        reason,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        message: 'KYC submission rejected',
        submission: {
          id: submission._id,
          status: submission.status,
          reviewedAt: submission.reviewedAt,
          reviewedBy: submission.reviewedBy,
          rejectionReason: submission.rejectionReason,
          reviewNotes: submission.reviewNotes,
        },
      });

    } catch (error) {
      logger.error('Failed to reject KYC submission:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            error: 'Submission not found',
            message: 'The KYC submission could not be found',
          });
          return;
        }
        
        if (error.message.includes('not in pending status')) {
          res.status(400).json({
            error: 'Invalid status',
            message: 'Only pending KYC submissions can be rejected',
          });
          return;
        }
      }

      res.status(500).json({
        error: 'Failed to reject KYC',
        message: 'An error occurred while rejecting the KYC submission',
      });
    }
  }
);

/**
 * POST /api/admin/products
 * Create a new investment product
 */
router.post('/products',
  authenticate,
  authorize('admin'),
  [
    body('name')
      .notEmpty()
      .isLength({ min: 1, max: 200 })
      .withMessage('Product name is required and must be between 1-200 characters'),
    body('symbol')
      .notEmpty()
      .matches(/^[A-Z]{2,10}$/)
      .withMessage('Symbol must be 2-10 uppercase letters'),
    body('type')
      .isIn(['REIT', 'BDC'])
      .withMessage('Type must be either REIT or BDC'),
    body('description')
      .notEmpty()
      .isLength({ min: 1, max: 2000 })
      .withMessage('Description is required and must be between 1-2000 characters'),
    body('strategy')
      .notEmpty()
      .isLength({ min: 1, max: 1000 })
      .withMessage('Strategy is required and must be between 1-1000 characters'),
    body('sharePrice')
      .isFloat({ min: 0.01, max: 10000 })
      .withMessage('Share price must be between $0.01 and $10,000'),
    body('totalShares')
      .isInt({ min: 1 })
      .withMessage('Total shares must be at least 1'),
    body('availableShares')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Available shares must be non-negative'),
    body('minimumInvestment')
      .optional()
      .isFloat({ min: 1 })
      .withMessage('Minimum investment must be at least $1'),
    body('fees.managementFee')
      .isFloat({ min: 0, max: 10 })
      .withMessage('Management fee must be between 0-10%'),
    body('fees.performanceFee')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .withMessage('Performance fee must be between 0-50%'),
    body('fees.acquisitionFee')
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage('Acquisition fee must be between 0-5%'),
    body('fees.dispositionFee')
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage('Disposition fee must be between 0-5%'),
    body('issuerId')
      .optional()
      .isMongoId()
      .withMessage('Valid issuer ID is required'),
    body('nav')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('NAV must be at least $0.01'),
    body('status')
      .optional()
      .isIn(['active', 'on_hold', 'inactive'])
      .withMessage('Invalid status'),
    body('sector')
      .optional()
      .isString()
      .trim()
      .withMessage('Sector must be a string'),
    body('geography')
      .optional()
      .isString()
      .trim()
      .withMessage('Geography must be a string'),
    body('targetReturn')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Target return must be between 0-100%'),
    body('distributionFrequency')
      .optional()
      .isIn(['monthly', 'quarterly', 'annually'])
      .withMessage('Invalid distribution frequency'),
    body('cusip')
      .optional()
      .matches(/^[0-9A-Z]{9}$/)
      .withMessage('CUSIP must be 9 alphanumeric characters'),
    body('isin')
      .optional()
      .matches(/^[A-Z]{2}[0-9A-Z]{9}[0-9]$/)
      .withMessage('ISIN must be 12 characters (2 letters + 9 alphanumeric + 1 digit)'),
    body('overviewData.totalInvestments')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Total investments must be non-negative'),
    body('overviewData.floatingRatePercentage')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Floating rate percentage must be between 0-100%'),
    body('overviewData.totalValue')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total value must be non-negative'),
    body('overviewData.totalAssets')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total assets must be non-negative'),
    body('overviewData.totalLiabilities')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total liabilities must be non-negative'),
    body('overviewData.eps')
      .optional()
      .isFloat()
      .withMessage('EPS must be a valid number'),
    body('overviewData.lastSalePrice')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Last sale price must be non-negative'),
    body('overviewData.contactWebsite')
      .optional()
      .isURL()
      .withMessage('Contact website must be a valid URL'),
    body('overviewData.contactPhone')
      .optional()
      .isString()
      .trim()
      .withMessage('Contact phone must be a string'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const productData = req.body;

      // Auto-set missing fields
      if (!productData.availableShares) {
        productData.availableShares = productData.totalShares;
      }
      
      if (!productData.issuerId) {
        productData.issuerId = req.user.userId;
      }
      
      if (!productData.nav) {
        productData.nav = productData.sharePrice;
      }

      // Validate that availableShares doesn't exceed totalShares
      if (productData.availableShares > productData.totalShares) {
        res.status(400).json({
          error: 'Invalid share allocation',
          message: 'Available shares cannot exceed total shares'
        });
        return;
      }

      // Check if symbol already exists
      const existingProduct = await InvestmentProduct.findOne({ symbol: productData.symbol });
      if (existingProduct) {
        res.status(400).json({
          error: 'Symbol already exists',
          message: 'A product with this symbol already exists'
        });
        return;
      }

      // Create the product
      const product = new InvestmentProduct({
        ...productData,
        navDate: new Date(),
        status: productData.status || 'on_hold', // Default to on_hold for safety
      });

      await product.save();

      logger.info('Investment product created by admin', {
        adminId: req.user.userId,
        productId: product._id,
        productName: product.name,
        symbol: product.symbol,
        type: product.type,
        sharePrice: product.sharePrice,
        totalShares: product.totalShares,
      });

      securityLogger.info('Product creation', {
        adminId: req.user.userId,
        productId: product._id,
        symbol: product.symbol,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.status(201).json({
        success: true,
        message: 'Investment product created successfully',
        data: {
          product: {
            id: product._id,
            name: product.name,
            symbol: product.symbol,
            type: product.type,
            sharePrice: product.sharePrice,
            totalShares: product.totalShares,
            availableShares: product.availableShares,
            status: product.status,
            createdAt: product.createdAt,
          }
        }
      });

    } catch (error) {
      logger.error('Failed to create investment product:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('duplicate key')) {
          res.status(400).json({
            error: 'Duplicate symbol',
            message: 'A product with this symbol already exists'
          });
          return;
        }
      }

      res.status(500).json({
        error: 'Failed to create product',
        message: 'An error occurred while creating the investment product'
      });
    }
  }
);

/**
 * GET /api/admin/products
 * Get all investment products for admin management
 */
router.get('/products',
  authenticate,
  authorize('admin'),
  [
    query('status')
      .optional()
      .isIn(['active', 'on_hold', 'inactive'])
      .withMessage('Invalid status'),
    query('type')
      .optional()
      .isIn(['REIT', 'BDC'])
      .withMessage('Type must be either REIT or BDC'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be non-negative'),
    query('sortBy')
      .optional()
      .isIn(['name', 'symbol', 'sharePrice', 'createdAt', 'status'])
      .withMessage('Invalid sort field'),
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const {
        status,
        type,
        limit = 50,
        offset = 0,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter
      const filter: any = {};
      if (status) filter.status = status;
      if (type) filter.type = type;

      // Build sort
      const sort: any = {};
      sort[sortBy as string] = sortOrder === 'asc' ? 1 : -1;

      const [products, total] = await Promise.all([
        InvestmentProduct.find(filter)
          .populate('issuerId', 'email companyName')
          .sort(sort)
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean(),
        InvestmentProduct.countDocuments(filter)
      ]);

      logger.info('Admin accessed product management', {
        adminId: req.user.userId,
        filters: { status, type },
        resultCount: products.length,
        total
      });

      res.json({
        success: true,
        data: {
          products: products.map(product => ({
            id: product._id,
            name: product.name,
            symbol: product.symbol,
            type: product.type,
            sharePrice: product.sharePrice,
            totalShares: product.totalShares,
            availableShares: product.availableShares,
            minimumInvestment: product.minimumInvestment,
            status: product.status,
            sector: product.sector,
            geography: product.geography,
            nav: product.nav,
            navDate: product.navDate,
            overviewData: product.overviewData,
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
            issuer: (product as any).issuerId,
            // Calculated fields
            marketCap: product.totalShares * product.sharePrice,
            availabilityPercentage: (product.availableShares / product.totalShares) * 100,
            isAvailableForTrading: product.status === 'active' && product.availableShares > 0,
            documentsCount: product.documents?.length || 0,
          })),
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < total,
          },
          summary: {
            totalProducts: total,
            activeProducts: await InvestmentProduct.countDocuments({ status: 'active' }),
            onHoldProducts: await InvestmentProduct.countDocuments({ status: 'on_hold' }),
            inactiveProducts: await InvestmentProduct.countDocuments({ status: 'inactive' }),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get admin products:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load investment products'
      });
    }
  }
);

/**
 * PUT /api/admin/products/:id
 * Update an investment product
 */
router.put('/products/:id',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid product ID'),
    body('name')
      .optional()
      .isLength({ min: 1, max: 200 })
      .withMessage('Product name must be between 1-200 characters'),
    body('sharePrice')
      .optional()
      .isFloat({ min: 0.01, max: 10000 })
      .withMessage('Share price must be between $0.01 and $10,000'),
    body('availableShares')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Available shares must be non-negative'),
    body('status')
      .optional()
      .isIn(['active', 'on_hold', 'inactive'])
      .withMessage('Invalid status'),
    body('nav')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('NAV must be at least $0.01'),
    body('description')
      .optional()
      .isLength({ min: 1, max: 2000 })
      .withMessage('Description must be between 1-2000 characters'),
    body('strategy')
      .optional()
      .isLength({ min: 1, max: 1000 })
      .withMessage('Strategy must be between 1-1000 characters'),
    body('sector')
      .optional()
      .isString()
      .trim()
      .withMessage('Sector must be a string'),
    body('geography')
      .optional()
      .isString()
      .trim()
      .withMessage('Geography must be a string'),
    body('targetReturn')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Target return must be between 0-100%'),
    body('minimumInvestment')
      .optional()
      .isFloat({ min: 1 })
      .withMessage('Minimum investment must be at least $1'),
    body('overviewData.totalInvestments')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Total investments must be non-negative'),
    body('overviewData.floatingRatePercentage')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Floating rate percentage must be between 0-100%'),
    body('overviewData.totalValue')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total value must be non-negative'),
    body('overviewData.totalAssets')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total assets must be non-negative'),
    body('overviewData.totalLiabilities')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Total liabilities must be non-negative'),
    body('overviewData.eps')
      .optional()
      .isFloat()
      .withMessage('EPS must be a valid number'),
    body('overviewData.lastSalePrice')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Last sale price must be non-negative'),
    body('overviewData.contactWebsite')
      .optional()
      .isURL()
      .withMessage('Contact website must be a valid URL'),
    body('overviewData.contactPhone')
      .optional()
      .isString()
      .trim()
      .withMessage('Contact phone must be a string'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const productId = req.params.id;
      const updates = req.body;

      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      // Validate availableShares if being updated
      if (updates.availableShares !== undefined && updates.availableShares > product.totalShares) {
        res.status(400).json({
          error: 'Invalid share allocation',
          message: 'Available shares cannot exceed total shares'
        });
        return;
      }

      // Update NAV date if NAV is being updated
      if (updates.nav !== undefined) {
        updates.navDate = new Date();
      }

      // Apply updates
      Object.assign(product, updates);
      await product.save();

      logger.info('Investment product updated by admin', {
        adminId: req.user.userId,
        productId,
        productName: product.name,
        updates: Object.keys(updates),
      });

      securityLogger.info('Product update', {
        adminId: req.user.userId,
        productId,
        symbol: product.symbol,
        updates: Object.keys(updates),
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        success: true,
        message: 'Investment product updated successfully',
        data: {
          product: {
            id: product._id,
            name: product.name,
            symbol: product.symbol,
            type: product.type,
            description: product.description,
            strategy: product.strategy,
            sharePrice: product.sharePrice,
            totalShares: product.totalShares,
            availableShares: product.availableShares,
            minimumInvestment: product.minimumInvestment,
            status: product.status,
            sector: product.sector,
            geography: product.geography,
            targetReturn: product.targetReturn,
            distributionFrequency: product.distributionFrequency,
            nav: product.nav,
            navDate: product.navDate,
            overviewData: product.overviewData,
            updatedAt: product.updatedAt,
          }
        }
      });

    } catch (error) {
      logger.error('Failed to update investment product:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update investment product'
      });
    }
  }
);

/**
 * PUT /api/admin/products/:id/status
 * Update product status (activate, hold, deactivate)
 */
router.put('/products/:id/status',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid product ID'),
    body('status')
      .isIn(['active', 'on_hold', 'inactive'])
      .withMessage('Status must be active, on_hold, or inactive'),
    body('reason')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Reason must be a string with max 500 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const productId = req.params.id;
      const { status, reason } = req.body;

      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      const oldStatus = product.status;
      product.status = status;
      await product.save();

      logger.info('Product status changed by admin', {
        adminId: req.user.userId,
        productId,
        productName: product.name,
        symbol: product.symbol,
        oldStatus,
        newStatus: status,
        reason,
      });

      securityLogger.info('Product status change', {
        adminId: req.user.userId,
        productId,
        symbol: product.symbol,
        oldStatus,
        newStatus: status,
        reason,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        success: true,
        message: `Product status changed from ${oldStatus} to ${status}`,
        data: {
          productId,
          symbol: product.symbol,
          oldStatus,
          newStatus: status,
          updatedAt: product.updatedAt,
        }
      });

    } catch (error) {
      logger.error('Failed to update product status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update product status'
      });
    }
  }
);

/**
 * GET /api/admin/revenue
 * Get comprehensive revenue analytics and breakdown
 */
router.get('/revenue',
  authenticate,
  authorize('admin'),
  [
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be a valid ISO 8601 date'),
    query('period')
      .optional()
      .isIn(['today', 'week', 'month', 'quarter', 'year', 'custom'])
      .withMessage('Period must be one of: today, week, month, quarter, year, custom'),
  ],
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
        return;
      }

      const { revenueService } = await import('@/services/RevenueService');
      
      let startDate: Date;
      let endDate: Date = new Date();

      // Handle different period options
      const period = req.query.period as string || 'month';
      
      if (period === 'custom') {
        if (!req.query.startDate || !req.query.endDate) {
          res.status(400).json({
            success: false,
            message: 'Start date and end date are required for custom period'
          });
          return;
        }
        startDate = new Date(req.query.startDate as string);
        endDate = new Date(req.query.endDate as string);
      } else {
        // Calculate start date based on period
        startDate = new Date();
        switch (period) {
          case 'today':
            startDate.setHours(0, 0, 0, 0);
            break;
          case 'week':
            startDate.setDate(startDate.getDate() - 7);
            break;
          case 'month':
            startDate.setMonth(startDate.getMonth() - 1);
            break;
          case 'quarter':
            startDate.setMonth(startDate.getMonth() - 3);
            break;
          case 'year':
            startDate.setFullYear(startDate.getFullYear() - 1);
            break;
        }
      }

      const revenueAnalytics = await revenueService.getRevenueAnalytics(startDate, endDate);

      logger.info('Admin accessed revenue analytics', {
        adminId: req.user!.userId,
        period,
        startDate,
        endDate,
        totalRevenue: revenueAnalytics.currentPeriod.totalRevenue
      });

      res.json({
        success: true,
        data: revenueAnalytics
      });

    } catch (error) {
      logger.error('Failed to get revenue analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve revenue analytics'
      });
    }
  }
);

/**
 * GET /api/admin/revenue/breakdown
 * Get detailed revenue breakdown for a specific period
 */
router.get('/revenue/breakdown',
  authenticate,
  authorize('admin'),
  [
    query('startDate')
      .isISO8601()
      .withMessage('Start date is required and must be a valid ISO 8601 date'),
    query('endDate')
      .isISO8601()
      .withMessage('End date is required and must be a valid ISO 8601 date'),
  ],
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
        return;
      }

      const { revenueService } = await import('@/services/RevenueService');
      
      const startDate = new Date(req.query.startDate as string);
      const endDate = new Date(req.query.endDate as string);

      const revenueBreakdown = await revenueService.getRevenueBreakdown(startDate, endDate);

      logger.info('Admin accessed revenue breakdown', {
        adminId: req.user!.userId,
        startDate,
        endDate,
        totalRevenue: revenueBreakdown.totalRevenue
      });

      res.json({
        success: true,
        data: revenueBreakdown
      });

    } catch (error) {
      logger.error('Failed to get revenue breakdown:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve revenue breakdown'
      });
    }
  }
);

/**
 * GET /api/admin/revenue/issuer-billing
 * Get issuer billing and payment tracking
 */
router.get('/revenue/issuer-billing',
  authenticate,
  authorize('admin'),
  [
    query('issuerId')
      .optional()
      .isMongoId()
      .withMessage('Issuer ID must be a valid MongoDB ObjectId'),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be a valid ISO 8601 date'),
    query('status')
      .optional()
      .isIn(['pending', 'paid', 'overdue', 'waived'])
      .withMessage('Status must be one of: pending, paid, overdue, waived'),
  ],
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
        return;
      }

      const { revenueService } = await import('@/services/RevenueService');
      const { ListingFee } = await import('@/models/ListingFee');
      
      const issuerId = req.query.issuerId as string;
      const status = req.query.status as string;
      
      // Default to last 12 months if no dates provided
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);

      if (issuerId) {
        // Get billing report for specific issuer
        const billingReport = await revenueService.getIssuerBillingReport(
          new mongoose.Types.ObjectId(issuerId),
          startDate,
          endDate
        );

        res.json({
          success: true,
          data: billingReport
        });
      } else {
        // Get summary of all issuer billing
        const query: any = {
          dueDate: { $gte: startDate, $lte: endDate }
        };
        if (status) query.status = status;

        const billingData = await ListingFee.find(query)
          .populate('issuerId', 'email companyName')
          .populate('productId', 'name symbol')
          .sort({ dueDate: -1 })
          .lean();

        // Group by issuer
        const issuerBilling = billingData.reduce((acc: any, fee: any) => {
          const issuerId = fee.issuerId._id.toString();
          if (!acc[issuerId]) {
            acc[issuerId] = {
              issuerId: fee.issuerId._id,
              issuerEmail: fee.issuerId.email,
              companyName: fee.issuerId.companyName,
              totalDue: 0,
              totalPaid: 0,
              totalOverdue: 0,
              fees: []
            };
          }

          acc[issuerId].fees.push({
            id: fee._id,
            productName: fee.productId.name,
            feeType: fee.feeType,
            amount: fee.amount,
            dueDate: fee.dueDate,
            status: fee.status,
            paidDate: fee.paidDate
          });

          if (fee.status === 'pending' || fee.status === 'overdue') {
            acc[issuerId].totalDue += fee.amount;
          }
          if (fee.status === 'paid') {
            acc[issuerId].totalPaid += fee.amount;
          }
          if (fee.status === 'overdue') {
            acc[issuerId].totalOverdue += fee.amount;
          }

          return acc;
        }, {});

        res.json({
          success: true,
          data: {
            period: { startDate, endDate },
            issuers: Object.values(issuerBilling),
            summary: {
              totalIssuers: Object.keys(issuerBilling).length,
              totalDue: Object.values(issuerBilling).reduce((sum: number, issuer: any) => sum + issuer.totalDue, 0),
              totalPaid: Object.values(issuerBilling).reduce((sum: number, issuer: any) => sum + issuer.totalPaid, 0),
              totalOverdue: Object.values(issuerBilling).reduce((sum: number, issuer: any) => sum + issuer.totalOverdue, 0)
            }
          }
        });
      }

      logger.info('Admin accessed issuer billing data', {
        adminId: req.user!.userId,
        issuerId,
        status,
        startDate,
        endDate
      });

    } catch (error) {
      logger.error('Failed to get issuer billing data:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve issuer billing data'
      });
    }
  }
);

/**
 * GET /api/admin/orders
 * Get all orders with filtering for admin management
 */
router.get('/orders',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
    query('status')
      .optional()
      .isIn(['pending', 'filled', 'partially_filled', 'cancelled', 'rejected'])
      .withMessage('Invalid status'),
    query('type')
      .optional()
      .isIn(['buy', 'sell'])
      .withMessage('Type must be buy or sell'),
    query('userId')
      .optional()
      .isMongoId()
      .withMessage('Invalid user ID'),
    query('productId')
      .optional()
      .isMongoId()
      .withMessage('Invalid product ID'),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be valid ISO8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be valid ISO8601 date'),
    query('sortBy')
      .optional()
      .isIn(['createdAt', 'totalAmount', 'status', 'pricePerShare'])
      .withMessage('Invalid sort field'),
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const {
        limit = 50,
        offset = 0,
        status,
        type,
        userId,
        productId,
        startDate,
        endDate,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter
      const filter: any = {};
      if (status) filter.status = status;
      if (type) filter.type = type;
      if (userId) filter.userId = userId;
      if (productId) filter.productId = productId;

      // Date filter
      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate as string);
        if (endDate) filter.createdAt.$lte = new Date(endDate as string);
      }

      // Build sort
      const sort: any = {};
      sort[sortBy as string] = sortOrder === 'asc' ? 1 : -1;

      const [orders, total] = await Promise.all([
        Order.find(filter)
          .populate('userId', 'email')
          .populate('productId', 'name symbol')
          .sort(sort)
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean(),
        Order.countDocuments(filter)
      ]);

      logger.info('Admin accessed order management', {
        adminId: req.user.userId,
        filters: { status, type, userId, productId },
        resultCount: orders.length,
        total
      });

      res.json({
        success: true,
        data: {
          orders: orders.map(order => ({
            id: order._id,
            user: (order as any).userId,
            product: (order as any).productId,
            type: order.type,
            orderType: order.orderType,
            quantity: order.quantity,
            pricePerShare: order.pricePerShare,
            totalAmount: order.totalAmount,
            status: order.status,
            filledQuantity: order.filledQuantity,
            remainingQuantity: order.remainingQuantity,
            averageFillPrice: order.averageFillPrice,
            fees: order.fees,
            expiresAt: order.expiresAt,
            filledAt: order.filledAt,
            cancelledAt: order.cancelledAt,
            rejectionReason: order.rejectionReason,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          })),
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < total,
          },
          summary: {
            totalOrders: total,
            pendingOrders: await Order.countDocuments({ status: 'pending' }),
            filledOrders: await Order.countDocuments({ status: 'filled' }),
            cancelledOrders: await Order.countDocuments({ status: 'cancelled' }),
            rejectedOrders: await Order.countDocuments({ status: 'rejected' }),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get orders for admin:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load orders'
      });
    }
  }
);

/**
 * PUT /api/admin/orders/:id/confirm
 * Confirm/approve a pending order and update user balance
 */
router.put('/orders/:id/confirm',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('fillPrice')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Fill price must be at least 0.01'),
    body('notes')
      .optional()
      .isString()
      .isLength({ max: 1000 })
      .withMessage('Notes must be less than 1000 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const orderId = req.params.id;
      const { fillPrice, notes } = req.body;

      const order = await Order.findById(orderId)
        .populate('userId', 'email')
        .populate('productId', 'name symbol');

      if (!order) {
        res.status(404).json({
          success: false,
          message: 'Order not found'
        });
        return;
      }

      if (order.status !== 'pending') {
        res.status(400).json({
          success: false,
          message: `Order cannot be confirmed. Current status: ${order.status}`
        });
        return;
      }

      // Use provided fill price or order price
      const executionPrice = fillPrice || order.pricePerShare;
      
      // Get user's wallet
      const wallet = await Wallet.findOne({ userId: order.userId });
      if (!wallet) {
        res.status(404).json({
          success: false,
          message: 'User wallet not found'
        });
        return;
      }

      // Calculate total cost including fees (assuming 1% fee for now)
      const feePercentage = 0.01; // 1%
      const fees = order.totalAmount * feePercentage;
      const totalCost = order.totalAmount + fees;

      if (order.type === 'buy') {
        // For buy orders, check if user has sufficient balance across all networks
        const totalUsdtBalance = wallet.balances.usdt.ethereum + wallet.balances.usdt.tron + wallet.balances.usdt.bsc;
        
        if (totalUsdtBalance < totalCost) {
          res.status(400).json({
            success: false,
            message: 'Insufficient balance to complete order'
          });
          return;
        }

        // Deduct from the network with the highest balance first
        let remainingCost = totalCost;
        const networks: Array<'ethereum' | 'tron' | 'bsc'> = ['ethereum', 'tron', 'bsc'];
        
        // Sort networks by balance (highest first)
        networks.sort((a, b) => wallet.balances.usdt[b] - wallet.balances.usdt[a]);
        
        for (const network of networks) {
          if (remainingCost <= 0) break;
          
          const networkBalance = wallet.balances.usdt[network];
          if (networkBalance > 0) {
            const deductAmount = Math.min(networkBalance, remainingCost);
            wallet.updateBalance(network, 'usdt', networkBalance - deductAmount);
            remainingCost -= deductAmount;
          }
        }
        
        // Update user's portfolio
        let portfolio = await Portfolio.findOne({ userId: order.userId });
        if (!portfolio) {
          portfolio = new Portfolio({
            userId: order.userId,
            holdings: [],
            totalValue: 0,
            totalInvested: 0,
            totalPnL: 0,
          });
        }

        // Use the portfolio's addHolding method which handles the logic correctly
        portfolio.addHolding(order.productId, order.quantity, executionPrice);

        await portfolio.save();

      } else {
        // For sell orders, add to wallet balance (prefer network with highest existing balance)
        const networks: Array<'ethereum' | 'tron' | 'bsc'> = ['ethereum', 'tron', 'bsc'];
        networks.sort((a, b) => wallet.balances.usdt[b] - wallet.balances.usdt[a]);
        
        // Add to the network with the highest balance, or BSC as default
        const targetNetwork = networks[0] === 'ethereum' && wallet.balances.usdt.ethereum === 0 ? 'bsc' : networks[0];
        const currentBalance = wallet.balances.usdt[targetNetwork];
        wallet.updateBalance(targetNetwork, 'usdt', currentBalance + (order.totalAmount - fees));
        
        // Update portfolio (remove shares)
        const portfolio = await Portfolio.findOne({ userId: order.userId });
        if (portfolio) {
          // Use the portfolio's updateHolding method for sells (negative quantity)
          portfolio.updateHolding(order.productId, -order.quantity, executionPrice);
          await portfolio.save();
        }
      }

      // Update order status
      order.completeFill(executionPrice);
      order.fees = fees;
      await order.save();

      // Save wallet changes
      await wallet.save();

      // Create audit log
      await createAuditLog({
        adminId: req.user.userId,
        action: 'confirm_order',
        resource: 'order',
        resourceId: orderId,
        details: {
          orderId,
          userId: order.userId,
          orderType: order.type,
          quantity: order.quantity,
          executionPrice,
          totalAmount: order.totalAmount,
          fees,
          notes,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity: 'medium',
      });

      logger.info('Admin confirmed order', {
        adminId: req.user.userId,
        orderId,
        userId: order.userId,
        orderType: order.type,
        executionPrice,
        totalAmount: order.totalAmount,
      });

      res.json({
        success: true,
        message: 'Order confirmed successfully',
        data: {
          orderId,
          status: order.status,
          executionPrice,
          fees,
          filledAt: order.filledAt,
          updatedBalance: wallet.balances.usdt.ethereum,
        }
      });

    } catch (error) {
      logger.error('Failed to confirm order:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to confirm order'
      });
    }
  }
);

/**
 * PUT /api/admin/orders/:id/reject
 * Reject a pending order
 */
router.put('/orders/:id/reject',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid order ID'),
    body('reason')
      .notEmpty()
      .isString()
      .isLength({ min: 1, max: 500 })
      .withMessage('Rejection reason is required and must be between 1-500 characters'),
    body('notes')
      .optional()
      .isString()
      .isLength({ max: 1000 })
      .withMessage('Notes must be less than 1000 characters'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const orderId = req.params.id;
      const { reason, notes } = req.body;

      const order = await Order.findById(orderId)
        .populate('userId', 'email')
        .populate('productId', 'name symbol');

      if (!order) {
        res.status(404).json({
          success: false,
          message: 'Order not found'
        });
        return;
      }

      if (order.status !== 'pending') {
        res.status(400).json({
          success: false,
          message: `Order cannot be rejected. Current status: ${order.status}`
        });
        return;
      }

      // Update order status
      order.status = 'rejected';
      order.rejectionReason = reason;
      await order.save();

      // Create audit log
      await createAuditLog({
        adminId: req.user.userId,
        action: 'reject_order',
        resource: 'order',
        resourceId: orderId,
        details: {
          orderId,
          userId: order.userId,
          orderType: order.type,
          reason,
          notes,
        },
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        category: 'admin',
        success: true,
        severity: 'medium',
      });

      logger.info('Admin rejected order', {
        adminId: req.user.userId,
        orderId,
        userId: order.userId,
        reason,
      });

      res.json({
        success: true,
        message: 'Order rejected successfully',
        data: {
          orderId,
          status: order.status,
          rejectionReason: order.rejectionReason,
        }
      });

    } catch (error) {
      logger.error('Failed to reject order:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to reject order'
      });
    }
  }
);

/**
 * GET /api/admin/wallets
 * Get all user wallets with pagination
 */
router.get('/wallets',
  authenticate,
  authorize('admin'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('search').optional().isString().withMessage('Search must be a string'),
  ],
  async (req: express.Request, res: express.Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const search = req.query.search as string;
      const skip = (page - 1) * limit;

      // Build filter
      const filter: any = {};
      if (search) {
        filter.$or = [
          { 'addresses.ethereum': { $regex: search, $options: 'i' } },
          { 'addresses.tron': { $regex: search, $options: 'i' } },
          { 'addresses.bsc': { $regex: search, $options: 'i' } },
        ];
      }

      const [wallets, total] = await Promise.all([
        Wallet.find(filter)
          .populate('userId', 'email firstName lastName kycStatus')
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(skip)
          .lean(),
        Wallet.countDocuments(filter)
      ]);

      logger.info('Admin accessed wallets list', {
        adminId: req.user!.userId,
        page,
        limit,
        total
      });

      return res.json({
        success: true,
        data: {
          wallets,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get wallets:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get wallets'
      });
    }
  }
);

/**
 * GET /api/admin/wallets/:walletId/private-keys
 * Get encrypted private keys for a specific wallet (admin only)
 */
router.get('/wallets/:walletId/private-keys',
  authenticate,
  authorize('admin'),
  [
    param('walletId').isMongoId().withMessage('Invalid wallet ID'),
  ],
  async (req: express.Request, res: express.Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const walletId = req.params.walletId;

      // Fetch wallet with private keys (they're excluded by default)
      const wallet = await Wallet.findById(walletId)
        .select('+privateKeys.ethereum.encryptedKey +privateKeys.ethereum.iv +privateKeys.tron.encryptedKey +privateKeys.tron.iv +privateKeys.bsc.encryptedKey +privateKeys.bsc.iv')
        .populate('userId', 'email firstName lastName kycStatus')
        .lean();

      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: 'Wallet not found'
        });
      }

      // Log admin access to private keys
      securityLogger.warn('Admin accessed wallet private keys', {
        adminId: req.user!.userId,
        adminEmail: req.user!.email,
        walletId,
        userId: wallet.userId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      });

      logger.info('Admin accessed wallet private keys', {
        adminId: req.user!.userId,
        walletId,
        userId: wallet.userId
      });

      return res.json({
        success: true,
        data: {
          walletId: wallet._id,
          userId: wallet.userId,
          addresses: wallet.addresses,
          privateKeys: wallet.privateKeys,
          balances: wallet.balances,
          totalBalanceUSD: wallet.totalBalanceUSD,
          warning: 'These are encrypted private keys. Use the decryption endpoint or decrypt manually with the master encryption key.'
        }
      });

    } catch (error) {
      logger.error('Failed to get wallet private keys:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get wallet private keys'
      });
    }
  }
);

/**
 * POST /api/admin/wallets/:walletId/decrypt-private-key
 * Decrypt a private key for a specific network (admin only)
 */
router.post('/wallets/:walletId/decrypt-private-key',
  authenticate,
  authorize('admin'),
  [
    param('walletId').isMongoId().withMessage('Invalid wallet ID'),
    body('network').isIn(['ethereum', 'tron', 'bsc']).withMessage('Invalid network'),
  ],
  async (req: express.Request, res: express.Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: errors.array()
        });
      }

      const walletId = req.params.walletId;
      const network = req.body.network as 'ethereum' | 'tron' | 'bsc';

      // Fetch wallet with private keys
      const wallet = await Wallet.findById(walletId)
        .select('+privateKeys.ethereum.encryptedKey +privateKeys.ethereum.iv +privateKeys.tron.encryptedKey +privateKeys.tron.iv +privateKeys.bsc.encryptedKey +privateKeys.bsc.iv')
        .populate('userId', 'email firstName lastName')
        .lean();

      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: 'Wallet not found'
        });
      }

      // Decrypt the private key
      const { walletService } = await import('@/services/WalletService');
      const encryptedKey = wallet.privateKeys[network].encryptedKey;
      const iv = wallet.privateKeys[network].iv;
      
      const decryptedPrivateKey = walletService.decryptPrivateKey(encryptedKey, iv);

      // Log admin decryption of private key
      securityLogger.warn('Admin decrypted wallet private key', {
        adminId: req.user!.userId,
        adminEmail: req.user!.email,
        walletId,
        userId: wallet.userId,
        network,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      });

      logger.info('Admin decrypted wallet private key', {
        adminId: req.user!.userId,
        walletId,
        userId: wallet.userId,
        network
      });

      return res.json({
        success: true,
        data: {
          walletId: wallet._id,
          userId: wallet.userId,
          network,
          address: wallet.addresses[network],
          privateKey: decryptedPrivateKey,
          warning: 'CRITICAL: This is the unencrypted private key. Handle with extreme care. Never share or log this value.'
        }
      });

    } catch (error) {
      logger.error('Failed to decrypt private key:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to decrypt private key'
      });
    }
  }
);

export default router;
/**
 
* GET /api/admin/withdrawals/pending
 * Get pending withdrawal requests for admin review
 */
router.get('/withdrawals/pending',
  authenticate,
  authorize('admin'),
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer'),
    query('network')
      .optional()
      .isIn(['ethereum', 'tron', 'bsc'])
      .withMessage('Invalid network'),
    query('minAmount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Minimum amount must be non-negative'),
    query('maxAmount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Maximum amount must be non-negative'),
    query('fraudScore')
      .optional()
      .isInt({ min: 0, max: 100 })
      .withMessage('Fraud score must be between 0 and 100'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const network = req.query.network as string;
      const minAmount = parseFloat(req.query.minAmount as string);
      const maxAmount = parseFloat(req.query.maxAmount as string);
      const fraudScore = parseInt(req.query.fraudScore as string);

      // Build filter
      const filter: any = { status: 'pending' };
      if (network) filter.network = network;
      if (!isNaN(minAmount)) filter.amount = { ...filter.amount, $gte: minAmount };
      if (!isNaN(maxAmount)) filter.amount = { ...filter.amount, $lte: maxAmount };
      if (!isNaN(fraudScore)) filter.fraudScore = { $gte: fraudScore };

      const [withdrawals, total] = await Promise.all([
        Withdrawal.find(filter)
          .populate('userId', 'email kycStatus accreditedInvestor createdAt')
          .populate('walletId', 'addresses totalBalanceUSD')
          .sort({ fraudScore: -1, requestedAt: 1 }) // High fraud score first, then oldest first
          .limit(limit)
          .skip(offset)
          .lean(),
        Withdrawal.countDocuments(filter)
      ]);

      logger.info('Admin accessed pending withdrawals', {
        adminId: req.user.userId,
        count: withdrawals.length,
        total,
        filters: { network, minAmount, maxAmount, fraudScore }
      });

      res.json({
        success: true,
        data: {
          withdrawals: withdrawals.map(withdrawal => ({
            id: withdrawal._id,
            userId: withdrawal.userId,
            user: (withdrawal as any).userId, // Populated user data
            wallet: (withdrawal as any).walletId, // Populated wallet data
            network: withdrawal.network,
            token: withdrawal.token,
            amount: withdrawal.amount,
            toAddress: withdrawal.toAddress,
            status: withdrawal.status,
            requestedAt: withdrawal.requestedAt,
            fraudScore: withdrawal.fraudScore,
            fraudFlags: withdrawal.fraudFlags,
            ipAddress: withdrawal.ipAddress,
            userAgent: withdrawal.userAgent,
            // Security: Only show partial address in list view
            toAddressDisplay: withdrawal.toAddress.substring(0, 10) + '...' + withdrawal.toAddress.substring(withdrawal.toAddress.length - 6),
          })),
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          },
          summary: {
            totalPendingAmount: withdrawals.reduce((sum, w) => sum + w.amount, 0),
            highRiskCount: withdrawals.filter(w => (w.fraudScore || 0) >= 70).length,
            mediumRiskCount: withdrawals.filter(w => (w.fraudScore || 0) >= 30 && (w.fraudScore || 0) < 70).length,
            lowRiskCount: withdrawals.filter(w => (w.fraudScore || 0) < 30).length,
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get pending withdrawals:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get pending withdrawals'
      });
    }
  }
);

/**
 * GET /api/admin/withdrawals/:id
 * Get detailed withdrawal information for admin review
 */
router.get('/withdrawals/:id',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid withdrawal ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const withdrawalId = req.params.id;

      const withdrawal = await Withdrawal.findById(withdrawalId)
        .populate('userId', 'email kycStatus accreditedInvestor createdAt lastLoginAt')
        .populate('walletId', 'addresses balances totalBalanceUSD lastSyncAt')
        .populate('reviewedBy', 'email');

      if (!withdrawal) {
        res.status(404).json({
          success: false,
          message: 'Withdrawal not found'
        });
        return;
      }

      // Get user's withdrawal history for context
      const userWithdrawalHistory = await Withdrawal.find({
        userId: withdrawal.userId,
        _id: { $ne: withdrawalId }
      })
        .sort({ requestedAt: -1 })
        .limit(10)
        .select('amount network token status requestedAt completedAt fraudScore');

      // Get recent transactions to the same address
      const addressHistory = await Withdrawal.find({
        toAddress: withdrawal.toAddress,
        status: { $in: ['completed', 'processing'] }
      })
        .populate('userId', 'email')
        .sort({ requestedAt: -1 })
        .limit(5)
        .select('userId amount network token status requestedAt completedAt');

      logger.info('Admin accessed withdrawal details', {
        adminId: req.user.userId,
        withdrawalId,
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        fraudScore: withdrawal.fraudScore
      });

      res.json({
        success: true,
        data: {
          withdrawal,
          context: {
            userWithdrawalHistory,
            addressHistory,
            riskAssessment: {
              fraudScore: withdrawal.fraudScore,
              fraudFlags: withdrawal.fraudFlags,
              riskLevel: (withdrawal.fraudScore ?? 0) >= 70 ? 'HIGH' : (withdrawal.fraudScore ?? 0) >= 30 ? 'MEDIUM' : 'LOW',
              recommendations: generateRiskRecommendations(withdrawal)
            }
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get withdrawal details:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get withdrawal details'
      });
    }
  }
);

/**
 * PUT /api/admin/withdrawals/:id/approve
 * Approve a withdrawal request
 */
router.put('/withdrawals/:id/approve',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid withdrawal ID'),
    body('notes').optional().isString().withMessage('Notes must be a string'),
    body('processImmediately').optional().isBoolean().withMessage('Process immediately must be boolean'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const withdrawalId = req.params.id;
      const { notes, processImmediately = false } = req.body;
      const adminId = req.user.userId;
      const ipAddress = req.ip;

      const withdrawal = await Withdrawal.findById(withdrawalId);
      if (!withdrawal) {
        res.status(404).json({
          success: false,
          message: 'Withdrawal not found'
        });
        return;
      }

      if (!withdrawal.canApprove()) {
        res.status(400).json({
          success: false,
          message: 'Withdrawal cannot be approved in current status',
          currentStatus: withdrawal.status
        });
        return;
      }

      // Update withdrawal status
      withdrawal.status = 'approved';
      withdrawal.reviewedAt = new Date();
      withdrawal.reviewedBy = new mongoose.Types.ObjectId(adminId);
      withdrawal.approvedAt = new Date();
      withdrawal.adminNotes = notes;

      await withdrawal.save();

      // If processImmediately is true, start processing
      if (processImmediately) {
        try {
          await processWithdrawal(withdrawal);
        } catch (processingError) {
          logger.error('Failed to process withdrawal immediately:', processingError);
          // Don't fail the approval, just log the error
        }
      }

      logger.info('Withdrawal approved by admin', {
        withdrawalId,
        adminId,
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        network: withdrawal.network,
        processImmediately,
        notes
      });

      securityLogger.info('Withdrawal approval', {
        withdrawalId,
        adminId,
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        network: withdrawal.network,
        toAddress: withdrawal.toAddress.substring(0, 10) + '...',
        fraudScore: withdrawal.fraudScore,
        ipAddress
      });

      res.json({
        success: true,
        data: {
          withdrawalId,
          status: withdrawal.status,
          approvedAt: withdrawal.approvedAt,
          message: processImmediately ? 'Withdrawal approved and processing initiated' : 'Withdrawal approved successfully'
        }
      });

    } catch (error) {
      logger.error('Failed to approve withdrawal:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to approve withdrawal'
      });
    }
  }
);

/**
 * PUT /api/admin/withdrawals/:id/reject
 * Reject a withdrawal request
 */
router.put('/withdrawals/:id/reject',
  authenticate,
  authorize('admin'),
  [
    param('id').isMongoId().withMessage('Invalid withdrawal ID'),
    body('reason').notEmpty().withMessage('Rejection reason is required'),
    body('notes').optional().isString().withMessage('Notes must be a string'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const withdrawalId = req.params.id;
      const { reason, notes } = req.body;
      const adminId = req.user.userId;
      const ipAddress = req.ip;

      const withdrawal = await Withdrawal.findById(withdrawalId);
      if (!withdrawal) {
        res.status(404).json({
          success: false,
          message: 'Withdrawal not found'
        });
        return;
      }

      if (!withdrawal.canReject()) {
        res.status(400).json({
          success: false,
          message: 'Withdrawal cannot be rejected in current status',
          currentStatus: withdrawal.status
        });
        return;
      }

      // Update withdrawal status
      withdrawal.status = 'rejected';
      withdrawal.reviewedAt = new Date();
      withdrawal.reviewedBy = new mongoose.Types.ObjectId(adminId);
      withdrawal.rejectedAt = new Date();
      withdrawal.rejectionReason = reason;
      withdrawal.adminNotes = notes;

      await withdrawal.save();

      // Restore funds to user's wallet
      const wallet = await Wallet.findById(withdrawal.walletId);
      if (wallet) {
        const currentBalance = wallet.balances[withdrawal.token][withdrawal.network];
        wallet.updateBalance(withdrawal.network, withdrawal.token, currentBalance + withdrawal.amount);
        await wallet.save();
      }

      logger.info('Withdrawal rejected by admin', {
        withdrawalId,
        adminId,
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        network: withdrawal.network,
        reason,
        notes
      });

      securityLogger.info('Withdrawal rejection', {
        withdrawalId,
        adminId,
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        network: withdrawal.network,
        toAddress: withdrawal.toAddress.substring(0, 10) + '...',
        reason,
        ipAddress
      });

      res.json({
        success: true,
        data: {
          withdrawalId,
          status: withdrawal.status,
          rejectedAt: withdrawal.rejectedAt,
          reason: withdrawal.rejectionReason,
          message: 'Withdrawal rejected and funds restored to user account'
        }
      });

    } catch (error) {
      logger.error('Failed to reject withdrawal:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to reject withdrawal'
      });
    }
  }
);

/**
 * GET /api/admin/withdrawals/statistics
 * Get withdrawal statistics for admin dashboard
 */
router.get('/withdrawals/statistics',
  authenticate,
  authorize('admin'),
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access admin features',
        });
        return;
      }

      const [
        totalWithdrawals,
        pendingWithdrawals,
        approvedWithdrawals,
        rejectedWithdrawals,
        completedWithdrawals,
        failedWithdrawals,
        totalWithdrawnAmount,
        recentWithdrawals,
        highRiskWithdrawals,
        networkStats,
        avgProcessingTime
      ] = await Promise.all([
        Withdrawal.countDocuments(),
        Withdrawal.countDocuments({ status: 'pending' }),
        Withdrawal.countDocuments({ status: 'approved' }),
        Withdrawal.countDocuments({ status: 'rejected' }),
        Withdrawal.countDocuments({ status: 'completed' }),
        Withdrawal.countDocuments({ status: 'failed' }),
        Withdrawal.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Withdrawal.countDocuments({
          requestedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }),
        Withdrawal.countDocuments({ fraudScore: { $gte: 70 } }),
        Withdrawal.aggregate([
          {
            $group: {
              _id: '$network',
              count: { $sum: 1 },
              totalAmount: { $sum: '$amount' },
              avgAmount: { $avg: '$amount' }
            }
          }
        ]),
        Withdrawal.aggregate([
          {
            $match: {
              status: 'completed',
              requestedAt: { $exists: true },
              completedAt: { $exists: true }
            }
          },
          {
            $group: {
              _id: null,
              avgProcessingTimeMs: {
                $avg: { $subtract: ['$completedAt', '$requestedAt'] }
              }
            }
          }
        ])
      ]);

      const totalAmount = totalWithdrawnAmount[0]?.total || 0;
      const avgProcessingTimeHours = avgProcessingTime[0]?.avgProcessingTimeMs 
        ? Math.round(avgProcessingTime[0].avgProcessingTimeMs / (1000 * 60 * 60))
        : 0;

      logger.info('Admin accessed withdrawal statistics', {
        adminId: req.user.userId,
      });

      res.json({
        success: true,
        data: {
          overview: {
            totalWithdrawals,
            pendingWithdrawals,
            approvedWithdrawals,
            rejectedWithdrawals,
            completedWithdrawals,
            failedWithdrawals,
            totalWithdrawnAmount: totalAmount,
            recentWithdrawals,
            highRiskWithdrawals,
            avgProcessingTimeHours
          },
          networkBreakdown: networkStats.reduce((acc: any, stat: any) => {
            acc[stat._id] = {
              count: stat.count,
              totalAmount: stat.totalAmount,
              avgAmount: Math.round(stat.avgAmount * 100) / 100
            };
            return acc;
          }, {}),
          generatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Failed to get withdrawal statistics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get withdrawal statistics'
      });
    }
  }
);

// Helper functions

/**
 * Generate risk recommendations based on withdrawal data
 */
function generateRiskRecommendations(withdrawal: any): string[] {
  const recommendations: string[] = [];
  
  if (withdrawal.fraudScore >= 70) {
    recommendations.push('HIGH RISK: Requires thorough manual review');
    recommendations.push('Verify user identity through additional channels');
    recommendations.push('Consider requesting additional documentation');
  }
  
  if (withdrawal.fraudFlags?.includes('HIGH_FREQUENCY')) {
    recommendations.push('User has made multiple recent withdrawal requests');
  }
  
  if (withdrawal.fraudFlags?.includes('LARGE_AMOUNT')) {
    recommendations.push('Large withdrawal amount - verify source of funds');
  }
  
  if (withdrawal.fraudFlags?.includes('NEW_ADDRESS')) {
    recommendations.push('New destination address - verify ownership');
  }
  
  if (withdrawal.amount > 5000) {
    recommendations.push('Consider splitting large withdrawals into smaller amounts');
  }
  
  return recommendations;
}

/**
 * Process approved withdrawal by executing blockchain transaction
 */
async function processWithdrawal(withdrawal: any): Promise<void> {
  try {
    withdrawal.status = 'processing';
    withdrawal.processedAt = new Date();
    await withdrawal.save();

    // Here you would integrate with blockchain services to execute the withdrawal
    // This is a simplified implementation
    
    // Simulate blockchain transaction processing
    // In production, this would use Web3, TronWeb, etc. to send the actual transaction
    
    logger.info('Processing withdrawal transaction', {
      withdrawalId: withdrawal._id,
      network: withdrawal.network,
      token: withdrawal.token,
      amount: withdrawal.amount,
      toAddress: withdrawal.toAddress
    });

    // For now, we'll just mark it as completed after a delay
    // In production, you'd monitor the transaction and update status based on confirmations
    setTimeout(async () => {
      try {
        withdrawal.status = 'completed';
        withdrawal.completedAt = new Date();
        withdrawal.txHash = 'simulated_tx_hash_' + Date.now(); // Would be real tx hash
        await withdrawal.save();
        
        logger.info('Withdrawal completed', {
          withdrawalId: withdrawal._id,
          txHash: withdrawal.txHash
        });
      } catch (error) {
        logger.error('Failed to complete withdrawal:', error);
        withdrawal.status = 'failed';
        withdrawal.failedAt = new Date();
        withdrawal.errorMessage = 'Transaction execution failed';
        await withdrawal.save();
      }
    }, 5000); // 5 second delay for simulation

  } catch (error) {
    logger.error('Failed to process withdrawal:', error);
    withdrawal.status = 'failed';
    withdrawal.failedAt = new Date();
    withdrawal.errorMessage = error instanceof Error ? error.message : String(error);
    await withdrawal.save();
    throw error;
  }
}