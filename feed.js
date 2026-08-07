(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var listEl = document.getElementById("feed-list");

  H.api("feed")
    .then(function (data) {
      if (!data.activity.length) {
        listEl.innerHTML = '<div class="hub-empty">Nothing here yet — activity shows up as members join and update their profiles.</div>';
        return;
      }
      listEl.innerHTML = data.activity
        .map(function (a) {
          return (
            '<div class="hub-feed-item">' +
            '<a href="/profile.html?id=' + a.engineerId + '">' + H.avatarHtml(a, "sm") + "</a>" +
            "<div>" +
            "<p>" + H.escapeHtml(a.description) + "</p>" +
            "<time>" + H.timeAgo(a.createdAt) + "</time>" +
            "</div></div>"
          );
        })
        .join("");
    })
    .catch(function (err) {
      listEl.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>";
    });
})();
