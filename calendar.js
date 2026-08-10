(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var upcomingPanel = document.getElementById("cal-upcoming-panel");
  var pastPanel = document.getElementById("cal-past-panel");
  var tabs = document.querySelectorAll("[data-caltab]");

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // eventAt arrives as a plain "YYYY-MM-DDTHH:MM:SS" string with no
  // timezone marker (see api/auth.js) — parsed here with a regex, never
  // new Date(), so the displayed hour can't drift depending on which
  // timezone the browser happens to be in.
  function fmtEventDateTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
    if (!m) return "";
    var month = Number(m[2]), day = Number(m[3]), hour = Number(m[4]), minute = m[5];
    var ampm = hour >= 12 ? "PM" : "AM";
    var h12 = hour % 12 || 12;
    return day + " " + MONTHS[month - 1] + " " + m[1] + " · " + h12 + ":" + minute + " " + ampm;
  }

  function eventCard(ev) {
    var img = ev.imageUrl
      ? '<div class="cal-card-img"><img src="' + H.escapeHtml(ev.imageUrl) + '" alt="" data-lightbox-img="' + H.escapeHtml(ev.imageUrl) + '" /></div>'
      : "";
    var desc = ev.description ? '<p class="cal-card-desc">' + H.escapeHtml(ev.description) + "</p>" : "";
    var location = ev.location
      ? '<span class="cal-card-meta-item">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>' +
        H.escapeHtml(ev.location) + "</span>"
      : "";
    var actions =
      '<div class="cal-card-actions">' +
      (ev.registerUrl && !ev.isPast ? '<a href="' + H.escapeHtml(ev.registerUrl) + '" target="_blank" rel="noopener" class="eh-btn eh-btn-primary hub-btn-sm">Register</a>' : "") +
      (ev.documentUrl ? '<a href="' + H.escapeHtml(ev.documentUrl) + '" target="_blank" rel="noopener" class="eh-btn eh-btn-ghost-light hub-btn-sm">View document</a>' : "") +
      "</div>";
    return (
      '<div class="hub-card cal-card" id="event-' + ev.id + '">' +
      img +
      '<div class="cal-card-body">' +
      (ev.isPast ? '<span class="cal-past-tag">Past event</span>' : "") +
      "<h3>" + H.escapeHtml(ev.title) + "</h3>" +
      '<div class="cal-card-meta">' +
      '<span class="cal-card-meta-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>' + H.escapeHtml(fmtEventDateTime(ev.eventAt)) + "</span>" +
      location +
      "</div>" +
      desc +
      actions +
      "</div></div>"
    );
  }

  function render(events) {
    var upcoming = events.filter(function (e) { return !e.isPast; });
    var past = events.filter(function (e) { return e.isPast; });

    upcomingPanel.innerHTML = upcoming.length
      ? upcoming.map(eventCard).join("")
      : '<div class="hub-empty"><div class="big">&#128197;</div>No upcoming events yet. Check back soon.</div>';
    pastPanel.innerHTML = past.length
      ? past.map(eventCard).join("")
      : '<div class="hub-empty">No past events on record.</div>';

    document.querySelectorAll("[data-lightbox-img]").forEach(function (img) {
      img.onclick = function () { H.openLightbox([{ type: "image", url: img.dataset.lightboxImg }], 0); };
    });

    if (window.location.hash) {
      var target = document.querySelector(window.location.hash);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.classList.remove("is-active"); });
      tab.classList.add("is-active");
      var which = tab.dataset.caltab;
      upcomingPanel.hidden = which !== "upcoming";
      pastPanel.hidden = which !== "past";
    });
  });

  H.api("events")
    .then(function (data) { render(data.events); })
    .catch(function (err) {
      upcomingPanel.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>";
    });
})();
