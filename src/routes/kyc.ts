import express from 'express';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { kycService, KYCSubmissionData, FileUpload } from '@/services/KYCService';
import { authenticate, authorize, selfOrAdmin } from '@/middleware/auth';
import { logger, securityLogger } from '@/utils/logger';

const router = express.Router();

// Configure multer for file uploads (memory storage for encryption)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 10, // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Allow specific file types
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
    ];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${allowedMimeTypes.join(', ')}`));
    }
  },
});

// Rate limiting for KYC endpoints
const kycLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'test' ? 1000 : 5, // 5 submissions per hour
  message: {
    error: 'Too many KYC submissions, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

// Validation middleware for KYC submission
const kycSubmissionValidation = [
  body('firstName')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('First name is required and must be between 1-50 characters'),
  body('lastName')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Last name is required and must be between 1-50 characters'),
  body('dateOfBirth')
    .isISO8601()
    .withMessage('Date of birth must be a valid date'),
  body('nationality')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Nationality is required and must be between 2-50 characters'),
  body('phoneNumber')
    .trim()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Phone number must be a valid international format'),
  body('address.street')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Street address is required and must be between 1-100 characters'),
  body('address.city')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('City is required and must be between 1-50 characters'),
  body('address.state')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('State is required and must be between 1-50 characters'),
  body('address.postalCode')
    .trim()
    .isLength({ min: 1, max: 20 })
    .withMessage('Postal code is required and must be between 1-20 characters'),
  body('address.country')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Country is required and must be between 2-50 characters'),
  body('accreditedInvestor.claimed')
    .optional()
    .isBoolean()
    .withMessage('Accredited investor claim must be a boolean'),
  body('accreditedInvestor.type')
    .optional()
    .isIn(['income', 'net_worth', 'professional', 'entity'])
    .withMessage('Invalid accredited investor type'),
  body('accreditedInvestor.annualIncome')
    .optional()
    .isNumeric()
    .withMessage('Annual income must be a number'),
  body('accreditedInvestor.netWorth')
    .optional()
    .isNumeric()
    .withMessage('Net worth must be a number'),
];

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
 * POST /api/kyc/submit
 * Submit KYC documents and information
 */
router.post('/submit', 
  authenticate,
  //kycLimiter,
  upload.fields([
    { name: 'passport', maxCount: 1 },
    { name: 'drivers_license', maxCount: 1 },
    { name: 'national_id', maxCount: 1 },
    { name: 'proof_of_address', maxCount: 1 },
    { name: 'bank_statement', maxCount: 1 },
    { name: 'accredited_income', maxCount: 3 },
    { name: 'accredited_net_worth', maxCount: 3 },
    { name: 'accredited_professional', maxCount: 3 },
    { name: 'accredited_entity', maxCount: 3 },
  ]),
  kycSubmissionValidation,
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to submit KYC information',
        });
        return;
      }

      // Parse submission data
      const submissionData: KYCSubmissionData = {
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        dateOfBirth: req.body.dateOfBirth,
        nationality: req.body.nationality,
        phoneNumber: req.body.phoneNumber,
        address: {
          street: req.body.address.street,
          city: req.body.address.city,
          state: req.body.address.state,
          postalCode: req.body.address.postalCode,
          country: req.body.address.country,
        },
        accreditedInvestor: req.body.accreditedInvestor ? {
          claimed: req.body.accreditedInvestor.claimed || false,
          type: req.body.accreditedInvestor.type,
          annualIncome: req.body.accreditedInvestor.annualIncome,
          netWorth: req.body.accreditedInvestor.netWorth,
          professionalCertification: req.body.accreditedInvestor.professionalCertification,
          entityType: req.body.accreditedInvestor.entityType,
        } : undefined,
      };

      // Process uploaded files
      const files: FileUpload[] = [];
      if (req.files && typeof req.files === 'object') {
        Object.entries(req.files).forEach(([fieldname, fileArray]) => {
          if (Array.isArray(fileArray)) {
            fileArray.forEach(file => {
              files.push({
                fieldname,
                originalname: file.originalname,
                encoding: file.encoding,
                mimetype: file.mimetype,
                buffer: file.buffer,
                size: file.size,
              });
            });
          }
        });
      }

      // Validate that at least one identity document is uploaded
      const identityDocTypes = ['passport', 'drivers_license', 'national_id'];
      const hasIdentityDoc = files.some(file => identityDocTypes.includes(file.fieldname));

      if (!hasIdentityDoc) {
        res.status(400).json({
          error: 'Missing required documents',
          message: 'At least one identity document (passport, driver\'s license, or national ID) is required',
        });
        return;
      }

      // Submit KYC
      const submission = await kycService.submitKYC(
        req.user.userId,
        submissionData,
        files,
        req.ip
      );

      logger.info('KYC submission successful', {
        userId: req.user.userId,
        submissionId: submission._id,
        documentsCount: files.length,
      });

      res.status(201).json({
        message: 'KYC submission successful',
        submission: {
          id: submission._id,
          status: submission.status,
          submittedAt: submission.submittedAt,
          documentsUploaded: files.length,
        },
      });

    } catch (error) {
      logger.error('KYC submission failed:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          res.status(409).json({
            error: 'KYC already submitted',
            message: 'You have already submitted KYC information. Please check your status.',
          });
          return;
        }
        
        if (error.message.includes('18 years old')) {
          res.status(400).json({
            error: 'Age requirement not met',
            message: 'You must be at least 18 years old to use this platform',
          });
          return;
        }

        if (error.message.includes('Invalid file type') || error.message.includes('File too large')) {
          res.status(400).json({
            error: 'File validation failed',
            message: error.message,
          });
          return;
        }
      }

      res.status(500).json({
        error: 'KYC submission failed',
        message: 'An error occurred while processing your KYC submission. Please try again.',
      });
    }
  }
);

/**
 * GET /api/kyc/status
 * Get KYC status for the authenticated user
 */
router.get('/status', 
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to check KYC status',
        });
        return;
      }

      const kycStatus = await kycService.getKYCStatus(req.user.userId);

      res.json({
        status: kycStatus.status,
        submission: kycStatus.submission ? {
          id: kycStatus.submission._id,
          status: kycStatus.submission.status,
          submittedAt: kycStatus.submission.submittedAt,
          reviewedAt: kycStatus.submission.reviewedAt,
          rejectionReason: kycStatus.submission.rejectionReason,
          additionalInfoRequired: kycStatus.submission.additionalInfoRequired,
          accreditedInvestorClaimed: kycStatus.submission.accreditedInvestor.claimed,
        } : null,
      });

    } catch (error) {
      logger.error('Failed to get KYC status:', error);
      res.status(500).json({
        error: 'Failed to get KYC status',
        message: 'An error occurred while retrieving your KYC status',
      });
    }
  }
);

/**
 * GET /api/kyc/document/:submissionId/:filename
 * Download a KYC document (user can access their own, admins can access any)
 */
router.get('/document/:submissionId/:filename',
  authenticate,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please log in to access documents',
        });
        return;
      }

      const { submissionId, filename } = req.params;

      const document = await kycService.getEncryptedDocument(
        submissionId,
        filename,
        req.user.userId
      );

      // Set appropriate headers for file download
      res.setHeader('Content-Type', document.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${document.originalName}"`);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.send(document.buffer);

    } catch (error) {
      logger.error('Failed to retrieve KYC document:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            error: 'Document not found',
            message: 'The requested document could not be found',
          });
          return;
        }
        
        if (error.message.includes('Unauthorized')) {
          res.status(403).json({
            error: 'Access denied',
            message: 'You do not have permission to access this document',
          });
          return;
        }
      }

      res.status(500).json({
        error: 'Failed to retrieve document',
        message: 'An error occurred while retrieving the document',
      });
    }
  }
);

export default router;