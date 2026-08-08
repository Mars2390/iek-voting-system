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

  return { token: token, requireAuth: requireAuth, api: api, escapeHtml: escapeHtml, initials: initials, avatarHtml: avatarHtml, timeAgo: timeAgo, toast: toast, compressImage: compressImage };
})();
