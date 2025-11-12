import mongoose, { Document, Schema } from 'mongoose';

export interface IFeeConfig {
  transactionFee: {
    percentage: number;
    flatFee: number;
    minimum: number;
    maximum: number;
  };
  depositFee: {
    percentage: number;
    flatFee: number;
    minimum: number;
    maximum: number;
  };
  withdrawalFee: {
    percentage: number;
    flatFee: number;
    minimum: number;
    maximum: number;
  };
  tradingFee: {
    buyerFeePercentage: number;
    sellerFeePercentage: number;
    minimumFee: number;
    maximumFee: number;
  };
  listingFee: {
    flatFee: number;
    annualFee: number;
  };
}

export interface ITradingRules {
  minimumOrderSize: number;
  maximumOrderSize: number;
  minimumTradeAmount: number;
  maximumTradeAmount: number;
  dailyTradingLimit: number;
  monthlyTradingLimit: number;
  priceDeviationLimit: number; // percentage
  orderExpirationHours: number;
  maxOpenOrdersPerUser: number;
  tradingHours: {
    enabled: boolean;
    startTime: string; // HH:MM format
    endTime: string; // HH:MM format
    timezone: string;
    weekendsEnabled: boolean;
    holidaysEnabled: boolean;
  };
}

export interface IWithdrawalLimits {
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  minimumAmount: number;
  maximumAmount: number;
  requiresApprovalAbove: number;
  autoApprovalLimit: number;
  cooldownPeriodHours: number;
}

export interface ISystemSettings {
  maintenanceMode: {
    enabled: boolean;
    message: string;
    scheduledStart?: Date;
    scheduledEnd?: Date;
    allowedRoles: string[];
  };
  registrationEnabled: boolean;
  kycRequired: boolean;
  mfaRequired: boolean;
  emailVerificationRequired: boolean;
  maxLoginAttempts: number;
  sessionTimeoutMinutes: number;
  passwordPolicy: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
    maxAge: number; // days
  };
  rateLimiting: {
    apiCallsPerMinute: number;
    loginAttemptsPerHour: number;
    registrationAttemptsPerHour: number;
  };
}

export interface IPlatformConfig extends Document {
  configVersion: string;
  fees: IFeeConfig;
  tradingRules: ITradingRules;
  withdrawalLimits: IWithdrawalLimits;
  systemSettings: ISystemSettings;
  lastUpdatedBy: mongoose.Types.ObjectId;
  lastUpdatedAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  // Methods
  validateConfig(): boolean;
  applyConfig(): void;
  createBackup(): IPlatformConfig;
}

const feeConfigSchema = new Schema<IFeeConfig>({
  transactionFee: {
    percentage: { type: Number, min: 0, max: 10, default: 1.5 },
    flatFee: { type: Number, min: 0, default: 0 },
    minimum: { type: Number, min: 0, default: 0.01 },
    maximum: { type: Number, min: 0, default: 1000 },
  },
  depositFee: {
    percentage: { type: Number, min: 0, max: 5, default: 0 },
    flatFee: { type: Number, min: 0, default: 0 },
    minimum: { type: Number, min: 0, default: 0 },
    maximum: { type: Number, min: 0, default: 100 },
  },
  withdrawalFee: {
    percentage: { type: Number, min: 0, max: 5, default: 0.5 },
    flatFee: { type: Number, min: 0, default: 5 },
    minimum: { type: Number, min: 0, default: 5 },
    maximum: { type: Number, min: 0, default: 100 },
  },
  tradingFee: {
    buyerFeePercentage: { type: Number, min: 0, max: 5, default: 0.25 },
    sellerFeePercentage: { type: Number, min: 0, max: 5, default: 0.25 },
    minimumFee: { type: Number, min: 0, default: 0.01 },
    maximumFee: { type: Number, min: 0, default: 1000 },
  },
  listingFee: {
    flatFee: { type: Number, min: 0, default: 5000 },
    annualFee: { type: Number, min: 0, default: 10000 },
  },
});

const tradingRulesSchema = new Schema<ITradingRules>({
  minimumOrderSize: { type: Number, min: 1, default: 1 },
  maximumOrderSize: { type: Number, min: 1, default: 1000000 },
  minimumTradeAmount: { type: Number, min: 0.01, default: 10 },
  maximumTradeAmount: { type: Number, min: 1, default: 1000000 },
  dailyTradingLimit: { type: Number, min: 0, default: 100000 },
  monthlyTradingLimit: { type: Number, min: 0, default: 1000000 },
  priceDeviationLimit: { type: Number, min: 0, max: 100, default: 10 },
  orderExpirationHours: { type: Number, min: 1, max: 8760, default: 24 },
  maxOpenOrdersPerUser: { type: Number, min: 1, default: 10 },
  tradingHours: {
    enabled: { type: Boolean, default: false },
    startTime: { type: String, default: '09:00' },
    endTime: { type: String, default: '17:00' },
    timezone: { type: String, default: 'UTC' },
    weekendsEnabled: { type: Boolean, default: true },
    holidaysEnabled: { type: Boolean, default: true },
  },
});

const withdrawalLimitsSchema = new Schema<IWithdrawalLimits>({
  dailyLimit: { type: Number, min: 0, default: 10000 },
  weeklyLimit: { type: Number, min: 0, default: 50000 },
  monthlyLimit: { type: Number, min: 0, default: 200000 },
  minimumAmount: { type: Number, min: 0.01, default: 10 },
  maximumAmount: { type: Number, min: 1, default: 50000 },
  requiresApprovalAbove: { type: Number, min: 0, default: 5000 },
  autoApprovalLimit: { type: Number, min: 0, default: 1000 },
  cooldownPeriodHours: { type: Number, min: 0, default: 24 },
});

const systemSettingsSchema = new Schema<ISystemSettings>({
  maintenanceMode: {
    enabled: { type: Boolean, default: false },
    message: { type: String, default: 'System is under maintenance. Please try again later.' },
    scheduledStart: { type: Date },
    scheduledEnd: { type: Date },
    allowedRoles: { type: [String], default: ['admin'] },
  },
  registrationEnabled: { type: Boolean, default: true },
  kycRequired: { type: Boolean, default: true },
  mfaRequired: { type: Boolean, default: false },
  emailVerificationRequired: { type: Boolean, default: true },
  maxLoginAttempts: { type: Number, min: 1, max: 10, default: 5 },
  sessionTimeoutMinutes: { type: Number, min: 5, max: 1440, default: 60 },
  passwordPolicy: {
    minLength: { type: Number, min: 6, max: 128, default: 8 },
    requireUppercase: { type: Boolean, default: true },
    requireLowercase: { type: Boolean, default: true },
    requireNumbers: { type: Boolean, default: true },
    requireSpecialChars: { type: Boolean, default: false },
    maxAge: { type: Number, min: 30, max: 365, default: 90 },
  },
  rateLimiting: {
    apiCallsPerMinute: { type: Number, min: 10, max: 1000, default: 100 },
    loginAttemptsPerHour: { type: Number, min: 1, max: 100, default: 10 },
    registrationAttemptsPerHour: { type: Number, min: 1, max: 50, default: 5 },
  },
});

const platformConfigSchema = new Schema<IPlatformConfig>({
  configVersion: {
    type: String,
    required: true,
    unique: true,
    default: () => `v${Date.now()}`,
  },
  fees: {
    type: feeConfigSchema,
    required: true,
    default: () => ({}),
  },
  tradingRules: {
    type: tradingRulesSchema,
    required: true,
    default: () => ({}),
  },
  withdrawalLimits: {
    type: withdrawalLimitsSchema,
    required: true,
    default: () => ({}),
  },
  systemSettings: {
    type: systemSettingsSchema,
    required: true,
    default: () => ({}),
  },
  lastUpdatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  lastUpdatedAt: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
});

// Indexes
platformConfigSchema.index({ configVersion: 1 });
platformConfigSchema.index({ isActive: 1 });
platformConfigSchema.index({ lastUpdatedAt: -1 });

// Ensure only one active config at a time
platformConfigSchema.pre('save', async function(next) {
  if (this.isActive && this.isNew) {
    // Deactivate all other configs
    await PlatformConfig.updateMany(
      { _id: { $ne: this._id } },
      { $set: { isActive: false } }
    );
  }
  
  this.lastUpdatedAt = new Date();
  next();
});

// Instance method to validate configuration
platformConfigSchema.methods.validateConfig = function(): boolean {
  try {
    // Validate fee ranges
    const fees = this.fees;
    if (fees.transactionFee.percentage < 0 || fees.transactionFee.percentage > 10) return false;
    if (fees.withdrawalFee.minimum > fees.withdrawalFee.maximum) return false;
    
    // Validate trading rules
    const trading = this.tradingRules;
    if (trading.minimumOrderSize > trading.maximumOrderSize) return false;
    if (trading.minimumTradeAmount > trading.maximumTradeAmount) return false;
    
    // Validate withdrawal limits
    const withdrawal = this.withdrawalLimits;
    if (withdrawal.minimumAmount > withdrawal.maximumAmount) return false;
    if (withdrawal.dailyLimit > withdrawal.weeklyLimit) return false;
    if (withdrawal.weeklyLimit > withdrawal.monthlyLimit) return false;
    
    return true;
  } catch (error) {
    return false;
  }
};

// Instance method to apply configuration
platformConfigSchema.methods.applyConfig = async function(): Promise<void> {
  if (!this.validateConfig()) {
    throw new Error('Invalid configuration cannot be applied');
  }
  
  // Deactivate all other configs
  await PlatformConfig.updateMany(
    { _id: { $ne: this._id } },
    { $set: { isActive: false } }
  );
  
  // Activate this config
  this.isActive = true;
  await this.save();
};

// Instance method to create backup
platformConfigSchema.methods.createBackup = function(): IPlatformConfig {
  const backup = new PlatformConfig({
    configVersion: `${this.configVersion}_backup_${Date.now()}`,
    fees: this.fees,
    tradingRules: this.tradingRules,
    withdrawalLimits: this.withdrawalLimits,
    systemSettings: this.systemSettings,
    lastUpdatedBy: this.lastUpdatedBy,
    isActive: false,
  });
  
  return backup;
};

export const PlatformConfig = mongoose.model<IPlatformConfig>('PlatformConfig', platformConfigSchema);

// Helper function to get active configuration
export const getActiveConfig = async (): Promise<IPlatformConfig | null> => {
  return await PlatformConfig.findOne({ isActive: true });
};

// Helper function to create default configuration
export const createDefaultConfig = async (adminId: string): Promise<IPlatformConfig> => {
  const defaultConfig = new PlatformConfig({
    lastUpdatedBy: new mongoose.Types.ObjectId(adminId),
    isActive: true,
  });
  
  return await defaultConfig.save();
};