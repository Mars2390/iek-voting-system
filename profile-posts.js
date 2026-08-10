// "Posts" section on a profile page — a bounded preview of the author's
// most recent posts (pinned post first), rendered as a horizontally
// scrolling row like LinkedIn's profile Activity section instead of an
// endless vertical stack. "Show all" links out to profile-all-posts.html,
// which reuses the same post-shared.js rendering for the full,
// infinite-scrolling list. Shares rendering/reactions/menu with the Home
// feed via post-shared.js (window.HubPosts); this file only owns
// fetching the right author's preview posts.
(function () {
  "use strict";
  var section = document.getElementById("pf-posts-section");
  if (!section) return;
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var HP = window.HubPosts;

  var params = new URLSearchParams(window.location.search);
  var viewId = params.get("id"); // null => self

  var listEl = document.getElementById("pf-posts-list");
  var prevBtn = document.getElementById("pf-posts-prev");
  var nextBtn = document.getElementById("pf-posts-next");
  var showAllLink = document.getElementById("pf-posts-showall");
  var PREVIEW_LIMIT = 6;

  function updateNavVisibility() {
    var canScroll = listEl.scrollWidth > listEl.clientWidth + 4;
    prevBtn.hidden = !canScroll;
    nextBtn.hidden = !canScroll;
  }

  function scrollByCard(dir) {
    var card = listEl.querySelector(".feed-post-card");
    var amount = card ? card.getBoundingClientRect().width + 14 : 300;
    listEl.scrollBy({ left: dir * amount, behavior: "smooth" });
  }
  prevBtn.addEventListener("click", function () { scrollByCard(-1); });
  nextBtn.addEventListener("click", function () { scrollByCard(1); });
  listEl.addEventListener("scroll", updateNavVisibility);
  window.addEventListener("resize", updateNavVisibility);

  function loadPreview(authorId) {
    H.api("posts", { query: { authorId: authorId, limit: PREVIEW_LIMIT, offset: 0 } })
      .then(function (data) {
        if (!data.posts.length) {
          if (authorId !== window.__pfSelfId) { section.hidden = true; return; }
          section.hidden = false;
          showAllLink.hidden = true;
          listEl.innerHTML = '<div class="hub-empty" style="padding:16px 0;">You haven\'t posted anything yet. Share an update from Home.</div>';
          return;
        }
        section.hidden = false;
        listEl.innerHTML = data.posts.map(HP.postCard).join("");
        HP.wireContainer(listEl, function () { loadPreview(authorId); });
        updateNavVisibility();
      })
      .catch(function () { section.hidden = true; });
  }

  H.api("me").then(function (d) {
    var selfId = d.engineer.id;
    window.__pfSelfId = selfId;
    var authorId = viewId ? Number(viewId) : selfId;
    showAllLink.href = "/profile-all-posts.html" + (viewId ? "?id=" + authorId : "");
    loadPreview(authorId);
  });
})();
