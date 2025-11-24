import { database } from '../utils/database';
import { User, Wallet, InvestmentProduct, Order, Portfolio } from '../models';
import mongoose from 'mongoose';

describe('Database Connection and Models', () => {
  beforeAll(async () => {
    // Use test database
    process.env.MONGODB_URI = 'mongodb://localhost:27017/aim_test';
    await database.connect();
  });

  afterAll(async () => {
    // Clean up test database
    await mongoose.connection.dropDatabase();
    await database.disconnect();
  });

  beforeEach(async () => {
    // Clear all collections before each test
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
    // Also drop indexes to ensure clean state
    for (const key in collections) {
      try {
        await collections[key].dropIndexes();
      } catch (error) {
        // Ignore errors if indexes don't exist
      }
    }
  });

  describe('Database Connection', () => {
    it('should connect to MongoDB', () => {
      expect(database.isConnectionActive()).toBe(true);
    });

    it('should have correct connection state', () => {
      expect(mongoose.connection.readyState).toBe(1); // Connected
    });
  });

  describe('User Model', () => {
    it('should create a user with valid data', async () => {
      const userData = {
        email: 'test@example.com',
        passwordHash: 'hashedpassword123',
      };

      const user = new User(userData);
      await user.save();

      expect(user._id).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.emailVerified).toBe(false);
      expect(user.kycStatus).toBe('not_started');
      expect(user.role).toBe('user');
    });

    it('should have unique email index', async () => {
      const userData = {
        email: 'unique@example.com',
        passwordHash: 'hashedpassword123',
      };

      const user = new User(userData);
      await user.save();
      
      expect(user._id).toBeDefined();
      expect(user.email).toBe('unique@example.com');
    });

    it('should validate email format', async () => {
      const userData = {
        email: 'invalid-email',
        passwordHash: 'hashedpassword123',
      };

      const user = new User(userData);
      await expect(user.save()).rejects.toThrow();
    });
  });

  describe('Wallet Model', () => {
    it('should create a wallet with valid addresses', async () => {
      const user = await new User({
        email: 'wallet@example.com',
        passwordHash: 'hashedpassword123',
      }).save();

      const walletData = {
        userId: user._id,
        addresses: {
          ethereum: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b1',
          tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          bsc: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b2',
        },
      };

      const wallet = new Wallet(walletData);
      await wallet.save();

      expect(wallet._id).toBeDefined();
      expect(wallet.userId.toString()).toBe((user._id as any).toString());
      expect(wallet.totalBalanceUSD).toBe(0);
      expect(wallet.getTotalBalance()).toBe(0);
    });

    it('should validate address formats', async () => {
      const user = await new User({
        email: 'wallet2@example.com',
        passwordHash: 'hashedpassword123',
      }).save();

      const walletData = {
        userId: user._id,
        addresses: {
          ethereum: 'invalid-eth-address',
          tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          bsc: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b2',
        },
      };

      const wallet = new Wallet(walletData);
      await expect(wallet.save()).rejects.toThrow();
    });
  });

  describe('InvestmentProduct Model', () => {
    it('should create an investment product with valid data', async () => {
      const issuer = await new User({
        email: 'issuer@example.com',
        passwordHash: 'hashedpassword123',
        role: 'issuer',
      }).save();

      const productData = {
        name: 'Test REIT Fund',
        symbol: 'TREIT',
        type: 'REIT',
        description: 'A test REIT for unit testing',
        strategy: 'Commercial real estate investment',
        sharePrice: 100.00,
        totalShares: 1000000,
        availableShares: 500000,
        minimumInvestment: 1000,
        fees: {
          managementFee: 2.0,
          performanceFee: 20.0,
          acquisitionFee: 1.0,
          dispositionFee: 1.0,
        },
        issuerId: issuer._id,
        nav: 100.00,
      };

      const product = new InvestmentProduct(productData);
      await product.save();

      expect(product._id).toBeDefined();
      expect(product.symbol).toBe('TREIT');
      expect(product.getMarketCap()).toBe(100000000); // 1M shares * $100
      expect(product.getAvailabilityPercentage()).toBe(50); // 500k/1M * 100
    });

    it('should have unique symbol index', async () => {
      const issuer = await new User({
        email: 'issuer2@example.com',
        passwordHash: 'hashedpassword123',
        role: 'issuer',
      }).save();

      const productData = {
        name: 'Test REIT Fund',
        symbol: 'UNIQUE',
        type: 'REIT',
        description: 'A test REIT for unit testing',
        strategy: 'Commercial real estate investment',
        sharePrice: 100.00,
        totalShares: 1000000,
        availableShares: 500000,
        issuerId: issuer._id,
        fees: { managementFee: 2.0, performanceFee: 0, acquisitionFee: 0, dispositionFee: 0 },
        nav: 100.00,
      };

      const product = new InvestmentProduct(productData);
      await product.save();
      
      expect(product._id).toBeDefined();
      expect(product.symbol).toBe('UNIQUE');
    });
  });

  describe('Order Model', () => {
    it('should create an order with valid data', async () => {
      const user = await new User({
        email: 'trader@example.com',
        passwordHash: 'hashedpassword123',
      }).save();

      const issuer = await new User({
        email: 'issuer3@example.com',
        passwordHash: 'hashedpassword123',
        role: 'issuer',
      }).save();

      const product = await new InvestmentProduct({
        name: 'Test BDC Fund',
        symbol: 'TBDC',
        type: 'BDC',
        description: 'A test BDC for unit testing',
        strategy: 'Business development company',
        sharePrice: 50.00,
        totalShares: 500000,
        availableShares: 250000,
        issuerId: issuer._id,
        fees: { managementFee: 2.5, performanceFee: 0, acquisitionFee: 0, dispositionFee: 0 },
        nav: 50.00,
      }).save();

      const orderData = {
        userId: user._id,
        productId: product._id,
        type: 'buy',
        quantity: 100,
        pricePerShare: 50.00,
        totalAmount: 5000,
        remainingQuantity: 100,
      };

      const order = new Order(orderData);
      await order.save();

      expect(order._id).toBeDefined();
      expect(order.totalAmount).toBe(5000); // 100 * $50
      expect(order.remainingQuantity).toBe(100);
      expect(order.status).toBe('pending');
    });
  });

  describe('Portfolio Model', () => {
    it('should create a portfolio and manage holdings', async () => {
      const user = await new User({
        email: 'investor@example.com',
        passwordHash: 'hashedpassword123',
      }).save();

      const issuer = await new User({
        email: 'issuer4@example.com',
        passwordHash: 'hashedpassword123',
        role: 'issuer',
      }).save();

      const product = await new InvestmentProduct({
        name: 'Portfolio Test REIT',
        symbol: 'PTREIT',
        type: 'REIT',
        description: 'A test REIT for portfolio testing',
        strategy: 'Portfolio management testing',
        sharePrice: 25.00,
        totalShares: 1000000,
        availableShares: 500000,
        issuerId: issuer._id,
        fees: { managementFee: 1.5, performanceFee: 0, acquisitionFee: 0, dispositionFee: 0 },
        nav: 25.00,
      }).save();

      const portfolio = new Portfolio({
        userId: user._id,
        cashBalance: 10000,
      });

      // Add holding
      portfolio.addHolding(product._id as any, 100, 25.00);
      await portfolio.save();

      expect(portfolio.holdings).toHaveLength(1);
      expect(portfolio.totalValue).toBe(12500); // $10k cash + $2.5k investment
      expect(portfolio.totalInvested).toBe(2500);
      
      const holding = portfolio.getHolding(product._id as any);
      expect(holding?.quantity).toBe(100);
      expect(holding?.averageCost).toBe(25.00);
    });
  });
});