(function () {
  "use strict";

  var STORAGE_KEY = "eh_session_token";
  var token = localStorage.getItem(STORAGE_KEY);

  if (!token) {
    window.location.replace("/login.html");
    return;
  }

  var loadingEl = document.getElementById("db-loading");
  var contentEl = document.getElementById("db-content");
  var current = null;

  function authFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, { Authorization: "Bearer " + token });
    return fetch(url, options);
  }

  function render(engineer) {
    current = engineer;
    document.getElementById("db-welcome").textContent = "Welcome back, " + engineer.displayName + "!";
    document.getElementById("db-field-name").textContent = engineer.displayName || "—";
    document.getElementById("db-field-iek").textContent = engineer.iekNumber || "—";
    document.getElementById("db-field-discipline").textContent = engineer.discipline || "Not set yet";
    document.getElementById("db-field-company").textContent = engineer.company || "Not set yet";
    document.getElementById("db-field-phone").textContent = engineer.phone || "Not on file";

    document.getElementById("db-input-name").value = engineer.displayName || "";
    document.getElementById("db-input-discipline").value = engineer.discipline || "";
    document.getElementById("db-input-company").value = engineer.company || "";

    loadingEl.hidden = true;
    contentEl.hidden = false;
  }

  authFetch("/api/auth?action=me")
    .then(function (r) {
      if (r.status === 401) {
        localStorage.removeItem(STORAGE_KEY);
        window.location.replace("/login.html");
        return null;
      }
      return r.json();
    })
    .then(function (data) {
      if (data) render(data.engineer);
    })
    .catch(function () {
      loadingEl.textContent = "Couldn't load your profile. Check your connection and reload the page.";
    });

  // ---------- Logout ----------
  document.getElementById("db-logout").addEventListener("click", function () {
    authFetch("/api/auth?action=logout", { method: "POST" }).finally(function () {
      localStorage.removeItem(STORAGE_KEY);
      window.location.href = "/login.html";
    });
  });

  // ---------- Edit profile ----------
  var viewEl = document.getElementById("db-profile-view");
  var formEl = document.getElementById("db-edit-form");
  var editErrorEl = document.getElementById("db-edit-error");
  var editToggleBtn = document.getElementById("db-edit-toggle");

  function openEdit() {
    viewEl.hidden = true;
    formEl.hidden = false;
    editToggleBtn.hidden = true;
  }
  function closeEdit() {
    viewEl.hidden = false;
    formEl.hidden = true;
    editToggleBtn.hidden = false;
    editErrorEl.hidden = true;
  }

  editToggleBtn.addEventListener("click", openEdit);
  document.getElementById("db-edit-cancel").addEventListener("click", closeEdit);

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    editErrorEl.hidden = true;

    var payload = {
      displayName: document.getElementById("db-input-name").value.trim(),
      discipline: document.getElementById("db-input-discipline").value.trim(),
      company: document.getElementById("db-input-company").value.trim(),
    };

    if (!payload.displayName) {
      editErrorEl.textContent = "Name can't be empty.";
      editErrorEl.hidden = false;
      return;
    }

    authFetch("/api/auth?action=update-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) {
          editErrorEl.textContent = result.data.error || "Couldn't save changes. Try again.";
          editErrorEl.hidden = false;
          return;
        }
        render(result.data.engineer);
        closeEdit();
      })
      .catch(function () {
        editErrorEl.textContent = "Couldn't reach the server. Check your connection and try again.";
        editErrorEl.hidden = false;
      });
  });
})();
