#!/usr/bin/env node
/**
 * Password Reset Script
 * Usage: node reset-password.js <email> <new-password>
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const EMAIL = process.argv[2];
const NEW_PASSWORD = process.argv[3];

if (!EMAIL || !NEW_PASSWORD) {
  console.log('Usage: node reset-password.js <email> <new-password>');
  console.log('Example: node reset-password.js tim@familieklement.com NewPassword123');
  process.exit(1);
}

if (NEW_PASSWORD.length < 6) {
  console.error('Password must be at least 6 characters');
  process.exit(1);
}

const PASSWORD_VERSION = 1;

function encryptPassword(plain, key) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(derived), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PASSWORD_VERSION, salt, iv, tag, enc].map((b) => (typeof b === "number" ? String(b) : b.toString("base64"))).join(":");
}

(async () => {
  try {
    // Load encryption key
    const keyPath = path.join(__dirname, 'data', 'auth-key.txt');
    const keyRaw = fs.readFileSync(keyPath, 'utf8').trim();
    const encryptionKey = Buffer.from(keyRaw, 'base64');
    
    if (encryptionKey.length !== 32) {
      throw new Error('Invalid encryption key length');
    }

    // Load database
    const initSqlJs = require('./vendor/sqljs/sql-wasm.js');
    const sql = await initSqlJs({
      locateFile: file => path.join(__dirname, 'vendor', 'sqljs', file)
    });
    
    const dbPath = path.join(__dirname, 'data', 'auth.sqlite');
    const raw = fs.readFileSync(dbPath);
    const db = new sql.Database(raw);

    // Find user
    const normalizedEmail = EMAIL.trim().toLowerCase();
    const users = db.exec(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail]);
    
    if (users.length === 0 || users[0].values.length === 0) {
      console.error(`User not found: ${normalizedEmail}`);
      db.close();
      process.exit(1);
    }

    const userId = users[0].values[0][0];
    const userEmail = users[0].values[0][1];
    
    console.log(`Found user: ${userEmail} (ID: ${userId})`);

    // Encrypt new password
    const encryptedPassword = encryptPassword(NEW_PASSWORD, encryptionKey);
    const now = new Date().toISOString();

    // Update password
    db.run(`UPDATE users SET password_encrypted = ?, updated_at = ? WHERE id = ?`, 
           [encryptedPassword, now, userId]);

    // Save database
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    
    db.close();

    console.log(`✅ Password updated successfully for ${userEmail}`);
    console.log(`   New password: ${NEW_PASSWORD}`);
    console.log('\n⚠️  Please restart the server: sudo systemctl restart piano');

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
