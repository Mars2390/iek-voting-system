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
  var MAX_IMAGES = 10;
  var pendingImageFiles = [];
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
    pendingImageFiles = [];
    pendingVideoFile = null;
    pendingVideoUrl = null;
    renderImagePreviews();
    imageInput.value = "";
    cameraInput.value = "";
    videoPreview.hidden = true;
    videoInput.value = "";
  }
  textarea.addEventListener("input", function () { charCount.textContent = textarea.value.length + " / 3000"; });

  function renderImagePreviews() {
    if (!pendingImageFiles.length) {
      imagePreview.hidden = true;
      imagePreview.innerHTML = "";
      return;
    }
    imagePreview.hidden = false;
    imagePreview.innerHTML = pendingImageFiles
      .map(function (item, i) {
        return '<div class="feed-composer-image-thumb"><img src="' + item.dataUrl + '" alt="" /><button type="button" data-remove-image="' + i + '">&times;</button></div>';
      })
      .join("");
    imagePreview.querySelectorAll("[data-remove-image]").forEach(function (btn) {
      btn.onclick = function () {
        pendingImageFiles.splice(Number(btn.dataset.removeImage), 1);
        renderImagePreviews();
      };
    });
  }

  // A single <input accept="image/*"> can't reliably offer both "take a
  // new photo" and "choose an existing one" — capture="environment"
  // launches the camera directly on most mobile browsers (iOS Safari in
  // particular drops the photo-library option entirely once it's set),
  // while leaving it off falls back to each OS/browser's own generic
  // chooser, whose "Camera" shortcut is inconsistently reliable across
  // Android OEM skins. Two separate inputs, one with capture and one
  // without, sidesteps that instead of gambling on either alone — both
  // funnel into the same pending-image handling. A post can carry more
  // than one photo (rendered as a swipeable carousel), so picking more
  // images adds to the pending set instead of replacing it.
  function onImagesPicked(files) {
    if (!files || !files.length) return;
    pendingVideoFile = null;
    videoPreview.hidden = true;
    videoInput.value = "";
    var room = MAX_IMAGES - pendingImageFiles.length;
    if (room <= 0) return H.toast("You can add up to " + MAX_IMAGES + " photos per post.", true);
    var toAdd = Array.prototype.slice.call(files, 0, room);
    if (files.length > toAdd.length) H.toast("Only added " + toAdd.length + " — up to " + MAX_IMAGES + " photos per post.", true);
    toAdd.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        pendingImageFiles.push({ file: file, dataUrl: e.target.result });
        renderImagePreviews();
      };
      reader.readAsDataURL(file);
    });
  }
  var cameraInput = document.getElementById("composer-camera-input");
  imageInput.addEventListener("change", function () { onImagesPicked(imageInput.files); });
  cameraInput.addEventListener("change", function () { onImagesPicked(cameraInput.files); });
  videoInput.addEventListener("change", function () {
    var file = videoInput.files[0];
    if (!file) return;
    pendingImageFiles = [];
    renderImagePreviews();
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
    if (!content && !pendingImageFiles.length && !pendingVideoFile) return H.toast("Write something or add media.", true);
    var submitBtn = document.getElementById("composer-submit");
    var originalSubmitLabel = submitBtn.textContent;
    submitBtn.disabled = true;

    var uploadedImageUrls = [];
    var uploadStep;
    if (pendingImageFiles.length) {
      var uploadedSoFar = 0;
      uploadStep = Promise.all(
        pendingImageFiles.map(function (item) {
          return H.compressImage(item.file, 1600, 0.82)
            .then(function (compressed) { return H.api("upload-post-image", { method: "POST", headers: { "Content-Type": compressed.type || "image/jpeg" }, body: compressed }); })
            .then(function (d) {
              uploadedSoFar += 1;
              submitBtn.textContent = "Uploading " + uploadedSoFar + "/" + pendingImageFiles.length + "…";
              return d.url;
            });
        })
      ).then(function (urls) { uploadedImageUrls = urls; });
    } else if (pendingVideoFile) {
      submitBtn.textContent = "Uploading…";
      uploadStep = H.api("upload-post-video", { method: "POST", headers: { "Content-Type": pendingVideoFile.type || "video/mp4" }, body: pendingVideoFile })
        .then(function (d) { pendingVideoUrl = d.url; });
    } else {
      uploadStep = Promise.resolve();
    }

    uploadStep
      .then(function () {
        var body = { content: content, videoUrl: pendingVideoUrl };
        if (uploadedImageUrls.length === 1) body.imageUrl = uploadedImageUrls[0];
        else if (uploadedImageUrls.length > 1) body.imageUrls = uploadedImageUrls;
        return H.api("posts", { method: "POST", body: body });
      })
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
