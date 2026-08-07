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
})();
