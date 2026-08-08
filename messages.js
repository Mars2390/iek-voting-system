(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var POLL_MS = 5000;
  var listEl = document.getElementById("msg-conv-list");
  var searchInput = document.getElementById("msg-search");
  var threadEmpty = document.getElementById("msg-thread-empty");
  var threadActive = document.getElementById("msg-thread-active");
  var bodyEl = document.getElementById("msg-thread-body");
  var sendForm = document.getElementById("msg-send-form");
  var inputEl = document.getElementById("msg-input");

  var conversations = [];
  var activeOtherId = null;
  var pollTimer = null;

  var params = new URLSearchParams(window.location.search);
  var preselectId = params.get("with") ? Number(params.get("with")) : null;

  function fmtTime(dateStr) {
    var d = new Date(dateStr);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function renderConvList(filterText) {
    var filtered = conversations.filter(function (c) {
      return !filterText || c.displayName.toLowerCase().indexOf(filterText.toLowerCase()) !== -1;
    });
    if (!filtered.length) {
      listEl.innerHTML = '<div class="hub-empty" style="padding:24px 16px;">No conversations yet. Message someone from their profile.</div>';
      return;
    }
    listEl.innerHTML = filtered
      .map(function (c) {
        var preview = c.lastMessage ? (c.lastMessageIsMine ? "You: " : "") + c.lastMessage : "Say hello — no messages yet.";
        return (
          '<div class="msg-conv-item' + (c.otherId === activeOtherId ? " is-active" : "") + '" data-id="' + c.otherId + '">' +
          H.avatarHtml(c, "md") +
          '<div class="info">' +
          "<h4>" + H.escapeHtml(c.displayName) + (c.unreadCount ? '<span class="msg-unread-dot"></span>' : "") + "</h4>" +
          '<p class="preview' + (c.unreadCount ? " unread" : "") + '">' + H.escapeHtml(preview) + "</p>" +
          "</div>" +
          '<div class="meta"><time>' + (c.lastMessageAt ? fmtTime(c.lastMessageAt) : "") + "</time></div>" +
          "</div>"
        );
      })
      .join("");
    listEl.querySelectorAll(".msg-conv-item").forEach(function (el) {
      el.addEventListener("click", function () { openThread(Number(el.dataset.id)); });
    });
  }

  function loadConversations(callback) {
    H.api("conversations")
      .then(function (data) {
        conversations = data.conversations;
        renderConvList(searchInput.value.trim());
        if (callback) callback();
      })
      .catch(function (err) { listEl.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; });
  }

  function renderThreadHeader(person) {
    var role = [person.title, person.company].filter(Boolean).join(" at ");
    document.getElementById("msg-thread-avatar-link").href = "/profile.html?id=" + activeOtherId;
    document.getElementById("msg-thread-name-link").href = "/profile.html?id=" + activeOtherId;
    document.getElementById("msg-thread-avatar").outerHTML = H.avatarHtml(person, "sm").replace('class="hub-avatar', 'id="msg-thread-avatar" class="hub-avatar');
    document.getElementById("msg-thread-name").textContent = person.displayName || "Conversation";
    document.getElementById("msg-thread-role").textContent = role;
  }

  function openThread(otherId) {
    activeOtherId = otherId;
    threadEmpty.hidden = true;
    threadActive.hidden = false;

    var known = conversations.find(function (c) { return c.otherId === otherId; });
    if (known) {
      renderThreadHeader(known);
    } else {
      // Starting a fresh conversation (e.g. via a profile's Message button) —
      // not in the inbox list yet, so fetch their name/photo directly.
      renderThreadHeader({ displayName: "" });
      H.api("profile", { query: { id: otherId } })
        .then(function (data) { renderThreadHeader(data.engineer); })
        .catch(function () {});
    }

    loadThread(true);
    renderConvList(searchInput.value.trim());
  }

  function loadThread(scrollToBottom) {
    if (!activeOtherId) return;
    H.api("messages", { query: { with: activeOtherId } })
      .then(function (data) {
        bodyEl.innerHTML = data.messages.length
          ? data.messages
              .map(function (m) {
                return (
                  '<div class="msg-bubble-row' + (m.isMine ? " is-mine" : "") + '">' +
                  '<div class="msg-bubble-col"><div class="msg-bubble">' + H.escapeHtml(m.content) + "</div>" +
                  '<div class="msg-bubble-time">' + fmtTime(m.createdAt) + "</div></div></div>"
                );
              })
              .join("")
          : '<div class="hub-empty">No messages yet — say hello.</div>';
        if (scrollToBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
        loadConversations(); // refresh unread counts/previews in the list
      })
      .catch(function (err) { H.toast(err.message, true); });
  }

  sendForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var content = inputEl.value.trim();
    if (!content || !activeOtherId) return;
    inputEl.value = "";
    H.api("messages", { method: "POST", body: { recipientId: activeOtherId, content: content } })
      .then(function () { loadThread(true); })
      .catch(function (err) {
        H.toast(err.message, true);
        inputEl.value = content;
      });
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendForm.requestSubmit();
    }
  });

  searchInput.addEventListener("input", function () { renderConvList(searchInput.value.trim()); });

  loadConversations(function () {
    if (preselectId) {
      openThread(preselectId);
    } else if (conversations.length) {
      openThread(conversations[0].otherId);
    }
  });

  pollTimer = setInterval(function () {
    if (activeOtherId) loadThread(false);
    else loadConversations();
  }, POLL_MS);
  window.addEventListener("beforeunload", function () { clearInterval(pollTimer); });
})();
