import { Request, Response, NextFunction } from 'express';
import { User } from '@/models/User';
import { AuthenticationError, AuthorizationError } from '@/middleware/errorHandler';
import { securityLogger } from '@/utils/logger';

/**
 * Middleware to check KYC status and enforce KYC requirements for trading operations
 */
export const requireKYCForTrading = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      throw new AuthenticationError('Authentication required');
    }

    // Fetch fresh user data to get current KYC status
    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AuthenticationError('User not found');
    }

    if (user.kycStatus !== 'approved') {
      securityLogger.warn('Trading operation blocked: KYC not approved', {
        userId: req.user.userId,
        kycStatus: user.kycStatus,
        operation: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.status(403).json({
        error: 'KYC verification required',
        message: 'You must complete and have your KYC verification approved before trading',
        kycStatus: user.kycStatus,
        requiresKYC: true,
      });
      return;
    }

    // Update request user with fresh KYC status
    req.user.kycStatus = user.kycStatus;
    next();

  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      next(error);
    } else {
      securityLogger.error('KYC middleware error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: req.user?.userId,
        ip: req.ip,
      });
      next(new AuthorizationError('KYC verification check failed'));
    }
  }
};

/**
 * Middleware to check if user can access investment features (allows browsing but restricts trading)
 */
export const checkKYCForInvestmentAccess = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      // Allow unauthenticated users to browse public investment information
      next();
      return;
    }

    // Fetch fresh user data
    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new AuthenticationError('User not found');
    }

    // Add KYC status to response headers for frontend to display appropriate UI
    res.setHeader('X-KYC-Status', user.kycStatus);
    res.setHeader('X-KYC-Required', user.kycStatus !== 'approved' ? 'true' : 'false');

    // Update request user with fresh KYC status
    req.user.kycStatus = user.kycStatus;
    next();

  } catch (error) {
    if (error instanceof AuthenticationError) {
      next(error);
    } else {
      securityLogger.error('KYC access check error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: req.user?.userId,
        ip: req.ip,
      });
      // Don't block access for KYC check errors, just log them
      next();
    }
  }
};

/**
 * Middleware to add KYC status information to API responses
 */
export const addKYCStatusToResponse = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      next();
      return;
    }

    // Fetch fresh user data
    const user = await User.findById(req.user.userId);
    if (user) {
      // Store KYC info in res.locals for use in route handlers
      res.locals.kycStatus = user.kycStatus;
      res.locals.kycRequired = user.kycStatus !== 'approved';
      
      // Update request user with fresh KYC status
      req.user.kycStatus = user.kycStatus;
    }

    next();

  } catch (error) {
    securityLogger.error('KYC status middleware error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.userId,
      ip: req.ip,
    });
    // Don't block the request, just continue without KYC status
    next();
  }
};

/**
 * Helper function to get KYC status display information
 */
export const getKYCStatusInfo = (kycStatus: string) => {
  const statusInfo = {
    not_started: {
      message: 'KYC verification not started',
      action: 'Please complete your KYC verification to access all features',
      canTrade: false,
      canBrowse: true,
    },
    pending: {
      message: 'KYC verification pending review',
      action: 'Your KYC submission is being reviewed. You will be notified once approved',
      canTrade: false,
      canBrowse: true,
    },
    approved: {
      message: 'KYC verification approved',
      action: 'You have full access to all platform features',
      canTrade: true,
      canBrowse: true,
    },
    rejected: {
      message: 'KYC verification rejected',
      action: 'Please review the rejection reason and resubmit your KYC information',
      canTrade: false,
      canBrowse: true,
    },
  };

  return statusInfo[kycStatus as keyof typeof statusInfo] || statusInfo.not_started;
};