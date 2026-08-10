// Shared app-shell footer, injected into every logged-in page so it
// can't drift across hand-copies of the same markup — same rationale as
// app-nav.js. Usage: <div id="app-footer"></div><script src="app-footer.js"></script>
(function () {
  "use strict";
  var mount = document.getElementById("app-footer");
  if (!mount) return;

  mount.innerHTML =
    '<footer class="app-footer">' +
    '<div class="app-footer-row">' +
    '<span class="app-footer-copy">&copy; ' + new Date().getFullYear() + " Engineer Hub</span>" +
    '<nav class="app-footer-links">' +
    '<a href="/privacy.html">Privacy Policy</a>' +
    '<a href="/terms.html">Terms of Use</a>' +
    '<a href="mailto:albertmomanyi07@gmail.com">Contact</a>' +
    "</nav>" +
    "</div>" +
    "</footer>";
})();
