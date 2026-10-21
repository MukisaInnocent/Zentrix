// Loaded as a classic blocking script in <head> so the saved theme applies before first paint.
(function () {
  try {
    var t = localStorage.getItem('zx-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage blocked */
  }
})();
