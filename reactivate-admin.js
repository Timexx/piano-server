// Reaktiviere Admin-Account
// Usage: node reactivate-admin.js <email>

const { createAuthService } = require('./lib/auth');
const path = require('path');

const email = process.argv[2];

if (!email) {
  console.error('❌ Usage: node reactivate-admin.js <email>');
  console.error('   Example: node reactivate-admin.js admin@example.com');
  process.exit(1);
}

(async () => {
  try {
    const DATA_DIR = path.join(__dirname, 'data');
    const auth = await createAuthService({ dataDir: DATA_DIR, logger: console });
    
    console.log('\n🔍 Suche User:', email);
    const user = auth.getUserByEmail(email);
    
    if (!user) {
      console.error('❌ User nicht gefunden:', email);
      console.log('\n📋 Verfügbare User:');
      const users = auth.listUsers();
      users.forEach(u => {
        console.log(`   - ${u.email} (${u.role}) ${u.isActive ? '✅ aktiv' : '❌ deaktiviert'}`);
      });
      process.exit(1);
    }
    
    console.log('✓ User gefunden:', user.email);
    console.log('  - Role:', user.role);
    console.log('  - Status:', user.isActive ? 'aktiv' : 'deaktiviert');
    
    if (user.isActive) {
      console.log('\n✅ User ist bereits aktiv!');
      process.exit(0);
    }
    
    // Reaktiviere User
    const updated = await auth.updateUser(user.id, { isActive: true });
    
    if (updated) {
      console.log('\n✅ User erfolgreich reaktiviert!');
      console.log('   Email:', updated.email);
      console.log('   Role:', updated.role);
      console.log('   Status: aktiv');
      console.log('\n🔓 Du kannst dich jetzt wieder einloggen!');
    } else {
      console.error('❌ Fehler beim Reaktivieren');
      process.exit(1);
    }
    
  } catch (err) {
    console.error('❌ Fehler:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
