#!/usr/bin/env node
/**
 * Password Fix Script - Uses the CORRECT encryption from auth.js
 * Usage: node fix-password.js <email> <new-password>
 * 
 * Note: Password can contain any characters including quotes.
 * If using special characters in shell, wrap in single quotes:
 *   node fix-password.js email 'My"Pass!word'
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

let EMAIL = process.argv[2];
let NEW_PASSWORD = process.argv[3];

const PASSWORD_VERSION = 1;

// CORRECT encryption function from auth.js
function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function encryptPassword(password, key) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const hashHex = hashBuffer.toString("hex");
  const payload = JSON.stringify({
    v: PASSWORD_VERSION,
    alg: "scrypt",
    salt,
    hash: hashHex,
    len: 64,
  });
  return encrypt(payload, key);
}

async function promptForInput(question, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(question);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      
      let password = '';
      stdin.on('data', function handler(char) {
        char = char.toString();
        
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.removeListener('data', handler);
          stdin.pause();
          console.log('');
          rl.close();
          resolve(password);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(question + '*'.repeat(password.length));
          }
        } else {
          password += char;
          process.stdout.write('*');
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  // Interactive mode if arguments missing
  if (!EMAIL) {
    EMAIL = await promptForInput('E-Mail: ');
  }
  
  if (!NEW_PASSWORD) {
    console.log('(Passwort wird nicht angezeigt)');
    NEW_PASSWORD = await promptForInput('Neues Passwort: ', true);
  }
  
  if (!EMAIL || !EMAIL.trim()) {
    console.error('E-Mail ist erforderlich');
    process.exit(1);
  }
  
  if (!NEW_PASSWORD || NEW_PASSWORD.length < 6) {
    console.error('Passwort muss mindestens 6 Zeichen haben');
    process.exit(1);
  }

  try {
    // Load encryption key
    const keyPath = path.join(__dirname, 'data', 'auth-key.txt');
    const keyRaw = fs.readFileSync(keyPath, 'utf8').trim();
    const encryptionKey = Buffer.from(keyRaw, 'base64');
    
    if (encryptionKey.length !== 32) {
      throw new Error(`Invalid encryption key length: ${encryptionKey.length} (expected 32)`);
    }
    
    console.log('Encryption key loaded successfully');

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
    const stmt = db.prepare(`SELECT id, email FROM users WHERE email = ?`);
    stmt.bind([normalizedEmail]);
    
    let userId = null;
    let userEmail = null;
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      userId = row.id;
      userEmail = row.email;
    }
    stmt.free();
    
    if (!userId) {
      console.error(`User not found: ${normalizedEmail}`);
      db.close();
      process.exit(1);
    }
    
    console.log(`Found user: ${userEmail} (ID: ${userId})`);

    // Encrypt new password with CORRECT method
    const encryptedPassword = encryptPassword(NEW_PASSWORD, encryptionKey);
    const now = new Date().toISOString();

    console.log('Password encrypted successfully');
    console.log('Encrypted length:', encryptedPassword.length);

    // Update password
    db.run(`UPDATE users SET password_encrypted = ?, updated_at = ? WHERE id = ?`, 
           [encryptedPassword, now, userId]);

    // Verify the update
    const verifyStmt = db.prepare(`SELECT password_encrypted FROM users WHERE id = ?`);
    verifyStmt.bind([userId]);
    if (verifyStmt.step()) {
      const row = verifyStmt.getAsObject();
      console.log('Stored encrypted password length:', row.password_encrypted.length);
    }
    verifyStmt.free();

    // Save database
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    
    db.close();

    console.log('');
    console.log(`✅ Password updated successfully for ${userEmail}`);
    console.log(`   New password: ${NEW_PASSWORD}`);
    console.log('');
    console.log('⚠️  Please restart the server: sudo systemctl restart piano');

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
