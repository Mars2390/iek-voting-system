// Applies a saved theme choice before first paint — loaded as the very
// first thing in <head>, before any CSS <link>, so the attribute this
// sets is already on <html> by the time styles are applied. Without
// this running synchronously and early, a returning dark-mode user
// would see a flash of the light theme on every page load.
(function () {
  var saved = localStorage.getItem("eh_theme");
  if (saved === "dark" || saved === "light") {
    document.documentElement.setAttribute("data-theme", saved);
  }
})();
