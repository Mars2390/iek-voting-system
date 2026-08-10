// Full, infinite-scrolling post history for one author — the "Show all"
// destination from the bounded carousel preview on profile.html
// (profile-posts.js). Same fetch/paging shape that used to live directly
// on the profile page before the carousel redesign.
(function () {
  "use strict";
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var HP = window.HubPosts;

  var params = new URLSearchParams(window.location.search);
  var viewId = params.get("id"); // null => self

  var listEl = document.getElementById("pap-posts-list");
  var loadMoreBtn = document.getElementById("pap-loadmore");
  var LIMIT = 10;
  var offset = 0;
  var authorId = null;
  var total = 0;

  var isLoadingPosts = false;
  function loadPosts(reset) {
    if (isLoadingPosts) return;
    isLoadingPosts = true;
    if (reset) offset = 0;
    H.api("posts", { query: { authorId: authorId, limit: LIMIT, offset: offset } })
      .then(function (data) {
        if (reset) listEl.innerHTML = "";
        if (!data.posts.length && reset) {
          listEl.innerHTML = '<div class="hub-empty" style="padding:16px 0;">No posts yet.</div>';
          loadMoreBtn.hidden = true;
          return;
        }
        listEl.insertAdjacentHTML("beforeend", data.posts.map(HP.postCard).join(""));
        offset += data.posts.length;
        total += data.posts.length;
        document.getElementById("pap-count").textContent = total + " post" + (total === 1 ? "" : "s");
        loadMoreBtn.hidden = data.posts.length < LIMIT;
        HP.wireContainer(listEl, function () { loadPosts(true); });
      })
      .catch(function (err) { listEl.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; })
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
    document.getElementById("pap-back-link").href = authorId === selfId ? "/profile.html" : "/profile.html?id=" + authorId;

    H.api("profile", { query: { id: authorId } }).then(function (data) {
      var e = data.engineer;
      document.getElementById("pap-avatar").outerHTML = H.avatarHtml(e, "md").replace('class="hub-avatar', 'id="pap-avatar" class="hub-avatar');
      document.getElementById("pap-name").textContent = (authorId === selfId ? "Your" : (e.displayName + "'s")) + " posts";
    });

    loadPosts(true);
  });
})();
