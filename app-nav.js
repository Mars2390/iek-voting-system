// Shared authenticated app-shell nav, injected into every logged-in page
// (dashboard, profile, directory, connections, jobs, feed, settings) so
// the nav can't drift across 7 hand-copies of the same markup.
// Usage: <div id="app-nav" data-active="directory"></div><script src="app-nav.js"></script>
(function () {
  "use strict";

  var mount = document.getElementById("app-nav");
  if (!mount) return;
  var active = mount.getAttribute("data-active") || "";

  var links = [
    { key: "dashboard", href: "/dashboard.html", label: "Dashboard" },
    { key: "directory", href: "/directory.html", label: "Directory" },
    { key: "connections", href: "/connections.html", label: "Connections" },
    { key: "jobs", href: "/jobs.html", label: "Jobs" },
    { key: "feed", href: "/feed.html", label: "Feed" },
  ];

  var linksHtml = links
    .map(function (l) {
      return '<a href="' + l.href + '" class="' + (l.key === active ? "is-active" : "") + '">' + l.label + "</a>";
    })
    .join("");

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
    linksHtml +
    "</nav>" +
    '<div class="db-nav-actions">' +
    '<a href="/profile.html" class="db-link">My Profile</a>' +
    '<a href="/settings.html" class="db-link">Settings</a>' +
    '<button id="db-logout" type="button" class="eh-btn eh-btn-ghost-dark db-logout-btn">Logout</button>' +
    "</div>" +
    '<button id="db-nav-burger" class="eh-burger" type="button" aria-expanded="false" aria-label="Toggle menu"><span></span><span></span><span></span></button>' +
    "</div>" +
    '<div id="db-mobile-menu" class="eh-mobile-menu">' +
    '<nav>' + links.map(function (l) { return '<a href="' + l.href + '">' + l.label + "</a>"; }).join("") +
    '<a href="/profile.html">My Profile</a><a href="/settings.html">Settings</a>' +
    "</nav>" +
    '<div class="eh-mobile-actions"><button id="db-logout-mobile" type="button" class="eh-btn eh-btn-primary eh-btn-full">Logout</button></div>' +
    "</div>" +
    "</header>";

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
})();
