/* Apply the saved theme before the first paint. A classic script from this
   origin: the page's content policy allows script-src 'self' and blocks
   inline scripts. The value is the same key ThemeToggle writes. */
try {
  var theme = JSON.parse(localStorage.getItem('eagle-eye:theme'));
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
    var color = document.querySelector('meta[name="color-scheme"]');
    if (color) color.setAttribute('content', theme);
  }
} catch (e) {}
