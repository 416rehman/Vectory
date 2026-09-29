// Apply the saved or system theme before the first paint. Loaded as a blocking
// same-origin script because the Content-Security-Policy forbids inline scripts.
(function () {
  var theme = "light";
  try {
    var saved = window.localStorage.getItem("vectory-theme");
    theme =
      saved === "light" || saved === "dark"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  } catch (error) {
    try {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch (ignored) {
      theme = "light";
    }
  }
  var root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  var color = theme === "dark" ? "#1b1a1e" : "#f5f3ef";
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++)
    metas[i].setAttribute("content", color);
})();
