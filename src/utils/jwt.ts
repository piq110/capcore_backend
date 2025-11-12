import jwt from 'jsonwebtoken';
import config from '@/config';
import { logger, securityLogger } from '@/utils/logger';

export interface JWTPayload {
  userId: string;
  email: string;
  role: 'user' | 'admin' | 'issuer';
  kycStatus: 'not_started' | 'pending' | 'approved' | 'rejected';
  emailVerified: boolean;
  accreditedInvestor?: boolean;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

class JWTService {
  private static instance: JWTService;

  private constructor() {}

  public static getInstance(): JWTService {
    if (!JWTService.instance) {
      JWTService.instance = new JWTService();
    }
    return JWTService.instance;
  }

  /**
   * Generate access token
   */
  public generateAccessToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
    try {
      const token = (jwt.sign as any)(
        payload,
        config.jwt.secret,
        {
          expiresIn: config.jwt.expiresIn,
          issuer: 'aim-platform',
          audience: 'aim-users',
        }
      );

      logger.debug('Access token generated', { userId: payload.userId });
      return token;
    } catch (error) {
      logger.error('Failed to generate access token:', error);
      throw new Error('Token generation failed');
    }
  }

  /**
   * Generate refresh token
   */
  public generateRefreshToken(userId: string, tokenVersion: number = 1): string {
    try {
      const payload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
        userId,
        tokenVersion,
      };

      const token = (jwt.sign as any)(
        payload,
        config.jwt.refreshSecret,
        {
          expiresIn: config.jwt.refreshExpiresIn,
          issuer: 'aim-platform',
          audience: 'aim-refresh',
        }
      );

      logger.debug('Refresh token generated', { userId });
      return token;
    } catch (error) {
      logger.error('Failed to generate refresh token:', error);
      throw new Error('Refresh token generation failed');
    }
  }

  /**
   * Generate token pair (access + refresh)
   */
  public generateTokenPair(
    userPayload: Omit<JWTPayload, 'iat' | 'exp'>,
    tokenVersion: number = 1
  ): TokenPair {
    const accessToken = this.generateAccessToken(userPayload);
    const refreshToken = this.generateRefreshToken(userPayload.userId, tokenVersion);
    
    // Calculate expiration time in seconds
    const expiresIn = this.getTokenExpirationTime(config.jwt.expiresIn);

    securityLogger.info('Token pair generated', {
      userId: userPayload.userId,
      email: userPayload.email,
      role: userPayload.role,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn,
    };
  }

  /**
   * Verify access token
   */
  public verifyAccessToken(token: string): JWTPayload {
    try {
      const decoded = (jwt.verify as any)(token, config.jwt.secret, {
        issuer: 'aim-platform',
        audience: 'aim-users',
      }) as JWTPayload;

      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Token expired');
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token');
      } else {
        logger.error('Token verification failed:', error);
        throw new Error('Token verification failed');
      }
    }
  }

  /**
   * Verify refresh token
   */
  public verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      const decoded = (jwt.verify as any)(token, config.jwt.refreshSecret, {
        issuer: 'aim-platform',
        audience: 'aim-refresh',
      }) as RefreshTokenPayload;

      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Refresh token expired');
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid refresh token');
      } else {
        logger.error('Refresh token verification failed:', error);
        throw new Error('Refresh token verification failed');
      }
    }
  }

  /**
   * Extract token from Authorization header
   */
  public extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    return parts[1];
  }

  /**
   * Get token expiration time in seconds
   */
  private getTokenExpirationTime(expiresIn: string): number {
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) {
      return 900; // Default 15 minutes
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 60 * 60 * 24;
      default:
        return 900;
    }
  }

  /**
   * Decode token without verification (for debugging)
   */
  public decodeToken(token: string): any {
    try {
      return jwt.decode(token);
    } catch (error) {
      logger.error('Failed to decode token:', error);
      return null;
    }
  }

  /**
   * Check if token is expired
   */
  public isTokenExpired(token: string): boolean {
    try {
      const decoded = this.decodeToken(token);
      if (!decoded || !decoded.exp) {
        return true;
      }

      const currentTime = Math.floor(Date.now() / 1000);
      return decoded.exp < currentTime;
    } catch (error) {
      return true;
    }
  }
}

// Export singleton instance
export const jwtService = JWTService.getInstance();

// Helper functions
export const generateTokenPair = (
  userPayload: Omit<JWTPayload, 'iat' | 'exp'>,
  tokenVersion?: number
): TokenPair => {
  return jwtService.generateTokenPair(userPayload, tokenVersion);
};

export const verifyAccessToken = (token: string): JWTPayload => {
  return jwtService.verifyAccessToken(token);
};

export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  return jwtService.verifyRefreshToken(token);
};

export const extractTokenFromHeader = (authHeader: string | undefined): string | null => {
  return jwtService.extractTokenFromHeader(authHeader);
};