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
    { key: "network", href: "/connections.html", label: "My Network", badgeId: "nav-net-badge" },
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
    // Search and the notifications bell both sit outside
    // .db-nav-actions/.db-nav-links on purpose — both of those are
    // display:none below the 860px breakpoint (the bottom tab bar takes
    // over primary nav there), but search and notifications need to
    // stay reachable at every width, so they live directly in the row.
    '<div class="nav-search-wrap">' +
    '<button id="nav-search-btn" class="nav-bell-btn" type="button" aria-label="Search">' +
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>' +
    "</button>" +
    '<div id="nav-search-panel" class="nav-notif-panel nav-search-panel" hidden>' +
    '<div class="nav-search-input-wrap">' +
    '<input type="text" id="nav-search-input" placeholder="Search engineers, title, company…" autocomplete="off" />' +
    "</div>" +
    '<div id="nav-search-results" class="nav-notif-list"></div>' +
    "</div>" +
    "</div>" +
    '<div class="nav-bell-wrap">' +
    '<button id="nav-bell-btn" class="nav-bell-btn" type="button" aria-label="Notifications">' +
    '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>' +
    '<span id="nav-notif-badge" class="nav-badge nav-bell-badge" hidden></span>' +
    "</button>" +
    '<div id="nav-notif-panel" class="nav-notif-panel" hidden>' +
    '<div class="nav-notif-head"><h3>Notifications</h3><button id="nav-notif-markall" type="button">Mark all read</button></div>' +
    '<div id="nav-notif-list" class="nav-notif-list"></div>' +
    "</div>" +
    "</div>" +
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
  burger.addEventListener("click", function (e) {
    e.stopPropagation();
    // Search and the notification bell stay visible at every width
    // (including alongside this burger on mobile), so the same
    // stacking bug applies here too — closing them first before
    // opening the drawer.
    closeSearchAndNotifPanels(null);
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

  // Pending-connection-request badge on My Network, same pattern.
  function refreshNetworkBadge() {
    if (!token) return;
    fetch("/api/auth?action=connections", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var count = data.incoming ? data.incoming.length : 0;
        [document.getElementById("nav-net-badge"), document.getElementById("nav-net-badge-t")].forEach(function (el) {
          if (!el) return;
          if (count > 0) {
            el.textContent = count > 9 ? "9+" : String(count);
            el.hidden = false;
          } else {
            el.hidden = true;
          }
        });
      })
      .catch(function () {});
  }

  // Notifications bell — badge polls in the background; the list itself
  // is only fetched when the panel is opened, not on every poll tick.
  function notifUrl(n) {
    if (n.targetType === "event") return "/calendar.html#event-" + n.targetId;
    if (n.targetType === "post") return "/profile.html#post-" + n.targetId;
    if (n.type === "connection_request") return "/connections.html";
    if (n.targetType === "profile") return "/profile.html?id=" + n.actorId;
    if (n.targetType === "conversation") return "/messages.html?with=" + n.actorId;
    return "#";
  }

  var CALENDAR_NOTIF_ICON =
    '<span class="hub-avatar sz-sm nav-notif-icon" aria-hidden="true">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg></span>';

  function refreshNotifBadge() {
    if (!token) return;
    fetch("/api/auth?action=notifications", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var el = document.getElementById("nav-notif-badge");
        if (data.unreadCount > 0) {
          el.textContent = data.unreadCount > 9 ? "9+" : String(data.unreadCount);
          el.hidden = false;
        } else {
          el.hidden = true;
        }
      })
      .catch(function () {});
  }

  function renderNotifList() {
    var list = document.getElementById("nav-notif-list");
    list.innerHTML = '<div class="hub-empty" style="padding:18px 0;">Loading…</div>';
    fetch("/api/auth?action=notifications", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (!data.notifications.length) {
          list.innerHTML = '<div class="hub-empty" style="padding:18px 0;">No notifications yet.</div>';
          return;
        }
        var H = window.Hub;
        list.innerHTML = data.notifications
          .map(function (n) {
            return (
              '<a href="' + notifUrl(n) + '" class="nav-notif-item' + (n.isRead ? "" : " is-unread") + '" data-type="' + n.type + '" data-target-type="' + n.targetType + '" data-target-id="' + n.targetId + '">' +
              (n.type === "event" ? CALENDAR_NOTIF_ICON : H.avatarHtml({ displayName: "", profilePhoto: n.actorPhoto }, "sm")) +
              '<span class="body"><span class="text">' + H.escapeHtml(n.text) + "</span><time>" + H.timeAgo(n.createdAt) + "</time></span>" +
              (n.isRead ? "" : '<span class="dot"></span>') +
              "</a>"
            );
          })
          .join("");
        list.querySelectorAll(".nav-notif-item").forEach(function (a) {
          // Letting this be a plain <a> click races the browser's own
          // navigation against the mark-read POST — navigating away
          // aborts any fetch still in flight, so the click often
          // wouldn't actually mark the notification read. Take over the
          // click: fire the POST, then navigate once it (or its
          // failure) is known, instead of leaving the two to race.
          a.addEventListener("click", function (e) {
            e.preventDefault();
            var href = a.getAttribute("href");
            fetch("/api/auth?action=notifications", {
              method: "POST",
              headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
              body: JSON.stringify({ type: a.dataset.type, targetType: a.dataset.targetType, targetId: Number(a.dataset.targetId) }),
            })
              .catch(function () {})
              .finally(function () {
                refreshNotifBadge();
                window.location.href = href;
              });
          });
        });
      })
      .catch(function () {
        list.innerHTML = '<div class="hub-empty" style="padding:18px 0;">Couldn\'t load notifications.</div>';
      });
  }

  // ---------- Search (engineers / title / company) ----------
  var searchBtn = document.getElementById("nav-search-btn");
  var searchPanel = document.getElementById("nav-search-panel");
  var searchInput = document.getElementById("nav-search-input");
  var searchResults = document.getElementById("nav-search-results");
  var searchDebounce = null;
  var searchSeq = 0;

  function renderSearchResults(q) {
    if (!q) {
      searchResults.innerHTML = '<div class="hub-empty" style="padding:18px 0;">Start typing a name, title, or company…</div>';
      return;
    }
    var seq = ++searchSeq;
    fetch("/api/auth?action=directory&" + new URLSearchParams({ q: q, limit: 6 }), { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || seq !== searchSeq) return;
        var H = window.Hub;
        if (!data.engineers.length) {
          searchResults.innerHTML = '<div class="hub-empty" style="padding:18px 0;">No one matches "' + H.escapeHtml(q) + '".</div>';
          return;
        }
        var html = data.engineers
          .map(function (e) {
            var role = [e.title, e.company].filter(Boolean).join(" at ");
            return (
              '<a href="/profile.html?id=' + e.id + '" class="nav-notif-item">' +
              H.avatarHtml(e, "sm") +
              '<span class="body"><span class="text">' + H.escapeHtml(e.displayName) + "</span>" +
              (role ? '<span class="sub">' + H.escapeHtml(role) + "</span>" : "") +
              "</span></a>"
            );
          })
          .join("");
        html += '<a href="/directory.html?q=' + encodeURIComponent(q) + '" class="nav-search-seeall">See all results for "' + H.escapeHtml(q) + '"</a>';
        searchResults.innerHTML = html;
      })
      .catch(function () {});
  }

  // The search button and bell button each stopPropagation their own
  // click (needed so the document-level "click outside closes it"
  // listeners below don't immediately close the panel that same click
  // just opened) — but that also means clicking the bell while search is
  // open never reaches the document listener that would've closed
  // search, and vice versa, so both stayed open stacked on top of each
  // other. Closing the sibling panel explicitly before opening this one
  // fixes it without touching the outside-click behavior either relies on.
  function closeSearchAndNotifPanels(exceptPanel) {
    [searchPanel, notifPanel].forEach(function (p) {
      if (p && p !== exceptPanel) p.hidden = true;
    });
  }
  function closeMobileDrawer() {
    mobileMenu.classList.remove("is-open");
    burger.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
  }
  // Search and the bell stay visible at every width, including
  // alongside the burger on mobile, so opening either one should also
  // close the drawer if it's open — but the burger's own handler
  // manages the drawer's open/closed state itself (including closing
  // it back), so it only needs the search/notif half of this, not a
  // version that would also fight its own toggle.
  function closeOtherNavPanels(exceptPanel) {
    closeSearchAndNotifPanels(exceptPanel);
    closeMobileDrawer();
  }

  searchBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var opening = searchPanel.hidden;
    closeOtherNavPanels(searchPanel);
    searchPanel.hidden = !opening;
    if (opening) {
      renderSearchResults(searchInput.value.trim());
      setTimeout(function () { searchInput.focus(); }, 0);
    }
  });
  document.addEventListener("click", function (e) {
    if (!searchPanel.hidden && !searchPanel.contains(e.target) && e.target !== searchBtn) searchPanel.hidden = true;
  });
  searchInput.addEventListener("input", function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () { renderSearchResults(searchInput.value.trim()); }, 300);
  });
  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      var q = searchInput.value.trim();
      if (q) window.location.href = "/directory.html?q=" + encodeURIComponent(q);
    }
  });

  var bellBtn = document.getElementById("nav-bell-btn");
  var notifPanel = document.getElementById("nav-notif-panel");
  bellBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var opening = notifPanel.hidden;
    closeOtherNavPanels(notifPanel);
    notifPanel.hidden = !opening;
    if (opening) renderNotifList();
  });
  document.addEventListener("click", function (e) {
    if (!notifPanel.hidden && !notifPanel.contains(e.target) && e.target !== bellBtn) notifPanel.hidden = true;
  });
  document.getElementById("nav-notif-markall").addEventListener("click", function (e) {
    e.stopPropagation();
    fetch("/api/auth?action=notifications", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ markAll: true }),
    }).then(function () { refreshNotifBadge(); renderNotifList(); });
  });

  refreshUnreadBadge();
  refreshNetworkBadge();
  refreshNotifBadge();
  setInterval(refreshUnreadBadge, 20000);
  setInterval(refreshNetworkBadge, 20000);
  setInterval(refreshNotifBadge, 20000);
})();
