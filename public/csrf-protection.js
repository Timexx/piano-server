// SECURITY: CSRF Protection Helper
// Automatically adds CSRF tokens to all state-changing requests

(function() {
  // Store original fetch
  const originalFetch = window.fetch;
  
  // Token retrieval promise for synchronization
  let tokenPromise = null;

  // Override fetch to automatically include CSRF token
  window.fetch = async function(url, options = {}) {
    // Only add CSRF token for state-changing methods
    const method = (options.method || 'GET').toUpperCase();
    const needsCsrf = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
    
    if (needsCsrf && url.startsWith('/api/') && url !== '/api/auth/login') {
      // Wait for token if it's being retrieved
      if (tokenPromise) {
        await tokenPromise;
      }
      
      let csrfToken = sessionStorage.getItem('csrfToken');
      
      // If no token, try to retrieve it now (blocking)
      if (!csrfToken) {
        console.warn('[CSRF] ⚠️ No token available, retrieving now for:', method, url);
        await retrieveCsrfToken();
        csrfToken = sessionStorage.getItem('csrfToken');
      }
      
      if (csrfToken) {
        // Add CSRF token to headers
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
          options.headers.set('X-CSRF-Token', csrfToken);
        } else {
          options.headers['X-CSRF-Token'] = csrfToken;
        }
        console.debug('[CSRF] ✓ Token added to request:', method, url, csrfToken.substring(0, 8) + '...');
      } else {
        console.error('[CSRF] ❌ CRITICAL: No CSRF token available for:', method, url);
        console.error('[CSRF] SessionStorage:', Object.keys(sessionStorage).length, 'items');
      }
    }
    
    // Call original fetch
    const response = await originalFetch(url, options);
    
    // Check if server sent a fresh CSRF token in response header
    if (response.headers) {
      const freshToken = response.headers.get('X-CSRF-Token');
      if (freshToken && freshToken !== sessionStorage.getItem('csrfToken')) {
        console.log('[CSRF] 🔄 Updating token from response:', freshToken.substring(0, 8) + '...');
        sessionStorage.setItem('csrfToken', freshToken);
      }
    }
    
    return response;
  };

  // Retrieve CSRF token on page load
  async function retrieveCsrfToken() {
    if (tokenPromise) {
      return tokenPromise;
    }
    
    tokenPromise = (async () => {
      try {
        console.log('[CSRF] Retrieving token from /api/auth/session...');
        const response = await originalFetch('/api/auth/session', {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.csrfToken) {
            sessionStorage.setItem('csrfToken', data.csrfToken);
            console.log('[CSRF] ✅ Token retrieved successfully:', data.csrfToken.substring(0, 8) + '...');
            return data.csrfToken;
          } else {
            console.error('[CSRF] ❌ No csrfToken in response:', data);
          }
        } else {
          console.error('[CSRF] ❌ Session endpoint returned', response.status, response.statusText);
        }
      } catch (err) {
        console.error('[CSRF] ❌ Failed to retrieve token:', err.message);
      } finally {
        tokenPromise = null;
      }
    })();
    
    return tokenPromise;
  }

  // Auto-retrieve token on page load
  // Always retrieve fresh token on page load to ensure validity
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', retrieveCsrfToken);
  } else {
    retrieveCsrfToken();
  }
  
  // Also expose function globally for manual refresh if needed
  window.refreshCsrfToken = retrieveCsrfToken;
})();
