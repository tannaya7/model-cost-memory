// Sets the theme before the first paint, so a dark-mode visitor never sees a light flash.
// Light unless this browser chose dark. A separate file because the CSP allows only same-origin scripts.
(function () {
  var theme = "light";
  try {
    if (localStorage.getItem("mcm_theme") === "dark") theme = "dark";
  } catch (e) {
    /* storage blocked: stay light */
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
