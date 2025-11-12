import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';
import { logger } from '@/utils/logger';
import config from '@/config';

export interface CloudinaryUploadResult {
  public_id: string;
  secure_url: string;
  original_filename: string;
  format: string;
  bytes: number;
  created_at: string;
}

export interface EncryptedUploadResult extends CloudinaryUploadResult {
  encrypted: boolean;
  encryption_iv?: string;
}

class CloudinaryService {
  private readonly encryptionKey: string;
  private readonly shouldEncrypt: boolean;

  constructor() {
    // Configure Cloudinary
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    this.encryptionKey = process.env.KYC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    this.shouldEncrypt = process.env.KYC_ENCRYPT_FILES === 'true';

    logger.info('Cloudinary service initialized', {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      encryptionEnabled: this.shouldEncrypt,
    });
  }

  private encryptBuffer(buffer: Buffer): { encryptedData: Buffer; iv: string } {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(buffer),
      cipher.final()
    ]);

    return {
      encryptedData: encrypted,
      iv: iv.toString('hex')
    };
  }

  private decryptBuffer(encryptedData: Buffer, iv: string): Buffer {
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
    
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ]);

    return decrypted;
  }

  async uploadKYCDocument(
    buffer: Buffer,
    filename: string,
    userId: string,
    documentType: string
  ): Promise<EncryptedUploadResult> {
    try {
      let uploadBuffer = buffer;
      let encryptionIv: string | undefined;

      // Encrypt the file if encryption is enabled
      if (this.shouldEncrypt) {
        const encrypted = this.encryptBuffer(buffer);
        uploadBuffer = encrypted.encryptedData;
        encryptionIv = encrypted.iv;
        logger.info('File encrypted before upload', {
          userId,
          documentType,
          originalSize: buffer.length,
          encryptedSize: uploadBuffer.length,
        });
      }

      // Generate a secure filename
      const timestamp = Date.now();
      const randomSuffix = crypto.randomBytes(8).toString('hex');
      const secureFilename = `kyc/${userId}/${documentType}_${timestamp}_${randomSuffix}`;

      // Upload to Cloudinary
      const result = await new Promise<CloudinaryUploadResult>((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            public_id: secureFilename,
            folder: 'kyc-documents',
            access_mode: 'authenticated', // Restrict access
            type: 'authenticated',
            tags: [userId, documentType, 'kyc'],
            context: {
              user_id: userId,
              document_type: documentType,
              encrypted: this.shouldEncrypt.toString(),
              upload_timestamp: timestamp.toString(),
            },
          },
          (error, result) => {
            if (error) {
              logger.error('Cloudinary upload failed', {
                error: error.message,
                userId,
                documentType,
              });
              reject(error);
            } else if (result) {
              resolve({
                public_id: result.public_id,
                secure_url: result.secure_url,
                original_filename: filename,
                format: result.format,
                bytes: result.bytes,
                created_at: result.created_at,
              });
            } else {
              reject(new Error('Upload failed - no result returned'));
            }
          }
        ).end(uploadBuffer);
      });

      logger.info('KYC document uploaded to Cloudinary', {
        userId,
        documentType,
        publicId: result.public_id,
        encrypted: this.shouldEncrypt,
        size: result.bytes,
      });

      return {
        ...result,
        encrypted: this.shouldEncrypt,
        encryption_iv: encryptionIv,
      };

    } catch (error) {
      logger.error('Failed to upload KYC document to Cloudinary', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId,
        documentType,
      });
      throw error;
    }
  }

  async downloadKYCDocument(publicId: string, encryptionIv?: string): Promise<Buffer> {
    try {
      // Download from Cloudinary
      const result = await cloudinary.api.resource(publicId, {
        resource_type: 'auto',
        type: 'authenticated',
      });

      // Get the file content
      const response = await fetch(result.secure_url);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      let buffer: Buffer = Buffer.from(new Uint8Array(arrayBuffer));

      // Decrypt if the file was encrypted
      if (this.shouldEncrypt && encryptionIv) {
        buffer = this.decryptBuffer(buffer, encryptionIv);
        logger.info('File decrypted after download', {
          publicId,
          decryptedSize: buffer.length,
        });
      }

      return buffer;

    } catch (error) {
      logger.error('Failed to download KYC document from Cloudinary', {
        error: error instanceof Error ? error.message : 'Unknown error',
        publicId,
      });
      throw error;
    }
  }

  async deleteKYCDocument(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: 'auto',
        type: 'authenticated',
      });

      logger.info('KYC document deleted from Cloudinary', {
        publicId,
      });

    } catch (error) {
      logger.error('Failed to delete KYC document from Cloudinary', {
        error: error instanceof Error ? error.message : 'Unknown error',
        publicId,
      });
      throw error;
    }
  }

  async getDocumentInfo(publicId: string): Promise<any> {
    try {
      const result = await cloudinary.api.resource(publicId, {
        resource_type: 'auto',
        type: 'authenticated',
      });

      return {
        public_id: result.public_id,
        format: result.format,
        bytes: result.bytes,
        created_at: result.created_at,
        secure_url: result.secure_url,
        context: result.context,
        tags: result.tags,
      };

    } catch (error) {
      logger.error('Failed to get document info from Cloudinary', {
        error: error instanceof Error ? error.message : 'Unknown error',
        publicId,
      });
      throw error;
    }
  }

  isEncryptionEnabled(): boolean {
    return this.shouldEncrypt;
  }
}

export const cloudinaryService = new CloudinaryService();