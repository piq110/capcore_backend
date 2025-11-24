import { FeeTransaction, IFeeTransaction } from '@/models/FeeTransaction';
import { ListingFee, IListingFee } from '@/models/ListingFee';
import { PlatformConfig, getActiveConfig, IFeeConfig } from '@/models/PlatformConfig';
import { Wallet } from '@/models/Wallet';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

export interface FeeCalculationResult {
  amount: number;
  feeRate?: number;
  flatFee?: number;
  calculationBase: number;
  currency: string;
}

export interface TradingFeeResult {
  buyerFee: FeeCalculationResult;
  sellerFee: FeeCalculationResult;
  totalFees: number;
}

export interface FeeCollectionResult {
  success: boolean;
  feeTransaction?: IFeeTransaction;
  error?: string;
}

export class FeeService {
  private feeConfig: IFeeConfig | null = null;
  private configLastUpdated: Date | null = null;

  /**
   * Get current fee configuration with caching
   */
  private async getFeeConfig(): Promise<IFeeConfig> {
    try {
      const config = await getActiveConfig();
      if (!config) {
        throw new Error('No active platform configuration found');
      }

      // Cache the config for 5 minutes to reduce database calls
      if (!this.feeConfig || !this.configLastUpdated || 
          Date.now() - this.configLastUpdated.getTime() > 5 * 60 * 1000) {
        this.feeConfig = config.fees;
        this.configLastUpdated = new Date();
      }

      return this.feeConfig;
    } catch (error) {
      logger.error('Failed to get fee configuration:', error);
      throw error;
    }
  }

  /**
   * Calculate trading fees for both buyer and seller
   */
  async calculateTradingFees(tradeAmount: number): Promise<TradingFeeResult> {
    try {
      const feeConfig = await this.getFeeConfig();
      const tradingFeeConfig = feeConfig.tradingFee;

      // Calculate buyer fee
      const buyerFeeAmount = this.calculateFeeAmount(
        tradeAmount,
        tradingFeeConfig.buyerFeePercentage,
        0, // No flat fee for trading
        tradingFeeConfig.minimumFee,
        tradingFeeConfig.maximumFee
      );

      // Calculate seller fee
      const sellerFeeAmount = this.calculateFeeAmount(
        tradeAmount,
        tradingFeeConfig.sellerFeePercentage,
        0, // No flat fee for trading
        tradingFeeConfig.minimumFee,
        tradingFeeConfig.maximumFee
      );

      const buyerFee: FeeCalculationResult = {
        amount: buyerFeeAmount,
        feeRate: tradingFeeConfig.buyerFeePercentage,
        calculationBase: tradeAmount,
        currency: 'USD'
      };

      const sellerFee: FeeCalculationResult = {
        amount: sellerFeeAmount,
        feeRate: tradingFeeConfig.sellerFeePercentage,
        calculationBase: tradeAmount,
        currency: 'USD'
      };

      return {
        buyerFee,
        sellerFee,
        totalFees: buyerFeeAmount + sellerFeeAmount
      };
    } catch (error) {
      logger.error('Failed to calculate trading fees:', error);
      throw error;
    }
  }

  /**
   * Calculate withdrawal fee
   */
  async calculateWithdrawalFee(withdrawalAmount: number): Promise<FeeCalculationResult> {
    try {
      const feeConfig = await this.getFeeConfig();
      const withdrawalFeeConfig = feeConfig.withdrawalFee;

      const feeAmount = this.calculateFeeAmount(
        withdrawalAmount,
        withdrawalFeeConfig.percentage,
        withdrawalFeeConfig.flatFee,
        withdrawalFeeConfig.minimum,
        withdrawalFeeConfig.maximum
      );

      return {
        amount: feeAmount,
        feeRate: withdrawalFeeConfig.percentage,
        flatFee: withdrawalFeeConfig.flatFee,
        calculationBase: withdrawalAmount,
        currency: 'USD'
      };
    } catch (error) {
      logger.error('Failed to calculate withdrawal fee:', error);
      throw error;
    }
  }

  /**
   * Calculate deposit fee
   */
  async calculateDepositFee(depositAmount: number): Promise<FeeCalculationResult> {
    try {
      const feeConfig = await this.getFeeConfig();
      const depositFeeConfig = feeConfig.depositFee;

      const feeAmount = this.calculateFeeAmount(
        depositAmount,
        depositFeeConfig.percentage,
        depositFeeConfig.flatFee,
        depositFeeConfig.minimum,
        depositFeeConfig.maximum
      );

      return {
        amount: feeAmount,
        feeRate: depositFeeConfig.percentage,
        flatFee: depositFeeConfig.flatFee,
        calculationBase: depositAmount,
        currency: 'USD'
      };
    } catch (error) {
      logger.error('Failed to calculate deposit fee:', error);
      throw error;
    }
  }

  /**
   * Calculate listing fee for issuers
   */
  async calculateListingFee(feeType: 'initial_listing' | 'annual_maintenance'): Promise<FeeCalculationResult> {
    try {
      const feeConfig = await this.getFeeConfig();
      const listingFeeConfig = feeConfig.listingFee;

      const amount = feeType === 'initial_listing' 
        ? listingFeeConfig.flatFee 
        : listingFeeConfig.annualFee;

      return {
        amount,
        flatFee: amount,
        calculationBase: amount,
        currency: 'USD'
      };
    } catch (error) {
      logger.error('Failed to calculate listing fee:', error);
      throw error;
    }
  }

  /**
   * Create and collect trading fees for a trade
   */
  async collectTradingFees(
    tradeId: mongoose.Types.ObjectId,
    buyerId: mongoose.Types.ObjectId,
    sellerId: mongoose.Types.ObjectId,
    tradeAmount: number,
    productId: mongoose.Types.ObjectId,
    session?: mongoose.ClientSession
  ): Promise<{ buyerFeeTransaction: IFeeTransaction; sellerFeeTransaction: IFeeTransaction }> {
    try {
      const tradingFees = await this.calculateTradingFees(tradeAmount);

      // Create buyer fee transaction
      const buyerFeeTransaction = new FeeTransaction({
        userId: buyerId,
        transactionId: tradeId,
        feeType: 'trading',
        feeCategory: 'buyer_fee',
        amount: tradingFees.buyerFee.amount,
        currency: tradingFees.buyerFee.currency,
        feeRate: tradingFees.buyerFee.feeRate,
        calculationBase: tradingFees.buyerFee.calculationBase,
        status: 'pending',
        metadata: {
          tradeId,
          productId,
          sellerId
        }
      });

      // Create seller fee transaction
      const sellerFeeTransaction = new FeeTransaction({
        userId: sellerId,
        transactionId: tradeId,
        feeType: 'trading',
        feeCategory: 'seller_fee',
        amount: tradingFees.sellerFee.amount,
        currency: tradingFees.sellerFee.currency,
        feeRate: tradingFees.sellerFee.feeRate,
        calculationBase: tradingFees.sellerFee.calculationBase,
        status: 'pending',
        metadata: {
          tradeId,
          productId,
          buyerId
        }
      });

      // Save fee transactions
      if (session) {
        await buyerFeeTransaction.save({ session });
        await sellerFeeTransaction.save({ session });
      } else {
        await buyerFeeTransaction.save();
        await sellerFeeTransaction.save();
      }

      // Collect fees from user wallets
      await this.deductFeeFromWallet(buyerId, tradingFees.buyerFee.amount, session);
      await this.deductFeeFromWallet(sellerId, tradingFees.sellerFee.amount, session);

      // Mark fees as collected
      await buyerFeeTransaction.collect();
      await sellerFeeTransaction.collect();

      logger.info('Trading fees collected successfully', {
        tradeId,
        buyerId,
        sellerId,
        buyerFee: tradingFees.buyerFee.amount,
        sellerFee: tradingFees.sellerFee.amount,
        totalFees: tradingFees.totalFees
      });

      return { buyerFeeTransaction, sellerFeeTransaction };
    } catch (error) {
      logger.error('Failed to collect trading fees:', error);
      throw error;
    }
  }

  /**
   * Create and collect withdrawal fee
   */
  async collectWithdrawalFee(
    userId: mongoose.Types.ObjectId,
    withdrawalId: mongoose.Types.ObjectId,
    withdrawalAmount: number,
    session?: mongoose.ClientSession
  ): Promise<IFeeTransaction> {
    try {
      const withdrawalFee = await this.calculateWithdrawalFee(withdrawalAmount);

      const feeTransaction = new FeeTransaction({
        userId,
        transactionId: withdrawalId,
        feeType: 'withdrawal',
        feeCategory: 'withdrawal_fee',
        amount: withdrawalFee.amount,
        currency: withdrawalFee.currency,
        feeRate: withdrawalFee.feeRate,
        flatFee: withdrawalFee.flatFee,
        calculationBase: withdrawalFee.calculationBase,
        status: 'pending',
        metadata: {
          withdrawalId
        }
      });

      if (session) {
        await feeTransaction.save({ session });
      } else {
        await feeTransaction.save();
      }

      // Deduct fee from user wallet
      await this.deductFeeFromWallet(userId, withdrawalFee.amount, session);

      // Mark fee as collected
      await feeTransaction.collect();

      logger.info('Withdrawal fee collected successfully', {
        userId,
        withdrawalId,
        feeAmount: withdrawalFee.amount
      });

      return feeTransaction;
    } catch (error) {
      logger.error('Failed to collect withdrawal fee:', error);
      throw error;
    }
  }

  /**
   * Create listing fee for issuer
   */
  async createListingFee(
    issuerId: mongoose.Types.ObjectId,
    productId: mongoose.Types.ObjectId,
    feeType: 'initial_listing' | 'annual_maintenance',
    dueDate?: Date
  ): Promise<IListingFee> {
    try {
      const listingFee = await this.calculateListingFee(feeType);
      
      const fee = new ListingFee({
        issuerId,
        productId,
        feeType,
        amount: listingFee.amount,
        currency: listingFee.currency,
        dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        status: 'pending'
      });

      await fee.save();

      logger.info('Listing fee created', {
        issuerId,
        productId,
        feeType,
        amount: listingFee.amount,
        dueDate: fee.dueDate
      });

      return fee;
    } catch (error) {
      logger.error('Failed to create listing fee:', error);
      throw error;
    }
  }

  /**
   * Get fee transactions for a user
   */
  async getUserFeeTransactions(
    userId: mongoose.Types.ObjectId,
    feeType?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<IFeeTransaction[]> {
    try {
      const query: any = { userId };
      if (feeType) {
        query.feeType = feeType;
      }

      const feeTransactions = await FeeTransaction.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(offset)
        .populate('transactionId')
        .lean();
      
      return feeTransactions as unknown as IFeeTransaction[];
    } catch (error) {
      logger.error('Failed to get user fee transactions:', error);
      throw error;
    }
  }

  /**
   * Get listing fees for an issuer
   */
  async getIssuerListingFees(
    issuerId: mongoose.Types.ObjectId,
    status?: string
  ): Promise<IListingFee[]> {
    try {
      const query: any = { issuerId };
      if (status) {
        query.status = status;
      }

      const listingFees = await ListingFee.find(query)
        .sort({ createdAt: -1 })
        .populate('productId', 'name symbol')
        .lean();
      
      return listingFees as unknown as IListingFee[];
    } catch (error) {
      logger.error('Failed to get issuer listing fees:', error);
      throw error;
    }
  }

  /**
   * Private helper method to calculate fee amount
   */
  private calculateFeeAmount(
    baseAmount: number,
    percentage: number,
    flatFee: number,
    minimum: number,
    maximum: number
  ): number {
    let fee = 0;

    // Apply percentage fee
    if (percentage > 0) {
      fee += baseAmount * (percentage / 100);
    }

    // Add flat fee
    if (flatFee > 0) {
      fee += flatFee;
    }

    // Apply minimum fee
    if (minimum > 0 && fee < minimum) {
      fee = minimum;
    }

    // Apply maximum fee
    if (maximum > 0 && fee > maximum) {
      fee = maximum;
    }

    return Math.round(fee * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Private helper method to deduct fee from user wallet
   */
  private async deductFeeFromWallet(
    userId: mongoose.Types.ObjectId,
    feeAmount: number,
    session?: mongoose.ClientSession
  ): Promise<void> {
    try {
      const wallet = await Wallet.findOne({ userId }).session(session || null);
      if (!wallet) {
        throw new Error('User wallet not found');
      }

      const currentBalance = wallet.getTotalBalanceUSD();
      if (currentBalance < feeAmount) {
        throw new Error('Insufficient balance to pay fee');
      }

      // Deduct from USDT Ethereum balance (primary balance)
      // In a real implementation, you might want to deduct from the same currency as the transaction
      const newBalance = wallet.balances.usdt.ethereum - feeAmount;
      wallet.updateBalance('ethereum', 'usdt', newBalance);

      if (session) {
        await wallet.save({ session });
      } else {
        await wallet.save();
      }

      logger.debug('Fee deducted from wallet', {
        userId,
        feeAmount,
        previousBalance: currentBalance,
        newBalance: wallet.getTotalBalanceUSD()
      });
    } catch (error) {
      logger.error('Failed to deduct fee from wallet:', error);
      throw error;
    }
  }
}

export const feeService = new FeeService();