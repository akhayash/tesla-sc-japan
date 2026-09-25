/* Shows the current app version (newest entry of data/releases.json) in every [data-app-version] element. */
(() => {
  fetch('data/releases.json', { cache: 'no-cache' }).then((r) => r.json()).then(({ releases }) => {
    const v = releases?.[0]?.version;
    if (!v) return;
    document.querySelectorAll('[data-app-version]').forEach((el) => {
      el.textContent = `v${v}`;
      el.title = `リリースノート（v${v}：${releases[0].title}）`;
      el.hidden = false;
    });
  }).catch(() => {});
})();
