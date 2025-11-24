import mongoose, { Document, Schema } from 'mongoose';

export interface IShareRegisterEntry extends Document {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantity: number;
  certificateNumber?: string;
  acquisitionDate: Date;
  acquisitionPrice: number;
  custodianAccountNumber: string;
  custodianReference: string;
  status: 'active' | 'transferred' | 'cancelled';
  transferHistory: {
    fromUserId?: mongoose.Types.ObjectId;
    toUserId: mongoose.Types.ObjectId;
    quantity: number;
    transferDate: Date;
    custodialTransferId: mongoose.Types.ObjectId;
    reason: string;
  }[];
  createdAt: Date;
  updatedAt: Date;

  // Methods
  transfer(toUserId: mongoose.Types.ObjectId, quantity: number, custodialTransferId: mongoose.Types.ObjectId, reason: string): void;
  isActive(): boolean;
  getTotalTransferred(): number;
}

const shareRegisterSchema = new Schema<IShareRegisterEntry>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  productId: {
    type: Schema.Types.ObjectId,
    ref: 'InvestmentProduct',
    required: true,
    index: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'Quantity must be a whole number',
    },
  },
  certificateNumber: {
    type: String,
    sparse: true,
    index: true,
  },
  acquisitionDate: {
    type: Date,
    required: true,
    index: true,
  },
  acquisitionPrice: {
    type: Number,
    required: true,
    min: 0.01,
  },
  custodianAccountNumber: {
    type: String,
    required: true,
    index: true,
  },
  custodianReference: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['active', 'transferred', 'cancelled'],
    default: 'active',
    index: true,
  },
  transferHistory: [{
    fromUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    toUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    transferDate: {
      type: Date,
      required: true,
    },
    custodialTransferId: {
      type: Schema.Types.ObjectId,
      ref: 'CustodialTransfer',
      required: true,
    },
    reason: {
      type: String,
      required: true,
    },
  }],
}, {
  timestamps: true,
});

// Indexes for performance
shareRegisterSchema.index({ userId: 1 });
shareRegisterSchema.index({ productId: 1 });
shareRegisterSchema.index({ status: 1 });
shareRegisterSchema.index({ custodianAccountNumber: 1 });
shareRegisterSchema.index({ custodianReference: 1 });
shareRegisterSchema.index({ acquisitionDate: -1 });

// Compound indexes
shareRegisterSchema.index({ userId: 1, productId: 1 });
shareRegisterSchema.index({ productId: 1, status: 1 });
shareRegisterSchema.index({ userId: 1, status: 1 });

// Instance method to transfer shares
shareRegisterSchema.methods.transfer = function(
  toUserId: mongoose.Types.ObjectId,
  quantity: number,
  custodialTransferId: mongoose.Types.ObjectId,
  reason: string
): void {
  if (this.status !== 'active') {
    throw new Error('Can only transfer active shares');
  }
  
  if (quantity > this.quantity) {
    throw new Error('Cannot transfer more shares than owned');
  }
  
  // Add to transfer history
  this.transferHistory.push({
    fromUserId: this.userId,
    toUserId,
    quantity,
    transferDate: new Date(),
    custodialTransferId,
    reason,
  });
  
  // Update quantity
  this.quantity -= quantity;
  
  // Mark as transferred if no shares remain
  if (this.quantity === 0) {
    this.status = 'transferred';
  }
};

// Instance method to check if shares are active
shareRegisterSchema.methods.isActive = function(): boolean {
  return this.status === 'active' && this.quantity > 0;
};

// Instance method to get total transferred shares
shareRegisterSchema.methods.getTotalTransferred = function(): number {
  return this.transferHistory.reduce((total: number, transfer: any) => total + transfer.quantity, 0);
};

export const ShareRegister = mongoose.model<IShareRegisterEntry>('ShareRegister', shareRegisterSchema);