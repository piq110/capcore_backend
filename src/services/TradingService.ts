import { Order } from '@/models/Order';
import { Trade } from '@/models/Trade';
import { InvestmentProduct } from '@/models/InvestmentProduct';
import { Wallet } from '@/models/Wallet';
import { Portfolio } from '@/models/Portfolio';
import { AssetTransferService, assetTransferService } from './AssetTransferService';
import { FeeService, feeService } from './FeeService';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';

export interface OrderMatch {
  buyOrder: any;
  sellOrder: any;
  matchedQuantity: number;
  matchedPrice: number;
}

export interface TradeExecutionResult {
  trade: any;
  success: boolean;
  error?: string;
}

export class TradingService {
  private assetTransferService: AssetTransferService;
  private feeService: FeeService;

  constructor(assetTransferService: AssetTransferService, feeService: FeeService) {
    this.assetTransferService = assetTransferService;
    this.feeService = feeService;
  }
  /**
   * Find matching orders for a given product
   */
  async findMatches(productId: string): Promise<OrderMatch[]> {
    try {
      // Get all pending buy and sell orders for the product
      const [buyOrders, sellOrders] = await Promise.all([
        Order.find({
          productId,
          type: 'buy',
          status: { $in: ['pending', 'partially_filled'] },
          remainingQuantity: { $gt: 0 }
        }).sort({ pricePerShare: -1, createdAt: 1 }), // Highest price first, then FIFO

        Order.find({
          productId,
          type: 'sell',
          status: { $in: ['pending', 'partially_filled'] },
          remainingQuantity: { $gt: 0 }
        }).sort({ pricePerShare: 1, createdAt: 1 }) // Lowest price first, then FIFO
      ]);

      const matches: OrderMatch[] = [];

      // Match orders using price-time priority
      for (const buyOrder of buyOrders) {
        for (const sellOrder of sellOrders) {
          // Check if orders can match (buy price >= sell price)
          if (buyOrder.pricePerShare >= sellOrder.pricePerShare) {
            // Determine matched quantity (minimum of remaining quantities)
            const matchedQuantity = Math.min(
              buyOrder.remainingQuantity,
              sellOrder.remainingQuantity
            );

            if (matchedQuantity > 0) {
              // Use the sell order price (price improvement for buyer)
              const matchedPrice = sellOrder.pricePerShare;

              matches.push({
                buyOrder,
                sellOrder,
                matchedQuantity,
                matchedPrice
              });

              // Update remaining quantities for simulation
              buyOrder.remainingQuantity -= matchedQuantity;
              sellOrder.remainingQuantity -= matchedQuantity;

              // If sell order is fully matched, move to next sell order
              if (sellOrder.remainingQuantity === 0) {
                break;
              }
            }
          } else {
            // No more matches possible for this buy order
            break;
          }
        }
      }

      return matches;
    } catch (error) {
      logger.error('Error finding order matches:', error);
      throw error;
    }
  }

  /**
   * Execute a trade between matched orders
   */
  async executeTrade(match: OrderMatch): Promise<TradeExecutionResult> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { buyOrder, sellOrder, matchedQuantity, matchedPrice } = match;
      const totalAmount = matchedQuantity * matchedPrice;

      // Calculate fees using FeeService
      const tradingFees = await this.feeService.calculateTradingFees(totalAmount);
      const buyerFees = tradingFees.buyerFee.amount;
      const sellerFees = tradingFees.sellerFee.amount;

      // Verify orders still exist and have sufficient remaining quantity
      const [currentBuyOrder, currentSellOrder] = await Promise.all([
        Order.findById(buyOrder._id).session(session),
        Order.findById(sellOrder._id).session(session)
      ]);

      if (!currentBuyOrder || !currentSellOrder) {
        throw new Error('One or both orders no longer exist');
      }

      if (currentBuyOrder.remainingQuantity < matchedQuantity ||
          currentSellOrder.remainingQuantity < matchedQuantity) {
        throw new Error('Insufficient remaining quantity in orders');
      }

      // Verify buyer has sufficient funds
      const buyerWallet = await Wallet.findOne({ userId: buyOrder.userId }).session(session);
      if (!buyerWallet) {
        throw new Error('Buyer wallet not found');
      }

      const requiredAmount = totalAmount + buyerFees;
      if (buyerWallet.getTotalBalanceUSD() < requiredAmount) {
        throw new Error('Buyer has insufficient funds');
      }

      // Create the trade record
      const trade = new Trade({
        buyOrderId: buyOrder._id,
        sellOrderId: sellOrder._id,
        buyerId: buyOrder.userId,
        sellerId: sellOrder.userId,
        productId: buyOrder.productId,
        quantity: matchedQuantity,
        pricePerShare: matchedPrice,
        totalAmount,
        buyerFees,
        sellerFees,
        status: 'pending'
      });

      await trade.save({ session });

      // Update buy order
      currentBuyOrder.partialFill(matchedQuantity, matchedPrice);
      await currentBuyOrder.save({ session });

      // Update sell order
      currentSellOrder.partialFill(matchedQuantity, matchedPrice);
      await currentSellOrder.save({ session });

      // Update buyer's wallet (deduct funds)
      const buyerCurrentBalance = buyerWallet.getTotalBalanceUSD();
      // In a real implementation, we'd need to handle multi-token balances properly
      // For now, we'll assume USDT on Ethereum as the primary balance
      buyerWallet.updateBalance('ethereum', 'usdt', 
        buyerWallet.balances.usdt.ethereum - requiredAmount);
      await buyerWallet.save({ session });

      // Update seller's wallet (add funds minus fees)
      const sellerWallet = await Wallet.findOne({ userId: sellOrder.userId }).session(session);
      if (sellerWallet) {
        const sellerReceives = totalAmount - sellerFees;
        sellerWallet.updateBalance('ethereum', 'usdt',
          sellerWallet.balances.usdt.ethereum + sellerReceives);
        await sellerWallet.save({ session });
      }

      // Update product available shares
      const product = await InvestmentProduct.findById(buyOrder.productId).session(session);
      if (product) {
        // For buy orders, reduce available shares
        // For sell orders, this would increase available shares
        // This is a simplified implementation
        product.availableShares = Math.max(0, product.availableShares - matchedQuantity);
        await product.save({ session });
      }

      // Update portfolios (temporarily - will be finalized after custodial transfer)
      await this.updatePortfolios(trade, session);

      // Collect trading fees
      await this.feeService.collectTradingFees(
        trade._id as mongoose.Types.ObjectId,
        buyOrder.userId,
        sellOrder.userId,
        totalAmount,
        buyOrder.productId,
        session
      );

      await session.commitTransaction();

      // Initiate custodial transfer (outside of transaction)
      try {
        await this.assetTransferService.executeAssetTransfer(trade);
        
        logger.info('Custodial transfer initiated for trade', {
          tradeId: trade._id,
        });
      } catch (custodialError) {
        logger.error('Failed to initiate custodial transfer:', custodialError);
        
        // Mark trade as failed due to custodial issues
        trade.fail('Custodial transfer initiation failed');
        await trade.save();
        
        return {
          trade,
          success: false,
          error: 'Custodial transfer failed: ' + (custodialError instanceof Error ? custodialError.message : 'Unknown error')
        };
      }

      logger.info('Trade executed successfully', {
        tradeId: trade._id,
        buyOrderId: buyOrder._id,
        sellOrderId: sellOrder._id,
        quantity: matchedQuantity,
        price: matchedPrice,
        totalAmount,
        buyerFees,
        sellerFees
      });

      return {
        trade,
        success: true
      };

    } catch (error) {
      await session.abortTransaction();
      logger.error('Trade execution failed:', error);
      
      return {
        trade: null,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      session.endSession();
    }
  }

  /**
   * Process all pending matches for a product
   */
  async processMatches(productId: string): Promise<TradeExecutionResult[]> {
    try {
      const matches = await this.findMatches(productId);
      const results: TradeExecutionResult[] = [];

      for (const match of matches) {
        const result = await this.executeTrade(match);
        results.push(result);

        // If trade failed, log and continue with next match
        if (!result.success) {
          logger.warn('Trade execution failed, continuing with next match', {
            error: result.error,
            buyOrderId: match.buyOrder._id,
            sellOrderId: match.sellOrder._id
          });
        }
      }

      return results;
    } catch (error) {
      logger.error('Error processing matches:', error);
      throw error;
    }
  }

  /**
   * Get order book for a product
   */
  async getOrderBook(productId: string, depth: number = 10) {
    try {
      const [buyOrders, sellOrders] = await Promise.all([
        Order.aggregate([
          {
            $match: {
              productId: new mongoose.Types.ObjectId(productId),
              type: 'buy',
              status: { $in: ['pending', 'partially_filled'] },
              remainingQuantity: { $gt: 0 }
            }
          },
          {
            $group: {
              _id: '$pricePerShare',
              totalQuantity: { $sum: '$remainingQuantity' },
              orderCount: { $sum: 1 }
            }
          },
          {
            $sort: { _id: -1 } // Highest price first
          },
          {
            $limit: depth
          },
          {
            $project: {
              price: '$_id',
              quantity: '$totalQuantity',
              orders: '$orderCount',
              _id: 0
            }
          }
        ]),

        Order.aggregate([
          {
            $match: {
              productId: new mongoose.Types.ObjectId(productId),
              type: 'sell',
              status: { $in: ['pending', 'partially_filled'] },
              remainingQuantity: { $gt: 0 }
            }
          },
          {
            $group: {
              _id: '$pricePerShare',
              totalQuantity: { $sum: '$remainingQuantity' },
              orderCount: { $sum: 1 }
            }
          },
          {
            $sort: { _id: 1 } // Lowest price first
          },
          {
            $limit: depth
          },
          {
            $project: {
              price: '$_id',
              quantity: '$totalQuantity',
              orders: '$orderCount',
              _id: 0
            }
          }
        ])
      ]);

      return {
        bids: buyOrders, // Buy orders (bids)
        asks: sellOrders, // Sell orders (asks)
        spread: buyOrders.length > 0 && sellOrders.length > 0 
          ? sellOrders[0].price - buyOrders[0].price 
          : null
      };
    } catch (error) {
      logger.error('Error getting order book:', error);
      throw error;
    }
  }

  /**
   * Get recent trades for a product
   */
  async getRecentTrades(productId: string, limit: number = 50) {
    try {
      const trades = await Trade.find({
        productId,
        status: 'settled'
      })
      .populate('buyerId', 'email')
      .populate('sellerId', 'email')
      .populate('productId', 'name symbol')
      .sort({ executedAt: -1 })
      .limit(limit)
      .lean();

      return trades.map(trade => ({
        id: trade._id,
        quantity: trade.quantity,
        price: trade.pricePerShare,
        totalAmount: trade.totalAmount,
        executedAt: trade.executedAt,
        settledAt: trade.settledAt,
        // Don't expose user details for privacy
        product: (trade as any).productId
      }));
    } catch (error) {
      logger.error('Error getting recent trades:', error);
      throw error;
    }
  }

  /**
   * Update portfolios after trade execution
   */
  private async updatePortfolios(trade: any, session: mongoose.ClientSession): Promise<void> {
    try {
      // Update buyer's portfolio
      let buyerPortfolio = await Portfolio.findOne({ userId: trade.buyerId }).session(session);
      if (!buyerPortfolio) {
        buyerPortfolio = new Portfolio({
          userId: trade.buyerId,
          holdings: [],
          cashBalance: 0,
        });
      }

      // Add shares to buyer's portfolio
      buyerPortfolio.addHolding(
        trade.productId,
        trade.quantity,
        trade.pricePerShare
      );
      await buyerPortfolio.save({ session });

      // Update seller's portfolio
      let sellerPortfolio = await Portfolio.findOne({ userId: trade.sellerId }).session(session);
      if (!sellerPortfolio) {
        sellerPortfolio = new Portfolio({
          userId: trade.sellerId,
          holdings: [],
          cashBalance: 0,
        });
      }

      // Remove shares from seller's portfolio
      sellerPortfolio.updateHolding(
        trade.productId,
        -trade.quantity, // Negative for selling
        trade.pricePerShare
      );
      await sellerPortfolio.save({ session });

      logger.info('Portfolios updated after trade', {
        tradeId: trade._id,
        buyerId: trade.buyerId,
        sellerId: trade.sellerId,
        quantity: trade.quantity,
        price: trade.pricePerShare
      });

    } catch (error) {
      logger.error('Failed to update portfolios:', error);
      throw error;
    }
  }
}

export const tradingService = new TradingService(assetTransferService, feeService);