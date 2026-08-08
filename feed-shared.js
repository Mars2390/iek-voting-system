// Shared Home-feed behavior: composer + post list + like/comment/repost.
// Mounts only if #feed-posts exists on the page (currently dashboard.html).
(function () {
  "use strict";
  var postsEl = document.getElementById("feed-posts");
  if (!postsEl) return;
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;

  var currentSort = "recent";
  var offset = 0;
  var LIMIT = 15;
  var pendingImageFile = null;
  var pendingImageUrl = null;
  var me = null;

  // ---------- Composer ----------
  var openBtn = document.getElementById("composer-open-btn");
  var form = document.getElementById("composer-form");
  var textarea = document.getElementById("composer-text");
  var charCount = document.getElementById("composer-charcount");
  var imageInput = document.getElementById("composer-image-input");
  var imagePreview = document.getElementById("composer-image-preview");
  var imagePreviewImg = document.getElementById("composer-image-preview-img");

  openBtn.addEventListener("click", function () {
    openBtn.parentElement.hidden = true;
    form.hidden = false;
    textarea.focus();
  });
  document.getElementById("composer-cancel").addEventListener("click", resetComposer);
  function resetComposer() {
    form.hidden = true;
    openBtn.parentElement.hidden = false;
    textarea.value = "";
    charCount.textContent = "0 / 3000";
    pendingImageFile = null;
    pendingImageUrl = null;
    imagePreview.hidden = true;
    imageInput.value = "";
  }
  textarea.addEventListener("input", function () { charCount.textContent = textarea.value.length + " / 3000"; });
  imageInput.addEventListener("change", function () {
    var file = imageInput.files[0];
    if (!file) return;
    pendingImageFile = file;
    var reader = new FileReader();
    reader.onload = function (e) { imagePreviewImg.src = e.target.result; imagePreview.hidden = false; };
    reader.readAsDataURL(file);
  });
  document.getElementById("composer-image-remove").addEventListener("click", function () {
    pendingImageFile = null;
    imagePreview.hidden = true;
    imageInput.value = "";
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var content = textarea.value.trim();
    if (!content && !pendingImageFile) return H.toast("Write something or add a photo.", true);
    var submitBtn = document.getElementById("composer-submit");
    submitBtn.disabled = true;

    var uploadStep = pendingImageFile
      ? H.api("upload-post-image", { method: "POST", headers: { "Content-Type": pendingImageFile.type }, body: pendingImageFile }).then(function (d) { pendingImageUrl = d.url; })
      : Promise.resolve();

    uploadStep
      .then(function () { return H.api("posts", { method: "POST", body: { content: content, imageUrl: pendingImageUrl } }); })
      .then(function () {
        resetComposer();
        loadPosts(true);
        H.toast("Posted");
      })
      .catch(function (err) { H.toast(err.message, true); })
      .finally(function () { submitBtn.disabled = false; });
  });

  H.api("me").then(function (d) {
    me = d.engineer;
    document.getElementById("composer-avatar").outerHTML = H.avatarHtml(me, "md").replace('class="hub-avatar', 'id="composer-avatar" class="hub-avatar');
  });

  // ---------- Sort tabs ----------
  document.querySelectorAll(".hub-tab[data-sort]").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".hub-tab[data-sort]").forEach(function (t) { t.classList.remove("is-active"); });
      tab.classList.add("is-active");
      currentSort = tab.dataset.sort;
      loadPosts(true);
    });
  });

  // ---------- Render ----------
  function timeAgoOrDate(d) { return H.timeAgo(d); }

  function postCard(p) {
    var role = [p.authorTitle, p.authorCompany].filter(Boolean).join(" at ");
    var menu = p.isMine
      ? '<div class="feed-post-menu" data-menu><button type="button" data-menu-toggle>&#8942;</button><div class="feed-post-menu-list"><button type="button" data-delete="' + p.id + '">Delete post</button></div></div>'
      : "";
    var imageHtml = p.imageUrl ? '<div class="feed-post-image"><img src="' + H.escapeHtml(p.imageUrl) + '" alt="" /></div>' : "";
    var repostHtml = p.repostOf
      ? '<div class="feed-repost-box"><div class="head">' + H.avatarHtml(p.repostOf, "sm") + '<h5>' + H.escapeHtml(p.repostOf.authorName) + '</h5></div>' +
        (p.repostOf.content ? '<p>' + H.escapeHtml(p.repostOf.content) + '</p>' : "") +
        (p.repostOf.imageUrl ? '<div class="feed-post-image" style="margin-top:8px;"><img src="' + H.escapeHtml(p.repostOf.imageUrl) + '" alt="" /></div>' : "") +
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
      (p.repostOf ? '<div class="feed-repost-tag">&#8635; ' + (p.isMine ? "You reposted" : H.escapeHtml(p.authorName) + " reposted") + "</div>" : "") +
      (p.content ? '<p class="feed-post-content">' + H.escapeHtml(p.content) + "</p>" : "") +
      imageHtml + repostHtml +
      '<div class="feed-post-actions">' +
      '<button type="button" class="feed-action-btn' + (p.likedByMe ? " is-liked" : "") + '" data-like="' + p.id + '">' +
      "&#128077; Like" + (p.likeCount ? " (" + p.likeCount + ")" : "") +
      "</button>" +
      '<button type="button" class="feed-action-btn" data-comment-toggle="' + p.id + '">&#128172; Comment' + (p.commentCount ? " (" + p.commentCount + ")" : "") + "</button>" +
      '<button type="button" class="feed-action-btn" data-repost="' + p.id + '">&#8635; Repost</button>' +
      "</div>" +
      '<div class="feed-comments" id="comments-' + p.id + '">' +
      '<div class="feed-comment-list" id="comment-list-' + p.id + '"></div>' +
      '<form class="feed-comment-form" data-comment-form="' + p.id + '"><input type="text" placeholder="Write a comment…" maxlength="1000" /><button type="submit" class="eh-btn eh-btn-primary hub-btn-sm">Send</button></form>' +
      "</div>" +
      "</div>"
    );
  }

  function loadPosts(reset) {
    if (reset) offset = 0;
    H.api("posts", { query: { sort: currentSort, limit: LIMIT, offset: offset } })
      .then(function (data) {
        if (reset) postsEl.innerHTML = "";
        if (!data.posts.length && reset) {
          postsEl.innerHTML = '<div class="hub-empty">No posts yet — be the first to share an update.</div>';
        } else {
          postsEl.insertAdjacentHTML("beforeend", data.posts.map(postCard).join(""));
        }
        offset += data.posts.length;
        document.getElementById("feed-loadmore").hidden = data.posts.length < LIMIT;
        wirePostEvents();
      })
      .catch(function (err) { postsEl.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; });
  }
  document.getElementById("feed-loadmore").addEventListener("click", function () { loadPosts(false); });

  function wirePostEvents() {
    postsEl.querySelectorAll("[data-like]").forEach(function (btn) {
      btn.onclick = function () {
        H.api("like-post", { method: "POST", body: { postId: Number(btn.dataset.like) } }).then(function (d) {
          btn.classList.toggle("is-liked", d.liked);
          btn.innerHTML = "&#128077; Like" + (d.likeCount ? " (" + d.likeCount + ")" : "");
        });
      };
    });

    postsEl.querySelectorAll("[data-comment-toggle]").forEach(function (btn) {
      btn.onclick = function () {
        var postId = btn.dataset.commentToggle;
        var panel = document.getElementById("comments-" + postId);
        var opening = !panel.classList.contains("is-open");
        panel.classList.toggle("is-open");
        if (opening && !panel.dataset.loaded) {
          panel.dataset.loaded = "1";
          H.api("comments", { query: { postId: postId } }).then(function (d) { renderComments(postId, d.comments); });
        }
      };
    });

    postsEl.querySelectorAll("[data-comment-form]").forEach(function (f) {
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
          renderComments(postId, d.comments);
          var countBtn = postsEl.querySelector('[data-comment-toggle="' + postId + '"]');
          countBtn.innerHTML = "&#128172; Comment (" + d.comments.length + ")";
        });
      };
    });

    postsEl.querySelectorAll("[data-repost]").forEach(function (btn) {
      btn.onclick = function () {
        H.api("posts", { method: "POST", body: { repostedFromId: Number(btn.dataset.repost) } })
          .then(function () { H.toast("Reposted to your profile"); loadPosts(true); })
          .catch(function (err) { H.toast(err.message, true); });
      };
    });

    postsEl.querySelectorAll("[data-menu-toggle]").forEach(function (btn) {
      btn.onclick = function () { btn.closest("[data-menu]").classList.toggle("is-open"); };
    });
    postsEl.querySelectorAll("[data-delete]").forEach(function (btn) {
      btn.onclick = function () {
        if (!window.confirm("Delete this post?")) return;
        H.api("posts", { method: "DELETE", query: { id: btn.dataset.delete } }).then(function () { loadPosts(true); });
      };
    });
  }

  function renderComments(postId, comments) {
    var list = document.getElementById("comment-list-" + postId);
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
          renderComments(b.dataset.post, d.comments);
          postsEl.querySelector('[data-comment-toggle="' + b.dataset.post + '"]').innerHTML = "&#128172; Comment" + (d.comments.length ? " (" + d.comments.length + ")" : "");
        });
      };
    });
  }

  document.addEventListener("click", function (e) {
    document.querySelectorAll(".feed-post-menu.is-open").forEach(function (m) {
      if (!m.contains(e.target)) m.classList.remove("is-open");
    });
  });

  loadPosts(true);
})();
