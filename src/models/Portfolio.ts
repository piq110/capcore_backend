import mongoose, { Document, Schema } from 'mongoose';

export interface IHolding {
  productId: mongoose.Types.ObjectId;
  quantity: number;
  averageCost: number;
  totalCost: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  realizedPnL: number;
  lastUpdated: Date;
}

export interface IPortfolio extends Document {
  userId: mongoose.Types.ObjectId;
  holdings: IHolding[];
  totalValue: number;
  totalInvested: number;
  totalPnL: number;
  totalRealizedPnL: number;
  totalUnrealizedPnL: number;
  cashBalance: number;
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Methods
  addHolding(productId: mongoose.Types.ObjectId, quantity: number, price: number): void;
  updateHolding(productId: mongoose.Types.ObjectId, quantity: number, price: number): void;
  removeHolding(productId: mongoose.Types.ObjectId): void;
  getHolding(productId: mongoose.Types.ObjectId): IHolding | undefined;
  updatePrices(priceUpdates: { productId: mongoose.Types.ObjectId; price: number }[]): void;
  consolidateDuplicateHoldings(): void;
  cleanupNaNValues(): void;
  calculateTotals(): void;
  getAssetAllocation(): { type: string; value: number; percentage: number }[];
  getSectorAllocation(): { sector: string; value: number; percentage: number }[];
}

const holdingSchema = new Schema<IHolding>({
  productId: {
    type: Schema.Types.ObjectId,
    ref: 'InvestmentProduct',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: [0, 'Quantity cannot be negative'],
    validate: {
      validator: Number.isInteger,
      message: 'Quantity must be a whole number',
    },
  },
  averageCost: {
    type: Number,
    required: true,
    min: [0, 'Average cost cannot be negative'],
  },
  totalCost: {
    type: Number,
    required: true,
    min: [0, 'Total cost cannot be negative'],
  },
  currentPrice: {
    type: Number,
    required: true,
    min: [0, 'Current price cannot be negative'],
  },
  currentValue: {
    type: Number,
    required: true,
    min: [0, 'Current value cannot be negative'],
  },
  unrealizedPnL: {
    type: Number,
    required: true,
  },
  realizedPnL: {
    type: Number,
    default: 0,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

const portfolioSchema = new Schema<IPortfolio>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  holdings: [holdingSchema],
  totalValue: {
    type: Number,
    default: 0,
    min: [0, 'Total value cannot be negative'],
  },
  totalInvested: {
    type: Number,
    default: 0,
    min: [0, 'Total invested cannot be negative'],
  },
  totalPnL: {
    type: Number,
    default: 0,
  },
  totalRealizedPnL: {
    type: Number,
    default: 0,
  },
  totalUnrealizedPnL: {
    type: Number,
    default: 0,
  },
  cashBalance: {
    type: Number,
    default: 0,
    min: [0, 'Cash balance cannot be negative'],
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Indexes for performance
portfolioSchema.index({ userId: 1 });
portfolioSchema.index({ totalValue: -1 });
portfolioSchema.index({ lastUpdated: -1 });
portfolioSchema.index({ 'holdings.productId': 1 });

// Pre-save middleware to calculate totals
portfolioSchema.pre('save', function(next) {
  this.calculateTotals();
  this.lastUpdated = new Date();
  next();
});

// Instance method to add a new holding
portfolioSchema.methods.addHolding = function(
  productId: mongoose.Types.ObjectId,
  quantity: number,
  price: number
): void {
  const existingHolding = this.holdings.find((h: IHolding) => 
    h.productId.toString() === productId.toString()
  );
  
  if (existingHolding) {
    // Update existing holding with weighted average cost
    const newTotalQuantity = existingHolding.quantity + quantity;
    const newTotalCost = existingHolding.totalCost + (quantity * price);
    
    existingHolding.quantity = newTotalQuantity;
    existingHolding.averageCost = newTotalCost / newTotalQuantity;
    existingHolding.totalCost = newTotalCost;
    existingHolding.currentPrice = price;
    existingHolding.currentValue = newTotalQuantity * price;
    existingHolding.unrealizedPnL = existingHolding.currentValue - existingHolding.totalCost;
    existingHolding.lastUpdated = new Date();
  } else {
    // Add new holding
    const newHolding: IHolding = {
      productId,
      quantity,
      averageCost: price,
      totalCost: quantity * price,
      currentPrice: price,
      currentValue: quantity * price,
      unrealizedPnL: 0,
      realizedPnL: 0,
      lastUpdated: new Date(),
    };
    
    this.holdings.push(newHolding);
  }
};

// Instance method to update holding (for sells)
portfolioSchema.methods.updateHolding = function(
  productId: mongoose.Types.ObjectId,
  quantityChange: number,
  price: number
): void {
  const holding = this.holdings.find((h: IHolding) => 
    h.productId.toString() === productId.toString()
  );
  
  if (!holding) {
    throw new Error('Holding not found');
  }
  
  if (quantityChange < 0) {
    // Selling shares
    const sellQuantity = Math.abs(quantityChange);
    
    if (sellQuantity > holding.quantity) {
      throw new Error('Cannot sell more shares than owned');
    }
    
    // Calculate realized P&L
    const realizedPnL = sellQuantity * (price - holding.averageCost);
    holding.realizedPnL += realizedPnL;
    
    // Update holding
    holding.quantity -= sellQuantity;
    holding.totalCost = holding.quantity * holding.averageCost;
    
    // Remove holding if quantity becomes 0
    if (holding.quantity === 0) {
      this.holdings = this.holdings.filter((h: IHolding) => 
        h.productId.toString() !== productId.toString()
      );
    } else {
      holding.currentPrice = price;
      holding.currentValue = holding.quantity * price;
      holding.unrealizedPnL = holding.currentValue - holding.totalCost;
      holding.lastUpdated = new Date();
    }
  } else {
    // Adding shares (should use addHolding instead)
    this.addHolding(productId, quantityChange, price);
  }
};

// Instance method to remove holding
portfolioSchema.methods.removeHolding = function(productId: mongoose.Types.ObjectId): void {
  this.holdings = this.holdings.filter((h: IHolding) => 
    h.productId.toString() !== productId.toString()
  );
};

// Instance method to get specific holding
portfolioSchema.methods.getHolding = function(productId: mongoose.Types.ObjectId): IHolding | undefined {
  return this.holdings.find((h: IHolding) => 
    h.productId.toString() === productId.toString()
  );
};

// Instance method to update prices for all holdings
portfolioSchema.methods.updatePrices = function(
  priceUpdates: { productId: mongoose.Types.ObjectId; price: number }[]
): void {
  priceUpdates.forEach(update => {
    // Validate price update
    if (!update.price || typeof update.price !== 'number' || isNaN(update.price)) {
      console.warn('Skipping invalid price update:', update);
      return;
    }
    
    // Update ALL holdings for this product (in case there are duplicates)
    this.holdings.forEach((holding: IHolding) => {
      if (holding.productId.toString() === update.productId.toString()) {
        holding.currentPrice = update.price;
        holding.currentValue = (holding.quantity || 0) * update.price;
        holding.unrealizedPnL = holding.currentValue - (holding.totalCost || 0);
        holding.lastUpdated = new Date();
        
        // Ensure no NaN values
        if (isNaN(holding.currentValue)) holding.currentValue = 0;
        if (isNaN(holding.unrealizedPnL)) holding.unrealizedPnL = 0;
      }
    });
  });
};

// Instance method to consolidate duplicate holdings
portfolioSchema.methods.consolidateDuplicateHoldings = function(): void {
  const consolidatedHoldings = new Map<string, IHolding>();
  
  this.holdings.forEach((holding: IHolding) => {
    // Validate holding data to prevent NaN
    if (!holding.productId || 
        typeof holding.quantity !== 'number' || isNaN(holding.quantity) ||
        typeof holding.totalCost !== 'number' || isNaN(holding.totalCost) ||
        typeof holding.currentPrice !== 'number' || isNaN(holding.currentPrice)) {
      console.warn('Skipping invalid holding:', holding);
      return;
    }
    
    const productIdStr = holding.productId.toString();
    
    if (consolidatedHoldings.has(productIdStr)) {
      // Merge with existing holding
      const existing = consolidatedHoldings.get(productIdStr)!;
      
      // Safe calculations with validation
      const totalQuantity = (existing.quantity || 0) + (holding.quantity || 0);
      const totalCost = (existing.totalCost || 0) + (holding.totalCost || 0);
      const totalRealizedPnL = (existing.realizedPnL || 0) + (holding.realizedPnL || 0);
      
      if (totalQuantity > 0) {
        existing.quantity = totalQuantity;
        existing.averageCost = totalCost / totalQuantity;
        existing.totalCost = totalCost;
        existing.realizedPnL = totalRealizedPnL;
        existing.currentValue = totalQuantity * (existing.currentPrice || 0);
        existing.unrealizedPnL = existing.currentValue - existing.totalCost;
        existing.lastUpdated = new Date();
      }
    } else {
      // Add new holding with safe values
      const newHolding: IHolding = {
        productId: holding.productId,
        quantity: holding.quantity || 0,
        averageCost: holding.averageCost || 0,
        totalCost: holding.totalCost || 0,
        currentPrice: holding.currentPrice || 0,
        currentValue: holding.currentValue || 0,
        unrealizedPnL: holding.unrealizedPnL || 0,
        realizedPnL: holding.realizedPnL || 0,
        lastUpdated: holding.lastUpdated || new Date(),
      };
      consolidatedHoldings.set(productIdStr, newHolding);
    }
  });
  
  // Replace holdings array with consolidated holdings
  this.holdings = Array.from(consolidatedHoldings.values());
};

// Instance method to clean up NaN values
portfolioSchema.methods.cleanupNaNValues = function(): void {
  this.holdings.forEach((holding: IHolding) => {
    if (isNaN(holding.quantity)) holding.quantity = 0;
    if (isNaN(holding.averageCost)) holding.averageCost = 0;
    if (isNaN(holding.totalCost)) holding.totalCost = 0;
    if (isNaN(holding.currentPrice)) holding.currentPrice = 0;
    if (isNaN(holding.currentValue)) holding.currentValue = 0;
    if (isNaN(holding.unrealizedPnL)) holding.unrealizedPnL = 0;
    if (isNaN(holding.realizedPnL)) holding.realizedPnL = 0;
  });
  
  // Clean up portfolio totals
  if (isNaN(this.totalValue)) this.totalValue = 0;
  if (isNaN(this.totalInvested)) this.totalInvested = 0;
  if (isNaN(this.totalPnL)) this.totalPnL = 0;
  if (isNaN(this.totalRealizedPnL)) this.totalRealizedPnL = 0;
  if (isNaN(this.totalUnrealizedPnL)) this.totalUnrealizedPnL = 0;
  if (isNaN(this.cashBalance)) this.cashBalance = 0;
};

// Instance method to calculate portfolio totals
portfolioSchema.methods.calculateTotals = function(): void {
  this.totalValue = this.cashBalance || 0;
  this.totalInvested = 0;
  this.totalRealizedPnL = 0;
  this.totalUnrealizedPnL = 0;
  
  this.holdings.forEach((holding: IHolding) => {
    // Safe addition with NaN checks
    this.totalValue += (holding.currentValue || 0);
    this.totalInvested += (holding.totalCost || 0);
    this.totalRealizedPnL += (holding.realizedPnL || 0);
    this.totalUnrealizedPnL += (holding.unrealizedPnL || 0);
  });
  
  this.totalPnL = this.totalRealizedPnL + this.totalUnrealizedPnL;
  
  // Ensure no NaN values
  if (isNaN(this.totalValue)) this.totalValue = 0;
  if (isNaN(this.totalInvested)) this.totalInvested = 0;
  if (isNaN(this.totalRealizedPnL)) this.totalRealizedPnL = 0;
  if (isNaN(this.totalUnrealizedPnL)) this.totalUnrealizedPnL = 0;
  if (isNaN(this.totalPnL)) this.totalPnL = 0;
};

// Instance method to get asset allocation by type
portfolioSchema.methods.getAssetAllocation = function(): { type: string; value: number; percentage: number }[] {
  if (this.totalValue === 0) return [];
  
  const allocationMap = new Map<string, { value: number; count: number }>();
  
  this.holdings.forEach((holding: IHolding) => {
    // We'll need to populate the productId to get the type
    // For now, we'll use a placeholder - this should be populated in the route
    const type = (holding as any).productId?.type || 'Unknown';
    const existing = allocationMap.get(type) || { value: 0, count: 0 };
    allocationMap.set(type, {
      value: existing.value + holding.currentValue,
      count: existing.count + 1
    });
  });
  
  return Array.from(allocationMap.entries()).map(([type, data]) => ({
    type,
    value: data.value,
    percentage: (data.value / this.totalValue) * 100,
  }));
};

// Instance method to get sector allocation
portfolioSchema.methods.getSectorAllocation = function(): { sector: string; value: number; percentage: number }[] {
  if (this.totalValue === 0) return [];
  
  const allocationMap = new Map<string, { value: number; count: number }>();
  
  this.holdings.forEach((holding: IHolding) => {
    // We'll need to populate the productId to get the sector
    const sector = (holding as any).productId?.sector || 'Other';
    const existing = allocationMap.get(sector) || { value: 0, count: 0 };
    allocationMap.set(sector, {
      value: existing.value + holding.currentValue,
      count: existing.count + 1
    });
  });
  
  return Array.from(allocationMap.entries()).map(([sector, data]) => ({
    sector,
    value: data.value,
    percentage: (data.value / this.totalValue) * 100,
  }));
};

export const Portfolio = mongoose.model<IPortfolio>('Portfolio', portfolioSchema);