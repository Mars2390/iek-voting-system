(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  H.api("dashboard")
    .then(function (data) {
      document.getElementById("db-welcome").textContent = "Welcome back, " + data.engineer.displayName + "!";
      document.getElementById("db-stat-completion").textContent = data.profileCompletion + "%";
      document.getElementById("db-progress-bar").style.width = data.profileCompletion + "%";
      document.getElementById("db-stat-connections").textContent = data.connectionsCount;
      document.getElementById("db-stat-pending").textContent = data.pendingRequestsCount;

      var activityEl = document.getElementById("db-activity");
      activityEl.innerHTML = data.recentActivity.length
        ? data.recentActivity
            .map(function (a) {
              return (
                '<div class="hub-feed-item">' +
                H.avatarHtml(a, "sm") +
                "<div><p>" + H.escapeHtml(a.description) + "</p><time>" + H.timeAgo(a.createdAt) + "</time></div>" +
                "</div>"
              );
            })
            .join("")
        : '<div class="hub-empty" style="padding:16px 0;">Nothing yet — <a href="/profile.html">complete your profile</a> to get started.</div>';

      var sugEl = document.getElementById("db-suggestions");
      sugEl.innerHTML = data.suggestions.length
        ? data.suggestions
            .map(function (s) {
              var role = [s.title, s.company].filter(Boolean).join(" at ") || s.discipline || "";
              return (
                '<a href="/profile.html?id=' + s.id + '" class="db-suggestion-card">' +
                H.avatarHtml(s, "sm") +
                '<div class="info"><h4>' + H.escapeHtml(s.displayName) + "</h4><p>" + H.escapeHtml(role) + "</p></div>" +
                "</a>"
              );
            })
            .join("")
        : '<div class="hub-empty" style="padding:16px 0;">No suggestions yet.</div>';

      document.getElementById("db-loading").hidden = true;
      document.getElementById("db-content").hidden = false;
    })
    .catch(function (err) {
      document.getElementById("db-loading").textContent = err.message || "Couldn't load your dashboard.";
    });

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // eventAt is a plain "YYYY-MM-DDTHH:MM:SS" wall-clock string with no
  // timezone — parsed by regex, not new Date(), same reasoning as calendar.js.
  function fmtEventDateTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
    if (!m) return "";
    var month = Number(m[2]), day = Number(m[3]), hour = Number(m[4]), minute = m[5];
    var ampm = hour >= 12 ? "PM" : "AM";
    var h12 = hour % 12 || 12;
    return day + " " + MONTHS[month - 1] + " · " + h12 + ":" + minute + " " + ampm;
  }

  H.api("events")
    .then(function (data) {
      var next = data.events.find(function (e) { return !e.isPast; });
      if (!next) return;
      var card = document.getElementById("db-event-card");
      var teaser = document.getElementById("db-event-teaser");
      var img = next.imageUrl
        ? '<span class="cal-teaser-img"><img src="' + H.escapeHtml(next.imageUrl) + '" alt="" /></span>'
        : '<span class="cal-teaser-img hub-avatar sz-md" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg></span>';
      teaser.innerHTML = img + '<span class="cal-teaser-body"><h4>' + H.escapeHtml(next.title) + "</h4><p>" + H.escapeHtml(fmtEventDateTime(next.eventAt)) + "</p></span>";
      card.hidden = false;
    })
    .catch(function () {});
})();
