import { Request, Response, NextFunction } from 'express';
import { logger, logError } from '@/utils/logger';
import config from '@/config';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  code?: string;
  details?: Record<string, any>;
}

export class CustomError extends Error implements AppError {
  public statusCode: number;
  public isOperational: boolean;
  public code: string;
  public details?: Record<string, any>;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    details?: Record<string, any>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;
    this.details = details;
    this.name = this.constructor.name;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Specific error classes
export class ValidationError extends CustomError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class AuthenticationError extends CustomError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends CustomError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

export class NotFoundError extends CustomError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND_ERROR');
  }
}

export class ConflictError extends CustomError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 409, 'CONFLICT_ERROR', details);
  }
}

export class RateLimitError extends CustomError {
  constructor(message: string = 'Too many requests') {
    super(message, 429, 'RATE_LIMIT_ERROR');
  }
}

export class BlockchainError extends CustomError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 502, 'BLOCKCHAIN_ERROR', details);
  }
}

export class CustodialError extends CustomError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 502, 'CUSTODIAL_ERROR', details);
  }
}

export class KYCError extends CustomError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 400, 'KYC_ERROR', details);
  }
}

export class TradingError extends CustomError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 400, 'TRADING_ERROR', details);
  }
}

// Error response interface
interface ErrorResponse {
  error: {
    message: string;
    code: string;
    statusCode: number;
    details?: Record<string, any>;
    requestId?: string;
  };
}

// Generate unique request ID for error tracking
const generateRequestId = (): string => {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Main error handler middleware
export const errorHandler = (
  error: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const requestId = generateRequestId();
  
  // Set default error properties
  let statusCode = error.statusCode || 500;
  let message = error.message || 'Internal server error';
  let code = error.code || 'INTERNAL_ERROR';
  let details = error.details;

  // Handle specific error types
  if (error.name === 'ValidationError') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = { validationErrors: error.message };
  } else if (error.name === 'CastError') {
    statusCode = 400;
    code = 'INVALID_ID';
    message = 'Invalid ID format';
  } else if (error.name === 'MongoServerError' && (error as any).code === 11000) {
    statusCode = 409;
    code = 'DUPLICATE_ENTRY';
    message = 'Duplicate entry detected';
    details = { duplicateFields: Object.keys((error as any).keyPattern || {}) };
  } else if (error.name === 'JsonWebTokenError') {
    statusCode = 401;
    code = 'INVALID_TOKEN';
    message = 'Invalid authentication token';
  } else if (error.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'TOKEN_EXPIRED';
    message = 'Authentication token expired';
  }

  // Log error with context
  const errorContext = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    userId: (req as any).user?.id,
    statusCode,
    code,
  };

  if (statusCode >= 500) {
    logError(error, errorContext);
  } else {
    logger.warn(`Client error: ${message}`, errorContext);
  }

  // Prepare error response
  const errorResponse: ErrorResponse = {
    error: {
      message,
      code,
      statusCode,
      requestId,
    },
  };

  // Include details in development or for client errors
  if (config.nodeEnv === 'development' || statusCode < 500) {
    if (details) {
      errorResponse.error.details = details;
    }
  }

  // Include stack trace in development
  if (config.nodeEnv === 'development' && error.stack) {
    (errorResponse.error as any).stack = error.stack;
  }

  res.status(statusCode).json(errorResponse);
};

// Async error wrapper
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// 404 handler
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  const error = new NotFoundError(`Route ${req.originalUrl} not found`);
  next(error);
};