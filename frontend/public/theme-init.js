// Applies the saved appearance before the first paint so dark mode never flashes light.
// Mirrors src/theme/appearance.ts (key, default and theme colors); appearance.test.ts keeps them in step.
(function () {
  var key = 'collaboratory:appearance';
  var colors = { light: '#211006', dark: '#120d0a' };
  var appearance = 'system';
  try {
    var stored = localStorage.getItem(key);
    if (stored === 'light' || stored === 'dark' || stored === 'system') appearance = stored;
  } catch (e) {}
  var dark = appearance === 'dark' ||
    (appearance === 'system' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  var theme = dark ? 'dark' : 'light';
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colors[theme]);
})();
