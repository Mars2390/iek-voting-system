// Applies a saved theme choice before first paint — loaded as the very
// first thing in <head>, before any CSS <link>, so the attribute this
// sets is already on <html> by the time styles are applied. Without
// this running synchronously and early, a returning dark-mode user
// would see a flash of the light theme on every page load.
(function () {
  // localStorage can throw (not just return null) in real mobile
  // contexts — Safari Private Browsing, and critically, WhatsApp/
  // Facebook/Instagram in-app browser webviews, which is exactly how a
  // link to this app spreads in practice. An uncaught throw here would
  // do nothing worse than skip the theme (harmless), but every other
  // file touching localStorage directly needs the same guard, because
  // an uncaught throw THERE stops that whole script's initialization —
  // confirmed empirically: login.js's own unguarded read of a saved
  // session token, at the top of the file before its submit handler is
  // even registered, was silently killing the entire login flow.
  try {
    var saved = localStorage.getItem("eh_theme");
    if (saved === "dark" || saved === "light") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {}
})();
