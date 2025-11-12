import { CustodialTransfer, ICustodialTransfer } from '@/models/CustodialTransfer';
import { ShareRegister, IShareRegisterEntry } from '@/models/ShareRegister';
import { Trade, ITrade } from '@/models/Trade';
import { User } from '@/models/User';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';
import crypto from 'crypto';

export interface CustodianConfig {
  name: string;
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  accountPrefix: string;
  timeout: number;
}

export interface ShareTransferRequest {
  fromAccountNumber: string;
  toAccountNumber: string;
  productSymbol: string;
  quantity: number;
  transferType: 'buy' | 'sell' | 'transfer';
  instructions?: string;
}

export interface ShareTransferResponse {
  transferId: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'settled' | 'failed';
  custodianReference: string;
  estimatedSettlementDate?: Date;
  fees?: number;
  message?: string;
}

export interface CustodianBalance {
  accountNumber: string;
  productSymbol: string;
  quantity: number;
  marketValue: number;
  lastUpdated: Date;
}

export interface ReconciliationReport {
  productId: mongoose.Types.ObjectId;
  platformHoldings: number;
  custodianHoldings: number;
  discrepancy: number;
  lastReconciled: Date;
  status: 'matched' | 'discrepancy' | 'error';
}

export class CustodianService {
  private config: CustodianConfig;

  constructor(config: CustodianConfig) {
    this.config = config;
  }

  /**
   * Initialize share transfer for a trade
   */
  async initiateShareTransfer(trade: ITrade): Promise<ICustodialTransfer> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Validate trade
      if (trade.status !== 'pending') {
        throw new Error('Can only initiate transfer for pending trades');
      }

      // Get trade participants and product details
      const [buyer, seller, product] = await Promise.all([
        User.findById(trade.buyerId).session(session),
        User.findById(trade.sellerId).session(session),
        InvestmentProduct.findById(trade.productId).session(session)
      ]);

      if (!buyer || !seller || !product) {
        throw new Error('Trade participants or product not found');
      }

      // Generate unique transfer ID
      const transferId = this.generateTransferId();

      // Get custodian account numbers
      const buyerAccountNumber = this.getCustodianAccountNumber(buyer._id as mongoose.Types.ObjectId);
      const sellerAccountNumber = this.getCustodianAccountNumber(seller._id as mongoose.Types.ObjectId);

      // Create custodial transfer record
      const custodialTransfer = new CustodialTransfer({
        tradeId: trade._id,
        transferId,
        fromUserId: trade.sellerId,
        toUserId: trade.buyerId,
        productId: trade.productId,
        quantity: trade.quantity,
        transferType: 'buy',
        status: 'pending',
        custodianReference: `${this.config.name}-${transferId}`,
        metadata: {
          custodianName: this.config.name,
          accountNumbers: {
            from: sellerAccountNumber,
            to: buyerAccountNumber,
          },
          instructions: `Transfer ${trade.quantity} shares of ${product.symbol} from ${seller.email} to ${buyer.email}`,
        },
      });

      await custodialTransfer.save({ session });

      // Update trade with custodial transfer reference
      trade.custodialTransferId = transferId;
      trade.custodialStatus = 'pending';
      await trade.save({ session });

      await session.commitTransaction();

      logger.info('Share transfer initiated', {
        tradeId: trade._id,
        transferId,
        fromUser: seller.email,
        toUser: buyer.email,
        product: product.symbol,
        quantity: trade.quantity,
      });

      return custodialTransfer;

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to initiate share transfer:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Submit transfer request to custodian
   */
  async submitTransferToCustodian(transferId: string): Promise<ShareTransferResponse> {
    try {
      const custodialTransfer = await CustodialTransfer.findOne({ transferId })
        .populate('fromUserId', 'email')
        .populate('toUserId', 'email')
        .populate('productId', 'symbol name');

      if (!custodialTransfer) {
        throw new Error('Custodial transfer not found');
      }

      if (custodialTransfer.status !== 'pending') {
        throw new Error('Transfer can only be submitted from pending status');
      }

      // Prepare transfer request
      const transferRequest: ShareTransferRequest = {
        fromAccountNumber: custodialTransfer.metadata.accountNumbers.from!,
        toAccountNumber: custodialTransfer.metadata.accountNumbers.to!,
        productSymbol: (custodialTransfer.productId as any).symbol,
        quantity: custodialTransfer.quantity,
        transferType: custodialTransfer.transferType,
        instructions: custodialTransfer.metadata.instructions,
      };

      // Submit to custodian API
      const response = await this.callCustodianAPI('/transfers', 'POST', transferRequest);

      // Update custodial transfer status
      custodialTransfer.submit();
      custodialTransfer.custodianReference = response.custodianReference;
      if (response.fees) {
        custodialTransfer.metadata.fees = response.fees;
      }
      await custodialTransfer.save();

      // Update associated trade
      const trade = await Trade.findById(custodialTransfer.tradeId);
      if (trade) {
        trade.custodialStatus = 'pending';
        await trade.save();
      }

      logger.info('Transfer submitted to custodian', {
        transferId,
        custodianReference: response.custodianReference,
        status: response.status,
      });

      return response;

    } catch (error) {
      logger.error('Failed to submit transfer to custodian:', error);
      throw error;
    }
  }

  /**
   * Check transfer status with custodian
   */
  async checkTransferStatus(transferId: string): Promise<ShareTransferResponse> {
    try {
      const custodialTransfer = await CustodialTransfer.findOne({ transferId });

      if (!custodialTransfer) {
        throw new Error('Custodial transfer not found');
      }

      // Query custodian API for status
      const response = await this.callCustodianAPI(
        `/transfers/${custodialTransfer.custodianReference}`,
        'GET'
      );

      // Update status based on custodian response
      await this.updateTransferStatus(custodialTransfer, response);

      return response;

    } catch (error) {
      logger.error('Failed to check transfer status:', error);
      throw error;
    }
  }

  /**
   * Confirm transfer completion
   */
  async confirmTransfer(transferId: string): Promise<void> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const custodialTransfer = await CustodialTransfer.findOne({ transferId }).session(session);

      if (!custodialTransfer) {
        throw new Error('Custodial transfer not found');
      }

      if (custodialTransfer.status !== 'submitted') {
        throw new Error('Transfer must be in submitted status to confirm');
      }

      // Confirm the transfer
      custodialTransfer.confirm();
      await custodialTransfer.save({ session });

      // Update associated trade
      const trade = await Trade.findById(custodialTransfer.tradeId).session(session);
      if (trade) {
        trade.custodialStatus = 'completed';
        await trade.save({ session });
      }

      // Update share register
      await this.updateShareRegister(custodialTransfer, session);

      await session.commitTransaction();

      logger.info('Transfer confirmed', {
        transferId,
        custodianReference: custodialTransfer.custodianReference,
      });

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to confirm transfer:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Settle transfer and update ownership records
   */
  async settleTransfer(transferId: string): Promise<void> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const custodialTransfer = await CustodialTransfer.findOne({ transferId }).session(session);

      if (!custodialTransfer) {
        throw new Error('Custodial transfer not found');
      }

      if (!custodialTransfer.isSettleable()) {
        throw new Error('Transfer is not in a settleable state');
      }

      // Settle the transfer
      custodialTransfer.settle();
      await custodialTransfer.save({ session });

      // Update associated trade to settled
      const trade = await Trade.findById(custodialTransfer.tradeId).session(session);
      if (trade && trade.canSettle()) {
        trade.settle();
        await trade.save({ session });
      }

      // Finalize share register updates
      await this.finalizeShareOwnership(custodialTransfer, session);

      await session.commitTransaction();

      logger.info('Transfer settled', {
        transferId,
        custodianReference: custodialTransfer.custodianReference,
        fromUserId: custodialTransfer.fromUserId,
        toUserId: custodialTransfer.toUserId,
        quantity: custodialTransfer.quantity,
      });

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to settle transfer:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Get custodian balances for reconciliation
   */
  async getCustodianBalances(accountNumber?: string): Promise<CustodianBalance[]> {
    try {
      const endpoint = accountNumber 
        ? `/accounts/${accountNumber}/balances`
        : '/balances';

      const response = await this.callCustodianAPI(endpoint, 'GET');

      return response.balances || [];

    } catch (error) {
      logger.error('Failed to get custodian balances:', error);
      throw error;
    }
  }

  /**
   * Reconcile platform holdings with custodian records
   */
  async reconcileHoldings(productId?: mongoose.Types.ObjectId): Promise<ReconciliationReport[]> {
    try {
      const reports: ReconciliationReport[] = [];

      // Get products to reconcile
      const products = productId 
        ? [await InvestmentProduct.findById(productId)]
        : await InvestmentProduct.find({ status: 'active' });

      for (const product of products) {
        if (!product) continue;

        try {
          // Get platform holdings
          const platformHoldings = await ShareRegister.aggregate([
            {
              $match: {
                productId: product._id,
                status: 'active',
              },
            },
            {
              $group: {
                _id: null,
                totalQuantity: { $sum: '$quantity' },
              },
            },
          ]);

          const platformTotal = platformHoldings[0]?.totalQuantity || 0;

          // Get custodian holdings
          const custodianBalances = await this.getCustodianBalances();
          const custodianTotal = custodianBalances
            .filter(balance => balance.productSymbol === product.symbol)
            .reduce((total, balance) => total + balance.quantity, 0);

          const discrepancy = platformTotal - custodianTotal;

          reports.push({
            productId: product._id as mongoose.Types.ObjectId,
            platformHoldings: platformTotal,
            custodianHoldings: custodianTotal,
            discrepancy,
            lastReconciled: new Date(),
            status: discrepancy === 0 ? 'matched' : 'discrepancy',
          });

        } catch (error) {
          logger.error(`Failed to reconcile product ${product.symbol}:`, error);
          reports.push({
            productId: product._id as mongoose.Types.ObjectId,
            platformHoldings: 0,
            custodianHoldings: 0,
            discrepancy: 0,
            lastReconciled: new Date(),
            status: 'error',
          });
        }
      }

      return reports;

    } catch (error) {
      logger.error('Failed to reconcile holdings:', error);
      throw error;
    }
  }

  /**
   * Get transfer history for audit purposes
   */
  async getTransferHistory(
    userId?: mongoose.Types.ObjectId,
    productId?: mongoose.Types.ObjectId,
    limit: number = 100
  ): Promise<ICustodialTransfer[]> {
    try {
      const query: any = {};

      if (userId) {
        query.$or = [
          { fromUserId: userId },
          { toUserId: userId },
        ];
      }

      if (productId) {
        query.productId = productId;
      }

      const transfers = await CustodialTransfer.find(query)
        .populate('fromUserId', 'email')
        .populate('toUserId', 'email')
        .populate('productId', 'name symbol')
        .populate('tradeId')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return transfers as unknown as ICustodialTransfer[];

    } catch (error) {
      logger.error('Failed to get transfer history:', error);
      throw error;
    }
  }

  /**
   * Private helper methods
   */

  private generateTransferId(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(4).toString('hex');
    return `TXF-${timestamp}-${random}`.toUpperCase();
  }

  private getCustodianAccountNumber(userId: mongoose.Types.ObjectId): string {
    // Generate or retrieve custodian account number for user
    // In a real implementation, this would be stored in the user profile
    return `${this.config.accountPrefix}${userId.toString().slice(-8).toUpperCase()}`;
  }

  private async callCustodianAPI(endpoint: string, method: string, data?: any): Promise<any> {
    try {
      // In a real implementation, this would make actual HTTP requests to the custodian API
      // For now, we'll simulate the API responses
      
      const timestamp = Date.now().toString();
      const signature = this.generateAPISignature(method, endpoint, data, timestamp);

      // Simulate API call delay
      await new Promise(resolve => setTimeout(resolve, 100));

      // Mock responses based on endpoint
      if (endpoint === '/transfers' && method === 'POST') {
        return {
          transferId: this.generateTransferId(),
          status: 'submitted',
          custodianReference: `CUST-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
          estimatedSettlementDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days
          fees: 25.00,
          message: 'Transfer request submitted successfully',
        };
      }

      if (endpoint.startsWith('/transfers/') && method === 'GET') {
        return {
          status: 'confirmed',
          custodianReference: endpoint.split('/')[2],
          message: 'Transfer confirmed by custodian',
        };
      }

      if (endpoint.includes('/balances')) {
        return {
          balances: [
            {
              accountNumber: 'ACC123456',
              productSymbol: 'REIT001',
              quantity: 1000,
              marketValue: 50000,
              lastUpdated: new Date(),
            },
          ],
        };
      }

      throw new Error(`Unsupported API endpoint: ${endpoint}`);

    } catch (error) {
      logger.error('Custodian API call failed:', error);
      throw error;
    }
  }

  private generateAPISignature(method: string, endpoint: string, data: any, timestamp: string): string {
    const payload = `${method}${endpoint}${JSON.stringify(data || {})}${timestamp}`;
    return crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(payload)
      .digest('hex');
  }

  private async updateTransferStatus(
    custodialTransfer: ICustodialTransfer,
    response: ShareTransferResponse
  ): Promise<void> {
    try {
      const previousStatus = custodialTransfer.status;

      switch (response.status) {
        case 'confirmed':
          if (custodialTransfer.status === 'submitted') {
            custodialTransfer.confirm();
          }
          break;
        case 'settled':
          if (custodialTransfer.status === 'confirmed') {
            custodialTransfer.settle();
          }
          break;
        case 'failed':
          custodialTransfer.fail(response.message || 'Transfer failed at custodian');
          break;
      }

      if (custodialTransfer.status !== previousStatus) {
        await custodialTransfer.save();
        
        logger.info('Transfer status updated', {
          transferId: custodialTransfer.transferId,
          previousStatus,
          newStatus: custodialTransfer.status,
        });
      }

    } catch (error) {
      logger.error('Failed to update transfer status:', error);
      throw error;
    }
  }

  private async updateShareRegister(
    custodialTransfer: ICustodialTransfer,
    session: mongoose.ClientSession
  ): Promise<void> {
    try {
      // Find seller's share register entry
      const sellerShares = await ShareRegister.findOne({
        userId: custodialTransfer.fromUserId,
        productId: custodialTransfer.productId,
        status: 'active',
        quantity: { $gte: custodialTransfer.quantity },
      }).session(session);

      if (!sellerShares) {
        throw new Error('Seller does not have sufficient shares');
      }

      // Transfer shares from seller
      sellerShares.transfer(
        custodialTransfer.toUserId,
        custodialTransfer.quantity,
        custodialTransfer._id as mongoose.Types.ObjectId,
        'Trade execution'
      );
      await sellerShares.save({ session });

      // Create or update buyer's share register entry
      let buyerShares = await ShareRegister.findOne({
        userId: custodialTransfer.toUserId,
        productId: custodialTransfer.productId,
        status: 'active',
      }).session(session);

      if (buyerShares) {
        buyerShares.quantity += custodialTransfer.quantity;
        await buyerShares.save({ session });
      } else {
        // Create new share register entry for buyer
        const trade = await Trade.findById(custodialTransfer.tradeId).session(session);
        buyerShares = new ShareRegister({
          userId: custodialTransfer.toUserId,
          productId: custodialTransfer.productId,
          quantity: custodialTransfer.quantity,
          acquisitionDate: new Date(),
          acquisitionPrice: trade?.pricePerShare || 0,
          custodianAccountNumber: this.getCustodianAccountNumber(custodialTransfer.toUserId),
          custodianReference: custodialTransfer.custodianReference,
          status: 'active',
        });
        await buyerShares.save({ session });
      }

    } catch (error) {
      logger.error('Failed to update share register:', error);
      throw error;
    }
  }

  private async finalizeShareOwnership(
    custodialTransfer: ICustodialTransfer,
    session: mongoose.ClientSession
  ): Promise<void> {
    try {
      // This method would handle final ownership transfer confirmations
      // and any additional custodial requirements

      logger.info('Share ownership finalized', {
        transferId: custodialTransfer.transferId,
        fromUserId: custodialTransfer.fromUserId,
        toUserId: custodialTransfer.toUserId,
        productId: custodialTransfer.productId,
        quantity: custodialTransfer.quantity,
      });

    } catch (error) {
      logger.error('Failed to finalize share ownership:', error);
      throw error;
    }
  }
}

// Export singleton instance with default configuration
export const custodianService = new CustodianService({
  name: process.env.CUSTODIAN_NAME || 'DefaultCustodian',
  apiUrl: process.env.CUSTODIAN_API_URL || 'https://api.custodian.example.com',
  apiKey: process.env.CUSTODIAN_API_KEY || '',
  apiSecret: process.env.CUSTODIAN_API_SECRET || '',
  accountPrefix: process.env.CUSTODIAN_ACCOUNT_PREFIX || 'AIM',
  timeout: parseInt(process.env.CUSTODIAN_API_TIMEOUT || '30000'),
});