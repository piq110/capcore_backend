import mongoose, { Document, Schema } from 'mongoose';

export interface ITransaction extends Document {
  userId: mongoose.Types.ObjectId;
  walletId: mongoose.Types.ObjectId;
  txHash: string;
  network: 'ethereum' | 'tron' | 'bsc';
  type: 'deposit' | 'withdrawal';
  token: 'usdt' | 'usdc';
  amount: number;
  fromAddress: string;
  toAddress: string;
  status: 'pending' | 'confirmed' | 'failed';
  confirmations: number;
  requiredConfirmations: number;
  blockNumber?: number;
  blockHash?: string;
  gasUsed?: number;
  gasFee?: number;
  detectedAt: Date;
  confirmedAt?: Date;
  processedAt?: Date;
  failedAt?: Date;
  errorMessage?: string;
  webhookReceived?: boolean;
  webhookData?: any;
  createdAt: Date;
  updatedAt: Date;

  // Methods
  isConfirmed(): boolean;
  canProcess(): boolean;
}

const transactionSchema = new Schema<ITransaction>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  walletId: {
    type: Schema.Types.ObjectId,
    ref: 'Wallet',
    required: true,
    index: true,
  },
  txHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  network: {
    type: String,
    enum: ['ethereum', 'tron', 'bsc'],
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal'],
    required: true,
    index: true,
  },
  token: {
    type: String,
    enum: ['usdt', 'usdc'],
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  fromAddress: {
    type: String,
    required: true,
    index: true,
  },
  toAddress: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed'],
    default: 'pending',
    index: true,
  },
  confirmations: {
    type: Number,
    default: 0,
    min: 0,
  },
  requiredConfirmations: {
    type: Number,
    required: true,
    min: 1,
  },
  blockNumber: {
    type: Number,
    index: true,
  },
  blockHash: {
    type: String,
  },
  gasUsed: {
    type: Number,
    min: 0,
  },
  gasFee: {
    type: Number,
    min: 0,
  },
  detectedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  confirmedAt: {
    type: Date,
    index: true,
  },
  processedAt: {
    type: Date,
  },
  failedAt: {
    type: Date,
  },
  errorMessage: {
    type: String,
  },
  webhookReceived: {
    type: Boolean,
    default: false,
  },
  webhookData: {
    type: Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

// Compound indexes for performance
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ network: 1, status: 1, detectedAt: -1 });
transactionSchema.index({ toAddress: 1, network: 1, status: 1 });
transactionSchema.index({ status: 1, detectedAt: -1 });
transactionSchema.index({ type: 1, status: 1, createdAt: -1 });

// Instance method to check if transaction is confirmed
transactionSchema.methods.isConfirmed = function(): boolean {
  return this.status === 'confirmed' && this.confirmations >= this.requiredConfirmations;
};

// Instance method to check if transaction can be processed
transactionSchema.methods.canProcess = function(): boolean {
  return this.isConfirmed() && !this.processedAt && this.type === 'deposit';
};

// Pre-save middleware to update status based on confirmations
transactionSchema.pre('save', function(next) {
  if (this.confirmations >= this.requiredConfirmations && this.status === 'pending') {
    this.status = 'confirmed';
    this.confirmedAt = new Date();
  }
  next();
});

export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);