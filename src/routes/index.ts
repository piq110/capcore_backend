import express from 'express';
import authRoutes from './auth';
import kycRoutes from './kyc';
import adminRoutes from './admin';
import userRoutes from './user';
import tradingRoutes from './trading';
import walletRoutes from './wallet';
import productsRoutes from './products';
import portfolioRoutes from './portfolio';
import custodialRoutes from './custodial';

const router = express.Router();

// Mount auth routes
router.use('/auth', authRoutes);

// Mount KYC routes
router.use('/kyc', kycRoutes);

// Mount admin routes
router.use('/admin', adminRoutes);

// Mount user routes
router.use('/user', userRoutes);

// Mount trading routes
router.use('/trading', tradingRoutes);

// Mount wallet routes
router.use('/wallet', walletRoutes);

// Mount products routes
router.use('/products', productsRoutes);

// Mount portfolio routes
router.use('/portfolio', portfolioRoutes);

// Mount custodial routes
router.use('/custodial', custodialRoutes);

// Health check for API routes
router.get('/', (req, res) => {
  res.json({
    message: 'Capital Core API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      kyc: '/api/kyc',
      admin: '/api/admin',
      user: '/api/user',
      trading: '/api/trading',
      wallet: '/api/wallet',
      products: '/api/products',
      portfolio: '/api/portfolio',
      custodial: '/api/custodial',
    },
  });
});

export default router;