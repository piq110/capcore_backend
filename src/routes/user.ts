import express from 'express';
import { query, param, body, validationResult } from 'express-validator';
import { authenticate } from '@/middleware/auth';
import { addKYCStatusToResponse, getKYCStatusInfo } from '@/middleware/kycMiddleware';
import { User } from '@/models/User';
import { KYCSubmission } from '@/models/KYC';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';
import config from '@/config';

const router = express.Router();

/**
 * GET /api/user/dashboard
 * Get user dashboard information including KYC status and prompts
 */
router.get('/dashboard',
  authenticate,
  addKYCStatusToResponse,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access your dashboard',
        });
        return;
      }

      // Get fresh user data
      const user = await User.findById(req.user.userId);
      if (!user) {
        res.status(404).json({
          error: 'User not found',
          message: 'Your account could not be found',
        });
        return;
      }

      // Get KYC submission if exists
      const kycSubmission = await KYCSubmission.findOne({ userId: user._id });

      // Get KYC status information
      const kycStatusInfo = getKYCStatusInfo(user.kycStatus);

      // Determine what info bars to show
      const infoBars = [];

      // Alpha stage info bar
      if (config.stage === 'alpha') {
        infoBars.push({
          type: 'info',
          title: 'Alpha Stage',
          message: 'Welcome to the alpha version of our platform. Some features may be limited.',
          dismissible: false,
          priority: 1,
        });
      }

      // Email verification info bar
      if (!user.emailVerified) {
        infoBars.push({
          type: 'warning',
          title: 'Email Verification Required',
          message: 'Please verify your email address to access all platform features.',
          action: {
            text: 'Resend Verification Email',
            endpoint: '/api/auth/resend-verification',
          },
          dismissible: false,
          priority: 2,
        });
      }

      // KYC status info bar
      if (user.kycStatus !== 'approved') {
        let kycInfoBar: any = {
          type: user.kycStatus === 'rejected' ? 'error' : 'warning',
          title: kycStatusInfo.message,
          message: kycStatusInfo.action,
          dismissible: false,
          priority: 3,
        };

        if (user.kycStatus === 'not_started') {
          kycInfoBar.action = {
            text: 'Start KYC Verification',
            endpoint: '/api/kyc/submit',
          };
        } else if (user.kycStatus === 'rejected' && kycSubmission) {
          kycInfoBar.message += ` Reason: ${kycSubmission.rejectionReason}`;
          kycInfoBar.action = {
            text: 'Resubmit KYC',
            endpoint: '/api/kyc/submit',
          };
        }

        infoBars.push(kycInfoBar);
      }

      // MFA setup prompt (optional)
      if (!user.mfaEnabled && user.emailVerified) {
        infoBars.push({
          type: 'info',
          title: 'Enhance Your Security',
          message: 'Enable two-factor authentication for additional account security.',
          action: {
            text: 'Setup MFA',
            endpoint: '/api/auth/setup-mfa',
          },
          dismissible: true,
          priority: 4,
        });
      }

      // Sort info bars by priority
      infoBars.sort((a, b) => a.priority - b.priority);

      // Determine feature access
      const featureAccess = {
        canBrowseInvestments: true, // Always allow browsing
        canTrade: user.kycStatus === 'approved' && user.emailVerified,
        canDeposit: user.emailVerified,
        canWithdraw: user.kycStatus === 'approved' && user.emailVerified,
        canAccessPortfolio: user.emailVerified,
        requiresKYC: user.kycStatus !== 'approved',
        requiresEmailVerification: !user.emailVerified,
      };

      logger.info('User dashboard accessed', {
        userId: user._id,
        kycStatus: user.kycStatus,
        emailVerified: user.emailVerified,
        mfaEnabled: user.mfaEnabled,
        infoBarsCount: infoBars.length,
      });

      res.json({
        user: {
          id: user._id,
          email: user.email,
          emailVerified: user.emailVerified,
          kycStatus: user.kycStatus,
          accreditedInvestor: user.accreditedInvestor,
          mfaEnabled: user.mfaEnabled,
          role: user.role,
          status: user.status,
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
        },
        kycSubmission: kycSubmission ? {
          id: kycSubmission._id,
          status: kycSubmission.status,
          submittedAt: kycSubmission.submittedAt,
          reviewedAt: kycSubmission.reviewedAt,
          rejectionReason: kycSubmission.rejectionReason,
          additionalInfoRequired: kycSubmission.additionalInfoRequired,
        } : null,
        infoBars,
        featureAccess,
        kycStatusInfo,
        stage: config.stage,
      });

    } catch (error) {
      logger.error('Failed to get user dashboard:', error);
      res.status(500).json({
        error: 'Failed to load dashboard',
        message: 'An error occurred while loading your dashboard',
      });
    }
  }
);

/**
 * GET /api/user/feature-access
 * Check what features the user can access based on their verification status
 */
router.get('/feature-access',
  authenticate,
  addKYCStatusToResponse,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to check feature access',
        });
        return;
      }

      const user = await User.findById(req.user.userId);
      if (!user) {
        res.status(404).json({
          error: 'User not found',
          message: 'Your account could not be found',
        });
        return;
      }

      const featureAccess = {
        canBrowseInvestments: true,
        canViewInvestmentDetails: true,
        canTrade: user.kycStatus === 'approved' && user.emailVerified,
        canPlaceOrders: user.kycStatus === 'approved' && user.emailVerified,
        canDeposit: user.emailVerified,
        canWithdraw: user.kycStatus === 'approved' && user.emailVerified,
        canAccessPortfolio: user.emailVerified,
        canAccessWallet: user.emailVerified,
        requiresKYC: user.kycStatus !== 'approved',
        requiresEmailVerification: !user.emailVerified,
        kycStatus: user.kycStatus,
        emailVerified: user.emailVerified,
        accreditedInvestor: user.accreditedInvestor,
      };

      // Add specific restrictions and messages
      const restrictions = [];
      
      if (!user.emailVerified) {
        restrictions.push({
          feature: 'trading',
          reason: 'Email verification required',
          action: 'Please verify your email address',
        });
      }

      if (user.kycStatus !== 'approved') {
        restrictions.push({
          feature: 'trading',
          reason: 'KYC verification required',
          action: user.kycStatus === 'not_started' 
            ? 'Please complete your KYC verification'
            : `KYC status: ${user.kycStatus}`,
        });
        
        restrictions.push({
          feature: 'withdrawals',
          reason: 'KYC verification required',
          action: 'Complete KYC verification to enable withdrawals',
        });
      }

      res.json({
        featureAccess,
        restrictions,
        checkedAt: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Failed to check feature access:', error);
      res.status(500).json({
        error: 'Failed to check access',
        message: 'An error occurred while checking feature access',
      });
    }
  }
);

/**
 * GET /api/user/fees
 * Get user's fee transparency report
 */
router.get('/fees',
  authenticate,
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
      .isIn(['week', 'month', 'quarter', 'year', 'custom'])
      .withMessage('Period must be one of: week, month, quarter, year, custom'),
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

      const userId = new mongoose.Types.ObjectId(req.user!.userId);
      const feeReport = await revenueService.getUserFeeReport(userId, startDate, endDate);

      logger.info('User accessed fee report', {
        userId: req.user!.userId,
        period,
        startDate,
        endDate,
        totalFees: feeReport.totalFeesPaid
      });

      res.json({
        success: true,
        data: feeReport
      });

    } catch (error) {
      logger.error('Failed to get user fee report:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve fee report'
      });
    }
  }
);

/**
 * GET /api/user/listing-fees
 * Get issuer's listing fees and billing information (issuer role only)
 */
router.get('/listing-fees',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      // Check if user is an issuer
      const user = await User.findById(req.user!.userId);
      if (!user || user.role !== 'issuer') {
        res.status(403).json({
          success: false,
          message: 'Access denied. Issuer role required.'
        });
        return;
      }

      const { revenueService } = await import('@/services/RevenueService');
      
      // Default to last 12 months
      const endDate = new Date();
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 1);

      const issuerId = new mongoose.Types.ObjectId(req.user!.userId);
      const billingReport = await revenueService.getIssuerBillingReport(issuerId, startDate, endDate);

      logger.info('Issuer accessed listing fees', {
        issuerId: req.user!.userId,
        totalDue: billingReport.totalDue,
        totalPaid: billingReport.totalPaid
      });

      res.json({
        success: true,
        data: billingReport
      });

    } catch (error) {
      logger.error('Failed to get issuer listing fees:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve listing fees'
      });
    }
  }
);

/**
 * PUT /api/user/listing-fees/:feeId/pay
 * Mark a listing fee as paid (issuer role only)
 */
router.put('/listing-fees/:feeId/pay',
  authenticate,
  [
    param('feeId')
      .isMongoId()
      .withMessage('Fee ID must be a valid MongoDB ObjectId'),
    body('paymentMethod')
      .isIn(['crypto', 'bank_transfer', 'credit_card'])
      .withMessage('Payment method must be one of: crypto, bank_transfer, credit_card'),
    body('transactionId')
      .optional()
      .isString()
      .withMessage('Transaction ID must be a string'),
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

      // Check if user is an issuer
      const user = await User.findById(req.user!.userId);
      if (!user || user.role !== 'issuer') {
        res.status(403).json({
          success: false,
          message: 'Access denied. Issuer role required.'
        });
        return;
      }

      const { ListingFee } = await import('@/models/ListingFee');
      
      const feeId = req.params.feeId;
      const { paymentMethod, transactionId } = req.body;

      // Find the listing fee and verify it belongs to this issuer
      const listingFee = await ListingFee.findOne({
        _id: feeId,
        issuerId: req.user!.userId
      });

      if (!listingFee) {
        res.status(404).json({
          success: false,
          message: 'Listing fee not found or access denied'
        });
        return;
      }

      if (listingFee.status === 'paid') {
        res.status(400).json({
          success: false,
          message: 'Fee is already marked as paid'
        });
        return;
      }

      // Mark as paid
      await listingFee.markAsPaid(transactionId, paymentMethod);

      logger.info('Issuer marked listing fee as paid', {
        issuerId: req.user!.userId,
        feeId,
        amount: listingFee.amount,
        paymentMethod,
        transactionId
      });

      res.json({
        success: true,
        data: {
          feeId: listingFee._id,
          status: listingFee.status,
          paidDate: listingFee.paidDate,
          paymentMethod: listingFee.paymentMethod,
          transactionId: listingFee.transactionId
        }
      });

    } catch (error) {
      logger.error('Failed to mark listing fee as paid:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to process payment'
      });
    }
  }
);

/**
 * GET /api/user/fees/summary
 * Get user's fee summary for current month
 */
router.get('/fees/summary',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { FeeTransaction } = await import('@/models/FeeTransaction');
      
      const userId = new mongoose.Types.ObjectId(req.user!.userId);
      
      // Get current month's fees
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      
      const endOfMonth = new Date();
      endOfMonth.setMonth(endOfMonth.getMonth() + 1);
      endOfMonth.setDate(0);
      endOfMonth.setHours(23, 59, 59, 999);

      const monthlyFees = await FeeTransaction.aggregate([
        {
          $match: {
            userId,
            createdAt: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'collected'
          }
        },
        {
          $group: {
            _id: '$feeType',
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      // Get lifetime fees
      const lifetimeFees = await FeeTransaction.aggregate([
        {
          $match: {
            userId,
            status: 'collected'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]);

      const monthlyTotal = monthlyFees.reduce((sum, fee) => sum + fee.total, 0);
      const lifetimeTotal = lifetimeFees[0]?.total || 0;
      const lifetimeCount = lifetimeFees[0]?.count || 0;

      const summary = {
        currentMonth: {
          total: monthlyTotal,
          breakdown: monthlyFees.reduce((acc: any, fee) => {
            acc[fee._id] = {
              amount: fee.total,
              transactionCount: fee.count
            };
            return acc;
          }, {}),
          period: {
            startDate: startOfMonth,
            endDate: endOfMonth
          }
        },
        lifetime: {
          total: lifetimeTotal,
          transactionCount: lifetimeCount
        }
      };

      logger.info('User accessed fee summary', {
        userId: req.user!.userId,
        monthlyTotal,
        lifetimeTotal
      });

      res.json({
        success: true,
        data: summary
      });

    } catch (error) {
      logger.error('Failed to get user fee summary:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve fee summary'
      });
    }
  }
);

export default router;