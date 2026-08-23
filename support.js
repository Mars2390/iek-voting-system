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

  function renderList(messages) {
    if (!messages.length) {
      listEl.innerHTML = '<div class="hub-empty">You haven\'t sent any messages yet.</div>';
      return;
    }
    listEl.innerHTML = messages
      .map(function (m) {
        return (
          '<div class="sup-item">' +
          '<div class="sup-item-head"><h3>' + H.escapeHtml(m.subject) + '</h3>' +
          '<span class="sup-status' + (m.status === "resolved" ? " is-resolved" : "") + '">' + statusLabel(m.status) + "</span></div>" +
          '<p class="sup-item-date">' + H.timeAgo(m.createdAt) + "</p>" +
          '<p class="sup-item-message">' + H.escapeHtml(m.message) + "</p>" +
          (m.adminReply
            ? '<div class="sup-reply"><p class="sup-reply-label">Reply from National Engineering Strategy Secretariat</p><p>' + H.escapeHtml(m.adminReply) + "</p></div>"
            : "") +
          "</div>"
        );
      })
      .join("");
  }

  function loadMessages() {
    H.api("support")
      .then(function (data) { renderList(data.messages); })
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
