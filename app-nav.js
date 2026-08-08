// Shared authenticated app-shell nav, injected into every logged-in page
// so the nav can't drift across hand-copies of the same markup.
// Usage: <div id="app-nav" data-active="home"></div><script src="app-nav.js"></script>
//
// Directory and Feed are intentionally not top-level nav items — they're
// reachable from My Network and Home respectively, keeping the primary
// nav at exactly the 5 sections: Home, My Network, Jobs, Messages, Me.
// On phones those 5 also render as a fixed bottom tab bar (the pattern
// from the LinkedIn mobile app) instead of being buried in a hamburger
// drawer — the drawer now only holds Settings/Logout.
(function () {
  "use strict";

  var mount = document.getElementById("app-nav");
  if (!mount) return;
  var active = mount.getAttribute("data-active") || "";

  var ICONS = {
    home: '<path d="M4 11l8-7 8 7M6 10v9h12v-9" />',
    network: '<circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20a5 5 0 0110 0M13 20a4.5 4.5 0 018 0" />',
    jobs: '<rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18" />',
    messages: '<path d="M4 5h16v11H8l-4 4V5z" />',
    me: '<circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0116 0" />',
  };

  var links = [
    { key: "home", href: "/dashboard.html", label: "Home" },
    { key: "network", href: "/connections.html", label: "My Network" },
    { key: "jobs", href: "/jobs.html", label: "Jobs" },
    { key: "messages", href: "/messages.html", label: "Messages", badgeId: "nav-msg-badge" },
    { key: "me", href: "/profile.html", label: "Me" },
  ];

  function linkHtml(l, mobile) {
    var badge = l.badgeId ? '<span id="' + l.badgeId + (mobile ? "-m" : "") + '" class="nav-badge" hidden></span>' : "";
    return '<a href="' + l.href + '" class="' + (l.key === active ? "is-active" : "") + '">' + l.label + badge + "</a>";
  }

  function tabHtml(l) {
    var badge = l.badgeId ? '<span id="' + l.badgeId + '-t" class="nav-badge tab-badge" hidden></span>' : "";
    return (
      '<a href="' + l.href + '" class="tabbar-link' + (l.key === active ? " is-active" : "") + '">' +
      '<span class="tabbar-icon-wrap"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[l.key] + "</svg>" + badge + "</span>" +
      '<span class="tabbar-label">' + l.label.replace("My Network", "Network") + "</span>" +
      "</a>"
    );
  }

  mount.innerHTML =
    '<header class="db-nav">' +
    '<div class="db-nav-row">' +
    '<a href="/dashboard.html" class="eh-brand">' +
    '<span class="eh-brand-mark">' +
    '<svg viewBox="0 0 32 32" width="22" height="22" role="img" aria-label="Engineer Hub logo">' +
    '<defs><linearGradient id="logo-grad" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#bb0a1e" /><stop offset="1" stop-color="#007a3d" /></linearGradient></defs>' +
    '<line x1="8" y1="24" x2="24" y2="8" stroke="url(#logo-grad)" stroke-width="2" />' +
    '<line x1="8" y1="24" x2="24" y2="24" stroke="url(#logo-grad)" stroke-width="2" />' +
    '<line x1="24" y1="8" x2="24" y2="24" stroke="url(#logo-grad)" stroke-width="2" />' +
    '<circle cx="8" cy="24" r="4" fill="#101a24" /><circle cx="24" cy="8" r="4" fill="url(#logo-grad)" />' +
    '<circle cx="24" cy="24" r="4" fill="url(#logo-grad)" /></svg></span>' +
    '<span class="eh-brand-text"><span class="name">Engineer<em>Hub</em></span></span>' +
    "</a>" +
    '<nav class="db-nav-links">' +
    links.map(function (l) { return linkHtml(l, false); }).join("") +
    "</nav>" +
    '<div class="db-nav-actions">' +
    '<a href="/settings.html" class="db-link">Settings</a>' +
    '<button id="db-logout" type="button" class="eh-btn eh-btn-ghost-dark db-logout-btn">Logout</button>' +
    "</div>" +
    '<button id="db-nav-burger" class="eh-burger" type="button" aria-expanded="false" aria-label="Toggle menu"><span></span><span></span><span></span></button>' +
    "</div>" +
    '<div id="db-mobile-menu" class="eh-mobile-menu">' +
    '<nav><a href="/settings.html">Settings</a></nav>' +
    '<div class="eh-mobile-actions"><button id="db-logout-mobile" type="button" class="eh-btn eh-btn-primary eh-btn-full">Logout</button></div>' +
    "</div>" +
    "</header>" +
    '<nav class="mobile-tabbar">' + links.map(tabHtml).join("") + "</nav>";

  var STORAGE_KEY = "eh_session_token";
  function doLogout() {
    var token = localStorage.getItem(STORAGE_KEY);
    fetch("/api/auth?action=logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    }).finally(function () {
      localStorage.removeItem(STORAGE_KEY);
      window.location.href = "/login.html";
    });
  }
  document.getElementById("db-logout").addEventListener("click", doLogout);
  document.getElementById("db-logout-mobile").addEventListener("click", doLogout);

  var burger = document.getElementById("db-nav-burger");
  var mobileMenu = document.getElementById("db-mobile-menu");
  burger.addEventListener("click", function () {
    var isOpen = mobileMenu.classList.toggle("is-open");
    burger.classList.toggle("is-open", isOpen);
    burger.setAttribute("aria-expanded", String(isOpen));
  });

  // Unread-message badge (desktop nav, mobile drawer — no longer used
  // now that Messages is a bottom tab — and the tab bar itself).
  var token = localStorage.getItem(STORAGE_KEY);
  function refreshUnreadBadge() {
    if (!token) return;
    fetch("/api/auth?action=conversations", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        [document.getElementById("nav-msg-badge"), document.getElementById("nav-msg-badge-t")].forEach(function (el) {
          if (!el) return;
          if (data.totalUnread > 0) {
            el.textContent = data.totalUnread > 9 ? "9+" : String(data.totalUnread);
            el.hidden = false;
          } else {
            el.hidden = true;
          }
        });
      })
      .catch(function () {});
  }
  refreshUnreadBadge();
  setInterval(refreshUnreadBadge, 20000);
})();
