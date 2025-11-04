#!/usr/bin/env node
/**
 * Migration Script: Assign all existing data to a specific user
 * 
 * Usage:
 *   node scripts/migrate-to-user.js [email]
 * 
 * If no email is provided, you'll be prompted to select a user or create one.
 * 
 * Requirements:
 *   - Server must have been started at least once to initialize the database
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

// Paths
const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "auth.sqlite");
const CONFIG_BACKUP = path.join(DATA_DIR, "config.json.bak-1762241172917");
const PLAYLISTS_BACKUP = path.join(DATA_DIR, "playlists.json.bak-1762241172917");
const CONFIG_JSON = path.join(DATA_DIR, "config.json");
const PLAYLISTS_JSON = path.join(DATA_DIR, "playlists.json");
const SHEETS_DIR = path.join(PROJECT_ROOT, "sheets");

// We'll use the auth service to access the database
const { createAuthService } = require(path.join(PROJECT_ROOT, "lib", "auth.js"));
let authService = null;

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  try {
    console.log("=".repeat(70));
    console.log("DATA MIGRATION TO USER-SPECIFIC STORAGE");
    console.log("=".repeat(70));
    console.log();

    // Check if database exists
    if (!fs.existsSync(DB_PATH)) {
      console.error("❌ Database not found at:", DB_PATH);
      console.error("   Please start the server once to initialize the database.");
      process.exit(1);
    }

    // Initialize auth service (which opens the database)
    try {
      authService = await createAuthService({ dataDir: DATA_DIR, logger: console });
      console.log("✅ Database opened:", DB_PATH);
    } catch (err) {
      console.error("❌ Failed to open database:", err.message);
      process.exit(1);
    }
    console.log();

    // Check for backups
    const hasConfigBackup = fs.existsSync(CONFIG_BACKUP);
    const hasPlaylistsBackup = fs.existsSync(PLAYLISTS_BACKUP);

    if (!hasConfigBackup && !hasPlaylistsBackup) {
      console.log("ℹ️  No backup files found. Nothing to migrate.");
      process.exit(0);
    }

    console.log("Found backup files:");
    if (hasConfigBackup) console.log("  ✓ config.json.bak-1762241172917");
    if (hasPlaylistsBackup) console.log("  ✓ playlists.json.bak-1762241172917");
    console.log();

    // Get or select user
    const targetEmail = process.argv[2];
    let targetUser = null;

    if (targetEmail) {
      targetUser = authService.getUserByEmail(targetEmail);
      if (!targetUser) {
        console.error(`❌ User with email "${targetEmail}" not found.`);
        process.exit(1);
      }
      console.log(`✅ Target user: ${targetUser.email} (ID: ${targetUser.id}, Role: ${targetUser.role})`);
    } else {
      // List existing users
      const users = authService.listUsers();
      
      if (!users || users.length === 0) {
        console.log("No users found in database.");
        const createNew = await question("Create a new admin user? (y/n): ");
        if (createNew.toLowerCase() !== "y") {
          console.log("Migration cancelled.");
          process.exit(0);
        }
        
        const email = await question("Enter email: ");
        const password = await question("Enter password: ");
        
        // Create user using authService
        try {
          targetUser = authService.createUser({ email, password, role: "admin" });
          console.log(`✅ Created admin user: ${email} (ID: ${targetUser.id})`);
        } catch (err) {
          console.error("❌ Failed to create user:", err.message);
          process.exit(1);
        }
      } else {
        console.log("\nExisting users:");
        users.forEach((u, idx) => {
          console.log(`  ${idx + 1}. ${u.email} (ID: ${u.id}, Role: ${u.role})`);
        });
        console.log();
        
        const choice = await question(`Select user (1-${users.length}): `);
        const index = parseInt(choice, 10) - 1;
        
        if (index < 0 || index >= users.length) {
          console.error("❌ Invalid selection.");
          process.exit(1);
        }
        
        targetUser = users[index];
        console.log(`✅ Selected user: ${targetUser.email} (ID: ${targetUser.id})`);
      }
    }

    console.log();
    console.log("=".repeat(70));
    console.log("MIGRATION PLAN:");
    console.log("=".repeat(70));
    console.log(`1. Restore config.json from backup`);
    console.log(`2. Restore playlists.json from backup`);
    console.log(`3. Import config.json → user_configs (user_id: ${targetUser.id})`);
    console.log(`4. Import playlists.json → user_playlists (user_id: ${targetUser.id})`);
    console.log(`5. Register all PDF files → documents + user_documents`);
    console.log(`6. Create new backups with timestamp`);
    console.log("=".repeat(70));
    console.log();

    const confirm = await question("Proceed with migration? (yes/no): ");
    if (confirm.toLowerCase() !== "yes") {
      console.log("Migration cancelled.");
      process.exit(0);
    }

    console.log();
    console.log("Starting migration...");
    console.log();

    // Step 1: Restore config.json
    if (hasConfigBackup) {
      console.log("📄 Restoring config.json from backup...");
      fs.copyFileSync(CONFIG_BACKUP, CONFIG_JSON);
      console.log("   ✓ Restored to:", CONFIG_JSON);
    }

    // Step 2: Restore playlists.json
    if (hasPlaylistsBackup) {
      console.log("📄 Restoring playlists.json from backup...");
      fs.copyFileSync(PLAYLISTS_BACKUP, PLAYLISTS_JSON);
      console.log("   ✓ Restored to:", PLAYLISTS_JSON);
    }

    const now = new Date().toISOString();
    
    // Step 3: Import config
    console.log("📊 Importing config data...");
    const configData = JSON.parse(fs.readFileSync(CONFIG_JSON, "utf-8"));
    
    const configJson = JSON.stringify(configData);
    authService.transactional(({ run: txRun }) => {
      txRun("INSERT OR REPLACE INTO user_configs (user_id, data, updated_at) VALUES (?, ?, ?)",
         [targetUser.id, configJson, now]);
    });
    console.log(`   ✓ Imported config for user ${targetUser.email}`);

    // Step 4: Import playlists
    console.log("📊 Importing playlist data...");
    const playlistsData = JSON.parse(fs.readFileSync(PLAYLISTS_JSON, "utf-8"));
    
    const playlistsJson = JSON.stringify(playlistsData);
    authService.transactional(({ run: txRun }) => {
      txRun("INSERT OR REPLACE INTO user_playlists (user_id, data, updated_at) VALUES (?, ?, ?)",
         [targetUser.id, playlistsJson, now]);
    });
    console.log(`   ✓ Imported playlists for user ${targetUser.email}`);

    // Step 5: Register all PDF files
    console.log("📁 Scanning for PDF files...");
    const pdfFiles = [];
    
    function scanDirectory(dir, relativePath = "") {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
          scanDirectory(fullPath, relPath);
        } else if (entry.name.toLowerCase().endsWith(".pdf")) {
          pdfFiles.push(relPath.split(path.sep).join("/"));
        }
      }
    }
    
    if (fs.existsSync(SHEETS_DIR)) {
      scanDirectory(SHEETS_DIR);
    }
    
    console.log(`   Found ${pdfFiles.length} PDF files`);
    
    // Register documents directly in database
    let registered = 0;
    let linked = 0;
    
    authService.transactional(({ run: txRun, get: txGet }) => {
      for (const pdfName of pdfFiles) {
        // Generate document ID
        const docId = crypto.randomUUID();
        
        // Insert document (ignore if exists)
        const insertResult = txRun(
          "INSERT OR IGNORE INTO documents (id, rel_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [docId, pdfName, now, now]
        );
        
        if (insertResult > 0) registered++;
        
        // Get document ID (in case it already existed)
        const doc = txGet("SELECT id FROM documents WHERE rel_path = ?", [pdfName]);
        if (doc) {
          // Link to user (ignore if already linked)
          const linkResult = txRun(
            "INSERT OR IGNORE INTO user_documents (user_id, document_id, access_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            [targetUser.id, doc.id, 'owner', now, now]
          );
          if (linkResult > 0) linked++;
        }
      }
    });
    
    console.log(`   ✓ Registered ${registered} new documents`);
    console.log(`   ✓ Linked ${linked} documents to user ${targetUser.email}`);

    // Step 6: Create new backups
    const timestamp = Date.now();
    const newConfigBackup = `${CONFIG_JSON}.migrated-${timestamp}`;
    const newPlaylistsBackup = `${PLAYLISTS_JSON}.migrated-${timestamp}`;
    
    console.log("💾 Creating post-migration backups...");
    if (fs.existsSync(CONFIG_JSON)) {
      fs.copyFileSync(CONFIG_JSON, newConfigBackup);
      console.log(`   ✓ ${path.basename(newConfigBackup)}`);
    }
    if (fs.existsSync(PLAYLISTS_JSON)) {
      fs.copyFileSync(PLAYLISTS_JSON, newPlaylistsBackup);
      console.log(`   ✓ ${path.basename(newPlaylistsBackup)}`);
    }

    console.log();
    console.log("=".repeat(70));
    console.log("✅ MIGRATION COMPLETED SUCCESSFULLY");
    console.log("=".repeat(70));
    console.log();
    console.log("Summary:");
    console.log(`  • User: ${targetUser.email} (ID: ${targetUser.id})`);
    console.log(`  • Config entries: ${Object.keys(configData.files || {}).length} files`);
    console.log(`  • Categories: ${(configData.categories || []).length}`);
    console.log(`  • Playlists: ${(playlistsData.playlists || []).length}`);
    console.log(`  • Documents: ${pdfFiles.length} PDFs`);
    console.log();
    console.log("Next steps:");
    console.log("  1. Restart the server: npm start");
    console.log(`  2. Login with: ${targetUser.email}`);
    console.log("  3. All your data should now be visible!");
    console.log();

  } catch (error) {
    console.error();
    console.error("❌ Migration failed:");
    console.error(error);
    process.exit(1);
  } finally {
    if (authService && authService.close) {
      authService.close();
    }
    rl.close();
  }
}

main();
