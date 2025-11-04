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

  function createButton({ text, onClick, variant = "neutral", href = null }) {
    const baseClasses = [
      "px-3",
      "py-2",
      "text-sm",
      "rounded-lg",
      "border",
      "transition",
      "whitespace-nowrap",
    ];
    let variantClasses = [];
    switch (variant) {
      case "primary":
        variantClasses = [
          "border-indigo-400/50",
          "bg-indigo-500/20",
          "text-indigo-100",
          "hover:bg-indigo-500/30",
        ];
        break;
      case "danger":
        variantClasses = [
          "border-red-400/60",
          "bg-red-500/20",
          "text-red-100",
          "hover:bg-red-500/30",
        ];
        break;
      default:
        variantClasses = [
          "border-white/10",
          "bg-white/5",
          "text-neutral-100",
          "hover:bg-white/10",
        ];
        break;
    }

    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = text;
      link.className = [...baseClasses, ...variantClasses].join(" ");
      return link;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.className = [...baseClasses, ...variantClasses].join(" ");
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
      render();
    }
  }

  function render() {
    if (!headerEl) return;
    const container = ensureContainer();
    if (!container) return;

    ignoreMutations = true;
    container.innerHTML = "";

    if (authState.user) {
      const userBadge = document.createElement("span");
      userBadge.className = "px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-neutral-200";
      userBadge.textContent = truncateEmail(authState.user.email);
      container.appendChild(userBadge);

      if (authState.user.role === "admin") {
        container.appendChild(
          createButton({
            text: "Adminbereich",
            href: "/admin.html",
            variant: "primary",
          })
        );
      }

      container.appendChild(
        createButton({
          text: "Abmelden",
          onClick: handleLogout,
          variant: "danger",
        })
      );
    } else {
      container.appendChild(
        createButton({
          text: "Login",
          href: "/login.html",
          variant: "primary",
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
