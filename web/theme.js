// Apply the theme before styles load to avoid a bright flash on dark pages.
(() => {
  const key = 'together-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { preference = localStorage.getItem(key); } catch { /* Browser storage may be unavailable. */ }
  const valid = value => value === 'dark' || value === 'light';

  function sync() {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.querySelectorAll('[data-command="toggle-theme"]').forEach(button => {
      const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(dark));
      button.title = label;
      button.querySelectorAll('[data-theme-icon]').forEach(icon => {
        icon.hidden = icon.dataset.themeIcon !== (dark ? 'sun' : 'moon');
      });
      const text = button.querySelector('.theme-label');
      if (text) text.textContent = dark ? 'Light mode' : 'Dark mode';
    });
  }

  function apply() {
    const theme = valid(preference) ? preference : system.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#212121' : '#7561c7');
    sync();
  }

  window.togetherTheme = {
    sync,
    toggle() {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Keep the selection for this page. */ }
      apply();
    },
  };
  system.addEventListener('change', () => { if (!valid(preference)) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = event.newValue; apply(); }
  });
  document.addEventListener('DOMContentLoaded', sync);
  apply();
})();
