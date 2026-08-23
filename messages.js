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
  var msgShell = document.querySelector(".msg-shell");
  var backBtn = document.getElementById("msg-back-btn");
  var imageInput = document.getElementById("msg-image-input");
  var fileInput = document.getElementById("msg-file-input");
  var voiceBtn = document.getElementById("msg-voice-btn");
  var attachmentPreviewEl = document.getElementById("msg-attachment-preview");
  var voiceRecorderEl = document.getElementById("msg-voice-recorder");
  var voiceTimerEl = document.getElementById("msg-voice-rec-timer");
  var sendBtn = document.getElementById("msg-send-btn");
  // Below this width the inbox list and the open thread can't fit side by
  // side (matches the @media (min-width: 860px) switch in messages.css),
  // so opening a thread there should replace the list view, not just
  // populate a pane the user can't currently see.
  function isDesktopMsgLayout() { return window.matchMedia("(min-width: 860px)").matches; }

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
  // "Today" / "Yesterday" / "Monday, August 4" (this week) / full date
  // with year once it's not this year — a day divider only needs enough
  // precision to tell threads apart, never a full timestamp.
  function fmtDayDivider(dateStr) {
    var d = new Date(dateStr);
    var now = new Date();
    var startOfDay = function (dt) { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); };
    var diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
    var opts = { weekday: "long", month: "long", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }
  // Presence text is built entirely from a server-computed "seconds ago"
  // integer, never from parsing a raw timestamp into a client-side Date —
  // the `engineers.last_active` column has no timezone, so a naive
  // client-side Date built from it is only correct if the reading
  // process's own system timezone happens to be UTC (true on Vercel by
  // default, not guaranteed everywhere, and provably false on at least
  // one dev machine this project has been tested from).
  // Turns any http(s):// or www. URL in a message into a real clickable
  // link. Escapes everything else normally — the URL segment itself is
  // escaped too before going into the href/label, so a message that
  // happens to contain "http://evil<script>" can't break out of the
  // anchor tag.
  var URL_REGEX = /(https?:\/\/[^\s<]+)|(www\.[^\s<]+)/gi;
  function linkifyHtml(text) {
    var parts = [];
    var lastIndex = 0;
    var match;
    URL_REGEX.lastIndex = 0;
    while ((match = URL_REGEX.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(H.escapeHtml(text.slice(lastIndex, match.index)));
      var url = match[0];
      var trail = "";
      while (url.length && ")]}'\".,;:!?".indexOf(url[url.length - 1]) !== -1) {
        trail = url[url.length - 1] + trail;
        url = url.slice(0, -1);
      }
      var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
      parts.push('<a href="' + H.escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + H.escapeHtml(url) + "</a>" + H.escapeHtml(trail));
      lastIndex = match.index + match[0].length;
    }
    parts.push(H.escapeHtml(text.slice(lastIndex)));
    return parts.join("");
  }

  function fmtPresence(isOnline, secondsAgo) {
    if (isOnline) return "Active now";
    if (secondsAgo == null) return "";
    if (secondsAgo < 3600) return "Active " + Math.max(1, Math.floor(secondsAgo / 60)) + "m ago";
    if (secondsAgo < 86400) return "Active " + Math.floor(secondsAgo / 3600) + "h ago";
    return "Active " + Math.floor(secondsAgo / 86400) + "d ago";
  }

  function fmtFileSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  function fmtDuration(seconds) {
    seconds = Math.round(seconds || 0);
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  var activeFilter = "all"; // "all" | "unread" | "starred"
  function renderConvList(filterText) {
    var filtered = conversations.filter(function (c) {
      var matchesText = !filterText || c.displayName.toLowerCase().indexOf(filterText.toLowerCase()) !== -1;
      var matchesFilter = activeFilter === "all" || (activeFilter === "unread" && c.unreadCount > 0) || (activeFilter === "starred" && c.isStarred);
      return matchesText && matchesFilter;
    });
    if (!filtered.length) {
      var emptyMsg =
        activeFilter === "unread" ? "No unread conversations." :
        activeFilter === "starred" ? "No starred conversations yet — star one to pin it here." :
        "No conversations yet. Message someone from their profile.";
      listEl.innerHTML = '<div class="hub-empty" style="padding:24px 16px;">' + emptyMsg + "</div>";
      return;
    }
    listEl.innerHTML = filtered
      .map(function (c) {
        var preview = c.lastMessage ? (c.lastMessageIsMine ? "You: " : "") + c.lastMessage : "Say hello — no messages yet.";
        var presenceDot = c.isOnline ? '<span class="msg-presence-dot" aria-hidden="true"></span>' : "";
        return (
          '<div class="msg-conv-item' + (c.otherId === activeOtherId ? " is-active" : "") + '" data-id="' + c.otherId + '">' +
          '<span class="msg-conv-avatar-wrap">' + H.avatarHtml(c, "md") + presenceDot + "</span>" +
          '<div class="info">' +
          "<h4>" + H.escapeHtml(c.displayName) + (c.unreadCount ? '<span class="msg-unread-dot"></span>' : "") + "</h4>" +
          '<p class="preview' + (c.unreadCount ? " unread" : "") + '">' + H.escapeHtml(preview) + "</p>" +
          "</div>" +
          '<div class="meta">' +
          '<button type="button" class="msg-star-btn' + (c.isStarred ? " is-starred" : "") + '" data-star="' + c.id + '" aria-label="' + (c.isStarred ? "Unstar conversation" : "Star conversation") + '">' + (c.isStarred ? "&#9733;" : "&#9734;") + "</button>" +
          '<time>' + (c.lastMessageAt ? fmtTime(c.lastMessageAt) : "") + "</time>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");
    listEl.querySelectorAll(".msg-conv-item").forEach(function (el) {
      el.addEventListener("click", function () { openThread(Number(el.dataset.id)); });
    });
    listEl.querySelectorAll("[data-star]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var conversationId = Number(btn.dataset.star);
        H.api("star-conversation", { method: "POST", body: { conversationId: conversationId } })
          .then(function (d) {
            var conv = conversations.find(function (c) { return c.id === conversationId; });
            if (conv) conv.isStarred = d.isStarred;
            renderConvList(searchInput.value.trim());
          })
          .catch(function (err) { H.toast(err.message, true); });
      });
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
    // On mobile the thread view replaces the list (see isDesktopMsgLayout
    // above); without a history entry, the phone's hardware/gesture back
    // button has nothing to consume for "close thread" and instead leaves
    // messages.html entirely, skipping the inbox. Push one entry only on
    // the list->thread transition, and only where that swap actually
    // happens, so desktop clicks (list+thread always both visible) don't
    // pile up pointless history entries.
    if (!isDesktopMsgLayout() && !msgShell.classList.contains("show-thread")) {
      history.pushState({ msgThread: true }, "");
    }
    activeOtherId = otherId;
    editingMessageId = null; // switching threads abandons any pending edit in the old one
    threadEmpty.hidden = true;
    threadActive.hidden = false;
    msgShell.classList.add("show-thread");
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

  // Which message (if any) the user currently has an open edit form on —
  // the background poll must not touch the DOM while this is set, since
  // a full re-render replaces bodyEl.innerHTML wholesale and would wipe
  // out the <textarea> mid-edit.
  var editingMessageId = null;

  function attachmentHtml(m) {
    if (m.attachmentType === "image") {
      return '<img src="' + H.escapeHtml(m.attachmentUrl) + '" alt="" class="msg-bubble-img" data-lightbox-img="' + H.escapeHtml(m.attachmentUrl) + '" />';
    }
    if (m.attachmentType === "voice") {
      return (
        '<div class="msg-voice-player">' +
        '<audio controls preload="metadata" src="' + H.escapeHtml(m.attachmentUrl) + '"></audio>' +
        (m.attachmentDuration ? '<span class="msg-voice-duration">' + H.escapeHtml(fmtDuration(m.attachmentDuration)) + "</span>" : "") +
        "</div>"
      );
    }
    return (
      '<a class="msg-file-card" href="' + H.escapeHtml(m.attachmentUrl) + '" target="_blank" rel="noopener noreferrer" download="' + H.escapeHtml(m.attachmentName || "") + '">' +
      '<span class="msg-file-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg></span>' +
      '<span class="msg-file-info"><span class="msg-file-name">' + H.escapeHtml(m.attachmentName || "File") + "</span>" +
      (m.attachmentSize ? '<span class="msg-file-size">' + H.escapeHtml(fmtFileSize(m.attachmentSize)) + "</span>" : "") + "</span>" +
      "</a>"
    );
  }

  var currentMessages = [];
  function renderMessages(messages) {
    currentMessages = messages;
    if (!messages.length) {
      bodyEl.innerHTML = '<div class="hub-empty">No messages yet — say hello.</div>';
      wireEditButtons();
      return;
    }
    var html = "";
    var lastDateKey = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var dateKey = new Date(m.createdAt).toDateString();
      var isNewDay = dateKey !== lastDateKey;
      if (isNewDay) {
        html += '<div class="msg-day-divider"><span>' + H.escapeHtml(fmtDayDivider(m.createdAt)) + "</span></div>";
        lastDateKey = dateKey;
      }
      var prev = messages[i - 1];
      var next = messages[i + 1];
      // Consecutive messages from the same sender on the same day read
      // as one "burst" — tightened spacing between them instead of a
      // repeated timestamp under every single bubble.
      var isGroupStart = isNewDay || !prev || prev.isMine !== m.isMine;
      var isLastInGroup = !next || next.isMine !== m.isMine || new Date(next.createdAt).toDateString() !== dateKey;

      // A read receipt on every bubble is noisy and redundant — only
      // the last message I sent needs one, same as most chat apps.
      var isLastMine = m.isMine && !messages.slice(i + 1).some(function (later) { return later.isMine; });
      var receipt = isLastMine ? '<span class="msg-bubble-receipt' + (m.isRead ? " is-read" : "") + '">' + (m.isRead ? "Read" : "Sent") + "</span>" : "";
      var edited = m.isEdited ? '<span class="msg-bubble-edited">(edited)</span>' : "";
      // Editing is text-only — a photo/file/voice message has no text
      // form to edit into, so the pencil only shows on plain text ones.
      var editBtn = m.isMine && !m.attachmentType ? '<button type="button" class="msg-edit-btn" data-edit-msg="' + m.id + '" aria-label="Edit message">&#9998;</button>' : "";
      var meta = isLastInGroup ? '<div class="msg-bubble-time">' + edited + "<span>" + fmtTime(m.createdAt) + "</span>" + receipt + "</div>" : "";
      var bubbleInner = (m.attachmentType ? attachmentHtml(m) : "") + (m.content ? '<div class="msg-bubble-text">' + linkifyHtml(m.content) + "</div>" : "");
      html +=
        '<div class="msg-bubble-row' + (m.isMine ? " is-mine" : "") + (isGroupStart ? " is-group-start" : " is-grouped") + '" data-msg-id="' + m.id + '">' +
        '<div class="msg-bubble-col">' +
        '<div class="msg-bubble-wrap"><div class="msg-bubble' + (m.attachmentType ? " has-" + m.attachmentType : "") + '">' + bubbleInner + "</div>" + editBtn + "</div>" +
        meta + "</div></div>";
    }
    bodyEl.innerHTML = html;
    bodyEl.querySelectorAll("[data-lightbox-img]").forEach(function (img) {
      img.onclick = function () { H.openLightbox([{ type: "image", url: img.dataset.lightboxImg }], 0); };
    });
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
    editingMessageId = id;
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
    bubbleWrap.querySelector(".msg-edit-cancel").addEventListener("click", function () {
      editingMessageId = null;
      renderMessages(currentMessages);
    });
    bubbleWrap.querySelector(".msg-edit-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var content = textarea.value.trim();
      if (!content) return;
      H.api("messages", { method: "PUT", body: { id: id, content: content } })
        .then(function (d) {
          editingMessageId = null;
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
    // Any full re-render replaces bodyEl.innerHTML wholesale, which
    // would wipe out an in-progress edit <textarea> — this has to hold
    // for every trigger (background poll, the reload after sending a
    // new message, opening the thread), not just polls: a send's own
    // reload can just as easily land while the user is mid-edit on a
    // different bubble. Still fetch (so `currentMessages` stays fresh
    // for whenever the edit ends), just don't touch the DOM meanwhile.
    // Checked again after the fetch resolves, not just before it
    // starts, since an edit can begin while a request is already in
    // flight.
    if (editingMessageId !== null) return;
    H.api("messages", { query: { with: activeOtherId } })
      .then(function (data) {
        if (editingMessageId !== null) { currentMessages = data.messages; return; }
        renderMessages(data.messages);
        if (scrollToBottom || isShowingTyping) bodyEl.scrollTop = bodyEl.scrollHeight;
        loadConversations(); // refresh unread counts/previews in the list
      })
      .catch(function (err) { H.toast(err.message, true); });
  }

  // ---------- Photo / file attachments ----------
  // Matches the backend's own caps (MAX_PHOTO_BYTES / MAX_FILE_BYTES in
  // api/auth.js) so an oversized pick is rejected immediately instead of
  // uploading megabytes over mobile data just to get a 413 back.
  var MAX_IMAGE_MB = 10;
  var MAX_FILE_MB = 25;
  var pendingAttachment = null; // { type: "image"|"file", blob, previewUrl, name }

  function clearPendingAttachment() {
    if (pendingAttachment && pendingAttachment.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
    pendingAttachment = null;
    attachmentPreviewEl.hidden = true;
    attachmentPreviewEl.innerHTML = "";
    imageInput.value = "";
    fileInput.value = "";
  }
  function renderAttachmentPreview() {
    if (!pendingAttachment) { attachmentPreviewEl.hidden = true; return; }
    attachmentPreviewEl.hidden = false;
    attachmentPreviewEl.innerHTML =
      (pendingAttachment.type === "image"
        ? '<img src="' + pendingAttachment.previewUrl + '" alt="" class="msg-attachment-preview-img" />'
        : '<span class="msg-attachment-preview-file"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>' +
          '<span>' + H.escapeHtml(pendingAttachment.name) + "</span></span>") +
      '<button type="button" class="msg-attachment-remove" aria-label="Remove attachment">&times;</button>';
    attachmentPreviewEl.querySelector(".msg-attachment-remove").addEventListener("click", clearPendingAttachment);
  }
  imageInput.addEventListener("change", function () {
    var file = imageInput.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_MB * 1024 * 1024) { H.toast("Image is too large. Keep it under " + MAX_IMAGE_MB + "MB.", true); imageInput.value = ""; return; }
    H.compressImage(file, 1600, 0.82).then(function (compressed) {
      if (pendingAttachment && pendingAttachment.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
      pendingAttachment = { type: "image", blob: compressed, previewUrl: URL.createObjectURL(compressed), name: file.name };
      renderAttachmentPreview();
      inputEl.focus();
    });
  });
  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) { H.toast("File is too large. Keep it under " + MAX_FILE_MB + "MB.", true); fileInput.value = ""; return; }
    pendingAttachment = { type: "file", blob: file, name: file.name };
    renderAttachmentPreview();
    inputEl.focus();
  });
  function uploadAttachment(att) {
    var contentType = att.blob.type || (att.type === "image" ? "image/jpeg" : "application/octet-stream");
    return H.api("upload-message-attachment", {
      method: "POST",
      query: att.name ? { filename: att.name } : {},
      headers: { "Content-Type": contentType },
      body: att.blob,
    });
  }

  // ---------- Voice messages ----------
  var mediaRecorder = null;
  var recordedChunks = [];
  var recordingStartedAt = 0;
  var recordingTimerInterval = null;
  var recordingStream = null;

  function stopRecordingUi() {
    clearInterval(recordingTimerInterval);
    if (recordingStream) recordingStream.getTracks().forEach(function (t) { t.stop(); });
    recordingStream = null;
    voiceRecorderEl.hidden = true;
    sendForm.hidden = false;
  }
  voiceBtn.addEventListener("click", function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      H.toast("Voice recording isn't supported on this browser.", true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        recordingStream = stream;
        recordedChunks = [];
        var mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
        mediaRecorder.ondataavailable = function (e) { if (e.data.size) recordedChunks.push(e.data); };
        mediaRecorder.start();
        recordingStartedAt = Date.now();
        sendForm.hidden = true;
        voiceRecorderEl.hidden = false;
        voiceTimerEl.textContent = "0:00";
        recordingTimerInterval = setInterval(function () {
          voiceTimerEl.textContent = fmtDuration((Date.now() - recordingStartedAt) / 1000);
        }, 500);
      })
      .catch(function () {
        H.toast("Couldn't access your microphone — check this site's permission in your browser settings.", true);
      });
  });
  document.getElementById("msg-voice-cancel").addEventListener("click", function () {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = null; // discard — don't send on cancel
      mediaRecorder.stop();
    }
    stopRecordingUi();
  });
  document.getElementById("msg-voice-stop").addEventListener("click", function () {
    if (!mediaRecorder || mediaRecorder.state === "inactive") return;
    var durationSec = (Date.now() - recordingStartedAt) / 1000;
    var otherIdAtRecordTime = activeOtherId;
    mediaRecorder.onstop = function () {
      var mimeType = mediaRecorder.mimeType || "audio/webm";
      var blob = new Blob(recordedChunks, { type: mimeType });
      stopRecordingUi();
      if (!otherIdAtRecordTime || blob.size < 500) return; // guards a near-instant accidental tap
      var ext = mimeType.indexOf("mp4") !== -1 ? "m4a" : "webm";
      H.api("upload-message-attachment", { method: "POST", query: { filename: "voice." + ext }, headers: { "Content-Type": mimeType }, body: blob })
        .then(function (uploaded) {
          return H.api("messages", {
            method: "POST",
            body: { recipientId: otherIdAtRecordTime, attachmentUrl: uploaded.url, attachmentType: "voice", attachmentSize: uploaded.size, attachmentDuration: durationSec },
          });
        })
        .then(function () { loadThread(true); })
        .catch(function (err) { H.toast(err.message, true); });
    };
    mediaRecorder.stop();
  });

  sendForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!activeOtherId) return;
    var content = inputEl.value.trim();
    if (!content && !pendingAttachment) return;
    var attachment = pendingAttachment;
    inputEl.value = "";
    clearPendingAttachment();
    lastTypingPingAt = 0; // next keystroke pings immediately instead of waiting out the 3s throttle
    setTypingIndicator(false);
    sendBtn.disabled = true;

    (attachment ? uploadAttachment(attachment) : Promise.resolve(null))
      .then(function (uploaded) {
        var body = { recipientId: activeOtherId, content: content };
        if (uploaded) {
          body.attachmentUrl = uploaded.url;
          body.attachmentType = uploaded.type;
          body.attachmentName = uploaded.name;
          body.attachmentSize = uploaded.size;
        }
        return H.api("messages", { method: "POST", body: body });
      })
      .then(function () { loadThread(true); })
      .catch(function (err) {
        H.toast(err.message, true);
        inputEl.value = content;
        if (attachment) { pendingAttachment = attachment; renderAttachmentPreview(); }
      })
      .finally(function () { sendBtn.disabled = false; });
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendForm.requestSubmit();
    }
  });
  inputEl.addEventListener("input", pingTyping);

  searchInput.addEventListener("input", function () { renderConvList(searchInput.value.trim()); });
  document.querySelectorAll(".msg-filter-pill").forEach(function (pill) {
    pill.addEventListener("click", function () {
      activeFilter = pill.dataset.filter;
      document.querySelectorAll(".msg-filter-pill").forEach(function (p) { p.classList.toggle("is-active", p === pill); });
      renderConvList(searchInput.value.trim());
    });
  });
  // On mobile, going "back" just switches the pane back to the list —
  // activeOtherId stays set so the thread's data (and its background
  // polling) keeps up to date, and reopening it is instant. Routed through
  // history.back() (not a direct class removal) so the in-app button and
  // the phone's real back button consume the same history entry pushed in
  // openThread() instead of drifting out of sync.
  backBtn.addEventListener("click", function () {
    if (!isDesktopMsgLayout() && history.state && history.state.msgThread) {
      history.back();
    } else {
      msgShell.classList.remove("show-thread");
    }
  });
  window.addEventListener("popstate", function (e) {
    if (!(e.state && e.state.msgThread)) {
      msgShell.classList.remove("show-thread");
    }
  });

  loadConversations(function () {
    if (preselectId) {
      openThread(preselectId);
    } else if (conversations.length && isDesktopMsgLayout()) {
      // On mobile, landing on Messages should show the conversation list
      // first (like every chat app) — auto-opening a thread there would
      // immediately hide the list the user just navigated to.
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
