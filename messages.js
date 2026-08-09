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
  var typingPollTimer = null;
  var isShowingTyping = false;

  var params = new URLSearchParams(window.location.search);
  var preselectId = params.get("with") ? Number(params.get("with")) : null;

  function fmtTime(dateStr) {
    var d = new Date(dateStr);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  // Presence text is built entirely from a server-computed "seconds ago"
  // integer, never from parsing a raw timestamp into a client-side Date —
  // the `engineers.last_active` column has no timezone, so a naive
  // client-side Date built from it is only correct if the reading
  // process's own system timezone happens to be UTC (true on Vercel by
  // default, not guaranteed everywhere, and provably false on at least
  // one dev machine this project has been tested from).
  function fmtPresence(isOnline, secondsAgo) {
    if (isOnline) return "Active now";
    if (secondsAgo == null) return "";
    if (secondsAgo < 3600) return "Active " + Math.max(1, Math.floor(secondsAgo / 60)) + "m ago";
    if (secondsAgo < 86400) return "Active " + Math.floor(secondsAgo / 3600) + "h ago";
    return "Active " + Math.floor(secondsAgo / 86400) + "d ago";
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
        // Keep the open thread's "Active now"/"Active Xh ago" line fresh —
        // conversations carries presence, the messages endpoint doesn't.
        if (activeOtherId) {
          var known = conversations.find(function (c) { return c.otherId === activeOtherId; });
          if (known) renderThreadHeader(known);
        }
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
    var isOnline = !!person.isOnline;
    var presenceEl = document.getElementById("msg-thread-presence");
    var text = fmtPresence(isOnline, person.lastActiveSecondsAgo);
    presenceEl.textContent = text;
    presenceEl.classList.toggle("is-online", !!isOnline);
    presenceEl.hidden = !text;
  }

  function openThread(otherId) {
    activeOtherId = otherId;
    threadEmpty.hidden = true;
    threadActive.hidden = false;
    setTypingIndicator(false);

    var known = conversations.find(function (c) { return c.otherId === otherId; });
    if (known) {
      renderThreadHeader(known);
    } else {
      // Starting a fresh conversation (e.g. via a profile's Message button) —
      // not in the inbox list yet, so fetch their name/photo directly.
      renderThreadHeader({ displayName: "" });
      H.api("profile", { query: { id: otherId } })
        .then(function (data) {
          renderThreadHeader(Object.assign({}, data.engineer, { isOnline: data.isOnline, lastActiveSecondsAgo: data.lastActiveSecondsAgo }));
        })
        .catch(function () {});
    }

    loadThread(true);
    renderConvList(searchInput.value.trim());
    restartTypingPoll();
  }

  // ---------- Typing indicator ----------
  var typingIndicatorEl = document.getElementById("msg-typing-indicator");
  function setTypingIndicator(show) {
    isShowingTyping = show;
    typingIndicatorEl.hidden = !show;
    if (show) bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function pollTyping() {
    if (!activeOtherId) return;
    H.api("typing", { query: { with: activeOtherId } })
      .then(function (d) { setTypingIndicator(!!d.isTyping); })
      .catch(function () {});
  }
  function restartTypingPoll() {
    if (typingPollTimer) clearInterval(typingPollTimer);
    pollTyping();
    typingPollTimer = setInterval(pollTyping, 2500);
  }
  // Ping the server that I'm typing, throttled to once every 3s of
  // continuous typing (not once per keystroke) — the server-side typing
  // window is 8s, so a 3s ping cadence keeps it fresh without spamming.
  var lastTypingPingAt = 0;
  function pingTyping() {
    if (!activeOtherId) return;
    var now = Date.now();
    if (now - lastTypingPingAt < 3000) return;
    lastTypingPingAt = now;
    H.api("typing", { method: "POST", body: { withId: activeOtherId } }).catch(function () {});
  }

  var currentMessages = [];
  function renderMessages(messages) {
    currentMessages = messages;
    bodyEl.innerHTML = messages.length
      ? messages
          .map(function (m, i) {
            // A read receipt on every bubble is noisy and redundant —
            // only the last message I sent needs one, same as most
            // chat apps.
            var isLastMine = m.isMine && !messages.slice(i + 1).some(function (later) { return later.isMine; });
            var receipt = isLastMine ? '<span class="msg-bubble-receipt' + (m.isRead ? " is-read" : "") + '">' + (m.isRead ? "Read" : "Sent") + "</span>" : "";
            var edited = m.isEdited ? '<span class="msg-bubble-edited">(edited)</span>' : "";
            var editBtn = m.isMine ? '<button type="button" class="msg-edit-btn" data-edit-msg="' + m.id + '" aria-label="Edit message">&#9998;</button>' : "";
            return (
              '<div class="msg-bubble-row' + (m.isMine ? " is-mine" : "") + '" data-msg-id="' + m.id + '">' +
              '<div class="msg-bubble-col">' +
              '<div class="msg-bubble-wrap"><div class="msg-bubble">' + H.escapeHtml(m.content) + "</div>" + editBtn + "</div>" +
              '<div class="msg-bubble-time">' + edited + "<span>" + fmtTime(m.createdAt) + "</span>" + receipt + "</div></div></div>"
            );
          })
          .join("")
      : '<div class="hub-empty">No messages yet — say hello.</div>';
    wireEditButtons();
  }

  function wireEditButtons() {
    bodyEl.querySelectorAll("[data-edit-msg]").forEach(function (btn) {
      btn.onclick = function () { startEditingMessage(Number(btn.dataset.editMsg)); };
    });
  }

  function startEditingMessage(id) {
    var msg = currentMessages.find(function (m) { return m.id === id; });
    if (!msg) return;
    var row = bodyEl.querySelector('.msg-bubble-row[data-msg-id="' + id + '"]');
    var bubbleWrap = row.querySelector(".msg-bubble-wrap");
    bubbleWrap.innerHTML =
      '<form class="msg-edit-form">' +
      '<textarea class="msg-edit-textarea" maxlength="4000">' + H.escapeHtml(msg.content) + "</textarea>" +
      '<div class="msg-edit-actions"><button type="button" class="msg-edit-cancel">Cancel</button><button type="submit" class="msg-edit-save">Save</button></div>' +
      "</form>";
    var textarea = bubbleWrap.querySelector("textarea");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    bubbleWrap.querySelector(".msg-edit-cancel").addEventListener("click", function () { renderMessages(currentMessages); });
    bubbleWrap.querySelector(".msg-edit-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var content = textarea.value.trim();
      if (!content) return;
      H.api("messages", { method: "PUT", body: { id: id, content: content } })
        .then(function (d) {
          var idx = currentMessages.findIndex(function (m) { return m.id === id; });
          if (idx !== -1) currentMessages[idx] = d.message;
          renderMessages(currentMessages);
          loadConversations();
        })
        .catch(function (err) { H.toast(err.message, true); });
    });
  }

  function loadThread(scrollToBottom) {
    if (!activeOtherId) return;
    H.api("messages", { query: { with: activeOtherId } })
      .then(function (data) {
        renderMessages(data.messages);
        if (scrollToBottom || isShowingTyping) bodyEl.scrollTop = bodyEl.scrollHeight;
        loadConversations(); // refresh unread counts/previews in the list
      })
      .catch(function (err) { H.toast(err.message, true); });
  }

  sendForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var content = inputEl.value.trim();
    if (!content || !activeOtherId) return;
    inputEl.value = "";
    lastTypingPingAt = 0; // next keystroke pings immediately instead of waiting out the 3s throttle
    setTypingIndicator(false);
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
  inputEl.addEventListener("input", pingTyping);

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
  window.addEventListener("beforeunload", function () {
    clearInterval(pollTimer);
    if (typingPollTimer) clearInterval(typingPollTimer);
  });
})();
