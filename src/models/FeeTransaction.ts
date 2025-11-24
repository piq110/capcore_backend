import mongoose, { Document, Schema } from 'mongoose';

export interface IFeeTransaction extends Document {
  userId: mongoose.Types.ObjectId;
  transactionId?: mongoose.Types.ObjectId; // Reference to related transaction (trade, withdrawal, etc.)
  feeType: 'trading' | 'withdrawal' | 'deposit' | 'listing';
  feeCategory: 'buyer_fee' | 'seller_fee' | 'withdrawal_fee' | 'deposit_fee' | 'listing_fee';
  amount: number; // Fee amount in USD
  currency: string; // Currency the fee was collected in
  feeRate?: number; // Percentage rate applied (if applicable)
  flatFee?: number; // Flat fee amount (if applicable)
  calculationBase: number; // Base amount used for calculation
  status: 'pending' | 'collected' | 'refunded' | 'failed';
  collectedAt?: Date;
  refundedAt?: Date;
  metadata?: {
    orderId?: mongoose.Types.ObjectId;
    tradeId?: mongoose.Types.ObjectId;
    withdrawalId?: mongoose.Types.ObjectId;
    productId?: mongoose.Types.ObjectId;
    issuerId?: mongoose.Types.ObjectId;
    [key: string]: any;
  };
  createdAt: Date;
  updatedAt: Date;

  // Methods
  collect(): Promise<void>;
  refund(reason?: string): Promise<void>;
  calculateFee(baseAmount: number, feeConfig: any): number;
}

const feeTransactionSchema = new Schema<IFeeTransaction>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  transactionId: {
    type: Schema.Types.ObjectId,
    index: true,
  },
  feeType: {
    type: String,
    enum: ['trading', 'withdrawal', 'deposit', 'listing'],
    required: true,
    index: true,
  },
  feeCategory: {
    type: String,
    enum: ['buyer_fee', 'seller_fee', 'withdrawal_fee', 'deposit_fee', 'listing_fee'],
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    required: true,
    default: 'USD',
  },
  feeRate: {
    type: Number,
    min: 0,
    max: 100,
  },
  flatFee: {
    type: Number,
    min: 0,
  },
  calculationBase: {
    type: Number,
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'collected', 'refunded', 'failed'],
    default: 'pending',
    index: true,
  },
  collectedAt: {
    type: Date,
  },
  refundedAt: {
    type: Date,
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

// Indexes
feeTransactionSchema.index({ userId: 1, feeType: 1 });
feeTransactionSchema.index({ status: 1, createdAt: -1 });
feeTransactionSchema.index({ feeType: 1, createdAt: -1 });
feeTransactionSchema.index({ 'metadata.tradeId': 1 });
feeTransactionSchema.index({ 'metadata.orderId': 1 });

// Instance method to collect fee
feeTransactionSchema.methods.collect = async function(): Promise<void> {
  if (this.status !== 'pending') {
    throw new Error(`Cannot collect fee with status: ${this.status}`);
  }
  
  this.status = 'collected';
  this.collectedAt = new Date();
  await this.save();
};

// Instance method to refund fee
feeTransactionSchema.methods.refund = async function(reason?: string): Promise<void> {
  if (this.status !== 'collected') {
    throw new Error(`Cannot refund fee with status: ${this.status}`);
  }
  
  this.status = 'refunded';
  this.refundedAt = new Date();
  if (reason) {
    this.metadata = { ...this.metadata, refundReason: reason };
  }
  await this.save();
};

// Static method to calculate fee
feeTransactionSchema.methods.calculateFee = function(baseAmount: number, feeConfig: any): number {
  let fee = 0;
  
  // Apply percentage fee
  if (feeConfig.percentage && feeConfig.percentage > 0) {
    fee += baseAmount * (feeConfig.percentage / 100);
  }
  
  // Add flat fee
  if (feeConfig.flatFee && feeConfig.flatFee > 0) {
    fee += feeConfig.flatFee;
  }
  
  // Apply minimum fee
  if (feeConfig.minimum && fee < feeConfig.minimum) {
    fee = feeConfig.minimum;
  }
  
  // Apply maximum fee
  if (feeConfig.maximum && fee > feeConfig.maximum) {
    fee = feeConfig.maximum;
  }
  
  return Math.round(fee * 100) / 100; // Round to 2 decimal places
};

export const FeeTransaction = mongoose.model<IFeeTransaction>('FeeTransaction', feeTransactionSchema);