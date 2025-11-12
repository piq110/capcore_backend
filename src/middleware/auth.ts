import { Request, Response, NextFunction } from 'express';
import { jwtService, JWTPayload } from '@/utils/jwt';
import { User } from '@/models/User';
import { AuthenticationError, AuthorizationError } from '@/middleware/errorHandler';
import { securityLogger } from '@/utils/logger';

// Extend Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload & { _id: string };
    }
  }
}

/**
 * Authentication middleware - verifies JWT token
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Extract token from Authorization header
    const token = jwtService.extractTokenFromHeader(req.headers.authorization);
    
    if (!token) {
      securityLogger.warn('Authentication failed: No token provided', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.originalUrl,
      });
      throw new AuthenticationError('Access token required');
    }

    // Verify token
    const payload = jwtService.verifyAccessToken(token);
    
    // Fetch user from database to ensure they still exist and are active
    const user = await User.findById(payload.userId).select('-passwordHash -mfaSecret');
    
    if (!user) {
      securityLogger.warn('Authentication failed: User not found', {
        userId: payload.userId,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      throw new AuthenticationError('User not found');
    }

    if (user.status !== 'active') {
      securityLogger.warn('Authentication failed: User account inactive', {
        userId: payload.userId,
        status: user.status,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      throw new AuthenticationError('Account is not active');
    }

    // Attach user to request
    req.user = {
      ...payload,
      _id: (user._id as any).toString(),
    };

    // Update last login time
    user.lastLoginAt = new Date();
    await user.save();

    next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      next(error);
    } else {
      securityLogger.error('Authentication middleware error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      next(new AuthenticationError('Authentication failed'));
    }
  }
};

/**
 * Optional authentication middleware - doesn't throw if no token
 */
export const optionalAuthenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = jwtService.extractTokenFromHeader(req.headers.authorization);
    
    if (token) {
      const payload = jwtService.verifyAccessToken(token);
      const user = await User.findById(payload.userId).select('-passwordHash -mfaSecret');
      
      if (user && user.status === 'active') {
        req.user = {
          ...payload,
          _id: (user._id as any).toString(),
        };
      }
    }
    
    next();
  } catch (error) {
    // Silently continue without authentication
    next();
  }
};

/**
 * Role-based authorization middleware
 */
export const authorize = (...roles: Array<'user' | 'admin' | 'issuer'>) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      securityLogger.warn('Authorization failed: No authenticated user', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.originalUrl,
        requiredRoles: roles,
      });
      throw new AuthenticationError('Authentication required');
    }

    if (!roles.includes(req.user.role)) {
      securityLogger.warn('Authorization failed: Insufficient permissions', {
        userId: req.user.userId,
        userRole: req.user.role,
        requiredRoles: roles,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.originalUrl,
      });
      throw new AuthorizationError('Insufficient permissions');
    }

    next();
  };
};

/**
 * KYC status check middleware
 */
export const requireKYC = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  if (req.user.kycStatus !== 'approved') {
    securityLogger.warn('KYC verification required', {
      userId: req.user.userId,
      kycStatus: req.user.kycStatus,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.originalUrl,
    });
    throw new AuthorizationError('KYC verification required');
  }

  next();
};

/**
 * Email verification check middleware
 */
export const requireEmailVerification = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  if (!req.user.emailVerified) {
    securityLogger.warn('Email verification required', {
      userId: req.user.userId,
      emailVerified: req.user.emailVerified,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.originalUrl,
    });
    throw new AuthorizationError('Email verification required');
  }

  next();
};

/**
 * Admin-only middleware (combines authentication and admin authorization)
 */
export const adminOnly = [authenticate, authorize('admin')];

/**
 * User or Admin middleware
 */
export const userOrAdmin = [authenticate, authorize('user', 'admin')];

/**
 * Issuer or Admin middleware
 */
export const issuerOrAdmin = [authenticate, authorize('issuer', 'admin')];

/**
 * Authenticated user with KYC middleware
 */
export const authenticatedWithKYC = [authenticate, requireKYC];

/**
 * Authenticated user with email verification middleware
 */
export const authenticatedWithEmail = [authenticate, requireEmailVerification];

/**
 * Full verification middleware (auth + email + KYC)
 */
export const fullyVerified = [authenticate, requireEmailVerification, requireKYC];

/**
 * Self or admin access middleware - allows users to access their own resources or admins to access any
 */
export const selfOrAdmin = (userIdParam: string = 'userId') => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AuthenticationError('Authentication required');
    }

    const targetUserId = req.params[userIdParam];
    const isAdmin = req.user.role === 'admin';
    const isSelf = req.user.userId === targetUserId;

    if (!isAdmin && !isSelf) {
      securityLogger.warn('Access denied: Not self or admin', {
        userId: req.user.userId,
        targetUserId,
        userRole: req.user.role,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.originalUrl,
      });
      throw new AuthorizationError('Access denied');
    }

    next();
  };
};