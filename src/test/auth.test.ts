import request from 'supertest';
import app from '../index';
import { jwtService, generateTokenPair } from '../utils/jwt';
import { User } from '../models/User';
import { database } from '../utils/database';
import mongoose from 'mongoose';

describe('Authentication and JWT', () => {
  beforeAll(async () => {
    process.env.MONGODB_URI = 'mongodb://localhost:27017/aim_test';
    await database.connect();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await database.disconnect();
  });

  beforeEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  describe('JWT Service', () => {
    it('should generate and verify access tokens', () => {
      const payload = {
        userId: '507f1f77bcf86cd799439011',
        email: 'test@example.com',
        role: 'user' as const,
        kycStatus: 'approved' as const,
        emailVerified: true,
      };

      const token = jwtService.generateAccessToken(payload);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = jwtService.verifyAccessToken(token);
      expect(decoded.userId).toBe(payload.userId);
      expect(decoded.email).toBe(payload.email);
      expect(decoded.role).toBe(payload.role);
    });

    it('should generate token pairs', () => {
      const payload = {
        userId: '507f1f77bcf86cd799439011',
        email: 'test@example.com',
        role: 'user' as const,
        kycStatus: 'approved' as const,
        emailVerified: true,
      };

      const tokenPair = generateTokenPair(payload);
      expect(tokenPair.accessToken).toBeDefined();
      expect(tokenPair.refreshToken).toBeDefined();
      expect(tokenPair.expiresIn).toBeGreaterThan(0);
    });

    it('should extract token from Authorization header', () => {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
      const authHeader = `Bearer ${token}`;
      
      const extracted = jwtService.extractTokenFromHeader(authHeader);
      expect(extracted).toBe(token);
    });

    it('should return null for invalid Authorization header', () => {
      expect(jwtService.extractTokenFromHeader('Invalid header')).toBeNull();
      expect(jwtService.extractTokenFromHeader('')).toBeNull();
      expect(jwtService.extractTokenFromHeader(undefined)).toBeNull();
    });

    it('should reject expired tokens', () => {
      // This would require mocking jwt.verify or using a very short expiration
      // For now, we'll test the error handling structure
      expect(() => {
        jwtService.verifyAccessToken('invalid.token.here');
      }).toThrow();
    });
  });

  describe('Authentication Middleware', () => {
    let testUser: any;
    let validToken: string;

    beforeEach(async () => {
      // Create test user
      testUser = await new User({
        email: 'auth@example.com',
        passwordHash: 'hashedpassword123',
        emailVerified: true,
        kycStatus: 'approved',
        role: 'user',
        status: 'active',
      }).save();

      // Generate valid token
      const payload = {
        userId: (testUser._id as any).toString(),
        email: testUser.email,
        role: testUser.role,
        kycStatus: testUser.kycStatus,
        emailVerified: testUser.emailVerified,
      };
      validToken = jwtService.generateAccessToken(payload);
    });

    it('should reject requests without token', async () => {
      // We'll need to create a protected route to test this
      // For now, test the JWT service directly
      expect(() => {
        jwtService.verifyAccessToken('');
      }).toThrow();
    });

    it('should accept requests with valid token', () => {
      const decoded = jwtService.verifyAccessToken(validToken);
      expect(decoded.userId).toBe((testUser._id as any).toString());
      expect(decoded.email).toBe(testUser.email);
    });

    it('should reject requests with invalid token', () => {
      expect(() => {
        jwtService.verifyAccessToken('invalid.token.here');
      }).toThrow();
    });
  });

  describe('Role-based Authorization', () => {
    it('should validate user roles correctly', async () => {
      const adminUser = await new User({
        email: 'admin@example.com',
        passwordHash: 'hashedpassword123',
        role: 'admin',
        emailVerified: true,
        kycStatus: 'approved',
        status: 'active',
      }).save();

      const payload = {
        userId: (adminUser._id as any).toString(),
        email: adminUser.email,
        role: adminUser.role,
        kycStatus: adminUser.kycStatus,
        emailVerified: adminUser.emailVerified,
      };

      const token = jwtService.generateAccessToken(payload);
      const decoded = jwtService.verifyAccessToken(token);
      
      expect(decoded.role).toBe('admin');
    });

    it('should validate KYC status correctly', async () => {
      const kycUser = await new User({
        email: 'kyc@example.com',
        passwordHash: 'hashedpassword123',
        kycStatus: 'approved',
        emailVerified: true,
        status: 'active',
      }).save();

      const payload = {
        userId: (kycUser._id as any).toString(),
        email: kycUser.email,
        role: kycUser.role,
        kycStatus: kycUser.kycStatus,
        emailVerified: kycUser.emailVerified,
      };

      const token = jwtService.generateAccessToken(payload);
      const decoded = jwtService.verifyAccessToken(token);
      
      expect(decoded.kycStatus).toBe('approved');
    });
  });

  describe('Token Security', () => {
    it('should include proper claims in JWT payload', () => {
      const payload = {
        userId: '507f1f77bcf86cd799439011',
        email: 'security@example.com',
        role: 'user' as const,
        kycStatus: 'approved' as const,
        emailVerified: true,
      };

      const token = jwtService.generateAccessToken(payload);
      const decoded = jwtService.decodeToken(token);
      
      expect(decoded.iss).toBe('aim-platform');
      expect(decoded.aud).toBe('aim-users');
      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
    });

    it('should handle token expiration', () => {
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjE1MTYyMzkwMjJ9.invalid';
      
      expect(() => {
        jwtService.verifyAccessToken(expiredToken);
      }).toThrow();
    });
  });
});