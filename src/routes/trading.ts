import express from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { authenticate, authorize } from '@/middleware/auth';
import { requireKYCForTrading, checkKYCForInvestmentAccess } from '@/middleware/kycMiddleware';
import { Order } from '@/models/Order';
import { Trade } from '@/models/Trade';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { Wallet } from '@/models/Wallet';
import { User } from '@/models/User';
import { tradingService } from '@/services/TradingService';
import { logger } from '@/utils/logger';
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
 * GET /api/trading/investments
 * Browse available investments (allows browsing without KYC)
 */
router.get('/investments',
  checkKYCForInvestmentAccess,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      // This endpoint allows browsing without KYC but adds headers for frontend
      // to show appropriate UI based on KYC status
      
      logger.info('Investment browsing accessed', {
        userId: req.user?.userId || 'anonymous',
        kycStatus: req.user?.kycStatus || 'not_authenticated',
        authenticated: !!req.user,
      });

      // Mock investment data for demonstration
      const investments = [
        {
          id: '1',
          name: 'Premium REIT Fund',
          type: 'REIT',
          sharePrice: 25.50,
          availableShares: 10000,
          description: 'Diversified real estate investment trust',
          minimumInvestment: 1000,
          accreditedOnly: false,
        },
        {
          id: '2',
          name: 'Growth BDC Portfolio',
          type: 'BDC',
          sharePrice: 15.75,
          availableShares: 5000,
          description: 'Business development company focused on growth',
          minimumInvestment: 5000,
          accreditedOnly: true,
        },
      ];

      // Filter investments based on accredited investor status
      let filteredInvestments = investments;
      if (req.user && !req.user.accreditedInvestor) {
        filteredInvestments = investments.filter(inv => !inv.accreditedOnly);
      }

      res.json({
        investments: filteredInvestments,
        userAccess: {
          canTrade: req.user ? res.locals.kycStatus === 'approved' : false,
          kycRequired: req.user ? res.locals.kycRequired : true,
          kycStatus: req.user ? res.locals.kycStatus : 'not_authenticated',
          accreditedInvestor: req.user?.accreditedInvestor || false,
        },
        totalCount: filteredInvestments.length,
      });

    } catch (error) {
      logger.error('Failed to get investments:', error);
      res.status(500).json({
        error: 'Failed to load investments',
        message: 'An error occurred while loading investment opportunities',
      });
    }
  }
);

/**
 * POST /api/trading/orders
 * Place a trading order (requires KYC approval)
 */
router.post('/orders',
  authenticate,
  requireKYCForTrading,
  [
    body('productId')
      .isMongoId()
      .withMessage('Valid product ID is required'),
    body('type')
      .isIn(['buy', 'sell'])
      .withMessage('Order type must be either buy or sell'),
    body('orderType')
      .optional()
      .isIn(['market', 'limit'])
      .withMessage('Order type must be market or limit'),
    body('quantity')
      .isInt({ min: 1 })
      .withMessage('Quantity must be a positive integer'),
    body('pricePerShare')
      .isFloat({ min: 0.01 })
      .withMessage('Price per share must be at least $0.01'),
    body('expiresAt')
      .optional()
      .isISO8601()
      .withMessage('Expiration date must be a valid ISO date'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to place orders',
        });
        return;
      }

      const { productId, type, orderType = 'limit', quantity, pricePerShare, expiresAt } = req.body;
      const userId = req.user.userId;

      // Validate product exists and is available for trading
      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          error: 'Product not found',
          message: 'The investment product could not be found'
        });
        return;
      }

      if (!product.isAvailableForTrading()) {
        res.status(400).json({
          error: 'Product not available',
          message: 'This investment product is not currently available for trading'
        });
        return;
      }

      // Check minimum investment requirement for buy orders
      const totalAmount = quantity * pricePerShare;
      if (type === 'buy' && totalAmount < product.minimumInvestment) {
        res.status(400).json({
          error: 'Minimum investment not met',
          message: `Minimum investment for this product is $${product.minimumInvestment}`
        });
        return;
      }

      // For buy orders, check if user has sufficient balance
      if (type === 'buy') {
        const wallet = await Wallet.findOne({ userId });
        if (!wallet) {
          res.status(400).json({
            error: 'Wallet not found',
            message: 'User wallet not found'
          });
          return;
        }

        const totalBalance = wallet.getTotalBalanceUSD();
        if (totalBalance < totalAmount) {
          res.status(400).json({
            error: 'Insufficient balance',
            message: `Insufficient funds. Required: $${totalAmount.toFixed(2)}, Available: $${totalBalance.toFixed(2)}`
          });
          return;
        }
      }

      // For sell orders, check if user has sufficient shares
      if (type === 'sell') {
        // This would require portfolio tracking - for now we'll allow it
        // In a real implementation, we'd check the user's portfolio holdings
      }

      // Check for accredited investor requirements
      if (product.type === 'BDC') {
        const user = await User.findById(userId);
        if (!user?.accreditedInvestor) {
          res.status(403).json({
            error: 'Accredited investor required',
            message: 'This investment requires accredited investor status'
          });
          return;
        }
      }

      // Create the order
      const order = new Order({
        userId,
        productId,
        type,
        orderType,
        quantity,
        pricePerShare,
        totalAmount,
        remainingQuantity: quantity,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      await order.save();

      // For buy orders, reserve funds in wallet
      if (type === 'buy') {
        const wallet = await Wallet.findOne({ userId });
        if (wallet) {
          // In a real implementation, we'd reserve the funds
          // For now, we'll just log it
          logger.info('Funds reserved for buy order', {
            userId,
            orderId: order._id,
            amount: totalAmount
          });
        }
      }

      logger.info('Trading order placed', {
        userId,
        orderId: order._id,
        productId,
        productName: product.name,
        type,
        orderType,
        quantity,
        pricePerShare,
        totalAmount,
      });

      res.status(201).json({
        success: true,
        message: 'Order placed successfully',
        data: {
          order: {
            id: order._id,
            productId: order.productId,
            productName: product.name,
            productSymbol: product.symbol,
            type: order.type,
            orderType: order.orderType,
            quantity: order.quantity,
            pricePerShare: order.pricePerShare,
            totalAmount: order.totalAmount,
            status: order.status,
            filledQuantity: order.filledQuantity,
            remainingQuantity: order.remainingQuantity,
            expiresAt: order.expiresAt,
            createdAt: order.createdAt,
          }
        }
      });

    } catch (error) {
      logger.error('Failed to place order:', error);
      res.status(500).json({
        error: 'Failed to place order',
        message: 'An error occurred while placing your order',
      });
    }
  }
);

/**
 * GET /api/trading/orders
 * Get user's trading orders (requires authentication and email verification)
 */
router.get('/orders',
  authenticate,
  [
    query('status')
      .optional()
      .isIn(['pending', 'filled', 'partially_filled', 'cancelled', 'rejected'])
      .withMessage('Invalid status'),
    query('type')
      .optional()
      .isIn(['buy', 'sell'])
      .withMessage('Type must be buy or sell'),
    query('productId')
      .optional()
      .isMongoId()
      .withMessage('Invalid product ID'),
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
      .isIn(['createdAt', 'pricePerShare', 'totalAmount', 'status'])
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
          message: 'Please log in to view your orders',
        });
        return;
      }

      if (!req.user.emailVerified) {
        res.status(403).json({
          error: 'Email verification required',
          message: 'Please verify your email address to view your orders',
        });
        return;
      }

      const {
        status,
        type,
        productId,
        limit = 20,
        offset = 0,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter
      const filter: any = { userId: req.user.userId };
      if (status) filter.status = status;
      if (type) filter.type = type;
      if (productId) filter.productId = productId;

      // Build sort
      const sort: any = {};
      sort[sortBy as string] = sortOrder === 'asc' ? 1 : -1;

      const [orders, total] = await Promise.all([
        Order.find(filter)
          .populate('productId', 'name symbol type sharePrice')
          .sort(sort)
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean(),
        Order.countDocuments(filter)
      ]);

      logger.info('User accessed order history', {
        userId: req.user.userId,
        kycStatus: req.user.kycStatus,
        filters: { status, type, productId },
        resultCount: orders.length,
        total
      });

      res.json({
        success: true,
        data: {
          orders: orders.map(order => ({
            id: order._id,
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
            pendingOrders: await Order.countDocuments({ userId: req.user.userId, status: 'pending' }),
            filledOrders: await Order.countDocuments({ userId: req.user.userId, status: 'filled' }),
            cancelledOrders: await Order.countDocuments({ userId: req.user.userId, status: 'cancelled' }),
          }
        },
        userAccess: {
          canTrade: req.user.kycStatus === 'approved',
          kycStatus: req.user.kycStatus,
          kycRequired: req.user.kycStatus !== 'approved',
        },
      });

    } catch (error) {
      logger.error('Failed to get orders:', error);
      res.status(500).json({
        error: 'Failed to load orders',
        message: 'An error occurred while loading your orders',
      });
    }
  }
);

/**
 * GET /api/trading/orders/:id
 * Get detailed order information
 */
router.get('/orders/:id',
  authenticate,
  [
    param('id').isMongoId().withMessage('Invalid order ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to view order details',
        });
        return;
      }

      const orderId = req.params.id;

      const order = await Order.findOne({ _id: orderId, userId: req.user.userId })
        .populate('productId', 'name symbol type sharePrice description');

      if (!order) {
        res.status(404).json({
          success: false,
          message: 'Order not found'
        });
        return;
      }

      logger.info('User accessed order details', {
        userId: req.user.userId,
        orderId,
        orderStatus: order.status
      });

      res.json({
        success: true,
        data: {
          order: {
            id: order._id,
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
            // Calculated fields
            remainingValue: order.getRemainingValue(),
            filledValue: order.getFilledValue(),
            canBeCancelled: order.canBeCancelled(),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get order details:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load order details'
      });
    }
  }
);

/**
 * PUT /api/trading/orders/:id/cancel
 * Cancel a pending order
 */
router.put('/orders/:id/cancel',
  authenticate,
  [
    param('id').isMongoId().withMessage('Invalid order ID'),
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
          message: 'Please log in to cancel orders',
        });
        return;
      }

      const orderId = req.params.id;
      const { reason } = req.body;

      const order = await Order.findOne({ _id: orderId, userId: req.user.userId });

      if (!order) {
        res.status(404).json({
          success: false,
          message: 'Order not found'
        });
        return;
      }

      if (!order.canBeCancelled()) {
        res.status(400).json({
          success: false,
          message: 'Order cannot be cancelled in current status',
          currentStatus: order.status
        });
        return;
      }

      // Cancel the order
      order.cancel(reason);
      await order.save();

      // If it was a buy order, release reserved funds
      if (order.type === 'buy') {
        logger.info('Funds released for cancelled buy order', {
          userId: req.user.userId,
          orderId,
          amount: order.getRemainingValue()
        });
      }

      logger.info('Order cancelled by user', {
        userId: req.user.userId,
        orderId,
        orderType: order.type,
        reason
      });

      res.json({
        success: true,
        message: 'Order cancelled successfully',
        data: {
          orderId,
          status: order.status,
          cancelledAt: order.cancelledAt,
          reason: order.rejectionReason
        }
      });

    } catch (error) {
      logger.error('Failed to cancel order:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to cancel order'
      });
    }
  }
);

/**
 * GET /api/trading/orderbook/:productId
 * Get order book for a specific product
 */
router.get('/orderbook/:productId',
  [
    param('productId').isMongoId().withMessage('Invalid product ID'),
    query('depth')
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage('Depth must be between 1 and 50'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const productId = req.params.productId;
      const depth = parseInt(req.query.depth as string) || 10;

      // Verify product exists
      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      const orderBook = await tradingService.getOrderBook(productId, depth);

      logger.info('Order book accessed', {
        userId: req.user?.userId || 'anonymous',
        productId,
        productName: product.name,
        depth
      });

      res.json({
        success: true,
        data: {
          productId,
          productName: product.name,
          productSymbol: product.symbol,
          orderBook,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Failed to get order book:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load order book'
      });
    }
  }
);

/**
 * GET /api/trading/trades/:productId
 * Get recent trades for a specific product
 */
router.get('/trades/:productId',
  [
    param('productId').isMongoId().withMessage('Invalid product ID'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const productId = req.params.productId;
      const limit = parseInt(req.query.limit as string) || 50;

      // Verify product exists
      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      const recentTrades = await tradingService.getRecentTrades(productId, limit);

      logger.info('Recent trades accessed', {
        userId: req.user?.userId || 'anonymous',
        productId,
        productName: product.name,
        limit,
        resultCount: recentTrades.length
      });

      res.json({
        success: true,
        data: {
          productId,
          productName: product.name,
          productSymbol: product.symbol,
          trades: recentTrades,
          count: recentTrades.length,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Failed to get recent trades:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load recent trades'
      });
    }
  }
);

/**
 * POST /api/trading/match/:productId
 * Manually trigger order matching for a product (admin only)
 */
router.post('/match/:productId',
  authenticate,
  authorize('admin'),
  [
    param('productId').isMongoId().withMessage('Invalid product ID'),
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

      const productId = req.params.productId;

      // Verify product exists
      const product = await InvestmentProduct.findById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      // Process matches
      const results = await tradingService.processMatches(productId);

      const successfulTrades = results.filter(r => r.success);
      const failedTrades = results.filter(r => !r.success);

      logger.info('Manual order matching triggered', {
        adminId: req.user.userId,
        productId,
        productName: product.name,
        totalMatches: results.length,
        successfulTrades: successfulTrades.length,
        failedTrades: failedTrades.length
      });

      res.json({
        success: true,
        message: `Order matching completed for ${product.name}`,
        data: {
          productId,
          productName: product.name,
          summary: {
            totalMatches: results.length,
            successfulTrades: successfulTrades.length,
            failedTrades: failedTrades.length,
          },
          trades: successfulTrades.map(r => ({
            tradeId: r.trade._id,
            quantity: r.trade.quantity,
            price: r.trade.pricePerShare,
            totalAmount: r.trade.totalAmount,
            executedAt: r.trade.executedAt
          })),
          errors: failedTrades.map(r => r.error)
        }
      });

    } catch (error) {
      logger.error('Failed to process order matching:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to process order matching'
      });
    }
  }
);

/**
 * GET /api/trading/user/trades
 * Get user's trade history
 */
router.get('/user/trades',
  authenticate,
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be non-negative'),
    query('status')
      .optional()
      .isIn(['pending', 'settled', 'failed'])
      .withMessage('Invalid status'),
    query('productId')
      .optional()
      .isMongoId()
      .withMessage('Invalid product ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to view your trades',
        });
        return;
      }

      const {
        limit = 20,
        offset = 0,
        status,
        productId
      } = req.query;

      // Build filter
      const filter: any = {
        $or: [
          { buyerId: req.user.userId },
          { sellerId: req.user.userId }
        ]
      };
      
      if (status) filter.status = status;
      if (productId) filter.productId = productId;

      const [trades, total] = await Promise.all([
        Trade.find(filter)
          .populate('productId', 'name symbol type')
          .populate('buyerId', 'email')
          .populate('sellerId', 'email')
          .sort({ executedAt: -1 })
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean(),
        Trade.countDocuments(filter)
      ]);

      logger.info('User accessed trade history', {
        userId: req.user.userId,
        filters: { status, productId },
        resultCount: trades.length,
        total
      });

      res.json({
        success: true,
        data: {
          trades: trades.map(trade => ({
            id: trade._id,
            product: (trade as any).productId,
            side: trade.buyerId.toString() === req.user!.userId ? 'buy' : 'sell',
            quantity: trade.quantity,
            pricePerShare: trade.pricePerShare,
            totalAmount: trade.totalAmount,
            fees: trade.buyerId.toString() === req.user!.userId ? trade.buyerFees : trade.sellerFees,
            status: trade.status,
            executedAt: trade.executedAt,
            settledAt: trade.settledAt,
            failedAt: trade.failedAt,
            failureReason: trade.failureReason,
          })),
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < total,
          },
          summary: {
            totalTrades: total,
            settledTrades: await Trade.countDocuments({ 
              ...filter, 
              status: 'settled' 
            }),
            pendingTrades: await Trade.countDocuments({ 
              ...filter, 
              status: 'pending' 
            }),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get user trades:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load trade history'
      });
    }
  }
);

export default router;