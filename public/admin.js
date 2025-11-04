(() => {
  const state = {
    users: [],
    currentUser: null,
  };

  const el = {
    status: document.getElementById("statusMessage"),
    userTable: document.getElementById("userTableBody"),
    userCount: document.getElementById("userCount"),
    pdfTotal: document.getElementById("pdfTotal"),
    storageTotal: document.getElementById("storageTotal"),
    currentUserEmail: document.getElementById("currentUserEmail"),
    currentUserRole: document.getElementById("currentUserRole"),
    createForm: document.getElementById("createUserForm"),
    logout: document.getElementById("logoutButton"),
    refresh: document.getElementById("refreshUsers"),
  };

  function showStatus(kind, message) {
    if (!el.status) return;
    el.status.textContent = message;
    el.status.classList.remove("hidden");
    el.status.classList.remove(
      "border-green-400/60",
      "text-green-200",
      "bg-green-500/10",
      "border-red-400/60",
      "text-red-200",
      "bg-red-500/10"
    );
    if (kind === "success") {
      el.status.classList.add("border-green-400/60", "text-green-200", "bg-green-500/10");
    } else {
      el.status.classList.add("border-red-400/60", "text-red-200", "bg-red-500/10");
    }
  }

  function clearStatus() {
    if (!el.status) return;
    el.status.textContent = "";
    el.status.classList.add("hidden");
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value === 0) return "0 MB";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const size = value / Math.pow(1024, index);
    return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  }

  function formatDate(iso) {
    if (!iso) return "–";
    try {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "–";
      return date.toLocaleString("de-DE", {
        dateStyle: "short",
        timeStyle: "short",
      });
    } catch {
      return "–";
    }
  }

  async function fetchWithAuth(url, options = {}) {
    const resp = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (resp.status === 401 || resp.status === 403) {
      window.location.href = "/login.html";
      throw new Error("AUTH_REQUIRED");
    }
    return resp;
  }

  function renderCurrentUser() {
    if (!state.currentUser) return;
    if (el.currentUserEmail) {
      el.currentUserEmail.textContent = state.currentUser.email;
    }
    if (el.currentUserRole) {
      el.currentUserRole.textContent = state.currentUser.role === "admin" ? "Administrator" : "Benutzer";
    }
  }

  function renderUsers() {
    if (!el.userTable) return;
    const tbody = el.userTable;
    tbody.innerHTML = "";

    if (!state.users.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "px-4 py-6 text-center text-neutral-400";
      cell.textContent = "Keine Benutzer vorhanden.";
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    const frag = document.createDocumentFragment();
    state.users.forEach((user) => {
      const row = document.createElement("tr");
      row.className = "align-middle";
      row.innerHTML = `
        <td class="px-4 py-3 font-medium">${user.email}</td>
        <td class="px-4 py-3">
          <span class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
            user.role === "admin" ? "bg-indigo-500/20 text-indigo-200 border border-indigo-400/40" : "bg-neutral-800 text-neutral-200 border border-white/10"
          }">
            ${user.role === "admin" ? "Admin" : "Benutzer"}
          </span>
        </td>
        <td class="px-4 py-3">
          <span class="inline-flex items-center gap-2 text-xs font-medium ${
            user.isActive ? "text-green-300" : "text-red-300"
          }">
            <span class="h-2 w-2 rounded-full ${user.isActive ? "bg-green-400" : "bg-red-400"}"></span>
            ${user.isActive ? "Aktiv" : "Inaktiv"}
          </span>
        </td>
        <td class="px-4 py-3 text-right">${user.pdfCount ?? 0}</td>
        <td class="px-4 py-3 text-right">${formatBytes(user.storageBytes)}</td>
        <td class="px-4 py-3 text-left text-neutral-400">${formatDate(user.updatedAt)}</td>
        <td class="px-4 py-3 text-right">
          <div class="flex flex-wrap gap-2 justify-end">
            <button data-action="toggle-active" class="px-3 py-2 text-xs rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition">
              ${user.isActive ? "Deaktivieren" : "Aktivieren"}
            </button>
            <button data-action="toggle-role" class="px-3 py-2 text-xs rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-100 hover:bg-indigo-500/25 transition">
              ${user.role === "admin" ? "Zu Benutzer" : "Zu Admin"}
            </button>
            <button data-action="reset-password" class="px-3 py-2 text-xs rounded-lg border border-amber-400/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30 transition">
              Passwort
            </button>
            <button data-action="edit-usage" class="px-3 py-2 text-xs rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition">
              Statistik
            </button>
            <button data-action="delete" class="px-3 py-2 text-xs rounded-lg border border-red-400/40 bg-red-500/15 text-red-100 hover:bg-red-500/25 transition">
              Löschen
            </button>
          </div>
        </td>
      `;

      row.querySelector("[data-action='toggle-active']")?.addEventListener("click", () => toggleUserActive(user));
      row.querySelector("[data-action='toggle-role']")?.addEventListener("click", () => toggleUserRole(user));
      row.querySelector("[data-action='reset-password']")?.addEventListener("click", () => resetPassword(user));
      row.querySelector("[data-action='edit-usage']")?.addEventListener("click", () => editUsage(user));
      row.querySelector("[data-action='delete']")?.addEventListener("click", () => deleteUser(user));

      frag.appendChild(row);
    });

    tbody.appendChild(frag);
  }

  function renderSummary() {
    const totalUsers = state.users.length;
    const pdfTotal = state.users.reduce((sum, user) => sum + (Number(user.pdfCount) || 0), 0);
    const storageTotal = state.users.reduce((sum, user) => sum + (Number(user.storageBytes) || 0), 0);

    if (el.userCount) el.userCount.textContent = String(totalUsers);
    if (el.pdfTotal) el.pdfTotal.textContent = String(pdfTotal);
    if (el.storageTotal) el.storageTotal.textContent = formatBytes(storageTotal);
  }

  async function ensureSession() {
    try {
      const response = await fetch("/api/auth/session", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        window.location.href = "/login.html";
        return false;
      }
      const data = await response.json();
      if (!data || !data.ok || !data.user || data.user.role !== "admin") {
        window.location.href = "/login.html";
        return false;
      }
      state.currentUser = data.user;
      renderCurrentUser();
      return true;
    } catch (err) {
      console.error("Session check failed:", err);
      window.location.href = "/login.html";
      return false;
    }
  }

  async function loadUsers() {
    try {
      clearStatus();
      const response = await fetchWithAuth("/api/admin/users");
      const data = await response.json();
      state.users = data.users || [];
      renderUsers();
      renderSummary();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("Failed to load users:", err);
      showStatus("error", "Benutzer konnten nicht geladen werden.");
    }
  }

  async function toggleUserActive(user) {
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (error.error === "LAST_ADMIN_RESTRICTION") {
          showStatus("error", "Der letzte aktive Admin kann nicht deaktiviert werden.");
          return;
        }
        showStatus("error", "Status konnte nicht geändert werden.");
        return;
      }
      showStatus("success", "Benutzerstatus aktualisiert.");
      await loadUsers();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("toggleUserActive failed:", err);
      showStatus("error", "Status konnte nicht geändert werden.");
    }
  }

  async function toggleUserRole(user) {
    const newRole = user.role === "admin" ? "user" : "admin";
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (error.error === "LAST_ADMIN_RESTRICTION") {
          showStatus("error", "Der letzte aktive Admin kann nicht herabgestuft werden.");
          return;
        }
        showStatus("error", "Rolle konnte nicht geändert werden.");
        return;
      }
      showStatus("success", "Rolle aktualisiert.");
      await loadUsers();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("toggleUserRole failed:", err);
      showStatus("error", "Rolle konnte nicht geändert werden.");
    }
  }

  async function editUsage(user) {
    const pdfInput = prompt("Anzahl PDF-Dateien für dieses Konto:", String(user.pdfCount ?? 0));
    if (pdfInput === null) return;
    const pdfCount = Number(pdfInput);
    if (!Number.isFinite(pdfCount) || pdfCount < 0) {
      showStatus("error", "Ungültige Anzahl PDFs.");
      return;
    }

    const storageInput = prompt("Belegter Speicher in MB:", (Number(user.storageBytes || 0) / (1024 * 1024)).toFixed(2));
    if (storageInput === null) return;
    const storageMb = Number(storageInput);
    if (!Number.isFinite(storageMb) || storageMb < 0) {
      showStatus("error", "Ungültiger Speicherwert.");
      return;
    }
    const storageBytes = Math.round(storageMb * 1024 * 1024);

    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pdfCount, storageBytes }),
      });
      if (!response.ok) {
        showStatus("error", "Statistiken konnten nicht gespeichert werden.");
        return;
      }
      showStatus("success", "Statistiken aktualisiert.");
      await loadUsers();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("editUsage failed:", err);
      showStatus("error", "Statistiken konnten nicht gespeichert werden.");
    }
  }

  async function resetPassword(user) {
    const newPassword = prompt(`Neues Passwort für "${user.email}":`, "");
    if (newPassword === null) return;
    const trimmed = newPassword.trim();
    if (trimmed.length < 6) {
      showStatus("error", "Passwort muss mindestens 6 Zeichen haben.");
      return;
    }
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ password: trimmed }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (error.error === "E_PASSWORD_WEAK") {
          showStatus("error", "Passwort ist zu kurz.");
          return;
        }
        showStatus("error", "Passwort konnte nicht gesetzt werden.");
        return;
      }
      showStatus("success", "Passwort aktualisiert.");
      await loadUsers();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("resetPassword failed:", err);
      showStatus("error", "Passwort konnte nicht gesetzt werden.");
    }
  }

  async function deleteUser(user) {
    if (!confirm(`Soll das Benutzerkonto "${user.email}" wirklich gelöscht werden?`)) {
      return;
    }
    try {
      const response = await fetchWithAuth(`/api/admin/users/${user.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (error.error === "LAST_ADMIN_RESTRICTION") {
          showStatus("error", "Der letzte aktive Admin darf nicht gelöscht werden.");
          return;
        }
        showStatus("error", "Benutzer konnte nicht gelöscht werden.");
        return;
      }
      showStatus("success", "Benutzer gelöscht.");
      if (state.currentUser && state.currentUser.id === user.id) {
        await fetchWithAuth("/api/auth/logout", { method: "POST" }).catch(() => {});
        window.location.href = "/login.html";
        return;
      }
      await loadUsers();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("deleteUser failed:", err);
      showStatus("error", "Benutzer konnte nicht gelöscht werden.");
    }
  }

  async function handleCreateUser(event) {
    event.preventDefault();
    if (!el.createForm) return;
    const formData = new FormData(el.createForm);
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    const role = String(formData.get("role") || "user");
    const isActive = formData.get("isActive") !== null;

    if (!email || !password) {
      showStatus("error", "Bitte E-Mail und Passwort angeben.");
      return;
    }

    try {
      const response = await fetchWithAuth("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, password, role, isActive }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (error.error === "E_EMAIL_EXISTS") {
          showStatus("error", "Diese E-Mail wird bereits verwendet.");
          return;
        }
        if (error.error === "E_PASSWORD_WEAK") {
          showStatus("error", "Passwort ist zu kurz (mindestens 6 Zeichen).");
          return;
        }
        showStatus("error", "Benutzer konnte nicht erstellt werden.");
        return;
      }
      el.createForm.reset();
      el.createForm.querySelector("input[name='isActive']").checked = true;
      showStatus("success", "Benutzer erfolgreich angelegt.");
      await loadUsers();
    } catch (err) {
      if (err.message === "AUTH_REQUIRED") return;
      console.error("create user failed:", err);
      showStatus("error", "Benutzer konnte nicht erstellt werden.");
    }
  }

  async function handleLogout() {
    try {
      await fetchWithAuth("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore errors
    } finally {
      window.location.href = "/login.html";
    }
  }

  async function init() {
    const ok = await ensureSession();
    if (!ok) return;
    await loadUsers();
    if (el.createForm) el.createForm.addEventListener("submit", handleCreateUser);
    if (el.logout) el.logout.addEventListener("click", handleLogout);
    if (el.refresh) el.refresh.addEventListener("click", loadUsers);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
