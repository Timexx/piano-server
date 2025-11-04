(() => {
  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const errorBox = document.getElementById("loginError");
  const submitBtn = form?.querySelector('button[type="submit"]');

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.style.display = "block";
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.style.display = "none";
  }

  function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = isLoading;
    submitBtn.style.opacity = isLoading ? "0.6" : "1";
    submitBtn.textContent = isLoading ? "Einen Moment..." : "Los geht's";
  }

  async function checkExistingSession() {
    try {
      const response = await fetch("/api/auth/session", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.ok || !data.user) return;
      // Redirect all users (including admins) to the main page
      window.location.href = "/";
    } catch {
      // ignore connectivity errors and stay on login page
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!form) return;
    clearError();
    setLoading(true);

    const email = emailInput?.value.trim() || "";
    const password = passwordInput?.value || "";

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          showError("Ungültige Zugangsdaten.");
        } else if (response.status === 403) {
          showError("Dieses Konto wurde deaktiviert.");
        } else {
          showError("Anmeldung derzeit nicht möglich.");
        }
        return;
      }

      const data = await response.json();
      if (!data || !data.user) {
        showError("Anmeldung derzeit nicht möglich.");
        return;
      }

      // Redirect all users (including admins) to the main page
      window.location.href = "/";
    } catch (err) {
      console.error("Login request failed:", err);
      showError("Netzwerkfehler. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
    }
  }

  if (form) {
    form.addEventListener("submit", handleSubmit);
  }

  // Delay session check slightly to avoid blocking initial render
  setTimeout(checkExistingSession, 50);
})();
