import express from 'express';
import { authenticate } from '@/middleware/auth';
import { custodianService } from '@/services/CustodianService';
import { assetTransferService } from '@/services/AssetTransferService';
import { reconciliationService } from '@/services/ReconciliationService';
import { CustodialTransfer } from '@/models/CustodialTransfer';
import { ShareRegister } from '@/models/ShareRegister';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * @route GET /api/custodial/transfers
 * @desc Get custodial transfer history
 * @access Private
 */
router.get('/transfers', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, productId } = req.query;
    const userId = req.user!._id;

    const query: any = {
      $or: [
        { fromUserId: userId },
        { toUserId: userId },
      ],
    };

    if (status) {
      query.status = status;
    }

    if (productId) {
      query.productId = new mongoose.Types.ObjectId(productId as string);
    }

    const transfers = await CustodialTransfer.find(query)
      .populate('fromUserId', 'email')
      .populate('toUserId', 'email')
      .populate('productId', 'name symbol')
      .populate('tradeId', 'totalAmount pricePerShare')
      .sort({ createdAt: -1 })
      .limit(Number(limit) * Number(page))
      .skip((Number(page) - 1) * Number(limit))
      .lean();

    const total = await CustodialTransfer.countDocuments(query);

    return res.json({
      success: true,
      data: {
        transfers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });

  } catch (error) {
    logger.error('Failed to get custodial transfers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve custodial transfers',
    });
  }
});

/**
 * @route GET /api/custodial/transfers/:transferId
 * @desc Get detailed custodial transfer information
 * @access Private
 */
router.get('/transfers/:transferId', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    const { transferId } = req.params;
    const userId = req.user!._id;

    const transfer = await CustodialTransfer.findOne({
      transferId,
      $or: [
        { fromUserId: userId },
        { toUserId: userId },
      ],
    })
      .populate('fromUserId', 'email')
      .populate('toUserId', 'email')
      .populate('productId', 'name symbol')
      .populate('tradeId');

    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Transfer not found',
      });
    }

    // Get audit trail
    const auditTrail = await assetTransferService.getTransferAuditTrail(transferId);

    return res.json({
      success: true,
      data: {
        transfer,
        auditTrail,
      },
    });

  } catch (error) {
    logger.error('Failed to get transfer details:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve transfer details',
    });
  }
});

/**
 * @route GET /api/custodial/holdings
 * @desc Get user's share register holdings
 * @access Private
 */
router.get('/holdings', authenticate, async (req, res) => {
  try {
    const userId = req.user!._id;
    const { productId } = req.query;

    const query: any = {
      userId: new mongoose.Types.ObjectId(userId),
      status: 'active',
    };

    if (productId) {
      query.productId = new mongoose.Types.ObjectId(productId as string);
    }

    const holdings = await ShareRegister.find(query)
      .populate('productId', 'name symbol sharePrice')
      .sort({ acquisitionDate: -1 })
      .lean();

    // Calculate total values
    const summary = holdings.reduce(
      (acc, holding) => {
        const product = holding.productId as any;
        const currentValue = holding.quantity * (product?.sharePrice || 0);
        const totalCost = holding.quantity * holding.acquisitionPrice;
        const unrealizedPnL = currentValue - totalCost;

        acc.totalQuantity += holding.quantity;
        acc.totalCurrentValue += currentValue;
        acc.totalCost += totalCost;
        acc.totalUnrealizedPnL += unrealizedPnL;

        return acc;
      },
      {
        totalQuantity: 0,
        totalCurrentValue: 0,
        totalCost: 0,
        totalUnrealizedPnL: 0,
      }
    );

    return res.json({
      success: true,
      data: {
        holdings,
        summary,
      },
    });

  } catch (error) {
    logger.error('Failed to get share register holdings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve holdings',
    });
  }
});

/**
 * @route GET /api/custodial/ownership-verification/:productId
 * @desc Verify ownership across platform, share register, and custodian
 * @access Private
 */
router.get('/ownership-verification/:productId', authenticate, async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user!._id;

    const verification = await assetTransferService.verifyOwnership(
      new mongoose.Types.ObjectId(userId),
      new mongoose.Types.ObjectId(productId)
    );

    return res.json({
      success: true,
      data: verification,
    });

  } catch (error) {
    logger.error('Failed to verify ownership:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify ownership',
    });
  }
});

/**
 * @route GET /api/custodial/reconciliation
 * @desc Get user's reconciliation report
 * @access Private
 */
router.get('/reconciliation', authenticate, async (req, res) => {
  try {
    const userId = req.user!._id;

    const report = await reconciliationService.reconcileUser(
      new mongoose.Types.ObjectId(userId)
    );

    return res.json({
      success: true,
      data: report,
    });

  } catch (error) {
    logger.error('Failed to generate reconciliation report:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate reconciliation report',
    });
  }
});

/**
 * @route POST /api/custodial/transfers/:transferId/status-check
 * @desc Check transfer status with custodian
 * @access Private
 */
router.post('/transfers/:transferId/status-check', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    const { transferId } = req.params;
    const userId = req.user!._id;

    // Verify user has access to this transfer
    const transfer = await CustodialTransfer.findOne({
      transferId,
      $or: [
        { fromUserId: userId },
        { toUserId: userId },
      ],
    });

    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Transfer not found',
      });
    }

    const status = await custodianService.checkTransferStatus(transferId);

    return res.json({
      success: true,
      data: status,
    });

  } catch (error) {
    logger.error('Failed to check transfer status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check transfer status',
    });
  }
});

// Admin routes (require admin role)

/**
 * @route GET /api/custodial/admin/transfers
 * @desc Get all custodial transfers (admin only)
 * @access Private (Admin)
 */
router.get('/admin/transfers', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    // Check admin role
    if (req.user!.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
    }

    const { page = 1, limit = 50, status, productId } = req.query;

    const query: any = {};

    if (status) {
      query.status = status;
    }

    if (productId) {
      query.productId = new mongoose.Types.ObjectId(productId as string);
    }

    const transfers = await CustodialTransfer.find(query)
      .populate('fromUserId', 'email')
      .populate('toUserId', 'email')
      .populate('productId', 'name symbol')
      .populate('tradeId', 'totalAmount pricePerShare')
      .sort({ createdAt: -1 })
      .limit(Number(limit) * Number(page))
      .skip((Number(page) - 1) * Number(limit))
      .lean();

    const total = await CustodialTransfer.countDocuments(query);

    return res.json({
      success: true,
      data: {
        transfers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });

  } catch (error) {
    logger.error('Failed to get admin custodial transfers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve custodial transfers',
    });
  }
});

/**
 * @route POST /api/custodial/admin/reconciliation/full
 * @desc Perform full system reconciliation (admin only)
 * @access Private (Admin)
 */
router.post('/admin/reconciliation/full', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    // Check admin role
    if (req.user!.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
    }

    const report = await reconciliationService.performFullReconciliation();

    return res.json({
      success: true,
      data: report,
    });

  } catch (error) {
    logger.error('Failed to perform full reconciliation:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to perform full reconciliation',
    });
  }
});

/**
 * @route POST /api/custodial/admin/reconciliation/product/:productId
 * @desc Perform product-specific reconciliation (admin only)
 * @access Private (Admin)
 */
router.post('/admin/reconciliation/product/:productId', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    // Check admin role
    if (req.user!.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
    }

    const { productId } = req.params;

    const report = await reconciliationService.reconcileProduct(
      new mongoose.Types.ObjectId(productId)
    );

    return res.json({
      success: true,
      data: report,
    });

  } catch (error) {
    logger.error('Failed to perform product reconciliation:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to perform product reconciliation',
    });
  }
});

/**
 * @route GET /api/custodial/admin/summary
 * @desc Get asset transfer summary (admin only)
 * @access Private (Admin)
 */
router.get('/admin/summary', authenticate, async (req: express.Request, res: express.Response)=> {
  try {
    // Check admin role
    if (req.user!.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
    }

    const { startDate, endDate, productId } = req.query;

    const summary = await assetTransferService.getAssetTransferSummary(
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
      productId ? new mongoose.Types.ObjectId(productId as string) : undefined
    );

    return res.json({
      success: true,
      data: summary,
    });

  } catch (error) {
    logger.error('Failed to get asset transfer summary:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get asset transfer summary',
    });
  }
});

export default router;