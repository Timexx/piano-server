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
    let response = await originalFetch(url, options);
    
    console.log('[CSRF] 📡 Response received:', method, url, response.status);
    
    // If CSRF failed (403), refresh token and retry once
    if (response.status === 403 && needsCsrf && url.startsWith('/api/') && url !== '/api/auth/login') {
      console.log('[CSRF] 🔍 Got 403, checking if CSRF error...', {needsCsrf, startsWithApi: url.startsWith('/api/'), notLogin: url !== '/api/auth/login'});
      try {
        const clonedResponse = response.clone();
        const contentType = response.headers.get('content-type');
        
        if (contentType && contentType.includes('application/json')) {
          const errorData = await clonedResponse.json();
          console.log('[CSRF] 🔍 Error data:', errorData);
          
          if (errorData.error && (errorData.error.includes('CSRF') || errorData.error.includes('Invalid') || errorData.error.includes('token'))) {
            console.warn('[CSRF] ⚠️ CSRF token rejected by server, refreshing and retrying...', url);
            
            // Force refresh token
            sessionStorage.removeItem('csrfToken');
            tokenPromise = null; // Reset promise
            await retrieveCsrfToken();
            
            // Retry request with new token
            const newToken = sessionStorage.getItem('csrfToken');
            if (newToken) {
              // Recreate options with new token
              const retryOptions = { ...options };
              retryOptions.headers = retryOptions.headers instanceof Headers 
                ? new Headers(retryOptions.headers)
                : { ...retryOptions.headers };
              
              if (retryOptions.headers instanceof Headers) {
                retryOptions.headers.set('X-CSRF-Token', newToken);
              } else {
                retryOptions.headers['X-CSRF-Token'] = newToken;
              }
              
              console.log('[CSRF] 🔄 Retrying with new token:', method, url, newToken.substring(0, 8) + '...');
              response = await originalFetch(url, retryOptions);
              console.log('[CSRF] ✅ Retry result:', response.status, response.statusText);
            } else {
              console.error('[CSRF] ❌ Failed to get new token for retry');
            }
          }
        }
      } catch (e) {
        console.error('[CSRF] ❌ Error during retry logic:', e);
        // If we can't parse the error, just return original response
      }
    }
    
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
  console.log('[CSRF] 🚀 Initializing CSRF protection, readyState:', document.readyState);
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[CSRF] 🚀 DOMContentLoaded, retrieving token...');
      retrieveCsrfToken();
    });
  } else {
    console.log('[CSRF] 🚀 Document ready, retrieving token immediately...');
    retrieveCsrfToken();
  }
  
  // Also expose function globally for manual refresh if needed
  window.refreshCsrfToken = retrieveCsrfToken;
  
  console.log('[CSRF] ✅ Protection initialized, window.fetch overridden');
})();
