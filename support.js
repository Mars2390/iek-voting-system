(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var form = document.getElementById("sup-form");
  var subjectInput = document.getElementById("sup-subject");
  var messageInput = document.getElementById("sup-message");
  var errorBox = document.getElementById("sup-error");
  var submitBtn = document.getElementById("sup-submit");
  var listEl = document.getElementById("sup-list");

  function statusLabel(s) {
    return s === "resolved" ? "Replied" : "Pending";
  }

  function renderList(threads) {
    if (!threads.length) {
      listEl.innerHTML = '<div class="hub-empty">You haven\'t sent any messages yet.</div>';
      return;
    }
    listEl.innerHTML = threads
      .map(function (t) {
        var bubbles = t.messages
          .map(function (m) {
            return (
              '<div class="sup-bubble is-' + m.senderType + '">' + H.escapeHtml(m.body) +
              '<span class="sup-bubble-meta">' + (m.senderType === "admin" ? "National Engineering Strategy Secretariat" : "You") + " · " + H.timeAgo(m.createdAt) + "</span>" +
              "</div>"
            );
          })
          .join("");
        return (
          '<div class="sup-item">' +
          '<div class="sup-item-head"><h3>' + H.escapeHtml(t.subject) + '</h3>' +
          '<span class="sup-status' + (t.status === "resolved" ? " is-resolved" : "") + '">' + statusLabel(t.status) + "</span></div>" +
          '<p class="sup-item-date">' + H.timeAgo(t.lastMessageAt) + "</p>" +
          '<div class="sup-thread">' + bubbles + "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  function loadMessages() {
    H.api("support")
      .then(function (data) { renderList(data.threads); })
      .catch(function () { listEl.innerHTML = '<div class="hub-empty">Couldn\'t load your messages.</div>'; });
  }
  loadMessages();

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    var subject = subjectInput.value.trim();
    var message = messageInput.value.trim();
    if (!subject || !message) return;
    submitBtn.disabled = true;
    H.api("support", { method: "POST", body: { subject: subject, message: message } })
      .then(function () {
        form.reset();
        H.toast("Message sent.");
        loadMessages();
      })
      .catch(function (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      })
      .finally(function () { submitBtn.disabled = false; });
  });
})();
