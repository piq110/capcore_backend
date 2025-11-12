#!/usr/bin/env node

/**
 * Check if existing wallets need migration to include private keys
 * 
 * Usage: node scripts/check-wallet-migration.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function checkWalletMigration() {
  try {
    console.log('\n==============================================');
    console.log('  Wallet Migration Checker');
    console.log('==============================================\n');

    // Connect to database
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/your-database';
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to database\n');

    // Check for wallets
    const Wallet = mongoose.model('Wallet', new mongoose.Schema({}, { strict: false }));
    
    const totalWallets = await Wallet.countDocuments();
    console.log(`Total wallets in database: ${totalWallets}`);

    if (totalWallets === 0) {
      console.log('\n✓ No existing wallets found. You can start fresh with the new implementation.\n');
      await mongoose.disconnect();
      return;
    }

    // Check if any wallet has private keys
    const walletsWithKeys = await Wallet.countDocuments({
      'privateKeys.ethereum.encryptedKey': { $exists: true }
    });

    const walletsWithoutKeys = totalWallets - walletsWithKeys;

    console.log(`Wallets with private keys: ${walletsWithKeys}`);
    console.log(`Wallets without private keys: ${walletsWithoutKeys}\n`);

    if (walletsWithoutKeys > 0) {
      console.log('⚠️  WARNING: You have wallets without private keys!');
      console.log('');
      console.log('These wallets were created before private key storage was implemented.');
      console.log('You have two options:');
      console.log('');
      console.log('1. RECOMMENDED: Create new wallets for these users');
      console.log('   - Users will need to deposit to new addresses');
      console.log('   - Old wallets can be deprecated after migration');
      console.log('');
      console.log('2. Manual recovery (if you have the private keys stored elsewhere)');
      console.log('   - Manually update the database with encrypted private key);
tMigration(kWalle
}

chec }xit(1);
 ss.eoce  pressage);
  ', error.mor('Error: console.errror) {
   (ercatch 
  } ====\n');
==========================================.log('olecons);
    .disconnect(oseait mongo

    aw
    }\n');tion needed!grao mid. Nys storerivate keets have pl wallg('✓ Al console.lose {
        } el');
 llets.ese wathunds from ithdraw f wannot keys, you cprivatet te: Withousole.log('No
      con;'')e.log(    consol
  );vate keys'riginal pries the o - Requirlog('      console.s');
  