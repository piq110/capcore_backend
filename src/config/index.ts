import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  stage: string;
  frontendUrl: string;
  mongodb: {
    uri: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string;
    expiresIn: string;
    refreshExpiresIn: string;
  };
  email: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
  blockchain: {
    ethereum: {
      rpcUrl: string;
      testnetRpcUrl: string;
    };
    tron: {
      rpcUrl: string;
      testnetRpcUrl: string;
    };
    bsc: {
      rpcUrl: string;
      testnetRpcUrl: string;
    };
  };
  custodian: {
    apiUrl: string;
    apiKey: string;
    apiSecret: string;
  };
  upload: {
    maxFileSize: number;
    uploadPath: string;
    allowedFileTypes: string[];
  };
  security: {
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
    bcryptSaltRounds: number;
  };
  encryption: {
    kycKey: string;
    walletKey: string;
  };
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
  };
  notifications: {
    smsProvider: string;
    twilio: {
      accountSid: string;
      authToken: string;
      phoneNumber: string;
    };
  };
  logging: {
    level: string;
    file: string;
  };
}

const config: Config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  stage: process.env.STAGE || 'alpha',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/aim_dev',
  },
  
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback-secret-key',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'fallback-refresh-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  
  email: {
    host: process.env.EMAIL_HOST || 'localhost',
    port: parseInt(process.env.EMAIL_PORT || '1025', 10),
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || 'noreply@aim-platform.com',
  },
  
  blockchain: {
    ethereum: {
      rpcUrl: process.env.ETHEREUM_RPC_URL || '',
      testnetRpcUrl: process.env.ETHEREUM_TESTNET_RPC_URL || '',
    },
    tron: {
      rpcUrl: process.env.TRON_RPC_URL || 'https://api.trongrid.io',
      testnetRpcUrl: process.env.TRON_TESTNET_RPC_URL || 'https://api.shasta.trongrid.io',
    },
    bsc: {
      rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
      testnetRpcUrl: process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545',
    },
  },
  
  custodian: {
    apiUrl: process.env.CUSTODIAN_API_URL || '',
    apiKey: process.env.CUSTODIAN_API_KEY || '',
    apiSecret: process.env.CUSTODIAN_API_SECRET || '',
  },
  
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
    uploadPath: process.env.UPLOAD_PATH || './uploads',
    allowedFileTypes: (process.env.ALLOWED_FILE_TYPES || 'pdf,jpg,jpeg,png').split(','),
  },
  
  security: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10),
  },
  
  encryption: {
    kycKey: process.env.KYC_ENCRYPTION_KEY || '',
    walletKey: process.env.WALLET_ENCRYPTION_KEY || '',
  },
  
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
  
  notifications: {
    smsProvider: process.env.SMS_PROVIDER || 'twilio',
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
    },
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/app.log',
  },
};

// Validate required environment variables in production
if (config.nodeEnv === 'production') {
  const requiredEnvVars = [
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'MONGODB_URI',
    'REDIS_URL',
  ];
  
  const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missingEnvVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  }
}

export default config;