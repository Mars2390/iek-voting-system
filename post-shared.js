// Shared post-card rendering + reaction/menu/comment wiring, used by both
// the Home feed (feed-shared.js, which adds its own composer on top) and
// a profile's "Posts" section (profile-posts.js). Kept as one module so a
// fix to reaction/race-condition handling only has to happen once.
window.HubPosts = (function () {
  "use strict";
  var H = window.Hub;

  var REACTIONS = [
    { type: "like", emoji: "👍", label: "Like" },
    { type: "love", emoji: "❤️", label: "Love" },
    { type: "celebrate", emoji: "👏", label: "Celebrate" },
    { type: "laugh", emoji: "😂", label: "Laugh" },
    { type: "wow", emoji: "😮", label: "Wow" },
    { type: "sad", emoji: "😢", label: "Sad" },
    { type: "angry", emoji: "😡", label: "Angry" },
  ];
  var REACTION_MAP = {};
  REACTIONS.forEach(function (r) { REACTION_MAP[r.type] = r; });

  function reactionSummaryHtml(p) {
    if (!p.reactionCount) return "<span></span>";
    var types = Object.keys(p.reactionSummary || {}).sort(function (a, b) { return p.reactionSummary[b] - p.reactionSummary[a]; }).slice(0, 3);
    var emojis = types.map(function (t) { return '<span class="emoji">' + (REACTION_MAP[t] ? REACTION_MAP[t].emoji : "") + "</span>"; }).join("");
    return '<button type="button" class="feed-reaction-summary" data-reactors="' + p.id + '">' + emojis + " " + p.reactionCount + "</button>";
  }

  function reactionBtnHtml(p) {
    var mine = REACTION_MAP[p.myReaction];
    return (
      '<div class="feed-reaction-wrap" data-post="' + p.id + '">' +
      '<button type="button" class="feed-action-btn feed-reaction-btn' + (mine ? " is-reacted" : "") + '" data-react-quick="' + p.id + '">' +
      (mine ? mine.emoji + " " + mine.label : "👍 Like") +
      "</button>" +
      '<button type="button" class="feed-reaction-caret" data-react-caret="' + p.id + '" aria-label="Choose reaction">&#9650;</button>' +
      '<div class="feed-reaction-picker" data-picker="' + p.id + '">' +
      REACTIONS.map(function (r) { return '<button type="button" class="feed-reaction-opt" data-react-type="' + r.type + '" data-post="' + p.id + '" title="' + r.label + '">' + r.emoji + "</button>"; }).join("") +
      "</div>" +
      "</div>"
    );
  }

  function mediaHtml(imageUrl, videoUrl, imageUrls) {
    var vid = videoUrl ? '<div class="feed-post-video"><video src="' + H.escapeHtml(videoUrl) + '" controls playsinline preload="metadata"></video></div>' : "";
    if (imageUrls && imageUrls.length > 1) {
      var slides = imageUrls
        .map(function (url) { return '<div class="feed-post-carousel-slide"><img src="' + H.escapeHtml(url) + '" alt="" /></div>'; })
        .join("");
      var dots = imageUrls.map(function (_, i) { return '<span class="' + (i === 0 ? "is-active" : "") + '"></span>'; }).join("");
      return (
        '<div class="feed-post-carousel" data-carousel>' +
        '<div class="feed-post-carousel-track">' + slides + "</div>" +
        '<div class="feed-post-carousel-dots">' + dots + "</div>" +
        "</div>" + vid
      );
    }
    var singleUrl = imageUrls && imageUrls.length === 1 ? imageUrls[0] : imageUrl;
    var img = singleUrl ? '<div class="feed-post-image"><img src="' + H.escapeHtml(singleUrl) + '" alt="" data-lightbox-img="' + H.escapeHtml(singleUrl) + '" /></div>' : "";
    return img + vid;
  }

  function timeAgoOrDate(d) { return H.timeAgo(d); }

  function postCard(p) {
    var role = [p.authorTitle, p.authorCompany].filter(Boolean).join(" at ");
    var menuItems = [];
    if (p.isMine) menuItems.push('<button type="button" data-pin="' + p.id + '">' + (p.isPinned ? "Unpin post" : "Pin to profile") + "</button>");
    menuItems.push('<button type="button" data-save="' + p.id + '">' + (p.isSaved ? "Unsave" : "Save post") + "</button>");
    menuItems.push('<button type="button" data-share="' + p.id + '" data-share-author="' + p.authorId + '">Copy link</button>');
    if (p.isMine) menuItems.push('<button type="button" data-delete="' + p.id + '" class="danger">Delete post</button>');
    else menuItems.push('<button type="button" data-report="' + p.id + '" class="danger">Report post</button>');
    var menu = '<div class="feed-post-menu" data-menu><button type="button" data-menu-toggle>&#8942;</button><div class="feed-post-menu-list">' + menuItems.join("") + "</div></div>";

    var repostHtml = p.repostOf
      ? '<div class="feed-repost-box"><div class="head">' + H.avatarHtml({ displayName: p.repostOf.authorName, profilePhoto: p.repostOf.authorPhoto }, "sm") + '<h5>' + H.escapeHtml(p.repostOf.authorName) + '</h5></div>' +
        (p.repostOf.content ? '<p>' + H.escapeHtml(p.repostOf.content) + '</p>' : "") +
        mediaHtml(p.repostOf.imageUrl, p.repostOf.videoUrl, p.repostOf.imageUrls) +
        "</div>"
      : "";

    return (
      '<div class="hub-card feed-post-card" data-post-id="' + p.id + '">' +
      '<div class="feed-post-head">' +
      '<a href="/profile.html?id=' + p.authorId + '">' + H.avatarHtml({ displayName: p.authorName, profilePhoto: p.authorPhoto }, "md") + "</a>" +
      '<div class="info">' +
      '<a href="/profile.html?id=' + p.authorId + '" style="color:inherit;"><h4>' + H.escapeHtml(p.authorName) + "</h4></a>" +
      (role ? '<p class="role">' + H.escapeHtml(role) + "</p>" : "") +
      "<time>" + timeAgoOrDate(p.createdAt) + "</time>" +
      "</div>" + menu +
      "</div>" +
      (p.isPinned ? '<div class="feed-pinned-tag">📌 Pinned</div>' : "") +
      (p.repostOf ? '<div class="feed-repost-tag">&#8635; ' + (p.isMine ? "You reposted" : H.escapeHtml(p.authorName) + " reposted") + "</div>" : "") +
      (p.content ? '<p class="feed-post-content">' + H.escapeHtml(p.content) + "</p>" : "") +
      mediaHtml(p.imageUrl, p.videoUrl, p.imageUrls) + repostHtml +
      '<div class="feed-post-stats">' +
      reactionSummaryHtml(p) +
      (p.commentCount ? '<button type="button" class="feed-stat-link" data-comment-toggle="' + p.id + '">' + p.commentCount + " comment" + (p.commentCount === 1 ? "" : "s") + "</button>" : '<span></span>') +
      "</div>" +
      '<div class="feed-post-actions">' +
      reactionBtnHtml(p) +
      '<button type="button" class="feed-action-btn" data-comment-toggle="' + p.id + '">&#128172; Comment</button>' +
      '<button type="button" class="feed-action-btn" data-repost="' + p.id + '">&#8635; Repost</button>' +
      "</div>" +
      '<div class="feed-comments" id="comments-' + p.id + '">' +
      '<div class="feed-comment-list" id="comment-list-' + p.id + '"></div>' +
      '<form class="feed-comment-form" data-comment-form="' + p.id + '"><input type="text" placeholder="Write a comment…" maxlength="1000" /><button type="submit" class="eh-btn eh-btn-primary hub-btn-sm">Send</button></form>' +
      "</div>" +
      "</div>"
    );
  }

  function updatePostCardInPlace(containerEl, postId, patch) {
    var card = containerEl.querySelector('[data-post-id="' + postId + '"]');
    if (!card) return;
    var wrap = card.querySelector(".feed-reaction-wrap");
    var stats = card.querySelector(".feed-post-stats");
    if (wrap && patch.myReaction !== undefined) {
      var btn = wrap.querySelector("[data-react-quick]");
      var mine = REACTION_MAP[patch.myReaction];
      btn.classList.toggle("is-reacted", !!mine);
      btn.innerHTML = mine ? mine.emoji + " " + mine.label : "👍 Like";
    }
    if (stats && patch.reactionCount !== undefined) {
      var fakePost = { reactionCount: patch.reactionCount, reactionSummary: patch.reactionSummary, id: postId };
      var summaryBtn = stats.querySelector(".feed-reaction-summary") || stats.querySelector("span:first-child");
      if (summaryBtn) summaryBtn.outerHTML = reactionSummaryHtml(fakePost);
    }
  }

  function openReactorsModal(postId) {
    H.api("post-reactors", { query: { postId: postId } }).then(function (d) {
      var overlay = document.createElement("div");
      overlay.className = "hub-modal-overlay";
      overlay.innerHTML =
        '<div class="hub-modal"><div class="hub-modal-head"><h3>Reactions</h3><button type="button" class="hub-modal-close">&times;</button></div><div class="hub-modal-body"></div></div>';
      document.body.appendChild(overlay);
      var body = overlay.querySelector(".hub-modal-body");
      body.innerHTML = d.reactors.length
        ? d.reactors.map(function (r) {
            var rt = REACTION_MAP[r.reactionType] || REACTION_MAP.like;
            return (
              '<div class="hub-modal-row"><a href="/profile.html?id=' + r.id + '">' + H.avatarHtml({ displayName: r.displayName, profilePhoto: r.profilePhoto }, "sm") + "</a>" +
              '<span class="name">' + H.escapeHtml(r.displayName) + '</span><span class="emoji">' + rt.emoji + "</span></div>"
            );
          }).join("")
        : '<div class="hub-empty">No reactions yet.</div>';
      function close() { overlay.remove(); }
      overlay.querySelector(".hub-modal-close").onclick = close;
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    });
  }

  // One in-flight reaction request per post at a time (see feed-shared.js
  // history — concurrent requests can commit to Postgres out of send
  // order, so "last response wins" isn't reliable; only "last request
  // sent, and only after the previous one settled" is).
  var reactionInFlight = {};
  var reactionPending = {};
  function sendReaction(containerEl, postId, reactionType) {
    if (reactionInFlight[postId]) {
      reactionPending[postId] = reactionType;
      return;
    }
    reactionInFlight[postId] = true;
    H.api("react-post", { method: "POST", body: { postId: Number(postId), reactionType: reactionType } })
      .then(function (d) { updatePostCardInPlace(containerEl, postId, d); })
      .catch(function (err) { H.toast(err.message, true); })
      .finally(function () {
        reactionInFlight[postId] = false;
        if (reactionPending[postId] !== undefined) {
          var next = reactionPending[postId];
          delete reactionPending[postId];
          sendReaction(containerEl, postId, next);
        }
      });
  }

  function renderComments(containerEl, postId, comments) {
    var list = containerEl.querySelector("#comment-list-" + postId);
    if (!list) return;
    list.innerHTML = comments.length
      ? comments
          .map(function (c) {
            return (
              '<div class="feed-comment-item">' + H.avatarHtml({ displayName: c.authorName, profilePhoto: c.authorPhoto }, "sm") +
              '<div class="bubble"><h5>' + H.escapeHtml(c.authorName) + "</h5><p>" + H.escapeHtml(c.content) + "</p></div>" +
              (c.isMine ? '<button class="rm" data-del-comment="' + c.id + '" data-post="' + postId + '">Delete</button>' : "") +
              "</div>"
            );
          })
          .join("")
      : "";
    list.querySelectorAll("[data-del-comment]").forEach(function (b) {
      b.onclick = function () {
        H.api("comments", { method: "DELETE", query: { id: b.dataset.delComment } }).then(function () {
          return H.api("comments", { query: { postId: b.dataset.post } });
        }).then(function (d) {
          renderComments(containerEl, b.dataset.post, d.comments);
          containerEl.querySelectorAll('[data-comment-toggle="' + b.dataset.post + '"]').forEach(function (btn) {
            btn.innerHTML = btn.classList.contains("feed-stat-link") ? d.comments.length + " comment" + (d.comments.length === 1 ? "" : "s") : "&#128172; Comment";
          });
        });
      };
    });
  }

  // reloadFn is called after an action that changes list order/membership
  // (delete, pin) so the caller can decide how to refresh (full re-fetch
  // for the Home feed, same for a profile's post list).
  function wireContainer(containerEl, reloadFn) {
    containerEl.querySelectorAll("[data-react-quick]").forEach(function (btn) {
      btn.onclick = function () { sendReaction(containerEl, btn.dataset.reactQuick, "like"); };
    });
    containerEl.querySelectorAll("[data-react-caret]").forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var postId = btn.dataset.reactCaret;
        var picker = containerEl.querySelector('[data-picker="' + postId + '"]');
        var wasOpen = picker.classList.contains("is-open");
        containerEl.querySelectorAll(".feed-reaction-picker.is-open").forEach(function (p) { p.classList.remove("is-open"); });
        if (!wasOpen) picker.classList.add("is-open");
      };
    });
    containerEl.querySelectorAll("[data-react-type]").forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        sendReaction(containerEl, btn.dataset.post, btn.dataset.reactType);
        btn.closest(".feed-reaction-picker").classList.remove("is-open");
      };
    });
    containerEl.querySelectorAll("[data-reactors]").forEach(function (btn) {
      btn.onclick = function () { openReactorsModal(btn.dataset.reactors); };
    });

    containerEl.querySelectorAll("[data-comment-toggle]").forEach(function (btn) {
      btn.onclick = function () {
        var postId = btn.dataset.commentToggle;
        var panel = containerEl.querySelector("#comments-" + postId);
        var opening = !panel.classList.contains("is-open");
        panel.classList.toggle("is-open");
        if (opening && !panel.dataset.loaded) {
          panel.dataset.loaded = "1";
          H.api("comments", { query: { postId: postId } }).then(function (d) { renderComments(containerEl, postId, d.comments); });
        }
      };
    });
    containerEl.querySelectorAll("[data-comment-form]").forEach(function (f) {
      f.onsubmit = function (e) {
        e.preventDefault();
        var postId = f.dataset.commentForm;
        var input = f.querySelector("input");
        var content = input.value.trim();
        if (!content) return;
        H.api("comments", { method: "POST", body: { postId: Number(postId), content: content } }).then(function () {
          input.value = "";
          return H.api("comments", { query: { postId: postId } });
        }).then(function (d) {
          renderComments(containerEl, postId, d.comments);
          containerEl.querySelectorAll('[data-comment-toggle="' + postId + '"]').forEach(function (b) {
            b.innerHTML = b.classList.contains("feed-stat-link") ? d.comments.length + " comment" + (d.comments.length === 1 ? "" : "s") : "&#128172; Comment";
          });
        });
      };
    });

    containerEl.querySelectorAll("[data-repost]").forEach(function (btn) {
      btn.onclick = function () {
        H.api("posts", { method: "POST", body: { repostedFromId: Number(btn.dataset.repost) } })
          .then(function () { H.toast("Reposted to your profile"); if (reloadFn) reloadFn(); })
          .catch(function (err) { H.toast(err.message, true); });
      };
    });

    containerEl.querySelectorAll("[data-menu-toggle]").forEach(function (btn) {
      btn.onclick = function (e) { e.stopPropagation(); btn.closest("[data-menu]").classList.toggle("is-open"); };
    });
    containerEl.querySelectorAll("[data-delete]").forEach(function (btn) {
      btn.onclick = function () {
        if (!window.confirm("Delete this post?")) return;
        H.api("posts", { method: "DELETE", query: { id: btn.dataset.delete } }).then(function () { if (reloadFn) reloadFn(); });
      };
    });
    containerEl.querySelectorAll("[data-pin]").forEach(function (btn) {
      btn.onclick = function () {
        H.api("pin-post", { method: "POST", body: { postId: Number(btn.dataset.pin) } })
          .then(function (d) { H.toast(d.isPinned ? "Pinned to your profile" : "Unpinned"); if (reloadFn) reloadFn(); })
          .catch(function (err) { H.toast(err.message, true); });
      };
    });
    containerEl.querySelectorAll("[data-save]").forEach(function (btn) {
      btn.onclick = function () {
        H.api("save-post", { method: "POST", body: { postId: Number(btn.dataset.save) } })
          .then(function (d) { H.toast(d.saved ? "Saved" : "Removed from saved"); if (reloadFn) reloadFn(); })
          .catch(function (err) { H.toast(err.message, true); });
      };
    });
    containerEl.querySelectorAll("[data-share]").forEach(function (btn) {
      btn.onclick = function () {
        var url = window.location.origin + "/profile.html?id=" + btn.dataset.shareAuthor + "#post-" + btn.dataset.share;
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { H.toast("Link copied"); }).catch(function () { H.toast("Couldn't copy link", true); });
      };
    });
    containerEl.querySelectorAll("[data-report]").forEach(function (btn) {
      btn.onclick = function () {
        var reason = window.prompt("Why are you reporting this post?");
        if (reason === null) return;
        H.api("report-post", { method: "POST", body: { postId: Number(btn.dataset.report), reason: reason } })
          .then(function () { H.toast("Reported. Thank you."); })
          .catch(function (err) { H.toast(err.message, true); });
      };
    });

    containerEl.querySelectorAll("[data-lightbox-img]").forEach(function (img) {
      img.onclick = function () { H.openLightbox([{ type: "image", url: img.dataset.lightboxImg }], 0); };
    });

    containerEl.querySelectorAll("[data-carousel]").forEach(function (carousel) {
      var track = carousel.querySelector(".feed-post-carousel-track");
      var imgs = Array.prototype.slice.call(track.querySelectorAll("img"));
      var dots = carousel.querySelectorAll(".feed-post-carousel-dots span");
      imgs.forEach(function (img, i) {
        img.onclick = function () {
          H.openLightbox(imgs.map(function (im) { return { type: "image", url: im.src }; }), i);
        };
      });
      track.addEventListener("scroll", function () {
        var idx = Math.round(track.scrollLeft / track.clientWidth);
        dots.forEach(function (d, i) { d.classList.toggle("is-active", i === idx); });
      });
    });
  }

  // One document-level listener (installed once, lazily) closes any open
  // post menu / reaction picker on an outside click, across every
  // container that uses this module.
  var globalCloseWired = false;
  function ensureGlobalCloseHandler() {
    if (globalCloseWired) return;
    globalCloseWired = true;
    document.addEventListener("click", function (e) {
      document.querySelectorAll(".feed-post-menu.is-open").forEach(function (m) {
        if (!m.contains(e.target)) m.classList.remove("is-open");
      });
      document.querySelectorAll(".feed-reaction-picker.is-open").forEach(function (p) {
        if (!p.contains(e.target) && e.target.dataset.reactCaret === undefined) p.classList.remove("is-open");
      });
    });
  }
  ensureGlobalCloseHandler();

  return { postCard: postCard, wireContainer: wireContainer, REACTIONS: REACTIONS, REACTION_MAP: REACTION_MAP };
})();
