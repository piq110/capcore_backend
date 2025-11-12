import request from 'supertest';
import mongoose from 'mongoose';
import app from '../index';
import { User } from '@/models/User';
import { database } from '@/utils/database';
import { emailService } from '@/services/EmailService';

// Mock the email service
jest.mock('@/services/EmailService', () => ({
  emailService: {
    sendEmailVerification: jest.fn().mockResolvedValue(true),
    sendWelcomeEmail: jest.fn().mockResolvedValue(true),
  },
}));

const mockedEmailService = emailService as jest.Mocked<typeof emailService>;

describe('Email Verification Endpoints', () => {
  beforeAll(async () => {
    // Connect to test database
    await database.connect();
  });

  beforeEach(async () => {
    // Clear users collection and reset mocks before each test
    await User.deleteMany({});
    jest.clearAllMocks();
  });

  afterAll(async () => {
    // Clean up and close database connection
    await User.deleteMany({});
    await mongoose.connection.close();
  });

  describe('GET /api/auth/verify-email/:token', () => {
    let user: any;
    let verificationToken: string;

    beforeEach(async () => {
      // Create a user with unverified email
      const userData = {
        email: 'test@example.com',
        password: 'TestPassword123!',
        confirmPassword: 'TestPassword123!',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData);

      user = response.body.user;
      
      // Get the verification token from the database
      const dbUser = await User.findById(user.id);
      verificationToken = dbUser!.emailVerificationToken!;
    });

    it('should verify email successfully with valid token', async () => {
      const response = await request(app)
        .get(`/api/auth/verify-email/${verificationToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Email verified successfully');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('emailVerified', true);
      expect(response.body).toHaveProperty('welcomeEmailSent', true);

      // Verify the user is updated in database
      const updatedUser = await User.findById(user.id);
      expect(updatedUser!.emailVerified).toBe(true);
      expect(updatedUser!.emailVerificationToken).toBeUndefined();
      expect(updatedUser!.emailVerificationExpires).toBeUndefined();

      // Verify welcome email was sent
      expect(mockedEmailService.sendWelcomeEmail).toHaveBeenCalledWith(
        user.email,
        user.email
      );
    });

    it('should reject verification with invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/verify-email/invalid-token')
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Invalid or expired token');
    });

    it('should reject verification with expired token', async () => {
      // Manually expire the token
      const dbUser = await User.findById(user.id);
      dbUser!.emailVerificationExpires = new Date(Date.now() - 1000); // 1 second ago
      await dbUser!.save();

      const response = await request(app)
        .get(`/api/auth/verify-email/${verificationToken}`)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Invalid or expired token');
    });

    it('should handle already verified email gracefully', async () => {
      // First verification
      await request(app)
        .get(`/api/auth/verify-email/${verificationToken}`)
        .expect(200);

      // Manually set the user as verified with a token (simulating already verified state)
      const dbUser = await User.findById(user.id);
      dbUser!.emailVerified = true;
      dbUser!.emailVerificationToken = 'some-token';
      dbUser!.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await dbUser!.save();

      // Second verification attempt with the new token
      const response = await request(app)
        .get('/api/auth/verify-email/some-token')
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Email already verified');
      expect(response.body.user).toHaveProperty('emailVerified', true);
    });

    it('should require verification token', async () => {
      const response = await request(app)
        .get('/api/auth/verify-email/')
        .expect(404); // Route not found without token parameter
    });
  });

  describe('POST /api/auth/resend-verification', () => {
    let user: any;

    beforeEach(async () => {
      // Create a user with unverified email
      const userData = {
        email: 'test@example.com',
        password: 'TestPassword123!',
        confirmPassword: 'TestPassword123!',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData);

      user = response.body.user;
    });

    it('should resend verification email for unverified user', async () => {
      const response = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: user.email })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('verification email has been sent');

      // Verify email service was called
      expect(mockedEmailService.sendEmailVerification).toHaveBeenCalledWith({
        email: user.email,
        verificationToken: expect.any(String),
        userName: user.email,
      });
    });

    it('should handle already verified email', async () => {
      // First verify the email
      const dbUser = await User.findById(user.id);
      const verificationToken = dbUser!.emailVerificationToken!;
      
      await request(app)
        .get(`/api/auth/verify-email/${verificationToken}`)
        .expect(200);

      // Try to resend verification
      const response = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: user.email })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Email is already verified');
    });

    it('should handle non-existent email gracefully', async () => {
      // Clear previous mock calls
      jest.clearAllMocks();
      
      const response = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'nonexistent@example.com' })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('verification email has been sent');

      // Should not call email service for non-existent user
      expect(mockedEmailService.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('should require email address', async () => {
      const response = await request(app)
        .post('/api/auth/resend-verification')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Email required');
    });
  });

  describe('Registration with email verification', () => {
    it('should send verification email during registration', async () => {
      const userData = {
        email: 'test@example.com',
        password: 'TestPassword123!',
        confirmPassword: 'TestPassword123!',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body).toHaveProperty('requiresEmailVerification', true);

      // Verify email service was called during registration
      expect(mockedEmailService.sendEmailVerification).toHaveBeenCalledWith({
        email: userData.email,
        verificationToken: expect.any(String),
        userName: userData.email,
      });
    });
  });
});