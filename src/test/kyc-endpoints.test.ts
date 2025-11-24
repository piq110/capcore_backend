import request from 'supertest';
import app from '../index';
import { User } from '../models/User';
import { KYCSubmission } from '../models/KYC';
import { generateTokenPair } from '../utils/jwt';

describe('KYC Endpoints', () => {
  let testUser: any;
  let authToken: string;
  let adminUser: any;
  let adminToken: string;

  beforeAll(async () => {
    // Create test user
    testUser = new User({
      email: 'kyctest@example.com',
      passwordHash: 'hashedpassword123',
      emailVerified: true,
      kycStatus: 'not_started',
      role: 'user',
    });
    await testUser.save();

    // Create admin user
    adminUser = new User({
      email: 'admin@example.com',
      passwordHash: 'hashedpassword123',
      emailVerified: true,
      kycStatus: 'approved',
      role: 'admin',
    });
    await adminUser.save();

    // Generate tokens
    const userTokens = generateTokenPair({
      userId: testUser._id.toString(),
      email: testUser.email,
      role: testUser.role,
      kycStatus: testUser.kycStatus,
      emailVerified: testUser.emailVerified,
    });
    authToken = userTokens.accessToken;

    const adminTokens = generateTokenPair({
      userId: adminUser._id.toString(),
      email: adminUser.email,
      role: adminUser.role,
      kycStatus: adminUser.kycStatus,
      emailVerified: adminUser.emailVerified,
    });
    adminToken = adminTokens.accessToken;
  });

  afterAll(async () => {
    // Clean up test data
    await User.deleteMany({ email: { $in: ['kyctest@example.com', 'admin@example.com'] } });
    await KYCSubmission.deleteMany({ userId: { $in: [testUser._id, adminUser._id] } });
  });

  describe('GET /api/kyc/status', () => {
    it('should return KYC status for authenticated user', async () => {
      const response = await request(app)
        .get('/api/kyc/status')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('status', 'not_started');
      expect(response.body).toHaveProperty('submission', null);
    });

    it('should require authentication', async () => {
      await request(app)
        .get('/api/kyc/status')
        .expect(401);
    });
  });

  describe('POST /api/kyc/submit', () => {
    it('should require authentication', async () => {
      await request(app)
        .post('/api/kyc/submit')
        .expect(401);
    });

    it('should require at least one identity document', async () => {
      const kycData = {
        firstName: 'John',
        lastName: 'Doe',
        dateOfBirth: '1990-01-01',
        nationality: 'US',
        phoneNumber: '+1234567890',
        address: {
          street: '123 Main St',
          city: 'New York',
          state: 'NY',
          postalCode: '10001',
          country: 'US',
        },
      };

      const response = await request(app)
        .post('/api/kyc/submit')
        .set('Authorization', `Bearer ${authToken}`)
        .field('firstName', kycData.firstName)
        .field('lastName', kycData.lastName)
        .field('dateOfBirth', kycData.dateOfBirth)
        .field('nationality', kycData.nationality)
        .field('phoneNumber', kycData.phoneNumber)
        .field('address[street]', kycData.address.street)
        .field('address[city]', kycData.address.city)
        .field('address[state]', kycData.address.state)
        .field('address[postalCode]', kycData.address.postalCode)
        .field('address[country]', kycData.address.country)
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Missing required documents');
    });
  });

  describe('GET /api/admin/kyc/pending', () => {
    it('should require admin authentication', async () => {
      await request(app)
        .get('/api/admin/kyc/pending')
        .set('Authorization', `Bearer ${authToken}`) // Regular user token
        .expect(403);
    });

    it('should return pending submissions for admin', async () => {
      const response = await request(app)
        .get('/api/admin/kyc/pending')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('submissions');
      expect(response.body).toHaveProperty('pagination');
      expect(Array.isArray(response.body.submissions)).toBe(true);
    });
  });

  describe('PUT /api/admin/kyc/:id/approve', () => {
    it('should require admin authentication', async () => {
      await request(app)
        .put('/api/admin/kyc/123/approve')
        .set('Authorization', `Bearer ${authToken}`) // Regular user token
        .expect(403);
    });

    it('should return 404 for non-existent submission', async () => {
      const response = await request(app)
        .put('/api/admin/kyc/507f1f77bcf86cd799439011/approve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ notes: 'Test approval' })
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Submission not found');
    });
  });

  describe('PUT /api/admin/kyc/:id/reject', () => {
    it('should require admin authentication', async () => {
      await request(app)
        .put('/api/admin/kyc/123/reject')
        .set('Authorization', `Bearer ${authToken}`) // Regular user token
        .expect(403);
    });

    it('should require rejection reason', async () => {
      const response = await request(app)
        .put('/api/admin/kyc/507f1f77bcf86cd799439011/reject')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ notes: 'Test rejection' })
        .expect(400);

      expect(response.body).toHaveProperty('error', 'Validation failed');
    });
  });
});