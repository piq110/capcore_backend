import { createClient, RedisClientType } from 'redis';
import config from '@/config';
import { logger } from '@/utils/logger';

class RedisService {
  private static instance: RedisService;
  private client: RedisClientType;
  private isConnected: boolean = false;

  private constructor() {
    this.client = createClient({
      url: config.redis.url,
      socket: {
        connectTimeout: 5000,
      },
    });

    // Event handlers
    this.client.on('error', (error) => {
      logger.error('Redis client error:', error);
      this.isConnected = false;
    });

    this.client.on('connect', () => {
      logger.info('Redis client connected');
      this.isConnected = true;
    });

    this.client.on('disconnect', () => {
      logger.warn('Redis client disconnected');
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis client reconnecting');
    });
  }

  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  public async connect(): Promise<void> {
    if (this.isConnected) {
      logger.info('Redis already connected');
      return;
    }

    try {
      await this.client.connect();
      logger.info('Successfully connected to Redis');
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.client.disconnect();
      this.isConnected = false;
      logger.info('Disconnected from Redis');
    } catch (error) {
      logger.error('Error disconnecting from Redis:', error);
      throw error;
    }
  }

  public isConnectionActive(): boolean {
    return this.isConnected && this.client.isOpen;
  }

  /**
   * Store refresh token with expiration
   */
  public async storeRefreshToken(
    userId: string,
    tokenId: string,
    tokenVersion: number,
    expirationSeconds: number
  ): Promise<void> {
    try {
      const key = `refresh_token:${userId}:${tokenId}`;
      const value = JSON.stringify({
        tokenVersion,
        createdAt: new Date().toISOString(),
      });

      await this.client.setEx(key, expirationSeconds, value);
      logger.debug('Refresh token stored', { userId, tokenId });
    } catch (error) {
      logger.error('Failed to store refresh token:', error);
      throw error;
    }
  }

  /**
   * Validate refresh token
   */
  public async validateRefreshToken(
    userId: string,
    tokenId: string,
    expectedVersion: number
  ): Promise<boolean> {
    try {
      const key = `refresh_token:${userId}:${tokenId}`;
      const value = await this.client.get(key);

      if (!value) {
        return false;
      }

      const tokenData = JSON.parse(value);
      return tokenData.tokenVersion === expectedVersion;
    } catch (error) {
      logger.error('Failed to validate refresh token:', error);
      return false;
    }
  }

  /**
   * Revoke refresh token
   */
  public async revokeRefreshToken(userId: string, tokenId: string): Promise<void> {
    try {
      const key = `refresh_token:${userId}:${tokenId}`;
      await this.client.del(key);
      logger.debug('Refresh token revoked', { userId, tokenId });
    } catch (error) {
      logger.error('Failed to revoke refresh token:', error);
      throw error;
    }
  }

  /**
   * Revoke all refresh tokens for a user
   */
  public async revokeAllRefreshTokens(userId: string): Promise<void> {
    try {
      const pattern = `refresh_token:${userId}:*`;
      const keys = await this.client.keys(pattern);
      
      if (keys.length > 0) {
        await this.client.del(keys);
        logger.debug('All refresh tokens revoked for user', { userId, count: keys.length });
      }
    } catch (error) {
      logger.error('Failed to revoke all refresh tokens:', error);
      throw error;
    }
  }

  /**
   * Store user session data
   */
  public async storeSession(
    sessionId: string,
    userId: string,
    data: Record<string, any>,
    expirationSeconds: number = 3600
  ): Promise<void> {
    try {
      const key = `session:${sessionId}`;
      const value = JSON.stringify({
        userId,
        data,
        createdAt: new Date().toISOString(),
      });

      await this.client.setEx(key, expirationSeconds, value);
      logger.debug('Session stored', { sessionId, userId });
    } catch (error) {
      logger.error('Failed to store session:', error);
      throw error;
    }
  }

  /**
   * Get user session data
   */
  public async getSession(sessionId: string): Promise<{ userId: string; data: Record<string, any> } | null> {
    try {
      const key = `session:${sessionId}`;
      const value = await this.client.get(key);

      if (!value) {
        return null;
      }

      const sessionData = JSON.parse(value);
      return {
        userId: sessionData.userId,
        data: sessionData.data,
      };
    } catch (error) {
      logger.error('Failed to get session:', error);
      return null;
    }
  }

  /**
   * Delete session
   */
  public async deleteSession(sessionId: string): Promise<void> {
    try {
      const key = `session:${sessionId}`;
      await this.client.del(key);
      logger.debug('Session deleted', { sessionId });
    } catch (error) {
      logger.error('Failed to delete session:', error);
      throw error;
    }
  }

  /**
   * Store rate limit data
   */
  public async incrementRateLimit(
    key: string,
    windowSeconds: number,
    maxRequests: number
  ): Promise<{ count: number; remaining: number; resetTime: number }> {
    try {
      const rateLimitKey = `rate_limit:${key}`;
      const current = await this.client.incr(rateLimitKey);
      
      if (current === 1) {
        await this.client.expire(rateLimitKey, windowSeconds);
      }
      
      const ttl = await this.client.ttl(rateLimitKey);
      const resetTime = Date.now() + (ttl * 1000);
      
      return {
        count: current,
        remaining: Math.max(0, maxRequests - current),
        resetTime,
      };
    } catch (error) {
      logger.error('Failed to increment rate limit:', error);
      throw error;
    }
  }

  /**
   * Generic set operation
   */
  public async set(key: string, value: string, expirationSeconds?: number): Promise<void> {
    try {
      if (expirationSeconds) {
        await this.client.setEx(key, expirationSeconds, value);
      } else {
        await this.client.set(key, value);
      }
    } catch (error) {
      logger.error('Failed to set key:', error);
      throw error;
    }
  }

  /**
   * Generic get operation
   */
  public async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error('Failed to get key:', error);
      return null;
    }
  }

  /**
   * Generic delete operation
   */
  public async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      logger.error('Failed to delete key:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const redisService = RedisService.getInstance();

// Helper function for graceful shutdown
export const gracefulRedisShutdown = async (): Promise<void> => {
  try {
    await redisService.disconnect();
    logger.info('Redis connection closed through app termination');
  } catch (error) {
    logger.error('Error during Redis shutdown:', error);
  }
};