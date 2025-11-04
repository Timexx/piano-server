// Test suite for Path Traversal fixes
// Run with: node test-path-traversal.js

const path = require('path');

// Mock SHEETS_DIR for testing
const SHEETS_DIR = '/var/app/sheets';

function toPosixPath(input) {
  return input.replace(/\\/g, "/");
}

function resolvePdfName(name, options = {}) {
  const { requireExists = true } = options;
  if (typeof name !== "string") {
    return null;
  }

  let candidate = name.trim();
  if (!candidate) {
    return null;
  }
  
  // SECURITY: Decode URL-encoding (verhindert double-encoding bypass)
  const original = candidate;
  try { 
    candidate = decodeURIComponent(candidate); 
  } catch (err) {
    console.warn('[SECURITY] Invalid URL encoding detected:', original);
    return null;
  }

  // SECURITY: Normalisiere Path
  const normalized = path.posix.normalize(toPosixPath(candidate));
  
  // SECURITY: Block Windows drive letters (C:, D:, etc.)
  if (/^[a-zA-Z]:/.test(normalized)) {
    console.warn('[SECURITY] Windows absolute path blocked:', name);
    return null;
  }
  
  // SECURITY: Strikte Validierung gegen Path Traversal
  if (!normalized || 
      normalized === "." || 
      normalized.startsWith("../") || 
      normalized.includes("/../") ||  // CRITICAL: Block traversal in middle of path
      normalized.includes("\\") ||    // Block Windows backslashes
      path.isAbsolute(normalized)) {
    console.warn('[SECURITY] Path traversal attempt blocked:', name);
    return null;
  }
  
  // SECURITY: Prüfe auf Null-Bytes (directory traversal bypass technique)
  if (candidate.includes('\0') || normalized.includes('\0')) {
    console.warn('[SECURITY] Null-byte injection attempt blocked:', name);
    return null;
  }
  
  // SECURITY: Nur PDF-Dateien erlauben
  if (!normalized.toLowerCase().endsWith(".pdf")) {
    return null;
  }

  // SECURITY: Validiere absoluten Pfad
  const abs = path.resolve(path.join(SHEETS_DIR, normalized));
  
  // SECURITY: CRITICAL - Stelle sicher dass Pfad innerhalb SHEETS_DIR bleibt
  const relativePath = path.relative(SHEETS_DIR, abs);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    console.warn('[SECURITY] Path escape attempt blocked:', name, '-> abs:', abs);
    return null;
  }

  // Skip file existence check for testing
  if (requireExists) {
    // Would check fs.statSync here
  }

  return { rel: normalized, abs };
}

// Test Cases
console.log('========================================');
console.log('PATH TRAVERSAL SECURITY TEST SUITE');
console.log('========================================\n');

const testCases = [
  // LEGITIMATE CASES (should pass)
  { input: 'sheet.pdf', shouldPass: true, desc: 'Simple filename' },
  { input: 'folder/sheet.pdf', shouldPass: true, desc: 'Subfolder' },
  { input: 'music/jazz/song.pdf', shouldPass: true, desc: 'Nested folders' },
  { input: 'My%20Song.pdf', shouldPass: true, desc: 'URL encoded spaces' },
  
  // ATTACK CASES (should be blocked)
  { input: '../../../etc/passwd', shouldPass: false, desc: 'Classic path traversal' },
  { input: '..%2F..%2F..%2Fetc%2Fpasswd', shouldPass: false, desc: 'URL encoded traversal' },
  { input: 'folder/..%252F..%252Fetc%252Fpasswd', shouldPass: false, desc: 'Double URL encoded' },
  { input: 'folder/../../../etc/passwd', shouldPass: false, desc: 'Traversal in middle' },
  { input: '../../data/auth.sqlite', shouldPass: false, desc: 'Access to data dir' },
  { input: 'sheet.pdf\0.txt', shouldPass: false, desc: 'Null byte injection' },
  { input: '/etc/passwd', shouldPass: false, desc: 'Absolute path' },
  { input: '\\\\server\\share\\file.pdf', shouldPass: false, desc: 'UNC path (Windows)' },
  { input: 'C:\\Windows\\System32\\file.pdf', shouldPass: false, desc: 'Windows absolute path' },
  { input: '.', shouldPass: false, desc: 'Current directory' },
  { input: '..', shouldPass: false, desc: 'Parent directory' },
  { input: 'folder\\..\\..\\..\\etc\\passwd', shouldPass: false, desc: 'Backslash traversal' },
  { input: 'legitfile.pdf/../../../etc/passwd', shouldPass: false, desc: 'Mixed legitimate and attack' },
];

let passed = 0;
let failed = 0;

testCases.forEach((test, idx) => {
  const result = resolvePdfName(test.input, { requireExists: false });
  const actualPass = result !== null;
  const testPassed = actualPass === test.shouldPass;
  
  const status = testPassed ? '✅ PASS' : '❌ FAIL';
  const expected = test.shouldPass ? 'ALLOW' : 'BLOCK';
  const actual = actualPass ? 'ALLOWED' : 'BLOCKED';
  
  console.log(`Test ${idx + 1}: ${status}`);
  console.log(`  Input: "${test.input}"`);
  console.log(`  Description: ${test.desc}`);
  console.log(`  Expected: ${expected}, Actual: ${actual}`);
  if (result) {
    console.log(`  Resolved: ${result.rel} -> ${result.abs}`);
  }
  console.log('');
  
  if (testPassed) {
    passed++;
  } else {
    failed++;
  }
});

console.log('========================================');
console.log(`RESULTS: ${passed}/${testCases.length} tests passed`);
if (failed > 0) {
  console.log(`⚠️  ${failed} tests FAILED - SECURITY ISSUE!`);
  process.exit(1);
} else {
  console.log('✅ All security tests passed!');
  process.exit(0);
}
