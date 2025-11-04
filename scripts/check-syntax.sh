#!/bin/bash
# Quick syntax check for server.js

echo "🔍 Checking server.js syntax..."
node --check server.js

if [ $? -eq 0 ]; then
    echo "✅ Syntax check passed!"
    echo ""
    echo "Next steps:"
    echo "1. Start server: npm start"
    echo "2. Check logs for initialization"
    echo "3. Login at http://localhost:3000"
else
    echo "❌ Syntax errors found!"
    exit 1
fi
