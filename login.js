// Login overlay for the dashboard. Loaded (publicly) by index.html; index.html
// calls window.showLogin() when the API answers 401. Styling reuses the
// dashboard's theme variables so it follows light / dark / system automatically.
(function () {
  var CSS = [
    '#lg-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;',
    '  background: var(--bg); color: var(--ink); border-top: 3px solid var(--gold);',
    '  font-family: "Montserrat", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.5; }',
    '#lg-overlay * { box-sizing: border-box; }',
    '#lg-overlay .lg-card { background: var(--card); border: 1px solid var(--hairline); box-shadow: var(--shadow);',
    '  padding: 40px 36px; width: 100%; max-width: 360px; margin: 0 16px; }',
    '#lg-overlay .lg-eyebrow { font-size: 10px; letter-spacing: .32em; text-transform: uppercase; color: var(--gold); font-weight: 600; margin-bottom: 8px; }',
    '#lg-overlay h1 { font-size: 18px; font-weight: 600; letter-spacing: .08em; margin: 0 0 26px; }',
    '#lg-overlay label { display: block; font-size: 9px; letter-spacing: .24em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; font-weight: 600; }',
    '#lg-overlay .lg-field { margin-bottom: 20px; }',
    '#lg-overlay input { width: 100%; padding: 10px 0; border: none; border-bottom: 1px solid var(--control-line); background: transparent;',
    '  font-family: inherit; font-size: 14px; color: var(--ink); outline: none; border-radius: 0; transition: border-color .25s ease; }',
    '#lg-overlay input:focus { border-bottom-color: var(--gold); }',
    '#lg-overlay button { width: 100%; margin-top: 8px; padding: 12px; border: 1px solid var(--ink); background: var(--ink); color: var(--bg);',
    '  font-family: inherit; font-size: 11px; font-weight: 600; letter-spacing: .2em; text-transform: uppercase; cursor: pointer; transition: opacity .2s ease; }',
    '#lg-overlay button:disabled { opacity: .5; cursor: wait; }',
    '#lg-overlay .lg-error { color: #C0392B; font-size: 12px; margin-top: 14px; display: none; }'
  ].join('\n');

  var HTML =
    '<form class="lg-card" id="lg-form">' +
      '<div class="lg-eyebrow">K Estates</div>' +
      '<h1>Sign in to Property Inventory</h1>' +
      '<div class="lg-field"><label for="lg-username">Username</label>' +
        '<input type="text" id="lg-username" name="username" autocomplete="username" required></div>' +
      '<div class="lg-field"><label for="lg-password">Password</label>' +
        '<input type="password" id="lg-password" name="password" autocomplete="current-password" required></div>' +
      '<button type="submit" id="lg-submit">Sign in</button>' +
      '<div class="lg-error" id="lg-error"></div>' +
    '</form>';

  function showLogin() {
    if (document.getElementById('lg-overlay')) return;

    var style = document.createElement('style');
    style.id = 'lg-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = 'lg-overlay';
    overlay.innerHTML = HTML;
    document.body.appendChild(overlay);

    var form = overlay.querySelector('#lg-form');
    var btn = overlay.querySelector('#lg-submit');
    var errorEl = overlay.querySelector('#lg-error');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      errorEl.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      try {
        var res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: overlay.querySelector('#lg-username').value,
            password: overlay.querySelector('#lg-password').value,
          }),
        });
        var payload = await res.json();
        if (!res.ok) throw new Error(payload.error || 'Sign in failed');
        window.location.reload();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });

    overlay.querySelector('#lg-username').focus();
  }

  window.showLogin = showLogin;
})();
