#!/bin/bash
# Test script for proxy setup
# Tests if the server correctly handles proxy headers

echo "🔍 Testing Piano Sheets Server Proxy Configuration"
echo "=================================================="
echo ""

# Check if server is running
if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo "❌ Server not running on port 3000"
    echo "   Start with: npm start or npm run start:proxy"
    exit 1
fi

echo "✅ Server is running"
echo ""

# Test 1: Basic connection
echo "Test 1: Basic connection"
echo "------------------------"
response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/)
if [ "$response" -eq 200 ]; then
    echo "✅ Basic connection successful (HTTP $response)"
else
    echo "❌ Basic connection failed (HTTP $response)"
fi
echo ""

# Test 2: X-Forwarded-For header
echo "Test 2: X-Forwarded-For header handling"
echo "----------------------------------------"
curl -s -H "X-Forwarded-For: 1.2.3.4" http://localhost:3000/api/auth/session > /dev/null
echo "✅ X-Forwarded-For header sent (check server logs for IP)"
echo ""

# Test 3: X-Forwarded-Proto header
echo "Test 3: X-Forwarded-Proto header (HTTPS simulation)"
echo "----------------------------------------------------"
curl -s -H "X-Forwarded-Proto: https" http://localhost:3000/api/auth/session > /dev/null
echo "✅ X-Forwarded-Proto header sent"
echo ""

# Test 4: Full proxy header set
echo "Test 4: Complete proxy header set"
echo "----------------------------------"
response=$(curl -s -w "\nHTTP Status: %{http_code}\n" \
  -H "X-Forwarded-For: 192.168.1.100" \
  -H "X-Forwarded-Proto: https" \
  -H "X-Forwarded-Host: piano.example.com" \
  -H "X-Real-IP: 192.168.1.100" \
  http://localhost:3000/api/auth/session)
echo "$response" | head -5
echo ""

# Test 5: Check if trust proxy is enabled
echo "Test 5: Verify trust proxy setting"
echo "-----------------------------------"
if [ -z "$TRUST_PROXY" ]; then
    echo "⚠️  TRUST_PROXY not set (using default: loopback)"
    echo "   Set with: export TRUST_PROXY=true"
elif [ "$TRUST_PROXY" = "true" ]; then
    echo "✅ TRUST_PROXY=true (all proxies trusted)"
elif [ "$TRUST_PROXY" = "false" ]; then
    echo "⚠️  TRUST_PROXY=false (proxy support disabled)"
else
    echo "✅ TRUST_PROXY=$TRUST_PROXY"
fi
echo ""

echo "=================================================="
echo "Test complete!"
echo ""
echo "📖 For detailed proxy setup instructions, see:"
echo "   PROXY_SETUP.md"
echo ""
echo "💡 Tips:"
echo "   - Check server console for '[PROXY]' messages"
echo "   - Verify rate limiting uses correct client IPs"
echo "   - Test SSE connections: curl -N http://localhost:3000/api/playlist/events"
