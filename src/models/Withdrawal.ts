import mongoose, { Document, Schema } from 'mongoose';

export interface IWithdrawal extends Document {
  userId: mongoose.Types.ObjectId;
  walletId: mongoose.Types.ObjectId;
  network: 'ethereum' | 'tron' | 'bsc';
  token: 'usdt' | 'usdc';
  amount: number;
  toAddress: string;
  status: 'pending' | 'approved' | 'rejected' | 'processing' | 'completed' | 'failed';
  requestedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  rejectedAt?: Date;
  processedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: number;
  gasFee?: number;
  rejectionReason?: string;
  adminNotes?: string;
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
  fraudScore?: number;
  fraudFlags?: string[];
  createdAt: Date;
  updatedAt: Date;

  // Methods
  canApprove(): boolean;
  canReject(): boolean;
  canProcess(): boolean;
  isCompleted(): boolean;
}

const withdrawalSchema = new Schema<IWithdrawal>({
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
  network: {
    type: String,
    enum: ['ethereum', 'tron', 'bsc'],
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
  toAddress: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true,
  },
  requestedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  reviewedAt: {
    type: Date,
  },
  reviewedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: {
    type: Date,
  },
  rejectedAt: {
    type: Date,
  },
  processedAt: {
    type: Date,
  },
  completedAt: {
    type: Date,
  },
  failedAt: {
    type: Date,
  },
  txHash: {
    type: String,
    index: true,
  },
  blockNumber: {
    type: Number,
  },
  gasUsed: {
    type: Number,
    min: 0,
  },
  gasFee: {
    type: Number,
    min: 0,
  },
  rejectionReason: {
    type: String,
  },
  adminNotes: {
    type: String,
  },
  errorMessage: {
    type: String,
  },
  ipAddress: {
    type: String,
  },
  userAgent: {
    type: String,
  },
  fraudScore: {
    type: Number,
    min: 0,
    max: 100,
  },
  fraudFlags: [{
    type: String,
  }],
}, {
  timestamps: true,
});

// Compound indexes for performance
withdrawalSchema.index({ userId: 1, status: 1, requestedAt: -1 });
withdrawalSchema.index({ status: 1, requestedAt: -1 });
withdrawalSchema.index({ reviewedBy: 1, status: 1 });
withdrawalSchema.index({ network: 1, status: 1 });
withdrawalSchema.index({ fraudScore: -1, status: 1 });

// Instance method to check if withdrawal can be approved
withdrawalSchema.methods.canApprove = function(): boolean {
  return this.status === 'pending';
};

// Instance method to check if withdrawal can be rejected
withdrawalSchema.methods.canReject = function(): boolean {
  return this.status === 'pending';
};

// Instance method to check if withdrawal can be processed
withdrawalSchema.methods.canProcess = function(): boolean {
  return this.status === 'approved' && !this.processedAt;
};

// Instance method to check if withdrawal is completed
withdrawalSchema.methods.isCompleted = function(): boolean {
  return ['completed', 'failed', 'rejected'].includes(this.status);
};

export const Withdrawal = mongoose.model<IWithdrawal>('Withdrawal', withdrawalSchema);