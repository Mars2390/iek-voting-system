// "Posts" section on a profile page — the author's own post history,
// pinned post first. Shares rendering/reactions/menu with the Home feed
// via post-shared.js (window.HubPosts); this file only owns fetching the
// right author's posts and paging them.
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
  var loadMoreBtn = document.getElementById("pf-posts-loadmore");
  var LIMIT = 10;
  var offset = 0;
  var authorId = null;
  var isSelf = false;

  var isLoadingPosts = false;
  function loadPosts(reset) {
    if (isLoadingPosts) return;
    isLoadingPosts = true;
    if (reset) offset = 0;
    H.api("posts", { query: { authorId: authorId, limit: LIMIT, offset: offset } })
      .then(function (data) {
        if (reset) listEl.innerHTML = "";
        if (!data.posts.length && reset) {
          if (!isSelf) { section.hidden = true; return; }
          section.hidden = false;
          listEl.innerHTML = '<div class="hub-empty" style="padding:16px 0;">You haven\'t posted anything yet. Share an update from Home.</div>';
          loadMoreBtn.hidden = true;
          return;
        }
        section.hidden = false;
        listEl.insertAdjacentHTML("beforeend", data.posts.map(HP.postCard).join(""));
        offset += data.posts.length;
        loadMoreBtn.hidden = data.posts.length < LIMIT;
        HP.wireContainer(listEl, function () { loadPosts(true); });
      })
      .catch(function () { section.hidden = true; })
      .finally(function () { isLoadingPosts = false; });
  }
  loadMoreBtn.addEventListener("click", function () { loadPosts(false); });
  if (window.IntersectionObserver) {
    new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting && !loadMoreBtn.hidden) loadPosts(false);
      },
      { rootMargin: "600px" }
    ).observe(loadMoreBtn);
  }

  H.api("me").then(function (d) {
    var selfId = d.engineer.id;
    authorId = viewId ? Number(viewId) : selfId;
    isSelf = authorId === selfId;
    loadPosts(true);
  });
})();
