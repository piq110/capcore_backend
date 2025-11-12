import express from 'express';
import { query, param, validationResult } from 'express-validator';
import { authenticate } from '@/middleware/auth';
import { Portfolio } from '@/models/Portfolio';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { Trade } from '@/models/Trade';
import { Order } from '@/models/Order';
import { Wallet } from '@/models/Wallet';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

const router = express.Router();

// Helper function to save portfolio with retry logic for version conflicts
const savePortfolioWithRetry = async (portfolio: any, userId: mongoose.Types.ObjectId, maxAttempts = 3): Promise<any> => {
  let saveAttempts = 0;
  
  while (saveAttempts < maxAttempts) {
    try {
      await portfolio.save();
      return portfolio; // Return the saved portfolio
    } catch (error: any) {
      saveAttempts++;
      logger.warn(`Portfolio save attempt ${saveAttempts} failed`, {
        userId: userId.toString(),
        error: error.message,
        errorName: error.name
      });
      
      if (error.name === 'VersionError' && saveAttempts < maxAttempts) {
        // Reload the document and retry
        const freshPortfolio = await Portfolio.findOne({ userId });
        if (freshPortfolio) {
          logger.info(`Reloading fresh portfolio for retry attempt ${saveAttempts + 1}`, {
            userId: userId.toString()
          });
          
          // Reapply changes to fresh document
          freshPortfolio.cleanupNaNValues();
          freshPortfolio.consolidateDuplicateHoldings();
          
          const productIds = freshPortfolio.holdings.map(h => h.productId);
          if (productIds.length > 0) {
            const products = await InvestmentProduct.find({
              _id: { $in: productIds }
            });
            const priceUpdates = products.map(product => ({
              productId: product._id as mongoose.Types.ObjectId,
              price: product.sharePrice
            }));
            freshPortfolio.updatePrices(priceUpdates);
          }
          
          const wallet = await Wallet.findOne({ userId });
          if (wallet) {
            freshPortfolio.cashBalance = wallet.getTotalBalanceUSD();
          }
          freshPortfolio.calculateTotals();
          portfolio = freshPortfolio;
        } else {
          throw new Error('Portfolio not found during retry');
        }
      } else {
        logger.error(`Portfolio save failed after ${saveAttempts} attempts`, {
          userId: userId.toString(),
          error: error.message,
          errorName: error.name
        });
        throw error; // Re-throw if not a version error or max attempts reached
      }
    }
  }
  
  throw new Error(`Failed to save portfolio after ${maxAttempts} attempts`);
};

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
 * GET /api/portfolio
 * Get user's portfolio with holdings and P&L tracking
 */
router.get('/',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to view your portfolio',
        });
        return;
      }

      if (!req.user.emailVerified) {
        res.status(403).json({
          error: 'Email verification required',
          message: 'Please verify your email address to view your portfolio',
        });
        return;
      }

      // Get or create portfolio
      let portfolio = await Portfolio.findOne({ userId: req.user.userId })
        .populate('holdings.productId', 'name symbol type sharePrice nav navDate sector');

      if (!portfolio) {
        // Create new portfolio if it doesn't exist
        portfolio = new Portfolio({
          userId: req.user.userId,
          holdings: [],
          cashBalance: 0,
        });
        await savePortfolioWithRetry(portfolio, new mongoose.Types.ObjectId(req.user.userId));
      }

      // Clean up any NaN values first, then consolidate duplicate holdings
      portfolio.cleanupNaNValues();
      portfolio.consolidateDuplicateHoldings();
      
      // Always update portfolio with current prices to ensure real-time accuracy
      const productIds = portfolio.holdings.map(h => h.productId);
      if (productIds.length > 0) {
        const products = await InvestmentProduct.find({
          _id: { $in: productIds }
        });

        const priceUpdates = products.map(product => ({
          productId: product._id as mongoose.Types.ObjectId,
          price: product.sharePrice
        }));

        portfolio.updatePrices(priceUpdates);
        logger.info(`Updated portfolio prices for ${priceUpdates.length} products`, {
          userId: req.user.userId,
          priceUpdatesCount: priceUpdates.length,
          holdingsCount: portfolio.holdings.length
        });
      }

      // Get user's wallet balance for cash balance
      const wallet = await Wallet.findOne({ userId: req.user.userId });
      if (wallet) {
        portfolio.cashBalance = wallet.getTotalBalanceUSD();
      }
      
      portfolio.calculateTotals();
      
      // Save with retry logic for version conflicts
      portfolio = await savePortfolioWithRetry(portfolio, new mongoose.Types.ObjectId(req.user.userId));

      if (!portfolio) {
        res.status(500).json({
          success: false,
          message: 'Failed to save portfolio'
        });
        return;
      }

      logger.info('User accessed portfolio', {
        userId: req.user.userId,
        totalValue: portfolio.totalValue,
        holdingsCount: portfolio.holdings.length,
      });

      res.json({
        success: true,
        data: {
          portfolio: {
            id: portfolio._id,
            userId: portfolio.userId,
            totalValue: portfolio.totalValue,
            totalInvested: portfolio.totalInvested,
            totalPnL: portfolio.totalPnL,
            totalPnLPercentage: portfolio.totalInvested > 0 ? (portfolio.totalPnL / portfolio.totalInvested) * 100 : 0,
            totalRealizedPnL: portfolio.totalRealizedPnL,
            totalUnrealizedPnL: portfolio.totalUnrealizedPnL,
            dayChange: 0, // TODO: Calculate daily change
            dayChangePercentage: 0, // TODO: Calculate daily change percentage
            cashBalance: portfolio.cashBalance,
            updatedAt: portfolio.lastUpdated.toISOString(),
            holdings: portfolio.holdings.map((holding, index) => ({
              id: `${holding.productId}-${index}`, // Add unique ID for frontend
              product: (holding as any).productId, // This includes current sharePrice from populate
              quantity: holding.quantity,
              averageCost: holding.averageCost, // Purchase price
              totalCost: holding.totalCost, // Total invested (quantity × averageCost)
              // Let frontend calculate these dynamically:
              currentPrice: (holding as any).productId?.sharePrice || holding.currentPrice,
              currentValue: 0, // Frontend will calculate
              unrealizedPnL: 0, // Frontend will calculate  
              unrealizedPnLPercentage: 0, // Frontend will calculate
              totalInvested: holding.totalCost,
              lastUpdated: holding.lastUpdated.toISOString(),
            })),
            assetAllocation: portfolio.getAssetAllocation(),
            sectorAllocation: portfolio.getSectorAllocation(),
            performance: {
              totalReturn: portfolio.totalInvested > 0 ? (portfolio.totalPnL / portfolio.totalInvested) * 100 : 0,
              unrealizedReturn: portfolio.totalInvested > 0 ? (portfolio.totalUnrealizedPnL / portfolio.totalInvested) * 100 : 0,
              realizedReturn: portfolio.totalInvested > 0 ? (portfolio.totalRealizedPnL / portfolio.totalInvested) * 100 : 0,
            }
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get portfolio:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load portfolio'
      });
    }
  }
);

/**
 * GET /api/portfolio/performance
 * Get detailed portfolio performance analytics
 */
router.get('/performance',
  authenticate,
  [
    query('period')
      .optional()
      .isIn(['1D', '1W', '1M', '3M', '6M', '1Y', 'ALL', '1d', '7d', '30d', '90d', '1y', 'all'])
      .withMessage('Invalid period'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to view portfolio performance',
        });
        return;
      }

      const period = req.query.period as string || '30d';

      // Calculate date range
      const now = new Date();
      let startDate: Date;
      
      switch (period) {
        case '1D':
        case '1d':
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '1W':
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '1M':
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '3M':
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        case '6M':
          startDate = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
          break;
        case '1Y':
        case '1y':
          startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
        case 'ALL':
        case 'all':
        default:
          startDate = new Date(0); // All time
      }

      let portfolio = await Portfolio.findOne({ userId: req.user.userId });
      if (!portfolio) {
        res.status(404).json({
          success: false,
          message: 'Portfolio not found'
        });
        return;
      }

      // Clean up any NaN values first, then consolidate duplicate holdings
      portfolio.cleanupNaNValues();
      portfolio.consolidateDuplicateHoldings();
      
      // Always ensure portfolio has current prices before calculating performance
      const productIds = portfolio.holdings.map(h => h.productId);
      if (productIds.length > 0) {
        const products = await InvestmentProduct.find({
          _id: { $in: productIds }
        });

        const priceUpdates = products.map(product => ({
          productId: product._id as mongoose.Types.ObjectId,
          price: product.sharePrice
        }));

        portfolio.updatePrices(priceUpdates);
        await savePortfolioWithRetry(portfolio, new mongoose.Types.ObjectId(req.user.userId));
        logger.info(`Updated portfolio performance prices for ${priceUpdates.length} products`, {
          userId: req.user.userId,
          priceUpdatesCount: priceUpdates.length,
          holdingsCount: portfolio.holdings.length
        });
      }

      // Get trades in the period for performance calculation
      const trades = await Trade.find({
        $or: [
          { buyerId: req.user.userId },
          { sellerId: req.user.userId }
        ],
        status: 'settled',
        executedAt: { $gte: startDate }
      })
      .populate('productId', 'name symbol type')
      .sort({ executedAt: 1 });

      // Calculate performance metrics
      let totalInvested = 0;
      let totalRealized = 0;
      const performanceData: any[] = [];

      trades.forEach(trade => {
        const isBuyer = trade.buyerId.toString() === req.user!.userId;
        const amount = isBuyer ? trade.totalAmount + trade.buyerFees : trade.totalAmount - trade.sellerFees;
        
        if (isBuyer) {
          totalInvested += amount;
        } else {
          totalRealized += amount;
        }

        performanceData.push({
          date: trade.executedAt,
          type: isBuyer ? 'buy' : 'sell',
          product: (trade as any).productId,
          quantity: trade.quantity,
          price: trade.pricePerShare,
          amount: amount,
          cumulativeInvested: totalInvested,
          cumulativeRealized: totalRealized,
        });
      });

      // If no trades in the period, create sample data points for the chart
      if (performanceData.length === 0 && portfolio.totalValue > 0) {
        const dataPoints = period === '1D' ? 24 : period === '1W' ? 7 : period === '1M' ? 30 : 10;
        const timeInterval = (now.getTime() - startDate.getTime()) / dataPoints;
        
        for (let i = 0; i <= dataPoints; i++) {
          const date = new Date(startDate.getTime() + (i * timeInterval));
          performanceData.push({
            date: date,
            type: 'snapshot',
            cumulativeInvested: portfolio.totalInvested,
            cumulativeRealized: portfolio.totalValue,
          });
        }
      }

      logger.info('User accessed portfolio performance', {
        userId: req.user.userId,
        period,
        tradesCount: trades.length,
      });

      res.json({
        success: true,
        data: {
          period,
          startDate,
          endDate: now,
          summary: {
            totalInvested: portfolio.totalInvested,
            totalValue: portfolio.totalValue,
            totalPnL: portfolio.totalPnL,
            totalReturn: portfolio.totalInvested > 0 ? (portfolio.totalPnL / portfolio.totalInvested) * 100 : 0,
            realizedPnL: portfolio.totalRealizedPnL,
            unrealizedPnL: portfolio.totalUnrealizedPnL,
          },
          periodData: {
            tradesCount: trades.length,
            periodInvested: totalInvested,
            periodRealized: totalRealized,
            periodPnL: totalRealized - totalInvested,
          },
          performanceHistory: performanceData,
          holdings: portfolio.holdings.map(holding => ({
            productId: holding.productId,
            quantity: holding.quantity,
            averageCost: holding.averageCost,
            currentValue: holding.currentValue,
            unrealizedPnL: holding.unrealizedPnL,
            pnlPercentage: holding.totalCost > 0 ? (holding.unrealizedPnL / holding.totalCost) * 100 : 0,
          }))
        }
      });

    } catch (error) {
      logger.error('Failed to get portfolio performance:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load portfolio performance'
      });
    }
  }
);

/**
 * GET /api/portfolio/holdings/:productId
 * Get detailed information about a specific holding
 */
router.get('/holdings/:productId',
  authenticate,
  [
    param('productId').isMongoId().withMessage('Invalid product ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to view holding details',
        });
        return;
      }

      const productId = req.params.productId;

      const portfolio = await Portfolio.findOne({ userId: req.user.userId });
      if (!portfolio) {
        res.status(404).json({
          success: false,
          message: 'Portfolio not found'
        });
        return;
      }

      const holding = portfolio.getHolding(new mongoose.Types.ObjectId(productId));
      if (!holding) {
        res.status(404).json({
          success: false,
          message: 'Holding not found in portfolio'
        });
        return;
      }

      // Get product details
      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      // Get trade history for this holding
      const trades = await Trade.find({
        $or: [
          { buyerId: req.user.userId },
          { sellerId: req.user.userId }
        ],
        productId,
        status: 'settled'
      })
      .sort({ executedAt: -1 })
      .limit(50);

      logger.info('User accessed holding details', {
        userId: req.user.userId,
        productId,
        productName: product.name,
        quantity: holding.quantity,
        currentValue: holding.currentValue,
      });

      res.json({
        success: true,
        data: {
          holding: {
            product: {
              id: product._id,
              name: product.name,
              symbol: product.symbol,
              type: product.type,
              currentPrice: product.sharePrice,
              nav: product.nav,
              navDate: product.navDate,
            },
            quantity: holding.quantity,
            averageCost: holding.averageCost,
            totalCost: holding.totalCost,
            currentPrice: holding.currentPrice,
            currentValue: holding.currentValue,
            unrealizedPnL: holding.unrealizedPnL,
            realizedPnL: holding.realizedPnL,
            totalPnL: holding.unrealizedPnL + holding.realizedPnL,
            pnlPercentage: holding.totalCost > 0 ? (holding.unrealizedPnL / holding.totalCost) * 100 : 0,
            lastUpdated: holding.lastUpdated,
            // Portfolio allocation
            portfolioPercentage: portfolio.totalValue > 0 ? (holding.currentValue / portfolio.totalValue) * 100 : 0,
          },
          tradeHistory: trades.map(trade => ({
            id: trade._id,
            type: trade.buyerId.toString() === req.user!.userId ? 'buy' : 'sell',
            quantity: trade.quantity,
            price: trade.pricePerShare,
            totalAmount: trade.totalAmount,
            fees: trade.buyerId.toString() === req.user!.userId ? trade.buyerFees : trade.sellerFees,
            executedAt: trade.executedAt,
            settledAt: trade.settledAt,
          }))
        }
      });

    } catch (error) {
      logger.error('Failed to get holding details:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load holding details'
      });
    }
  }
);

/**
 * GET /api/portfolio/transactions
 * Get user's transaction history with filtering and pagination
 */
router.get('/transactions',
  authenticate,
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
      .isIn(['buy', 'sell', 'deposit', 'withdrawal', 'fee', 'dividend'])
      .withMessage('Invalid transaction type'),
    query('status')
      .optional()
      .isIn(['pending', 'completed', 'failed', 'cancelled', 'filled', 'partially_filled', 'rejected'])
      .withMessage('Invalid status'),
    query('productId')
      .optional()
      .isMongoId()
      .withMessage('Invalid product ID'),
    query('dateFrom')
      .optional()
      .isISO8601()
      .withMessage('Invalid start date'),
    query('dateTo')
      .optional()
      .isISO8601()
      .withMessage('Invalid end date'),
    query('minAmount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Minimum amount must be non-negative'),
    query('maxAmount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Maximum amount must be non-negative'),
    query('sortBy')
      .optional()
      .isIn(['executedAt', 'amount', 'type', 'status', 'createdAt', 'filledAt'])
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
          message: 'Please log in to view transactions',
        });
        return;
      }

      const {
        limit = 25,
        offset = 0,
        type,
        status,
        productId,
        dateFrom,
        dateTo,
        minAmount,
        maxAmount,
        sortBy = 'executedAt',
        sortOrder = 'desc'
      } = req.query;

      // Build date filter
      const dateFilter: any = {};
      if (dateFrom) dateFilter.$gte = new Date(dateFrom as string);
      if (dateTo) dateFilter.$lte = new Date(dateTo as string);

      // Build amount filter
      const amountFilter: any = {};
      if (minAmount) amountFilter.$gte = parseFloat(minAmount as string);
      if (maxAmount) amountFilter.$lte = parseFloat(maxAmount as string);

      // Build trade filter for buy/sell transactions
      const tradeFilter: any = {
        $or: [
          { buyerId: req.user.userId },
          { sellerId: req.user.userId }
        ],
        status: 'settled'
      };

      if (productId) tradeFilter.productId = productId;
      if (Object.keys(dateFilter).length > 0) tradeFilter.executedAt = dateFilter;
      if (Object.keys(amountFilter).length > 0) tradeFilter.totalAmount = amountFilter;

      // Build order filter for completed orders
      const orderFilter: any = {
        userId: req.user.userId,
        status: { $in: ['filled', 'partially_filled'] }
      };

      if (productId) orderFilter.productId = productId;
      if (Object.keys(dateFilter).length > 0) orderFilter.filledAt = dateFilter;
      if (Object.keys(amountFilter).length > 0) orderFilter.totalAmount = amountFilter;

      // Get completed orders
      let orders: any[] = [];
      if (!type || type === 'buy' || type === 'sell') {
        const orderResults = await Order.find(orderFilter)
          .populate('productId', 'name symbol type')
          .populate('userId', 'email')
          .sort({ [sortBy === 'executedAt' ? 'filledAt' : sortBy as string]: sortOrder === 'asc' ? 1 : -1 })
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean();

        orders = orderResults.map(order => {
          // Filter by type if specified
          if (type && type !== order.type) return null;

          return {
            id: order._id,
            type: order.type,
            product: (order as any).productId,
            quantity: order.quantity,
            pricePerShare: order.averageFillPrice || order.pricePerShare,
            amount: order.totalAmount,
            fees: order.fees || 0,
            status: order.status === 'filled' ? 'completed' : 'partially_filled',
            description: `${order.type.charAt(0).toUpperCase() + order.type.slice(1)} ${order.quantity} shares of ${(order as any).productId?.name || 'Unknown'}`,
            executedAt: order.filledAt || order.createdAt,
            settledAt: order.filledAt,
            orderId: order._id,
            filledQuantity: order.filledQuantity,
            remainingQuantity: order.remainingQuantity,
          };
        }).filter(Boolean);
      }

      // Get trades for additional context (if needed)
      let trades: any[] = [];
      if (!type || type === 'buy' || type === 'sell') {
        const tradeResults = await Trade.find(tradeFilter)
          .populate('productId', 'name symbol type')
          .populate('buyerId', 'email')
          .populate('sellerId', 'email')
          .sort({ [sortBy as string]: sortOrder === 'asc' ? 1 : -1 })
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean();

        trades = tradeResults.map(trade => {
          const isBuyer = trade.buyerId.toString() === req.user!.userId;
          const transactionType = isBuyer ? 'buy' : 'sell';
          
          // Filter by type if specified
          if (type && type !== transactionType) return null;

          return {
            id: `trade-${trade._id}`,
            type: transactionType,
            product: (trade as any).productId,
            quantity: trade.quantity,
            pricePerShare: trade.pricePerShare,
            amount: trade.totalAmount,
            fees: isBuyer ? trade.buyerFees : trade.sellerFees,
            status: 'completed',
            description: `${transactionType.charAt(0).toUpperCase() + transactionType.slice(1)} ${trade.quantity} shares of ${(trade as any).productId?.name || 'Unknown'} (Trade)`,
            executedAt: trade.executedAt,
            settledAt: trade.settledAt,
            orderId: isBuyer ? trade.buyOrderId : trade.sellOrderId,
            tradeId: trade._id,
          };
        }).filter(Boolean);
      }

      // Combine orders and trades, prioritizing orders
      const allTransactions = [...orders, ...trades]
        .sort((a, b) => {
          const dateA = new Date(a.executedAt).getTime();
          const dateB = new Date(b.executedAt).getTime();
          return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        })
        .slice(0, parseInt(limit as string));

      // Calculate summary
      const summary = {
        totalTransactions: allTransactions.length,
        totalVolume: allTransactions.reduce((sum, tx) => sum + tx.amount, 0),
        totalFees: allTransactions.reduce((sum, tx) => sum + tx.fees, 0),
        completedTransactions: allTransactions.filter(tx => tx.status === 'completed').length,
        pendingTransactions: allTransactions.filter(tx => tx.status === 'pending').length,
      };

      logger.info('User accessed transaction history', {
        userId: req.user.userId,
        filters: { type, status, productId, dateFrom, dateTo },
        resultCount: allTransactions.length,
      });

      res.json({
        success: true,
        data: {
          transactions: allTransactions,
          pagination: {
            total: allTransactions.length, // This is simplified - in production you'd want proper pagination
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: false, // Simplified for now
          },
          summary
        }
      });

    } catch (error) {
      logger.error('Failed to get transaction history:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load transaction history'
      });
    }
  }
);

/**
 * POST /api/portfolio/cleanup
 * Clean up NaN values and fix portfolio data
 */
router.post('/cleanup',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to cleanup portfolio',
        });
        return;
      }

      const portfolio = await Portfolio.findOne({ userId: req.user.userId });
      if (!portfolio) {
        res.status(404).json({
          success: false,
          message: 'Portfolio not found'
        });
        return;
      }

      // Clean up NaN values
      portfolio.cleanupNaNValues();
      
      // Recalculate totals and save
      portfolio.calculateTotals();
      await savePortfolioWithRetry(portfolio, new mongoose.Types.ObjectId(req.user.userId));

      logger.info('Portfolio cleaned up', {
        userId: req.user.userId,
        holdingsCount: portfolio.holdings.length,
        totalValue: portfolio.totalValue,
      });

      res.json({
        success: true,
        message: 'Portfolio cleaned up successfully',
        data: {
          totalValue: portfolio.totalValue,
          totalPnL: portfolio.totalPnL,
          holdingsCount: portfolio.holdings.length,
          lastUpdated: portfolio.lastUpdated,
        }
      });

    } catch (error) {
      logger.error('Failed to cleanup portfolio:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to cleanup portfolio'
      });
    }
  }
);

/**
 * POST /api/portfolio/consolidate
 * Consolidate duplicate holdings and refresh prices
 */
router.post('/consolidate',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to consolidate portfolio',
        });
        return;
      }

      const portfolio = await Portfolio.findOne({ userId: req.user.userId });
      if (!portfolio) {
        res.status(404).json({
          success: false,
          message: 'Portfolio not found'
        });
        return;
      }

      const holdingsBeforeConsolidation = portfolio.holdings.length;
      
      // Consolidate duplicate holdings
      portfolio.consolidateDuplicateHoldings();
      
      const holdingsAfterConsolidation = portfolio.holdings.length;

      // Get current prices for all holdings
      const productIds = portfolio.holdings.map(h => h.productId);
      const products = await InvestmentProduct.find({
        _id: { $in: productIds }
      });

      // Update prices
      const priceUpdates = products.map(product => ({
        productId: product._id as mongoose.Types.ObjectId,
        price: product.sharePrice
      }));

      portfolio.updatePrices(priceUpdates);

      // Update cash balance from wallet
      const wallet = await Wallet.findOne({ userId: req.user.userId });
      if (wallet) {
        portfolio.cashBalance = wallet.getTotalBalanceUSD();
      }

      // Recalculate totals and save
      portfolio.calculateTotals();
      await savePortfolioWithRetry(portfolio, new mongoose.Types.ObjectId(req.user.userId));

      logger.info('Portfolio consolidated and refreshed', {
        userId: req.user.userId,
        holdingsBeforeConsolidation,
        holdingsAfterConsolidation,
        duplicatesRemoved: holdingsBeforeConsolidation - holdingsAfterConsolidation,
        totalValue: portfolio.totalValue,
        priceUpdatesCount: priceUpdates.length,
      });

      res.json({
        success: true,
        message: 'Portfolio consolidated and refreshed successfully',
        data: {
          holdingsBeforeConsolidation,
          holdingsAfterConsolidation,
          duplicatesRemoved: holdingsBeforeConsolidation - holdingsAfterConsolidation,
          totalValue: portfolio.totalValue,
          totalPnL: portfolio.totalPnL,
          lastUpdated: portfolio.lastUpdated,
          priceUpdatesApplied: priceUpdates.length,
        }
      });

    } catch (error) {
      logger.error('Failed to consolidate portfolio:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to consolidate portfolio'
      });
    }
  }
);

/**
 * POST /api/portfolio/refresh
 * Refresh portfolio with latest prices and recalculate P&L
 */
router.post('/refresh',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to refresh portfolio',
        });
        return;
      }

      const portfolio = await Portfolio.findOne({ userId: req.user.userId });
      if (!portfolio) {
        res.status(404).json({
          success: false,
          message: 'Portfolio not found'
        });
        return;
      }

      // Clean up any NaN values first, then consolidate duplicate holdings
      portfolio.cleanupNaNValues();
      portfolio.consolidateDuplicateHoldings();
      
      // Get current prices for all holdings
      const productIds = portfolio.holdings.map(h => h.productId);
      const products = await InvestmentProduct.find({
        _id: { $in: productIds }
      });

      // Update prices
      const priceUpdates = products.map(product => ({
        productId: product._id as mongoose.Types.ObjectId,
        price: product.sharePrice
      }));

      portfolio.updatePrices(priceUpdates);

      // Update cash balance from wallet
      const wallet = await Wallet.findOne({ userId: req.user.userId });
      if (wallet) {
        portfolio.cashBalance = wallet.getTotalBalanceUSD();
      }

      // Recalculate totals and save
      portfolio.calculateTotals();
      await savePortfolioWithRetry(portfolio, new mongoose.Types.ObjectId(req.user.userId));

      logger.info('Portfolio refreshed', {
        userId: req.user.userId,
        holdingsCount: portfolio.holdings.length,
        totalValue: portfolio.totalValue,
        priceUpdatesCount: priceUpdates.length,
      });

      res.json({
        success: true,
        message: 'Portfolio refreshed successfully',
        data: {
          totalValue: portfolio.totalValue,
          totalPnL: portfolio.totalPnL,
          lastUpdated: portfolio.lastUpdated,
          priceUpdatesApplied: priceUpdates.length,
        }
      });

    } catch (error) {
      logger.error('Failed to refresh portfolio:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to refresh portfolio'
      });
    }
  }
);

export default router;