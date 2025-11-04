// Base Path Helper - Automatically handles proxy subpaths
// Must be loaded FIRST before any other scripts

(function() {
  // Get base path from injected global variable or default to empty string
  const BASE_PATH = window.__BASE_PATH__ || '';
  
  // Helper function to prefix paths
  window.withBasePath = function(path) {
    if (!path) return path;
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
      return path; // External URL, don't modify
    }
    if (path.startsWith('data:') || path.startsWith('blob:')) {
      return path; // Data URL, don't modify
    }
    
    // Ensure path starts with /
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    
    // Add base path if configured
    return BASE_PATH ? BASE_PATH + normalizedPath : normalizedPath;
  };
  
  // Override fetch to automatically prefix API calls
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.startsWith('/')) {
      url = withBasePath(url);
    }
    return originalFetch(url, options);
  };
  
  // Log base path for debugging
  if (BASE_PATH) {
    console.log('[BASE_PATH] Application running under:', BASE_PATH);
  }
})();
