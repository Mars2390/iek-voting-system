// Small shared helpers used by profile.js, directory.js, connections.js,
// jobs.js, feed.js, dashboard.js. Loaded as a plain global (window.Hub) —
// no bundler in this project, so no ES module exports here.
window.Hub = (function () {
  "use strict";

  var STORAGE_KEY = "eh_session_token";

  function token() {
    return localStorage.getItem(STORAGE_KEY);
  }

  function requireAuth() {
    if (!token()) {
      window.location.replace("/login.html");
      return false;
    }
    return true;
  }

  function api(action, options) {
    options = options || {};
    var params = new URLSearchParams(Object.assign({ action: action }, options.query || {}));
    var headers = Object.assign({ Authorization: "Bearer " + token() }, options.headers || {});
    var isBinary = options.body instanceof Blob || options.body instanceof ArrayBuffer || options.body instanceof File;
    if (options.body && !isBinary && typeof options.body === "object") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    return fetch("/api/auth?" + params.toString(), {
      method: options.method || "GET",
      headers: headers,
      body: options.body,
    }).then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem(STORAGE_KEY);
        window.location.replace("/login.html");
        return new Promise(function () {}); // never resolves; we're navigating away
      }
      return r.json().then(function (data) {
        if (!r.ok) throw Object.assign(new Error(data.error || "Request failed"), { data: data });
        return data;
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function avatarHtml(person, size) {
    size = size || "md";
    var photo = person.profilePhoto || person.profile_photo;
    var name = person.displayName || person.display_name || person.name || "";
    if (photo) {
      return '<span class="hub-avatar sz-' + size + '"><img src="' + escapeHtml(photo) + '" alt="" /></span>';
    }
    return '<span class="hub-avatar sz-' + size + '">' + escapeHtml(initials(name)) + "</span>";
  }

  function timeAgo(dateStr) {
    var diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 2592000) return Math.floor(diff / 86400) + "d ago";
    return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  // Phone camera photos are routinely 3-15MB — well over the server's
  // 5MB cap — and slow to upload on mobile data. Downscale + re-encode
  // as JPEG client-side before every upload (desktop webcam/screenshot
  // files get the same treatment; it's a no-op cost for already-small
  // files). createImageBitmap with imageOrientation:'from-image' also
  // fixes the classic "phone photo comes out sideways" bug — phone
  // sensors capture in landscape and rely on EXIF to say how to
  // display it, and a naive canvas draw ignores that tag entirely.
  function compressImage(file, maxDimension, quality) {
    maxDimension = maxDimension || 1600;
    quality = quality || 0.82;
    if (!file.type || !file.type.startsWith("image/")) return Promise.resolve(file);
    // Recompressing a GIF through canvas only ever captures one frame —
    // silently kills the animation, which defeats the entire point of
    // uploading a GIF. Upload it as-is (GIFs are rarely huge anyway).
    if (file.type === "image/gif") return Promise.resolve(file);

    var loadBitmap = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: "from-image" })
      : new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () { resolve(img); };
          img.onerror = reject;
          img.src = URL.createObjectURL(file);
        });

    return loadBitmap.then(function (bitmap) {
      var w = bitmap.width, h = bitmap.height;
      var scale = Math.min(1, maxDimension / Math.max(w, h));
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      var ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return new Promise(function (resolve) {
        canvas.toBlob(
          function (blob) {
            // Fall back to the original file if canvas encoding ever
            // fails (some locked-down webviews block toBlob) — better
            // to upload the original than to hard-fail the post.
            resolve(blob || file);
          },
          "image/jpeg",
          quality
        );
      });
    }).catch(function () {
      return file; // decode failed (corrupt/unsupported format) — let the server's own validation catch it
    });
  }

  // Full-screen viewer for post/profile/cover images. `items` is
  // [{type:'image', url}], `startIndex` picks which one opens first —
  // multiple items get prev/next arrows + swipe, a single item doesn't.
  function openLightbox(items, startIndex) {
    items = (items || []).filter(function (it) { return it && it.url; });
    if (!items.length) return;
    var idx = Math.min(Math.max(startIndex || 0, 0), items.length - 1);

    var overlay = document.createElement("div");
    overlay.className = "hub-lightbox";
    overlay.innerHTML =
      '<button type="button" class="hub-lightbox-close" aria-label="Close">&times;</button>' +
      '<button type="button" class="hub-lightbox-nav prev" aria-label="Previous">&#10094;</button>' +
      '<div class="hub-lightbox-stage"></div>' +
      '<button type="button" class="hub-lightbox-nav next" aria-label="Next">&#10095;</button>' +
      '<span class="hub-lightbox-counter"></span>' +
      '<a class="hub-lightbox-download" download target="_blank" rel="noopener">Download</a>';
    document.body.appendChild(overlay);
    var prevScroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    var stage = overlay.querySelector(".hub-lightbox-stage");
    var prevBtn = overlay.querySelector(".prev");
    var nextBtn = overlay.querySelector(".next");
    var downloadLink = overlay.querySelector(".hub-lightbox-download");
    var counter = overlay.querySelector(".hub-lightbox-counter");
    var showNav = items.length > 1;
    prevBtn.style.display = showNav ? "" : "none";
    nextBtn.style.display = showNav ? "" : "none";
    counter.style.display = showNav ? "" : "none";

    function render() {
      var item = items[idx];
      stage.innerHTML = "";
      var img = document.createElement("img");
      img.src = item.url;
      img.alt = "";
      img.className = "hub-lightbox-media";
      var zoomed = false;
      img.addEventListener("click", function (e) {
        e.stopPropagation();
        zoomed = !zoomed;
        img.classList.toggle("is-zoomed", zoomed);
      });
      stage.appendChild(img);
      downloadLink.href = item.url;
      if (showNav) counter.textContent = idx + 1 + " / " + items.length;
    }
    render();

    function close() {
      document.body.style.overflow = prevScroll;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function go(delta) {
      idx = (idx + delta + items.length) % items.length;
      render();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" && showNav) go(-1);
      else if (e.key === "ArrowRight" && showNav) go(1);
    }
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".hub-lightbox-close").onclick = close;
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target === stage) close();
    });
    prevBtn.onclick = function (e) { e.stopPropagation(); go(-1); };
    nextBtn.onclick = function (e) { e.stopPropagation(); go(1); };

    var touchStartX = null;
    stage.addEventListener("touchstart", function (e) { touchStartX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (touchStartX == null || !showNav) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) go(dx > 0 ? -1 : 1);
      touchStartX = null;
    }, { passive: true });
  }

  // Universal broken-image fallback. `error` doesn't bubble, but it does
  // fire during the capture phase, so one listener on `document` here
  // catches every failed <img> load on every page that includes this
  // file — a deleted/expired Blob URL, a corrupt upload that slipped
  // past validation, an old bad photo — without every call site that
  // renders an <img> needing its own onerror handling.
  var BROKEN_IMG_SRC =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<rect width="100" height="100" fill="#eef0f2"/>' +
        '<path d="M22 70l18-22 14 16 10-12 18 22z" fill="none" stroke="#b8bcc4" stroke-width="4" stroke-linejoin="round"/>' +
        '<circle cx="34" cy="34" r="8" fill="none" stroke="#b8bcc4" stroke-width="4"/>' +
        "</svg>"
    );
  document.addEventListener(
    "error",
    function (e) {
      var el = e.target;
      if (!el || el.tagName !== "IMG" || el.dataset.fallbackApplied) return;
      el.dataset.fallbackApplied = "1";
      el.src = BROKEN_IMG_SRC;
      el.classList.add("hub-img-broken");
    },
    true
  );

  // Custom "are you sure?" dialog — replaces window.confirm everywhere in
  // Engineer Hub so warnings look and feel like the rest of the app
  // instead of a raw browser prompt. Accepts either a plain message
  // string or { title, message, confirmText, cancelText, danger } for
  // more control; danger:true (the default — most confirms here guard a
  // delete) styles the confirm button as a destructive red action.
  // Resolves true/false, mirroring window.confirm's boolean return so
  // every call site could drop this in with `H.confirm(...).then(...)`.
  function confirmDialog(opts) {
    if (typeof opts === "string") opts = { message: opts };
    opts = opts || {};
    var danger = opts.danger !== false;
    var title = opts.title || (danger ? "Are you sure?" : "Confirm");
    var confirmText = opts.confirmText || (danger ? "Delete" : "Confirm");
    var cancelText = opts.cancelText || "Cancel";

    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "hub-modal-overlay hub-confirm-overlay";
      overlay.innerHTML =
        '<div class="hub-confirm" role="alertdialog" aria-modal="true">' +
        '<span class="hub-confirm-icon' + (danger ? " is-danger" : "") + '">' +
        (danger
          ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>'
          : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.5 12.5l1.8 1.8L15 10.5" /></svg>') +
        "</span>" +
        '<h3 class="hub-confirm-title"></h3>' +
        '<p class="hub-confirm-message"></p>' +
        '<div class="hub-confirm-actions">' +
        '<button type="button" class="eh-btn eh-btn-ghost-light hub-btn-sm hub-confirm-cancel"></button>' +
        '<button type="button" class="eh-btn hub-btn-sm hub-confirm-ok' + (danger ? " eh-btn-danger" : " eh-btn-primary") + '"></button>' +
        "</div></div>";
      overlay.querySelector(".hub-confirm-title").textContent = title;
      overlay.querySelector(".hub-confirm-message").textContent = opts.message || "";
      overlay.querySelector(".hub-confirm-cancel").textContent = cancelText;
      overlay.querySelector(".hub-confirm-ok").textContent = confirmText;
      document.body.appendChild(overlay);
      var prevScroll = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      function finish(result) {
        document.body.style.overflow = prevScroll;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") finish(false);
        else if (e.key === "Enter") finish(true);
      }
      document.addEventListener("keydown", onKey);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) finish(false); });
      overlay.querySelector(".hub-confirm-cancel").addEventListener("click", function () { finish(false); });
      overlay.querySelector(".hub-confirm-ok").addEventListener("click", function () { finish(true); });
      overlay.querySelector(".hub-confirm-ok").focus();
    });
  }

  function toast(message, isError) {
    var el = document.createElement("div");
    el.textContent = message;
    el.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;" +
      "background:" + (isError ? "#bb0a1e" : "#101a24") + ";color:#fff;padding:12px 22px;" +
      "border-radius:999px;font-size:13.5px;font-weight:600;box-shadow:0 12px 28px -12px rgba(10,10,10,0.4);" +
      "opacity:0;transition:opacity 0.25s;";
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = "1"; });
    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 300);
    }, 2600);
  }

  return { token: token, requireAuth: requireAuth, api: api, escapeHtml: escapeHtml, initials: initials, avatarHtml: avatarHtml, timeAgo: timeAgo, toast: toast, compressImage: compressImage, openLightbox: openLightbox, confirm: confirmDialog };
})();
