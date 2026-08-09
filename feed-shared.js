// Home-feed page behavior: composer + post list. Rendering, reactions,
// comments, and the post menu are shared with a profile's Posts section
// via post-shared.js (window.HubPosts) — this file only owns what's
// unique to the Home feed: the composer and the sort/paging list.
// Mounts only if #feed-posts exists on the page (currently dashboard.html).
(function () {
  "use strict";
  var postsEl = document.getElementById("feed-posts");
  if (!postsEl) return;
  if (!window.Hub.requireAuth()) return;
  var H = window.Hub;
  var HP = window.HubPosts;

  var currentSort = "recent";
  var offset = 0;
  var LIMIT = 15;
  var pendingImageFile = null;
  var pendingImageUrl = null;
  var pendingVideoFile = null;
  var pendingVideoUrl = null;
  var me = null;

  // ---------- Composer ----------
  var openBtn = document.getElementById("composer-open-btn");
  var form = document.getElementById("composer-form");
  var textarea = document.getElementById("composer-text");
  var charCount = document.getElementById("composer-charcount");
  var imageInput = document.getElementById("composer-image-input");
  var imagePreview = document.getElementById("composer-image-preview");
  var imagePreviewImg = document.getElementById("composer-image-preview-img");
  var videoInput = document.getElementById("composer-video-input");
  var videoPreview = document.getElementById("composer-video-preview");
  var videoPreviewName = document.getElementById("composer-video-preview-name");

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
    pendingVideoFile = null;
    pendingVideoUrl = null;
    imagePreview.hidden = true;
    imageInput.value = "";
    cameraInput.value = "";
    videoPreview.hidden = true;
    videoInput.value = "";
  }
  textarea.addEventListener("input", function () { charCount.textContent = textarea.value.length + " / 3000"; });

  // A single <input accept="image/*"> can't reliably offer both "take a
  // new photo" and "choose an existing one" — capture="environment"
  // launches the camera directly on most mobile browsers (iOS Safari in
  // particular drops the photo-library option entirely once it's set),
  // while leaving it off falls back to each OS/browser's own generic
  // chooser, whose "Camera" shortcut is inconsistently reliable across
  // Android OEM skins. Two separate inputs, one with capture and one
  // without, sidesteps that instead of gambling on either alone — both
  // funnel into the same pending-image handling.
  function onImagePicked(file) {
    if (!file) return;
    pendingVideoFile = null;
    videoPreview.hidden = true;
    videoInput.value = "";
    pendingImageFile = file;
    var reader = new FileReader();
    reader.onload = function (e) { imagePreviewImg.src = e.target.result; imagePreview.hidden = false; };
    reader.readAsDataURL(file);
  }
  var cameraInput = document.getElementById("composer-camera-input");
  imageInput.addEventListener("change", function () { onImagePicked(imageInput.files[0]); });
  cameraInput.addEventListener("change", function () { onImagePicked(cameraInput.files[0]); });
  document.getElementById("composer-image-remove").addEventListener("click", function () {
    pendingImageFile = null;
    imagePreview.hidden = true;
    imageInput.value = "";
    cameraInput.value = "";
  });
  videoInput.addEventListener("change", function () {
    var file = videoInput.files[0];
    if (!file) return;
    pendingImageFile = null;
    imagePreview.hidden = true;
    imageInput.value = "";
    cameraInput.value = "";
    pendingVideoFile = file;
    videoPreviewName.textContent = file.name + " (" + (file.size / 1024 / 1024).toFixed(1) + " MB)";
    videoPreview.hidden = false;
  });
  document.getElementById("composer-video-remove").addEventListener("click", function () {
    pendingVideoFile = null;
    videoPreview.hidden = true;
    videoInput.value = "";
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var content = textarea.value.trim();
    if (!content && !pendingImageFile && !pendingVideoFile) return H.toast("Write something or add media.", true);
    var submitBtn = document.getElementById("composer-submit");
    var originalSubmitLabel = submitBtn.textContent;
    submitBtn.disabled = true;

    var uploadStep;
    if (pendingImageFile) {
      uploadStep = H.compressImage(pendingImageFile, 1600, 0.82).then(function (compressed) {
        submitBtn.textContent = "Uploading…";
        return H.api("upload-post-image", { method: "POST", headers: { "Content-Type": compressed.type || "image/jpeg" }, body: compressed });
      }).then(function (d) { pendingImageUrl = d.url; submitBtn.textContent = originalSubmitLabel; });
    } else if (pendingVideoFile) {
      submitBtn.textContent = "Uploading…";
      uploadStep = H.api("upload-post-video", { method: "POST", headers: { "Content-Type": pendingVideoFile.type || "video/mp4" }, body: pendingVideoFile })
        .then(function (d) { pendingVideoUrl = d.url; submitBtn.textContent = originalSubmitLabel; });
    } else {
      uploadStep = Promise.resolve();
    }

    uploadStep
      .then(function () { return H.api("posts", { method: "POST", body: { content: content, imageUrl: pendingImageUrl, videoUrl: pendingVideoUrl } }); })
      .then(function () {
        resetComposer();
        loadPosts(true);
        H.toast("Posted");
      })
      .catch(function (err) { H.toast(err.message, true); })
      .finally(function () { submitBtn.disabled = false; submitBtn.textContent = originalSubmitLabel; });
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

  // ---------- List ----------
  var loadMoreBtn = document.getElementById("feed-loadmore");
  var isLoadingPosts = false;
  function loadPosts(reset) {
    if (isLoadingPosts) return;
    isLoadingPosts = true;
    if (reset) offset = 0;
    H.api("posts", { query: { sort: currentSort, limit: LIMIT, offset: offset } })
      .then(function (data) {
        if (reset) postsEl.innerHTML = "";
        if (!data.posts.length && reset) {
          postsEl.innerHTML = '<div class="hub-empty">No posts yet — be the first to share an update.</div>';
        } else {
          postsEl.insertAdjacentHTML("beforeend", data.posts.map(HP.postCard).join(""));
        }
        offset += data.posts.length;
        loadMoreBtn.hidden = data.posts.length < LIMIT;
        HP.wireContainer(postsEl, function () { loadPosts(true); });
      })
      .catch(function (err) { postsEl.innerHTML = '<div class="hub-empty">' + H.escapeHtml(err.message) + "</div>"; })
      .finally(function () { isLoadingPosts = false; });
  }
  loadMoreBtn.addEventListener("click", function () { loadPosts(false); });

  // Infinite scroll: the "Load more" button doubles as the scroll
  // sentinel — it's already shown/hidden exactly when there is/isn't
  // another page, so observing it (instead of a separate invisible div)
  // gets auto-load-on-scroll and a manual fallback button for free.
  if (window.IntersectionObserver) {
    new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting && !loadMoreBtn.hidden) loadPosts(false);
      },
      { rootMargin: "600px" }
    ).observe(loadMoreBtn);
  }

  loadPosts(true);
})();
