// Runs before the first paint (a file, because the page's CSP forbids inline scripts). Applies the saved theme choice.
(function () {
  try {
    var saved = window.localStorage.getItem('ledger.theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  } catch {
    // storage can be blocked; the page then follows the system setting
  }
})();
