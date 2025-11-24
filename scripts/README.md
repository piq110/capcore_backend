# Backend Scripts

## Admin User Management

### create-admin.js

Creates an admin user in the database.

**Usage:**
```bash
node scripts/create-admin.js <email> <password>
```

**Example:**
```bash
node scripts/create-admin.js admin@lodas.com mySecurePassword123
```

**What it does:**
- Creates a new user with `role: 'admin'`
- Sets `emailVerified: true` (auto-verified)
- Sets `kycStatus: 'approved'` (auto-approved)
- Sets `status: 'active'`
- Sets `accreditedInvestor: true`
- Hashes the password securely

**Requirements:**
- MongoDB connection (uses MONGODB_URI from .env)
- Valid email format
- Password minimum 8 characters

**Notes:**
- If a user with the email already exists, it will be updated to admin role
- Admin users bypass normal verification requirements
- Make sure to use a strong password for production environments

## Running Scripts

1. Make sure you're in the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies if not already done:
   ```bash
   npm install
   ```

3. Make sure your .env file is configured with MONGODB_URI

4. Run the script:
   ```bash
   node scripts/create-admin.js your-admin@email.com yourPassword123
   ```

## Security Notes

- Admin accounts have full access to the system
- Use strong, unique passwords
- Consider enabling MFA for admin accounts after creation
- Regularly audit admin account access
- Store admin credentials securely