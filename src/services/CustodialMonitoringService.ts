import { CustodianService, custodianService } from './CustodianService';
import { CustodialTransfer } from '@/models/CustodialTransfer';
import { Trade } from '@/models/Trade';
import { logger } from '@/utils/logger';
import cron from 'node-cron';

export interface MonitoringConfig {
  enabled: boolean;
  checkInterval: string; // cron expression
  maxRetries: number;
  retryDelay: number; // in milliseconds
  alertThreshold: number; // hours before alerting on stuck transfers
}

export class CustodialMonitoringService {
  private custodianService: CustodianService;
  private config: MonitoringConfig;
  private isRunning: boolean = false;
  private cronJob?: any;

  constructor(custodianService: CustodianService, config: MonitoringConfig) {
    this.custodianService = custodianService;
    this.config = config;
  }

  /**
   * Start the monitoring service
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Custodial monitoring service is disabled');
      return;
    }

    if (this.isRunning) {
      logger.warn('Custodial monitoring service is already running');
      return;
    }

    this.cronJob = cron.schedule(this.config.checkInterval, async () => {
      await this.performMonitoringCycle();
    });

    this.cronJob.start();
    this.isRunning = true;

    logger.info('Custodial monitoring service started', {
      interval: this.config.checkInterval,
      maxRetries: this.config.maxRetries,
      alertThreshold: this.config.alertThreshold,
    });
  }

  /**
   * Stop the monitoring service
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = undefined;
    }

    this.isRunning = false;
    logger.info('Custodial monitoring service stopped');
  }

  /**
   * Perform a single monitoring cycle
   */
  async performMonitoringCycle(): Promise<void> {
    try {
      logger.info('Starting custodial monitoring cycle');

      // Get all pending transfers
      const pendingTransfers = await CustodialTransfer.find({
        status: { $in: ['pending', 'submitted', 'confirmed'] },
      }).populate('tradeId');

      logger.info(`Found ${pendingTransfers.length} pending transfers to monitor`);

      const results = {
        checked: 0,
        updated: 0,
        failed: 0,
        alerts: 0,
      };

      // Check each pending transfer
      for (const transfer of pendingTransfers) {
        try {
          await this.checkTransferStatus(transfer);
          results.checked++;

          // Check if transfer is stuck
          if (this.isTransferStuck(transfer)) {
            await this.handleStuckTransfer(transfer);
            results.alerts++;
          }

        } catch (error) {
          logger.error('Failed to check transfer status:', {
            transferId: transfer.transferId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          results.failed++;
        }
      }

      // Check for failed trades that need custodial cleanup
      await this.checkFailedTrades();

      logger.info('Custodial monitoring cycle completed', results);

    } catch (error) {
      logger.error('Custodial monitoring cycle failed:', error);
    }
  }

  /**
   * Check status of a specific transfer
   */
  async checkTransferStatus(transfer: any): Promise<void> {
    try {
      const previousStatus = transfer.status;

      // Check status with custodian
      const statusResponse = await this.custodianService.checkTransferStatus(transfer.transferId);

      // Update transfer if status changed
      if (statusResponse.status !== previousStatus) {
        logger.info('Transfer status updated', {
          transferId: transfer.transferId,
          previousStatus,
          newStatus: statusResponse.status,
        });

        // Handle status progression
        switch (statusResponse.status) {
          case 'confirmed':
            if (transfer.status === 'submitted') {
              await this.custodianService.confirmTransfer(transfer.transferId);
            }
            break;

          case 'settled':
            if (transfer.status === 'confirmed') {
              await this.custodianService.settleTransfer(transfer.transferId);
            }
            break;

          case 'failed':
            await this.handleFailedTransfer(transfer, statusResponse.message);
            break;
        }
      }

    } catch (error) {
      logger.error('Failed to check transfer status:', {
        transferId: transfer.transferId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Check if a transfer is stuck (taking too long)
   */
  private isTransferStuck(transfer: any): boolean {
    const now = new Date();
    const createdAt = new Date(transfer.createdAt);
    const hoursElapsed = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    return hoursElapsed > this.config.alertThreshold;
  }

  /**
   * Handle stuck transfers
   */
  private async handleStuckTransfer(transfer: any): Promise<void> {
    try {
      logger.warn('Stuck transfer detected', {
        transferId: transfer.transferId,
        status: transfer.status,
        createdAt: transfer.createdAt,
        hoursElapsed: (Date.now() - new Date(transfer.createdAt).getTime()) / (1000 * 60 * 60),
      });

      // In a real implementation, this would:
      // 1. Send alerts to administrators
      // 2. Escalate to custodian support
      // 3. Create support tickets
      // 4. Notify affected users

      // For now, just log the issue
      logger.error('ALERT: Transfer stuck - manual intervention required', {
        transferId: transfer.transferId,
        tradeId: transfer.tradeId,
        fromUserId: transfer.fromUserId,
        toUserId: transfer.toUserId,
        productId: transfer.productId,
        quantity: transfer.quantity,
      });

    } catch (error) {
      logger.error('Failed to handle stuck transfer:', error);
    }
  }

  /**
   * Handle failed transfers
   */
  private async handleFailedTransfer(transfer: any, reason?: string): Promise<void> {
    try {
      logger.error('Transfer failed', {
        transferId: transfer.transferId,
        reason: reason || 'Unknown reason',
      });

      // Update associated trade
      const trade = await Trade.findById(transfer.tradeId);
      if (trade && trade.status !== 'failed') {
        trade.fail(`Custodial transfer failed: ${reason || 'Unknown reason'}`);
        await trade.save();

        logger.info('Associated trade marked as failed', {
          tradeId: trade._id,
          transferId: transfer.transferId,
        });
      }

      // In a real implementation, this would:
      // 1. Reverse wallet transactions
      // 2. Restore order quantities
      // 3. Notify users
      // 4. Create support tickets

    } catch (error) {
      logger.error('Failed to handle failed transfer:', error);
    }
  }

  /**
   * Check for failed trades that need custodial cleanup
   */
  private async checkFailedTrades(): Promise<void> {
    try {
      // Find trades that failed but still have pending custodial transfers
      const failedTrades = await Trade.find({
        status: 'failed',
        custodialTransferId: { $exists: true },
      });

      for (const trade of failedTrades) {
        const transfer = await CustodialTransfer.findOne({
          transferId: trade.custodialTransferId,
          status: { $in: ['pending', 'submitted', 'confirmed'] },
        });

        if (transfer) {
          logger.warn('Found pending transfer for failed trade', {
            tradeId: trade._id,
            transferId: transfer.transferId,
          });

          // Cancel the transfer
          transfer.cancel();
          await transfer.save();

          logger.info('Cancelled transfer for failed trade', {
            tradeId: trade._id,
            transferId: transfer.transferId,
          });
        }
      }

    } catch (error) {
      logger.error('Failed to check failed trades:', error);
    }
  }

  /**
   * Manually trigger monitoring for a specific transfer
   */
  async monitorTransfer(transferId: string): Promise<void> {
    try {
      const transfer = await CustodialTransfer.findOne({ transferId })
        .populate('tradeId');

      if (!transfer) {
        throw new Error('Transfer not found');
      }

      await this.checkTransferStatus(transfer);

      logger.info('Manual transfer monitoring completed', {
        transferId,
        status: transfer.status,
      });

    } catch (error) {
      logger.error('Manual transfer monitoring failed:', error);
      throw error;
    }
  }

  /**
   * Get monitoring statistics
   */
  async getMonitoringStats(): Promise<{
    isRunning: boolean;
    config: MonitoringConfig;
    pendingTransfers: number;
    stuckTransfers: number;
    failedTransfers: number;
    lastCycleTime?: Date;
  }> {
    try {
      const [pendingCount, stuckCount, failedCount] = await Promise.all([
        CustodialTransfer.countDocuments({
          status: { $in: ['pending', 'submitted', 'confirmed'] },
        }),
        CustodialTransfer.countDocuments({
          status: { $in: ['pending', 'submitted', 'confirmed'] },
          createdAt: {
            $lt: new Date(Date.now() - this.config.alertThreshold * 60 * 60 * 1000),
          },
        }),
        CustodialTransfer.countDocuments({
          status: 'failed',
        }),
      ]);

      return {
        isRunning: this.isRunning,
        config: this.config,
        pendingTransfers: pendingCount,
        stuckTransfers: stuckCount,
        failedTransfers: failedCount,
      };

    } catch (error) {
      logger.error('Failed to get monitoring stats:', error);
      throw error;
    }
  }
}

// Export singleton instance with default configuration
export const custodialMonitoringService = new CustodialMonitoringService(custodianService, {
  enabled: process.env.CUSTODIAL_MONITORING_ENABLED === 'true',
  checkInterval: process.env.CUSTODIAL_MONITORING_INTERVAL || '*/5 * * * *', // Every 5 minutes
  maxRetries: parseInt(process.env.CUSTODIAL_MONITORING_MAX_RETRIES || '3'),
  retryDelay: parseInt(process.env.CUSTODIAL_MONITORING_RETRY_DELAY || '60000'), // 1 minute
  alertThreshold: parseInt(process.env.CUSTODIAL_MONITORING_ALERT_THRESHOLD || '24'), // 24 hours
});