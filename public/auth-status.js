(() => {
  const authState = { user: null, session: null };
  let headerEl = null;
  let observer = null;
  let ignoreMutations = false;

  function truncateEmail(email = "") {
    if (email.length <= 24) return email;
    const [local, domain] = email.split("@");
    if (!domain) return `${email.slice(0, 21)}…`;
    const shortLocal = local.length > 12 ? `${local.slice(0, 12)}…` : local;
    return `${shortLocal}@${domain}`;
  }

  function ensureContainer() {
    if (!headerEl) return null;
    let container = headerEl.querySelector("[data-auth-slot]");
    if (!container) {
      ignoreMutations = true;
      container = document.createElement("div");
      container.dataset.authSlot = "1";
      container.className = "flex items-center gap-2";
      headerEl.appendChild(container);
      ignoreMutations = false;
    }
    return container;
  }

  function createIconButton({ icon, title, onClick, variant = "neutral", href = null }) {
    const baseClasses = [
      "p-2",
      "rounded-lg",
      "border",
      "transition-all",
      "duration-200",
    ];
    let variantClasses = [];
    let iconColor = "#e5e5e5"; // neutral-200
    
    switch (variant) {
      case "admin":
        variantClasses = [
          "border-indigo-400/50",
          "bg-indigo-500/20",
          "hover:bg-indigo-500/30",
          "hover:border-indigo-400/70",
        ];
        iconColor = "#c7d2fe"; // indigo-200
        break;
      case "login":
        variantClasses = [
          "border-emerald-400/50",
          "bg-emerald-500/20",
          "hover:bg-emerald-500/30",
          "hover:border-emerald-400/70",
        ];
        iconColor = "#a7f3d0"; // emerald-200
        break;
      case "danger":
        variantClasses = [
          "border-red-400/60",
          "bg-red-500/20",
          "hover:bg-red-500/30",
          "hover:border-red-400/80",
        ];
        iconColor = "#fecaca"; // red-200
        break;
      default:
        variantClasses = [
          "border-white/10",
          "bg-white/5",
          "hover:bg-white/10",
          "hover:border-white/20",
        ];
        break;
    }

    const svgIcon = icon.replace(/fill="#[^"]*"/, `fill="${iconColor}"`);

    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.className = [...baseClasses, ...variantClasses].join(" ");
      link.title = title;
      link.setAttribute("aria-label", title);
      link.innerHTML = svgIcon;
      return link;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = [...baseClasses, ...variantClasses].join(" ");
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = svgIcon;
    button.addEventListener("click", onClick);
    return button;
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      console.warn("Logout failed:", err);
    } finally {
      authState.user = null;
      authState.session = null;
      // Redirect to login page after logout
      window.location.href = "/login.html";
    }
  }

  function render() {
    if (!headerEl) return;
    const container = ensureContainer();
    if (!container) return;

    ignoreMutations = true;
    container.innerHTML = "";

    if (authState.user) {
      if (authState.user.role === "admin") {
        const adminIcon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h480q33 0 56.5 23.5T800-800v640q0 33-23.5 56.5T720-80H600l-40-80H400l-40 80H240Zm0-80h70l40-80h260l40 80h70v-640H240v640Zm80-200h320v-22q0-52-50-75t-110-23q-60 0-110 23t-50 75v22Zm160-160q33 0 56.5-23.5T560-600q0-33-23.5-56.5T480-680q-33 0-56.5 23.5T400-600q0 33 23.5 56.5T480-520Zm0 40Z"/></svg>';
        container.appendChild(
          createIconButton({
            icon: adminIcon,
            title: "Adminbereich",
            href: "/admin.html",
            variant: "admin",
          })
        );
      }

      const logoutIcon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z"/></svg>';
      container.appendChild(
        createIconButton({
          icon: logoutIcon,
          title: "Abmelden",
          onClick: handleLogout,
          variant: "danger",
        })
      );
    } else {
      const loginIcon = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z"/></svg>';
      container.appendChild(
        createIconButton({
          icon: loginIcon,
          title: "Anmelden",
          href: "/login.html",
          variant: "login",
        })
      );
    }

    ignoreMutations = false;
  }

  async function refreshSession() {
    try {
      const res = await fetch("/api/auth/session", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        authState.user = null;
        authState.session = null;
        render();
        return;
      }
      const data = await res.json();
      if (data && data.ok && data.user) {
        authState.user = data.user;
        authState.session = data.session || null;
      } else {
        authState.user = null;
        authState.session = null;
      }
      render();
    } catch (err) {
      console.warn("Session fetch failed:", err);
    }
  }

  function ensureObserver() {
    if (!headerEl || observer) return;
    observer = new MutationObserver(() => {
      if (ignoreMutations) return;
      render();
    });
    observer.observe(headerEl, { childList: true });
  }

  document.addEventListener("DOMContentLoaded", () => {
    headerEl = document.getElementById("header-actions");
    if (!headerEl) return;
    ensureObserver();
    refreshSession();
  });
})();
