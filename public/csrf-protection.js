// SECURITY: CSRF Protection Helper
// Automatically adds CSRF tokens to all state-changing requests

(function() {
  // Store original fetch
  const originalFetch = window.fetch;

  // Override fetch to automatically include CSRF token
  window.fetch = function(url, options = {}) {
    // Only add CSRF token for state-changing methods
    const method = (options.method || 'GET').toUpperCase();
    const needsCsrf = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
    
    if (needsCsrf && url.startsWith('/api/')) {
      const csrfToken = sessionStorage.getItem('csrfToken');
      
      if (csrfToken) {
        // Add CSRF token to headers
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
          options.headers.set('X-CSRF-Token', csrfToken);
        } else {
          options.headers['X-CSRF-Token'] = csrfToken;
        }
      } else if (url !== '/api/auth/login') {
        // Warn if no CSRF token (except for login)
        console.warn('[CSRF] No CSRF token available for:', method, url);
      }
    }
    
    // Call original fetch
    return originalFetch(url, options);
  };

  // Retrieve CSRF token on page load
  async function retrieveCsrfToken() {
    try {
      const response = await originalFetch('/api/auth/session', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.csrfToken) {
          sessionStorage.setItem('csrfToken', data.csrfToken);
          console.log('[CSRF] Token retrieved successfully');
        }
      }
    } catch (err) {
      console.warn('[CSRF] Failed to retrieve token:', err.message);
    }
  }

  // Auto-retrieve token on page load (if not already present)
  if (!sessionStorage.getItem('csrfToken')) {
    retrieveCsrfToken();
  }
})();
