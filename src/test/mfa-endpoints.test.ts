import request from 'supertest';
import mongoose from 'mongoose';
import app from '../index';
import { User } from '@/models/User';
import { database } from '@/utils/database';
import { mfaService } from '@/services/MFAService';
import { emailService } from '@/services/EmailService';

// Mock the email service
jest.mock('@/services/EmailService', () => ({
  emailService: {
    sendEmailVerification: jest.fn().mockResolvedValue(true),
    sendWelcomeEmail: jest.fn().mockResolvedValue(true),
    sendNotificationEmail: jest.fn().mockResolvedValue(true),
  },
}));

const mockedEmailService = emailService as jest.Mocked<typeof emailService>;

describe('MFA Endpoints', () => {
  let testUser: any;
  let testUserEmail: string;
  let testUserPassword: string;

  beforeAll(async () => {
    // Connect to test database
    await database.connect();
  });

  beforeEach(async () => {
    // Clear users collection and reset mocks before each test
    await User.deleteMany({});
    jest.clearAllMocks();

    // Create a test user
    testUserEmail = 'mfa-test@example.com';
    testUserPassword = 'TestPassword123!';

    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: testUserEmail,
        password: testUserPassword,
        confirmPassword: testUserPassword,
      });

    testUser = response.body.user;

    // Verify the user's email
    const dbUser = await User.findById(testUser.id);
    const verificationToken = dbUser!.emailVerificationToken!;
    
    await request(app)
      .get(`/api/auth/verify-email/${verificationToken}`)
      .expect(200);
  });

  afterAll(async () => {
    // Clean up and close database connection
    await User.deleteMany({});
    await mongoose.connection.close();
  });

  describe('POST /api/auth/setup-mfa', () => {
    it('should set up MFA successfully for valid user', async () => {
      const response = await request(app)
        .post('/api/auth/setup-mfa')
        .send({ email: testUserEmail })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'MFA setup initiated');
      expect(response.body).toHaveProperty('setup');
      expect(response.body.setup).toHaveProperty('qrCodeUrl');
      expect(response.body.setup).toHaveProperty('manualEntryKey');
      expect(response.body.setup).toHaveProperty('backupCodes');
      expect(response.body).toHaveProperty('instructions');

      // Verify backup codes are generated
      expect(response.body.setup.backupCodes).toHaveLength(10);

      // Verify user has MFA secret stored
      const updatedUser = await User.findById(testUser.id).select('+mfaSecret +mfaBackupCodes');
      expect(updatedUser!.mfaSecret).toBeDefined();
      expect(updatedUser!.mfaBackupCodes).toHaveLength(10);
      expect(updatedUser!.mfaEnabled).toBe(false); // Not enabled until verified
    });

    it('should reject MFA setup for non-existent user', async () => {
      const response = await request(app)
        .post('/api/auth/setup-mfa')
        .send({ email: 'nonexistent@example.com' })
        .expect(404);

      expect(response.body).toHaveProperty('error', 'User not found');
    });

    it('should reject MFA setup if already enabled', async () => {
      // First setup
      await request(app)
        .post('/api/auth/setup-mfa')
        .send({ email: testUserEmail })
        .expect(200);

      // Enable MFA
      const user = await User.findById(testUser.id);
      user!.mfaEnabled = true;
      await user!.save();

      // Try to setup again
      const response = await request(app)
        .post('/api/auth/setup-mfa')
        .send({ email: testUserEmail })
        .expect(409);

      expect(response.body).toHaveProperty('error', 'MFA already enabled');
    });

    it('should require email address', async () => {
      const response = await request(app)
        .post('/api/auth/setup-mfa')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Email required');
    });
  });

  describe('POST /api/auth/verify-mfa', () => {
    let mfaSecret: string;
    let backupCodes: string[];

    beforeEach(async () => {
      // Set up MFA for the test user
      const setupResponse = await request(app)
        .post('/api/auth/setup-mfa')
        .send({ email: testUserEmail });

      const user = await User.findById(testUser.id).select('+mfaSecret +mfaBackupCodes');
      mfaSecret = user!.mfaSecret!;
      backupCodes = user!.mfaBackupCodes!;
    });

    it('should verify MFA setup with valid TOTP token', async () => {
      const validToken = mfaService.generateCurrentTOTP(mfaSecret);

      const response = await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: testUserEmail,
          token: validToken,
          isSetup: true,
        })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'MFA setup completed successfully');
      expect(response.body).toHaveProperty('mfaEnabled', true);
      expect(response.body).toHaveProperty('remainingBackupCodes', 10);

      // Verify user has MFA enabled
      const updatedUser = await User.findById(testUser.id);
      expect(updatedUser!.mfaEnabled).toBe(true);
    });

    it('should verify MFA setup with valid backup code', async () => {
      const backupCode = backupCodes[0];

      const response = await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: testUserEmail,
          token: backupCode,
          isSetup: true,
        })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'MFA setup completed successfully');
      expect(response.body).toHaveProperty('mfaEnabled', true);
      expect(response.body).toHaveProperty('remainingBackupCodes', 9); // One used

      // Verify backup code was removed
      const updatedUser = await User.findById(testUser.id).select('+mfaBackupCodes');
      expect(updatedUser!.mfaBackupCodes).toHaveLength(9);
      expect(updatedUser!.mfaBackupCodes).not.toContain(backupCode);
    });

    it('should authenticate with MFA after setup', async () => {
      // First complete MFA setup
      const validToken = mfaService.generateCurrentTOTP(mfaSecret);
      await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: testUserEmail,
          token: validToken,
          isSetup: true,
        });

      // Now authenticate with MFA
      const authToken = mfaService.generateCurrentTOTP(mfaSecret);
      const response = await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: testUserEmail,
          token: authToken,
          isSetup: false,
        })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'MFA verification successful');
      expect(response.body).toHaveProperty('usedBackupCode', false);
    });

    it('should reject invalid MFA token', async () => {
      const response = await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: testUserEmail,
          token: '123456', // Invalid token
          isSetup: true,
        })
        .expect(401);

      expect(response.body).toHaveProperty('error', 'Invalid token');
    });

    it('should reject MFA verification for non-existent user', async () => {
      const response = await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: 'nonexistent@example.com',
          token: '123456',
          isSetup: true,
        })
        .expect(404);

      expect(response.body).toHaveProperty('error', 'User not found');
    });

    it('should require email and token', async () => {
      const response = await request(app)
        .post('/api/auth/verify-mfa')
        .send({ email: testUserEmail })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Missing required fields');
    });
  });

  describe('POST /api/auth/disable-mfa', () => {
    let mfaSecret: string;

    beforeEach(async () => {
      // Set up and enable MFA for the test user
      const setupResponse = await request(app)
        .post('/api/auth/setup-mfa')
        .send({ email: testUserEmail });

      const user = await User.findById(testUser.id).select('+mfaSecret');
      mfaSecret = user!.mfaSecret!;

      // Complete MFA setup
      const validToken = mfaService.generateCurrentTOTP(mfaSecret);
      await request(app)
        .post('/api/auth/verify-mfa')
        .send({
          email: testUserEmail,
          token: validToken,
          isSetup: true,
        });
    });

    it('should disable MFA with valid credentials and token', async () => {
      const validToken = mfaService.generateCurrentTOTP(mfaSecret);

      const response = await request(app)
        .post('/api/auth/disable-mfa')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          token: validToken,
        })
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Multi-factor authentication has been disabled');
      expect(response.body).toHaveProperty('mfaEnabled', false);

      // Verify MFA is disabled in database
      const updatedUser = await User.findById(testUser.id).select('+mfaSecret +mfaBackupCodes');
      expect(updatedUser!.mfaEnabled).toBe(false);
      expect(updatedUser!.mfaSecret).toBeUndefined();
      expect(updatedUser!.mfaBackupCodes).toHaveLength(0);

      // Verify notification email was sent
      expect(mockedEmailService.sendNotificationEmail).toHaveBeenCalledWith({
        email: testUserEmail,
        userName: testUserEmail,
        action: 'Multi-Factor Authentication Disabled',
        details: 'MFA has been disabled for your account',
        timestamp: expect.any(Date),
      });
    });

    it('should reject MFA disable with invalid password', async () => {
      const validToken = mfaService.generateCurrentTOTP(mfaSecret);

      const response = await request(app)
        .post('/api/auth/disable-mfa')
        .send({
          email: testUserEmail,
          password: 'WrongPassword123!',
          token: validToken,
        })
        .expect(401);

      expect(response.body).toHaveProperty('error', 'Invalid credentials');
    });

    it('should reject MFA disable with invalid token', async () => {
      const response = await request(app)
        .post('/api/auth/disable-mfa')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          token: '123456',
        })
        .expect(401);

      expect(response.body).toHaveProperty('error', 'Invalid token');
    });

    it('should require all fields', async () => {
      const response = await request(app)
        .post('/api/auth/disable-mfa')
        .send({
          email: testUserEmail,
          password: testUserPassword,
        })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Missing required fields');
    });
  });
});