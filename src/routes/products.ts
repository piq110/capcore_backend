import express from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { authenticate, authorize } from '@/middleware/auth';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

const router = express.Router();

// Helper function to handle validation errors
const handleValidationErrors = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.type === 'field' ? err.path : 'unknown',
        message: err.msg,
      })),
    });
    return;
  }
  next();
};

/**
 * GET /api/products
 * Browse available investment products (public endpoint with optional filtering)
 */
router.get('/',
  [
    query('type')
      .optional()
      .isIn(['REIT', 'BDC'])
      .withMessage('Type must be either REIT or BDC'),
    query('status')
      .optional()
      .isIn(['active', 'on_hold', 'inactive'])
      .withMessage('Invalid status'),
    query('minPrice')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Minimum price must be non-negative'),
    query('maxPrice')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Maximum price must be non-negative'),
    query('sector')
      .optional()
      .isString()
      .trim()
      .withMessage('Sector must be a string'),
    query('geography')
      .optional()
      .isString()
      .trim()
      .withMessage('Geography must be a string'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be non-negative'),
    query('sortBy')
      .optional()
      .isIn(['name', 'sharePrice', 'createdAt', 'nav', 'targetReturn'])
      .withMessage('Invalid sort field'),
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort order must be asc or desc'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const {
        type,
        status = 'active',
        minPrice,
        maxPrice,
        sector,
        geography,
        limit = 20,
        offset = 0,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;

      // Build filter
      const filter: any = {};
      
      // Only show active products to public unless admin
      if (req.user?.role === 'admin') {
        if (status) filter.status = status;
      } else {
        filter.status = 'active';
      }

      if (type) filter.type = type;
      if (sector) filter.sector = new RegExp(sector as string, 'i');
      if (geography) filter.geography = new RegExp(geography as string, 'i');
      
      if (minPrice || maxPrice) {
        filter.sharePrice = {};
        if (minPrice) filter.sharePrice.$gte = parseFloat(minPrice as string);
        if (maxPrice) filter.sharePrice.$lte = parseFloat(maxPrice as string);
      }

      // Build sort
      const sort: any = {};
      sort[sortBy as string] = sortOrder === 'asc' ? 1 : -1;

      const [products, total] = await Promise.all([
        InvestmentProduct.find(filter)
          .populate('issuerId', 'email companyName')
          .sort(sort)
          .limit(parseInt(limit as string))
          .skip(parseInt(offset as string))
          .lean(),
        InvestmentProduct.countDocuments(filter)
      ]);

      logger.info('Products browsed', {
        userId: req.user?.userId || 'anonymous',
        filters: { type, status, minPrice, maxPrice, sector, geography },
        resultCount: products.length,
        total
      });

      res.json({
        success: true,
        data: {
          products: products.map(product => ({
            id: product._id,
            name: product.name,
            symbol: product.symbol,
            type: product.type,
            description: product.description,
            strategy: product.strategy,
            sharePrice: product.sharePrice,
            totalShares: product.totalShares,
            availableShares: product.availableShares,
            minimumInvestment: product.minimumInvestment,
            fees: product.fees,
            status: product.status,
            sector: product.sector,
            geography: product.geography,
            targetReturn: product.targetReturn,
            distributionFrequency: product.distributionFrequency,
            nav: product.nav,
            navDate: product.navDate,
            overviewData: product.overviewData,
            createdAt: product.createdAt,
            issuer: (product as any).issuerId,
            // Calculated fields
            marketCap: product.totalShares * product.sharePrice,
            availabilityPercentage: (product.availableShares / product.totalShares) * 100,
            isAvailableForTrading: product.status === 'active' && product.availableShares > 0,
            // Only show document count for security
            documentsCount: product.documents?.length || 0,
          })),
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + parseInt(limit as string) < total,
          },
          filters: {
            availableTypes: ['REIT', 'BDC'],
            availableStatuses: req.user?.role === 'admin' ? ['active', 'on_hold', 'inactive'] : ['active'],
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get products:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load investment products'
      });
    }
  }
);

/**
 * GET /api/products/:id
 * Get detailed product information
 */
router.get('/:id',
  [
    param('id').isMongoId().withMessage('Invalid product ID'),
  ],
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const productId = req.params.id;

      const product = await InvestmentProduct.findById(productId)
        .populate('issuerId', 'email companyName contactInfo');

      if (!product) {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      // Check if user can view this product
      if (product.status !== 'active' && req.user?.role !== 'admin') {
        res.status(404).json({
          success: false,
          message: 'Investment product not found'
        });
        return;
      }

      logger.info('Product details accessed', {
        userId: req.user?.userId || 'anonymous',
        productId,
        productName: product.name,
        productType: product.type
      });

      res.json({
        success: true,
        data: {
          product: {
            id: product._id,
            name: product.name,
            symbol: product.symbol,
            type: product.type,
            description: product.description,
            strategy: product.strategy,
            sharePrice: product.sharePrice,
            totalShares: product.totalShares,
            availableShares: product.availableShares,
            minimumInvestment: product.minimumInvestment,
            fees: product.fees,
            documents: product.documents.map(doc => ({
              name: doc.name,
              type: doc.type,
              uploadedAt: doc.uploadedAt,
              // URL only for authenticated users
              url: req.user ? doc.url : null
            })),
            status: product.status,
            cusip: product.cusip,
            isin: product.isin,
            sector: product.sector,
            geography: product.geography,
            targetReturn: product.targetReturn,
            distributionFrequency: product.distributionFrequency,
            lastDistributionDate: product.lastDistributionDate,
            nextDistributionDate: product.nextDistributionDate,
            nav: product.nav,
            navDate: product.navDate,
            overviewData: product.overviewData,
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
            issuer: (product as any).issuerId,
            // Calculated fields
            marketCap: product.getMarketCap(),
            availabilityPercentage: product.getAvailabilityPercentage(),
            isAvailableForTrading: product.isAvailableForTrading(),
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get product details:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to load product details'
      });
    }
  }
);

export default router;