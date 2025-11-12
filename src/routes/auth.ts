import express from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { User, IUser } from '@/models/User';
import { generateTokenPair } from '@/utils/jwt';
import { logger, securityLogger } from '@/utils/logger';
import { emailService } from '@/services/EmailService';
import { mfaService } from '@/services/MFAService';
import { walletService } from '@/services/WalletService';
import config from '@/config';

const router = express.Router();

// Rate limiting for auth endpoints (disabled in test environment)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 5, // Higher limit for tests
  message: {
    error: 'Too many authentication attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test', // Skip rate limiting in test environment
});

// Validation middleware
const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Password confirmation does not match password');
      }
      return true;
    }),
];

const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
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
 * POST /api/auth/register
 * Register a new user account
 */
router.post('/register', authLimiter, registerValidation, handleValidationErrors, async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      securityLogger.warn('Registration attempt with existing email', {
        email,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      res.status(409).json({
        error: 'User already exists',
        message: 'An account with this email address already exists',
      });
      return;
    }

    // Create new user
    const user = new User({
      email,
      passwordHash: password, // Will be hashed by pre-save middleware
      emailVerified: false,
      mfaEnabled: false,
      kycStatus: 'not_started',
      accreditedInvestor: false,
      role: 'user',
      status: 'active',
    });

    // Generate email verification token
    const verificationToken = user.generateEmailVerificationToken();
    
    // Save user to database
    await user.save();

    // Create wallet for the new user
    try {
      await walletService.generateMultiChainWallet((user._id as any).toString());
      logger.info('Wallet created for new user', {
        userId: user._id,
        email: user.email,
      });
    } catch (walletError) {
      // Log wallet creation error but don't fail registration
      logger.error('Failed to create wallet during registration', {
        userId: user._id,
        email: user.email,
        error: walletError,
      });
      // Wallet can be created later if needed
    }

    // Log successful registration
    logger.info('User registered successfully', {
      userId: user._id,
      email: user.email,
    });

    securityLogger.info('New user registration', {
      userId: user._id,
      email: user.email,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    // Generate tokens for immediate login
    const tokenPair = generateTokenPair({
      userId: (user._id as any).toString(),
      email: user.email,
      role: user.role,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
      accreditedInvestor: user.accreditedInvestor,
    });

    // Send verification email
    const emailSent = await emailService.sendEmailVerification({
      email: user.email,
      verificationToken,
      userName: user.email,
    });

    if (!emailSent) {
      logger.warn('Failed to send verification email', {
        userId: user._id,
        email: user.email,
      });
    }

    logger.info('Email verification token generated and email sent', {
      userId: user._id,
      emailSent,
    });

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        role: user.role,
        createdAt: user.createdAt,
      },
      tokens: tokenPair,
      requiresEmailVerification: true,
      stage: config.stage,
    });

  } catch (error) {
    logger.error('Registration failed:', error);
    
    // Handle duplicate key error (race condition)
    if ((error as any).code === 11000) {
      res.status(409).json({
        error: 'User already exists',
        message: 'An account with this email address already exists',
      });
      return;
    }

    res.status(500).json({
      error: 'Registration failed',
      message: 'An error occurred during registration. Please try again.',
    });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and return tokens
 */
router.post('/login', authLimiter, loginValidation, handleValidationErrors, async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      securityLogger.warn('Login attempt with non-existent email', {
        email,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      res.status(401).json({
        error: 'Invalid credentials',
        message: 'Email or password is incorrect',
      });
      return;
    }

    // Check if account is active
    if (user.status !== 'active') {
      securityLogger.warn('Login attempt with inactive account', {
        userId: user._id,
        email: user.email,
        status: user.status,
        ip: req.ip,
      });
      res.status(403).json({
        error: 'Account inactive',
        message: 'Your account has been suspended or deactivated. Please contact support.',
      });
      return;
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      securityLogger.warn('Login attempt with invalid password', {
        userId: user._id,
        email: user.email,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      res.status(401).json({
        error: 'Invalid credentials',
        message: 'Email or password is incorrect',
      });
      return;
    }

    // Update last login timestamp
    user.lastLoginAt = new Date();
    await user.save();

    // Generate tokens
    const tokenPair = generateTokenPair({
      userId: (user._id as any).toString(),
      email: user.email,
      role: user.role,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
      accreditedInvestor: user.accreditedInvestor,
    });

    // Log successful login
    logger.info('User logged in successfully', {
      userId: user._id,
      email: user.email,
    });

    securityLogger.info('Successful login', {
      userId: user._id,
      email: user.email,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      lastLoginAt: user.lastLoginAt,
    });

    res.json({
      message: 'Login successful',
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        mfaEnabled: user.mfaEnabled,
        role: user.role,
        lastLoginAt: user.lastLoginAt,
      },
      tokens: tokenPair,
      requiresEmailVerification: !user.emailVerified,
      requiresMFA: user.mfaEnabled,
      stage: config.stage,
    });

  } catch (error) {
    logger.error('Login failed:', error);
    res.status(500).json({
      error: 'Login failed',
      message: 'An error occurred during login. Please try again.',
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({
        error: 'Refresh token required',
        message: 'Please provide a refresh token',
      });
      return;
    }

    // TODO: Implement refresh token validation and new token generation
    // This will be enhanced when we implement the RefreshTokenService
    
    res.status(501).json({
      error: 'Not implemented',
      message: 'Refresh token functionality will be implemented in a future update',
    });

  } catch (error) {
    logger.error('Token refresh failed:', error);
    res.status(500).json({
      error: 'Token refresh failed',
      message: 'An error occurred while refreshing the token',
    });
  }
});

/**
 * GET /api/auth/verify-email/:token
 * Verify user email address using token
 */
router.get('/verify-email/:token', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { token } = req.params;

    if (!token) {
      res.status(400).json({
        error: 'Verification token required',
        message: 'Please provide a valid verification token',
      });
      return;
    }

    // Find user with matching verification token
    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      securityLogger.warn('Invalid or expired email verification attempt', {
        token,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      res.status(400).json({
        error: 'Invalid or expired token',
        message: 'The verification link is invalid or has expired. Please request a new verification email.',
      });
      return;
    }

    // Check if email is already verified
    if (user.emailVerified) {
      res.json({
        message: 'Email already verified',
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          phoneNumber: user.phoneNumber,
          emailVerified: user.emailVerified,
        },
      });
      return;
    }

    // Mark email as verified and clear verification token
    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    // Send welcome email
    const welcomeEmailSent = await emailService.sendWelcomeEmail(user.email, user.email);
    if (!welcomeEmailSent) {
      logger.warn('Failed to send welcome email', {
        userId: user._id,
        email: user.email,
      });
    }

    // Log successful verification
    logger.info('Email verified successfully', {
      userId: user._id,
      email: user.email,
    });

    securityLogger.info('Email verification completed', {
      userId: user._id,
      email: user.email,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      message: 'Email verified successfully',
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
      },
      welcomeEmailSent,
    });

  } catch (error) {
    logger.error('Email verification failed:', error);
    res.status(500).json({
      error: 'Verification failed',
      message: 'An error occurred during email verification. Please try again.',
    });
  }
});

/**
 * POST /api/auth/resend-verification
 * Resend email verification email
 */
router.post('/resend-verification', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({
        error: 'Email required',
        message: 'Please provide an email address',
      });
      return;
    }

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists or not for security
      res.json({
        message: 'If an account with this email exists and is not verified, a verification email has been sent.',
      });
      return;
    }

    // Check if email is already verified
    if (user.emailVerified) {
      res.json({
        message: 'Email is already verified',
      });
      return;
    }

    // Generate new verification token
    const verificationToken = user.generateEmailVerificationToken();
    await user.save();

    // Send verification email
    const emailSent = await emailService.sendEmailVerification({
      email: user.email,
      verificationToken,
      userName: user.email,
    });

    if (!emailSent) {
      logger.warn('Failed to resend verification email', {
        userId: user._id,
        email: user.email,
      });
    }

    logger.info('Verification email resent', {
      userId: user._id,
      email: user.email,
      emailSent,
    });

    res.json({
      message: 'If an account with this email exists and is not verified, a verification email has been sent.',
    });

  } catch (error) {
    logger.error('Failed to resend verification email:', error);
    res.status(500).json({
      error: 'Resend failed',
      message: 'An error occurred while resending the verification email. Please try again.',
    });
  }
});

/**
 * POST /api/auth/setup-mfa
 * Set up Multi-Factor Authentication for authenticated user
 */
router.post('/setup-mfa', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    // Extract token and get user (similar to /me endpoint)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Please provide an authentication token',
      });
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        error: 'Invalid token format',
        message: 'Please provide a valid Bearer token',
      });
      return;
    }

    const token = parts[1];

    // Import JWT service dynamically to avoid circular dependency
    const { jwtService } = await import('@/utils/jwt');
    
    // Verify token
    const payload = jwtService.verifyAccessToken(token);
    
    // Find user by ID from token
    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(404).json({
        error: 'User not found',
        message: 'User account no longer exists',
      });
      return;
    }

    if (user.status !== 'active') {
      res.status(403).json({
        error: 'Account inactive',
        message: 'Your account has been suspended or deactivated',
      });
      return;
    }

    // Check if MFA is already enabled
    if (user.mfaEnabled) {
      res.status(409).json({
        error: 'MFA already enabled',
        message: 'Multi-factor authentication is already enabled for this account',
      });
      return;
    }

    // Generate MFA setup
    const mfaSetup = await mfaService.generateMFASetup(user.email);

    // Store the secret temporarily (will be confirmed when user verifies)
    user.mfaSecret = mfaSetup.secret;
    user.mfaBackupCodes = mfaSetup.backupCodes;
    await user.save();

    logger.info('MFA setup initiated', {
      userId: user._id,
      email: user.email,
    });

    securityLogger.info('MFA setup started', {
      userId: user._id,
      email: user.email,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      message: 'MFA setup initiated',
      setup: {
        qrCodeUrl: mfaSetup.qrCodeUrl,
        manualEntryKey: mfaSetup.manualEntryKey,
        backupCodes: mfaSetup.backupCodes,
      },
      instructions: mfaService.getMFAInstructions(),
    });

  } catch (error) {
    logger.error('MFA setup failed:', error);
    res.status(500).json({
      error: 'MFA setup failed',
      message: 'An error occurred while setting up MFA. Please try again.',
    });
  }
});

/**
 * POST /api/auth/verify-mfa
 * Verify MFA setup or authenticate with MFA for authenticated user
 */
router.post('/verify-mfa', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { token, isSetup = false } = req.body;

    if (!token) {
      res.status(400).json({
        error: 'Missing required fields',
        message: 'Please provide MFA token',
      });
      return;
    }

    // Extract token and get user (similar to /me endpoint)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Please provide an authentication token',
      });
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        error: 'Invalid token format',
        message: 'Please provide a valid Bearer token',
      });
      return;
    }

    const authToken = parts[1];

    // Import JWT service dynamically to avoid circular dependency
    const { jwtService } = await import('@/utils/jwt');
    
    // Verify token
    const payload = jwtService.verifyAccessToken(authToken);
    
    // Find user by ID from token
    const user = await User.findById(payload.userId).select('+mfaSecret +mfaBackupCodes');
    if (!user) {
      res.status(404).json({
        error: 'User not found',
        message: 'User account no longer exists',
      });
      return;
    }

    if (!user.mfaSecret) {
      res.status(400).json({
        error: 'MFA not set up',
        message: 'Multi-factor authentication has not been set up for this account',
      });
      return;
    }

    let isValidToken = false;
    let usedBackupCode = false;

    // First try TOTP verification
    const totpResult = mfaService.verifyTOTP(token, user.mfaSecret);
    if (totpResult.isValid) {
      isValidToken = true;
    } else if (user.mfaBackupCodes && user.mfaBackupCodes.length > 0) {
      // Try backup code verification
      const isValidBackupCode = mfaService.verifyBackupCode(token, user.mfaBackupCodes);
      if (isValidBackupCode) {
        isValidToken = true;
        usedBackupCode = true;
        
        // Remove used backup code
        user.mfaBackupCodes = mfaService.removeUsedBackupCode(token, user.mfaBackupCodes);
      }
    }

    if (!isValidToken) {
      securityLogger.warn('Invalid MFA token attempt', {
        userId: user._id,
        email: user.email,
        isSetup,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      res.status(401).json({
        error: 'Invalid token',
        message: 'The provided MFA token is invalid or expired',
      });
      return;
    }

    // If this is MFA setup verification, enable MFA
    if (isSetup) {
      user.mfaEnabled = true;
      await user.save();

      logger.info('MFA setup completed', {
        userId: user._id,
        email: user.email,
      });

      securityLogger.info('MFA enabled', {
        userId: user._id,
        email: user.email,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        message: 'MFA setup completed successfully',
        mfaEnabled: true,
        remainingBackupCodes: user.mfaBackupCodes?.length || 0,
      });
    } else {
      // This is MFA authentication during login
      if (usedBackupCode) {
        await user.save(); // Save the updated backup codes
      }

      logger.info('MFA authentication successful', {
        userId: user._id,
        email: user.email,
        usedBackupCode,
      });

      securityLogger.info('MFA authentication completed', {
        userId: user._id,
        email: user.email,
        usedBackupCode,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        message: 'MFA verification successful',
        usedBackupCode,
        remainingBackupCodes: user.mfaBackupCodes?.length || 0,
      });
    }

  } catch (error) {
    logger.error('MFA verification failed:', error);
    res.status(500).json({
      error: 'MFA verification failed',
      message: 'An error occurred during MFA verification. Please try again.',
    });
  }
});

/**
 * POST /api/auth/disable-mfa
 * Disable Multi-Factor Authentication for authenticated user
 */
router.post('/disable-mfa', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({
        error: 'Missing required fields',
        message: 'Please provide MFA token',
      });
      return;
    }

    // Extract token and get user (similar to /me endpoint)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Please provide an authentication token',
      });
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        error: 'Invalid token format',
        message: 'Please provide a valid Bearer token',
      });
      return;
    }

    const authToken = parts[1];

    // Import JWT service dynamically to avoid circular dependency
    const { jwtService } = await import('@/utils/jwt');
    
    // Verify token
    const payload = jwtService.verifyAccessToken(authToken);
    
    // Find user by ID from token
    const user = await User.findById(payload.userId).select('+passwordHash +mfaSecret +mfaBackupCodes');
    if (!user) {
      res.status(404).json({
        error: 'User not found',
        message: 'User account no longer exists',
      });
      return;
    }

    if (!user.mfaEnabled || !user.mfaSecret) {
      res.status(400).json({
        error: 'MFA not enabled',
        message: 'Multi-factor authentication is not enabled for this account',
      });
      return;
    }

    // Verify MFA token
    let isValidToken = false;
    const totpResult = mfaService.verifyTOTP(token, user.mfaSecret);
    if (totpResult.isValid) {
      isValidToken = true;
    } else if (user.mfaBackupCodes && user.mfaBackupCodes.length > 0) {
      const isValidBackupCode = mfaService.verifyBackupCode(token, user.mfaBackupCodes);
      if (isValidBackupCode) {
        isValidToken = true;
      }
    }

    if (!isValidToken) {
      securityLogger.warn('Invalid MFA token for disable attempt', {
        userId: user._id,
        email: user.email,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });
      res.status(401).json({
        error: 'Invalid token',
        message: 'The provided MFA token is invalid or expired',
      });
      return;
    }

    // Disable MFA
    user.mfaEnabled = false;
    user.mfaSecret = undefined;
    user.mfaBackupCodes = [];
    await user.save();

    // Send notification email
    await emailService.sendNotificationEmail({
      email: user.email,
      userName: user.email,
      action: 'Multi-Factor Authentication Disabled',
      details: 'MFA has been disabled for your account',
      timestamp: new Date(),
    });

    logger.info('MFA disabled', {
      userId: user._id,
      email: user.email,
    });

    securityLogger.info('MFA disabled', {
      userId: user._id,
      email: user.email,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      message: 'Multi-factor authentication has been disabled',
      mfaEnabled: false,
    });

  } catch (error) {
    logger.error('MFA disable failed:', error);
    res.status(500).json({
      error: 'MFA disable failed',
      message: 'An error occurred while disabling MFA. Please try again.',
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user information
 */
router.get('/me', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Please provide an authentication token',
      });
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        error: 'Invalid token format',
        message: 'Please provide a valid Bearer token',
      });
      return;
    }

    const token = parts[1];

    // Import JWT service dynamically to avoid circular dependency
    const { jwtService } = await import('@/utils/jwt');
    
    // Verify token
    const payload = jwtService.verifyAccessToken(token);
    
    // Fetch user from database
    const user = await User.findById(payload.userId).select('-passwordHash -mfaSecret');
    
    if (!user) {
      res.status(404).json({
        error: 'User not found',
        message: 'User account no longer exists',
      });
      return;
    }

    if (user.status !== 'active') {
      res.status(403).json({
        error: 'Account inactive',
        message: 'Your account has been suspended or deactivated',
      });
      return;
    }

    res.json({
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        mfaEnabled: user.mfaEnabled,
        accreditedInvestor: user.accreditedInvestor,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      },
    });

  } catch (error) {
    logger.error('Failed to get current user:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('expired')) {
        res.status(401).json({
          error: 'Token expired',
          message: 'Your session has expired. Please log in again.',
        });
        return;
      }
      
      if (error.message.includes('invalid') || error.message.includes('Invalid')) {
        res.status(401).json({
          error: 'Invalid token',
          message: 'Your authentication token is invalid. Please log in again.',
        });
        return;
      }
    }

    res.status(500).json({
      error: 'Authentication failed',
      message: 'An error occurred while verifying your authentication',
    });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile information
 */
router.put('/profile', 
  body('firstName').optional().trim().isLength({ min: 1, max: 50 }).withMessage('First name must be between 1-50 characters'),
  body('lastName').optional().trim().isLength({ min: 1, max: 50 }).withMessage('Last name must be between 1-50 characters'),
  body('phoneNumber').optional().trim().matches(/^\+?[1-9]\d{1,14}$/).withMessage('Phone number must be a valid international format'),
  handleValidationErrors,
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      // Extract token and get user
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({
          error: 'Authentication required',
          message: 'Please provide an authentication token',
        });
        return;
      }

      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        res.status(401).json({
          error: 'Invalid token format',
          message: 'Please provide a valid Bearer token',
        });
        return;
      }

      const token = parts[1];

      // Import JWT service dynamically to avoid circular dependency
      const { jwtService } = await import('@/utils/jwt');
      
      // Verify token
      const payload = jwtService.verifyAccessToken(token);
      
      // Find user by ID from token
      const user = await User.findById(payload.userId);
      if (!user) {
        res.status(404).json({
          error: 'User not found',
          message: 'User account no longer exists',
        });
        return;
      }

      if (user.status !== 'active') {
        res.status(403).json({
          error: 'Account inactive',
          message: 'Your account has been suspended or deactivated',
        });
        return;
      }

      // Update profile fields if provided
      const { firstName, lastName, phoneNumber } = req.body;
      let updated = false;

      if (firstName !== undefined) {
        user.firstName = firstName;
        updated = true;
      }

      if (lastName !== undefined) {
        user.lastName = lastName;
        updated = true;
      }

      if (phoneNumber !== undefined) {
        user.phoneNumber = phoneNumber;
        updated = true;
      }

      if (!updated) {
        res.status(400).json({
          error: 'No updates provided',
          message: 'Please provide at least one field to update',
        });
        return;
      }

      // Save the updated user
      await user.save();

      logger.info('User profile updated', {
        userId: user._id,
        email: user.email,
        updatedFields: Object.keys(req.body),
      });

      securityLogger.info('Profile update', {
        userId: user._id,
        email: user.email,
        updatedFields: Object.keys(req.body),
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({
        message: 'Profile updated successfully',
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          phoneNumber: user.phoneNumber,
          emailVerified: user.emailVerified,
          kycStatus: user.kycStatus,
          mfaEnabled: user.mfaEnabled,
          role: user.role,
          updatedAt: user.updatedAt,
        },
      });

    } catch (error) {
      logger.error('Profile update failed:', error);
      
      if (error instanceof Error) {
        if (error.message.includes('expired')) {
          res.status(401).json({
            error: 'Token expired',
            message: 'Your session has expired. Please log in again.',
          });
          return;
        }
        
        if (error.message.includes('invalid') || error.message.includes('Invalid')) {
          res.status(401).json({
            error: 'Invalid token',
            message: 'Your authentication token is invalid. Please log in again.',
          });
          return;
        }
      }

      res.status(500).json({
        error: 'Profile update failed',
        message: 'An error occurred while updating your profile. Please try again.',
      });
    }
  }
);

/**
 * POST /api/auth/logout
 * Logout user (invalidate tokens)
 */
router.post('/logout', async (req: express.Request, res: express.Response): Promise<void> => {
  try {
    // TODO: Implement token blacklisting when we enhance the refresh token system
    
    logger.info('User logged out', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.json({
      message: 'Logout successful',
    });

  } catch (error) {
    logger.error('Logout failed:', error);
    res.status(500).json({
      error: 'Logout failed',
      message: 'An error occurred during logout',
    });
  }
});

export default router;