import nodemailer from 'nodemailer';
import config from '@/config';
import { logger } from '@/utils/logger';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailVerificationData {
  email: string;
  verificationToken: string;
  userName?: string;
}

export interface NotificationEmailData {
  email: string;
  userName?: string;
  action: string;
  details?: string;
  timestamp: Date;
}

class EmailService {
  private static instance: EmailService;
  private transporter: nodemailer.Transporter;

  private constructor() {
    this.transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.user && config.email.pass ? {
        user: config.email.user,
        pass: config.email.pass,
      } : undefined,
    });
  }

  public static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }

  /**
   * Send a generic email
   */
  public async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      const mailOptions = {
        from: config.email.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || this.stripHtml(options.html),
      };

      const result = await this.transporter.sendMail(mailOptions);
      
      logger.info('Email sent successfully', {
        to: options.to,
        subject: options.subject,
        messageId: result.messageId,
      });

      return true;
    } catch (error) {
      logger.error('Failed to send email:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        to: options.to,
        subject: options.subject,
      });
      return false;
    }
  }

  /**
   * Send email verification email
   */
  public async sendEmailVerification(data: EmailVerificationData): Promise<boolean> {
    const verificationUrl = `${config.frontendUrl}/verify-email/${data.verificationToken}`;
    
    const html = this.generateEmailVerificationTemplate({
      email: data.email,
      verificationUrl,
      userName: data.userName || data.email,
    });

    return this.sendEmail({
      to: data.email,
      subject: 'Verify Your Email Address - Capital Core',
      html,
    });
  }

  /**
   * Send notification email for security events
   */
  public async sendNotificationEmail(data: NotificationEmailData): Promise<boolean> {
    const html = this.generateNotificationTemplate(data);

    return this.sendEmail({
      to: data.email,
      subject: `Security Alert: ${data.action} - Capital Core`,
      html,
    });
  }

  /**
   * Send welcome email after email verification
   */
  public async sendWelcomeEmail(email: string, userName?: string): Promise<boolean> {
    const html = this.generateWelcomeTemplate({
      email,
      userName: userName || email,
      dashboardUrl: `${config.frontendUrl}/dashboard`,
    });

    return this.sendEmail({
      to: email,
      subject: 'Welcome to Capital Core',
      html,
    });
  }

  /**
   * Generate email verification template
   */
  private generateEmailVerificationTemplate(data: {
    email: string;
    verificationUrl: string;
    userName: string;
  }): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #1976d2; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; background-color: #1976d2; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #666; }
        .warning { background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Capital Core</h1>
        <p>Email Verification Required</p>
    </div>
    
    <div class="content">
        <h2>Hello ${data.userName},</h2>
        
        <p>Thank you for registering with Capital Core. To complete your account setup and start investing in alternative assets, please verify your email address.</p>
        
        <div style="text-align: center;">
            <a href="${data.verificationUrl}" class="button">Verify Email Address</a>
        </div>
        
        <p>If the button above doesn't work, you can copy and paste the following link into your browser:</p>
        <p style="word-break: break-all; background-color: #f0f0f0; padding: 10px; border-radius: 3px;">
            ${data.verificationUrl}
        </p>
        
        <div class="warning">
            <strong>Important:</strong> This verification link will expire in 24 hours. If you don't verify your email within this time, you'll need to request a new verification email.
        </div>
        
        <p>Once your email is verified, you'll be able to:</p>
        <ul>
            <li>Complete your KYC verification</li>
            <li>Deposit funds to your multi-chain wallet</li>
            <li>Browse and invest in REITs and BDCs</li>
            <li>Track your portfolio performance</li>
        </ul>
        
        <p>If you didn't create this account, please ignore this email or contact our support team.</p>
        
        <p>Best regards,<br>The Capital Core Team</p>
    </div>
    
    <div class="footer">
        <p>This is an automated email. Please do not reply to this message.</p>
        <p>© ${new Date().getFullYear()} Capital Core. All rights reserved.</p>
    </div>
</body>
</html>`;
  }

  /**
   * Generate notification email template
   */
  private generateNotificationTemplate(data: NotificationEmailData): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Security Alert</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #f44336; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .alert { background-color: #ffebee; border: 1px solid #f44336; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔒 Security Alert</h1>
        <p>Account Activity Notification</p>
    </div>
    
    <div class="content">
        <h2>Hello ${data.userName || data.email},</h2>
        
        <div class="alert">
            <strong>Action:</strong> ${data.action}<br>
            <strong>Time:</strong> ${data.timestamp.toLocaleString()}<br>
            ${data.details ? `<strong>Details:</strong> ${data.details}<br>` : ''}
        </div>
        
        <p>We're writing to inform you about recent activity on your Capital Core account.</p>
        
        <p>If this was you, no further action is required. If you didn't perform this action, please:</p>
        <ul>
            <li>Change your password immediately</li>
            <li>Enable two-factor authentication if not already active</li>
            <li>Contact our support team</li>
        </ul>
        
        <p>For your security, we recommend:</p>
        <ul>
            <li>Using a strong, unique password</li>
            <li>Enabling two-factor authentication</li>
            <li>Regularly monitoring your account activity</li>
        </ul>
        
        <p>If you have any concerns, please contact our support team immediately.</p>
        
        <p>Best regards,<br>The Capital Core Security Team</p>
    </div>
    
    <div class="footer">
        <p>This is an automated security notification. Please do not reply to this message.</p>
        <p>© ${new Date().getFullYear()} Capital Core. All rights reserved.</p>
    </div>
</body>
</html>`;
  }

  /**
   * Generate welcome email template
   */
  private generateWelcomeTemplate(data: {
    email: string;
    userName: string;
    dashboardUrl: string;
  }): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to AIM</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #4caf50; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; background-color: #4caf50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #666; }
        .feature { background-color: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #4caf50; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎉 Welcome to AIM!</h1>
        <p>Your email has been verified successfully</p>
    </div>
    
    <div class="content">
        <h2>Hello ${data.userName},</h2>
        
        <p>Congratulations! Your email has been verified and your Capital Core account is now active.</p>
        
        <div style="text-align: center;">
            <a href="${data.dashboardUrl}" class="button">Access Your Dashboard</a>
        </div>
        
        <h3>What's Next?</h3>
        
        <div class="feature">
            <strong>1. Complete KYC Verification</strong><br>
            Complete your identity verification to unlock full trading capabilities.
        </div>
        
        <div class="feature">
            <strong>2. Set Up Your Wallet</strong><br>
            Deposit USDT or USDC across Ethereum, Tron, or BSC networks.
        </div>
        
        <div class="feature">
            <strong>3. Explore Investments</strong><br>
            Browse our marketplace of REITs and BDCs available for trading.
        </div>
        
        <div class="feature">
            <strong>4. Enable Security Features</strong><br>
            Set up two-factor authentication for enhanced account security.
        </div>
        
        <h3>Platform Features</h3>
        <ul>
            <li>24/7 trading of alternative investments</li>
            <li>Multi-chain cryptocurrency wallet integration</li>
            <li>Real-time portfolio tracking and analytics</li>
            <li>Secure custodial asset management</li>
            <li>Comprehensive compliance and reporting</li>
        </ul>
        
        <p>If you have any questions or need assistance, our support team is here to help.</p>
        
        <p>Welcome aboard!<br>The Capital Core Team</p>
    </div>
    
    <div class="footer">
        <p>This is an automated welcome message. Please do not reply to this message.</p>
        <p>© ${new Date().getFullYear()} Capital Core. All rights reserved.</p>
    </div>
</body>
</html>`;
  }

  /**
   * Strip HTML tags from text
   */
  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Test email configuration
   */
  public async testConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      logger.info('Email service connection verified successfully');
      return true;
    } catch (error) {
      logger.error('Email service connection failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const emailService = EmailService.getInstance();