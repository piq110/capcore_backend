#!/usr/bin/env node

/**
 * Script to create an admin user
 * Usage: node scripts/create-admin.js <email> <password>
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import the User model (adjust path as needed)
const { User } = require('../dist/models/User');

async function createAdminUser(email, password) {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lodas');
    console.log('Connected to MongoDB');

    // Check if admin user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      if (existingUser.role === 'admin') {
        console.log(`Admin user with email ${email} already exists`);
        return;
      } else {
        // Update existing user to admin
        existingUser.role = 'admin';
        await existingUser.save();
        console.log(`Updated existing user ${email} to admin role`);
        return;
      }
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create admin user
    const adminUser = new User({
      email,
      passwordHash,
      emailVerified: true, // Auto-verify admin users
      mfaEnabled: false,
      kycStatus: 'approved', // Auto-approve admin users
      accreditedInvestor: true,
      role: 'admin',
      status: 'active',
    });

    await adminUser.save();
    console.log(`Admin user created successfully:`);
    console.log(`Email: ${email}`);
    console.log(`Role: admin`);
    console.log(`Status: active`);
    console.log(`Email Verified: true`);
    console.log(`KYC Status: approved`);

  } catch (error) {
    console.error('Error creating admin user:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Get command line arguments
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.log('Usage: node scripts/create-admin.js <email> <password>');
  console.log('Example: node scripts/create-admin.js admin@lodas.com mySecurePassword123');
  process.exit(1);
}

const [email, password] = args;

// Validate email format
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  console.error('Invalid email format');
  process.exit(1);
}

// Validate password strength
if (password.length < 8) {
  console.error('Password must be at least 8 characters long');
  process.exit(1);
}

createAdminUser(email, password);