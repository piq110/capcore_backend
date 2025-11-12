import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { logger } from '@/utils/logger';
import config from '@/config';

export interface MFASetupResult {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
  backupCodes: string[];
}

export interface MFAVerificationResult {
  isValid: boolean;
  window?: number;
}

class MFAService {
  private static instance: MFAService;
  private readonly serviceName = 'Capital Core';

  private constructor() {}

  public static getInstance(): MFAService {
    if (!MFAService.instance) {
      MFAService.instance = new MFAService();
    }
    return MFAService.instance;
  }

  /**
   * Generate MFA secret and QR code for user setup
   */
  public async generateMFASetup(userEmail: string): Promise<MFASetupResult> {
    try {
      // Generate secret
      const secret = speakeasy.generateSecret({
        name: userEmail,
        issuer: this.serviceName,
        length: 32,
      });

      if (!secret.base32) {
        throw new Error('Failed to generate MFA secret');
      }

      // Generate QR code URL
      const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      logger.info('MFA setup generated', {
        userEmail,
        secretLength: secret.base32.length,
        backupCodesCount: backupCodes.length,
      });

      return {
        secret: secret.base32,
        qrCodeUrl,
        manualEntryKey: secret.base32,
        backupCodes,
      };
    } catch (error) {
      logger.error('Failed to generate MFA setup:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userEmail,
      });
      throw new Error('Failed to generate MFA setup');
    }
  }

  /**
   * Verify TOTP token against secret
   */
  public verifyTOTP(token: string, secret: string): MFAVerificationResult {
    try {
      // Remove any spaces or formatting from token
      const cleanToken = token.replace(/\s/g, '');

      // Verify token with a window of ±1 (30 seconds before/after)
      const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: cleanToken,
        window: 1, // Allow 1 step before and after current time
      });

      logger.debug('TOTP verification attempt', {
        tokenLength: cleanToken.length,
        verified,
      });

      return {
        isValid: verified,
        window: verified ? 1 : undefined,
      };
    } catch (error) {
      logger.error('TOTP verification failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        tokenLength: token.length,
      });
      return {
        isValid: false,
      };
    }
  }

  /**
   * Verify backup code
   */
  public verifyBackupCode(code: string, userBackupCodes: string[]): boolean {
    try {
      const cleanCode = code.replace(/\s/g, '').toLowerCase();
      const hasValidCode = userBackupCodes.some(
        backupCode => backupCode.toLowerCase() === cleanCode
      );

      logger.debug('Backup code verification attempt', {
        codeLength: cleanCode.length,
        availableCodesCount: userBackupCodes.length,
        verified: hasValidCode,
      });

      return hasValidCode;
    } catch (error) {
      logger.error('Backup code verification failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Generate backup codes for MFA
   */
  public generateBackupCodes(count: number = 10): string[] {
    const codes: string[] = [];
    
    for (let i = 0; i < count; i++) {
      // Generate 8-character alphanumeric code
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      codes.push(code);
    }

    logger.debug('Generated backup codes', {
      count: codes.length,
    });

    return codes;
  }

  /**
   * Remove used backup code from user's list
   */
  public removeUsedBackupCode(usedCode: string, userBackupCodes: string[]): string[] {
    const cleanUsedCode = usedCode.replace(/\s/g, '').toLowerCase();
    const updatedCodes = userBackupCodes.filter(
      code => code.toLowerCase() !== cleanUsedCode
    );

    logger.info('Backup code removed', {
      originalCount: userBackupCodes.length,
      newCount: updatedCodes.length,
    });

    return updatedCodes;
  }

  /**
   * Generate current TOTP token for testing purposes
   */
  public generateCurrentTOTP(secret: string): string {
    try {
      const token = speakeasy.totp({
        secret,
        encoding: 'base32',
      });

      return token;
    } catch (error) {
      logger.error('Failed to generate current TOTP:', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error('Failed to generate TOTP token');
    }
  }

  /**
   * Validate MFA secret format
   */
  public isValidSecret(secret: string): boolean {
    try {
      // Check if secret is valid base32
      const isValidBase32 = /^[A-Z2-7]+=*$/i.test(secret);
      const hasValidLength = secret.length >= 16 && secret.length <= 128;

      return isValidBase32 && hasValidLength;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get MFA setup instructions
   */
  public getMFAInstructions(): {
    steps: string[];
    supportedApps: string[];
    troubleshooting: string[];
  } {
    return {
      steps: [
        'Download an authenticator app on your mobile device',
        'Scan the QR code with your authenticator app, or manually enter the setup key',
        'Enter the 6-digit code from your authenticator app to verify setup',
        'Save your backup codes in a secure location',
        'MFA will be required for all future logins',
      ],
      supportedApps: [
        'Google Authenticator',
        'Microsoft Authenticator',
        'Authy',
        '1Password',
        'LastPass Authenticator',
        'Any TOTP-compatible authenticator app',
      ],
      troubleshooting: [
        'Ensure your device clock is synchronized',
        'Try entering the code within 30 seconds of generation',
        'Use backup codes if your authenticator is unavailable',
        'Contact support if you lose access to your authenticator device',
      ],
    };
  }

  /**
   * Check if MFA token is within valid time window
   */
  public isTokenTimingValid(): boolean {
    // TOTP tokens are valid for 30-second windows
    // This method can be used to check if we're near a window boundary
    const now = Math.floor(Date.now() / 1000);
    const timeStep = 30;
    const currentWindow = Math.floor(now / timeStep);
    const timeInWindow = now % timeStep;
    
    // Return false if we're in the last 5 seconds of a window
    // to avoid timing issues
    return timeInWindow < 25;
  }
}

// Export singleton instance
export const mfaService = MFAService.getInstance();