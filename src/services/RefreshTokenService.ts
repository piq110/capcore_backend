import { redisService } from '@/utils/redis';
import { jwtService, generateTokenPair, verifyRefreshToken, JWTPayload } from '@/utils/jwt';
import { User } from '@/models/User';
import { logger, securityLogger } from '@/utils/logger';
import crypto from 'crypto';

export interface RefreshTokenData {
  tokenId: string;
  userId: string;
  tokenVersion: number;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt?: Date;
  userAgent?: string;
  ipAddress?: string;
}

class RefreshTokenService {
  private static instance: RefreshTokenService;

  private constructor() {}

  public static getInstance(): RefreshTokenService {
    if (!RefreshTokenService.instance) {
      RefreshTokenService.instance = new RefreshTokenService();
    }
    return RefreshTokenService.instance;
  }

  /**
   * Create a new refresh token for a user
   */
  public async createRefreshToken(
    user: any,
    userAgent?: string,
    ipAddress?: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenId: string }> {
    try {
      // Generate unique token ID
      const tokenId = crypto.randomBytes(32).toString('hex');
      const tokenVersion = 1; // Could be incremented for token rotation

      // Create JWT payload
      const jwtPayload: Omit<JWTPayload, 'iat' | 'exp'> = {
        userId: (user._id as any).toString(),
        email: user.email,
        role: user.role,
        kycStatus: user.kycStatus,
        emailVerified: user.emailVerified,
      };

      // Generate token pair
      const tokenPair = generateTokenPair(jwtPayload, tokenVersion);

      // Calculate expiration time (7 days default)
      const expirationSeconds = 7 * 24 * 60 * 60; // 7 days
      const expiresAt = new Date(Date.now() + expirationSeconds * 1000);

      // Store refresh token in Redis
      await redisService.storeRefreshToken(
        (user._id as any).toString(),
        tokenId,
        tokenVersion,
        expirationSeconds
      );

      // Log token creation
      securityLogger.info('Refresh token created', {
        userId: (user._id as any).toString(),
        tokenId,
        userAgent,
        ipAddress,
        expiresAt: expiresAt.toISOString(),
      });

      return {
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        expiresIn: tokenPair.expiresIn,
        tokenId,
      };
    } catch (error) {
      logger.error('Failed to create refresh token:', error);
      throw new Error('Failed to create refresh token');
    }
  }

  /**
   * Refresh access token using refresh token
   */
  public async refreshAccessToken(
    refreshToken: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    try {
      // Verify refresh token
      const refreshPayload = verifyRefreshToken(refreshToken);
      
      // Get user from database
      const user = await User.findById(refreshPayload.userId);
      if (!user) {
        securityLogger.warn('Refresh token used for non-existent user', {
          userId: refreshPayload.userId,
          userAgent,
          ipAddress,
        });
        throw new Error('User not found');
      }

      if (user.status !== 'active') {
        securityLogger.warn('Refresh token used for inactive user', {
          userId: refreshPayload.userId,
          status: user.status,
          userAgent,
          ipAddress,
        });
        throw new Error('User account is not active');
      }

      // Generate token ID from refresh token (simplified approach)
      const tokenId = crypto.createHash('sha256').update(refreshToken).digest('hex').substring(0, 32);

      // Validate refresh token in Redis
      const isValid = await redisService.validateRefreshToken(
        refreshPayload.userId,
        tokenId,
        refreshPayload.tokenVersion
      );

      if (!isValid) {
        securityLogger.warn('Invalid refresh token used', {
          userId: refreshPayload.userId,
          tokenId,
          userAgent,
          ipAddress,
        });
        throw new Error('Invalid refresh token');
      }

      // Create new JWT payload with current user data
      const jwtPayload: Omit<JWTPayload, 'iat' | 'exp'> = {
        userId: (user._id as any).toString(),
        email: user.email,
        role: user.role,
        kycStatus: user.kycStatus,
        emailVerified: user.emailVerified,
      };

      // Generate new token pair
      const tokenPair = generateTokenPair(jwtPayload, refreshPayload.tokenVersion);

      // Log token refresh
      securityLogger.info('Access token refreshed', {
        userId: (user._id as any).toString(),
        tokenId,
        userAgent,
        ipAddress,
      });

      return tokenPair;
    } catch (error) {
      logger.error('Failed to refresh access token:', error);
      throw new Error('Failed to refresh access token');
    }
  }

  /**
   * Revoke a specific refresh token
   */
  public async revokeRefreshToken(
    refreshToken: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<void> {
    try {
      const refreshPayload = verifyRefreshToken(refreshToken);
      const tokenId = crypto.createHash('sha256').update(refreshToken).digest('hex').substring(0, 32);

      await redisService.revokeRefreshToken(refreshPayload.userId, tokenId);

      securityLogger.info('Refresh token revoked', {
        userId: refreshPayload.userId,
        tokenId,
        userAgent,
        ipAddress,
      });
    } catch (error) {
      logger.error('Failed to revoke refresh token:', error);
      throw new Error('Failed to revoke refresh token');
    }
  }

  /**
   * Revoke all refresh tokens for a user
   */
  public async revokeAllRefreshTokens(
    userId: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<void> {
    try {
      await redisService.revokeAllRefreshTokens(userId);

      securityLogger.info('All refresh tokens revoked for user', {
        userId,
        userAgent,
        ipAddress,
      });
    } catch (error) {
      logger.error('Failed to revoke all refresh tokens:', error);
      throw new Error('Failed to revoke all refresh tokens');
    }
  }

  /**
   * Clean up expired tokens (should be run periodically)
   */
  public async cleanupExpiredTokens(): Promise<void> {
    try {
      // Redis automatically handles expiration, but we can add additional cleanup logic here
      logger.info('Expired token cleanup completed');
    } catch (error) {
      logger.error('Failed to cleanup expired tokens:', error);
    }
  }

  /**
   * Get active refresh tokens for a user (for security dashboard)
   */
  public async getActiveTokensForUser(userId: string): Promise<RefreshTokenData[]> {
    try {
      // This would require additional Redis storage structure to track token metadata
      // For now, return empty array as Redis keys don't store metadata easily
      return [];
    } catch (error) {
      logger.error('Failed to get active tokens for user:', error);
      return [];
    }
  }

  /**
   * Validate if a refresh token exists and is valid
   */
  public async validateRefreshToken(refreshToken: string): Promise<boolean> {
    try {
      const refreshPayload = verifyRefreshToken(refreshToken);
      const tokenId = crypto.createHash('sha256').update(refreshToken).digest('hex').substring(0, 32);

      return await redisService.validateRefreshToken(
        refreshPayload.userId,
        tokenId,
        refreshPayload.tokenVersion
      );
    } catch (error) {
      return false;
    }
  }
}

// Export singleton instance
export const refreshTokenService = RefreshTokenService.getInstance();