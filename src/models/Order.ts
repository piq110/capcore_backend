import mongoose, { Document, Schema } from 'mongoose';

export interface IOrder extends Document {
  userId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  type: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: number;
  pricePerShare: number;
  totalAmount: number;
  status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
  filledQuantity: number;
  remainingQuantity: number;
  averageFillPrice: number;
  fees: number;
  expiresAt?: Date;
  filledAt?: Date;
  cancelledAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  getRemainingValue(): number;
  getFilledValue(): number;
  canBeCancelled(): boolean;
  cancel(reason?: string): void;
  partialFill(quantity: number, price: number): void;
  completeFill(price: number): void;
}

const orderSchema = new Schema<IOrder>({
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
  type: {
    type: String,
    enum: ['buy', 'sell'],
    required: [true, 'Order type is required'],
    index: true,
  },
  orderType: {
    type: String,
    enum: ['market', 'limit'],
    required: [true, 'Order type is required'],
    default: 'limit',
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1'],
    validate: {
      validator: Number.isInteger,
      message: 'Quantity must be a whole number',
    },
  },
  pricePerShare: {
    type: Number,
    required: [true, 'Price per share is required'],
    min: [0.01, 'Price per share must be at least $0.01'],
  },
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0.01, 'Total amount must be at least $0.01'],
  },
  status: {
    type: String,
    enum: ['pending', 'filled', 'partially_filled', 'cancelled', 'rejected'],
    default: 'pending',
    index: true,
  },
  filledQuantity: {
    type: Number,
    default: 0,
    min: [0, 'Filled quantity cannot be negative'],
  },
  remainingQuantity: {
    type: Number,
    required: true,
  },
  averageFillPrice: {
    type: Number,
    default: 0,
    min: [0, 'Average fill price cannot be negative'],
  },
  fees: {
    type: Number,
    default: 0,
    min: [0, 'Fees cannot be negative'],
  },
  expiresAt: {
    type: Date,
    index: true,
  },
  filledAt: {
    type: Date,
  },
  cancelledAt: {
    type: Date,
  },
  rejectionReason: {
    type: String,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters'],
  },
}, {
  timestamps: true,
});

// Indexes for performance
orderSchema.index({ userId: 1 });
orderSchema.index({ productId: 1 });
orderSchema.index({ type: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ expiresAt: 1 });

// Compound indexes for order book queries
orderSchema.index({ productId: 1, type: 1, status: 1 });
orderSchema.index({ productId: 1, type: 1, pricePerShare: 1 });
orderSchema.index({ userId: 1, status: 1, createdAt: -1 });

// Pre-save middleware to calculate remaining quantity and total amount
orderSchema.pre('save', function(next) {
  // Calculate remaining quantity
  this.remainingQuantity = this.quantity - this.filledQuantity;
  
  // Calculate total amount if not set
  if (!this.totalAmount || this.totalAmount === 0) {
    this.totalAmount = this.quantity * this.pricePerShare;
  }
  
  // Validate filled quantity doesn't exceed total quantity
  if (this.filledQuantity > this.quantity) {
    return next(new Error('Filled quantity cannot exceed total quantity'));
  }
  
  next();
});

// Instance method to get remaining value
orderSchema.methods.getRemainingValue = function(): number {
  return this.remainingQuantity * this.pricePerShare;
};

// Instance method to get filled value
orderSchema.methods.getFilledValue = function(): number {
  return this.filledQuantity * this.averageFillPrice;
};

// Instance method to check if order can be cancelled
orderSchema.methods.canBeCancelled = function(): boolean {
  return ['pending', 'partially_filled'].includes(this.status);
};

// Instance method to cancel order
orderSchema.methods.cancel = function(reason?: string): void {
  if (!this.canBeCancelled()) {
    throw new Error('Order cannot be cancelled in current status');
  }
  
  this.status = 'cancelled';
  this.cancelledAt = new Date();
  if (reason) {
    this.rejectionReason = reason;
  }
};

// Instance method to partially fill order
orderSchema.methods.partialFill = function(quantity: number, price: number): void {
  if (quantity <= 0 || quantity > this.remainingQuantity) {
    throw new Error('Invalid fill quantity');
  }
  
  // Update average fill price
  const totalFilledValue = (this.filledQuantity * this.averageFillPrice) + (quantity * price);
  const newFilledQuantity = this.filledQuantity + quantity;
  this.averageFillPrice = totalFilledValue / newFilledQuantity;
  
  // Update quantities
  this.filledQuantity = newFilledQuantity;
  this.remainingQuantity = this.quantity - this.filledQuantity;
  
  // Update status
  if (this.remainingQuantity === 0) {
    this.status = 'filled';
    this.filledAt = new Date();
  } else {
    this.status = 'partially_filled';
  }
};

// Instance method to completely fill order
orderSchema.methods.completeFill = function(price: number): void {
  this.partialFill(this.remainingQuantity, price);
};

export const Order = mongoose.model<IOrder>('Order', orderSchema);