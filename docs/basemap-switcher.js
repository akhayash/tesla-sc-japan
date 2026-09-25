/* Google Maps-style basemap switcher placed on the map (bottom-left).
 * The main tile shows the alternate basemap (aerial ⇄ map) and switches with one click;
 * hovering (or the ▸ button on touch devices) reveals every basemap.
 */
(() => {
  'use strict';

  const THUMB = { z: 12, x: 3637, y: 1614 };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function init({ map, options, get, set }) {
    const thumb = (o) => o.tiles.replace('{z}', THUMB.z).replace('{x}', THUMB.x).replace('{y}', THUMB.y);
    const root = document.createElement('div');
    root.className = 'maplibregl-ctrl base-switcher';
    root.innerHTML = `
      <button type="button" class="bs-main" aria-label=""><img alt="" loading="lazy"><span></span></button>
      <button type="button" class="bs-more" aria-label="背景地図を選ぶ" aria-expanded="false" aria-controls="bs-panel">▸</button>
      <div class="bs-panel" id="bs-panel" role="radiogroup" aria-label="背景地図">
        ${options.map((o) => `<button type="button" role="radio" data-id="${esc(o.id)}" title="${esc(o.note || o.label)}">
          <img src="${esc(thumb(o))}" alt="" loading="lazy"><span>${esc(o.label)}</span></button>`).join('')}
      </div>`;
    const main = root.querySelector('.bs-main');
    const more = root.querySelector('.bs-more');
    const alt = () => (get() === 'photo' ? options.find((o) => o.id === 'pale') : options.find((o) => o.id === 'photo'));
    const open = (on) => { root.classList.toggle('open', on); more.setAttribute('aria-expanded', String(on)); };
    function sync() {
      const a = alt();
      main.querySelector('img').src = thumb(a);
      main.querySelector('span').textContent = a.short || a.label;
      main.setAttribute('aria-label', `背景を${a.label}に切り替え`);
      root.querySelectorAll('.bs-panel button').forEach((b) => {
        const on = b.dataset.id === get();
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });
    }
    function choose(id) {
      set(id);
      sync();
    }
    main.addEventListener('click', () => choose(alt().id));
    more.addEventListener('click', () => open(!root.classList.contains('open')));
    root.querySelector('.bs-panel').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      choose(b.dataset.id);
      open(false);
    });
    root.addEventListener('mouseenter', (e) => { if (matchMedia('(hover: hover)').matches) open(true); });
    root.addEventListener('mouseleave', () => open(false));
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) open(false); });
    ['mousedown', 'touchstart', 'wheel', 'dblclick'].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));
    // On narrow screens the full-width attribution covers the bottom-left corner, so sit under the zoom buttons instead.
    const right = matchMedia('(max-width: 760px)').matches;
    root.classList.toggle('bs-right', right);
    if (right) more.textContent = '◂';
    map.addControl({ onAdd: () => root, onRemove: () => root.remove() }, right ? 'top-right' : 'bottom-left');
    sync();
    return { sync };
  }

  window.BaseSwitcher = { init };
})();
