(function () {
  'use strict';

  if (window.__COMPUTRAX_ENHANCEMENTS__) return;
  window.__COMPUTRAX_ENHANCEMENTS__ = true;

  function addResponsiveStyles() {
    if (document.getElementById('ctrax-enhancement-styles')) return;
    const style = document.createElement('style');
    style.id = 'ctrax-enhancement-styles';
    style.textContent = [
      'html{scroll-padding-top:7rem}',
      '.mobile-filter-toggle{display:none;width:100%;min-height:46px;align-items:center;justify-content:space-between;gap:.75rem;margin-top:1rem;padding:.75rem .9rem;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.04);color:var(--text);font-weight:800;cursor:pointer}',
      '.mobile-filter-toggle .filter-toggle-icon{color:var(--accent);font-size:1.1rem;transition:transform .2s ease}',
      '.mobile-filter-toggle[aria-expanded="true"] .filter-toggle-icon{transform:rotate(180deg)}',
      '@media(max-width:1320px){html{scroll-padding-top:11.5rem}}',
      '@media(max-width:720px){html{scroll-padding-top:13.5rem}.mobile-filter-toggle{display:flex}.filter-details:not(.mobile-open){display:none}.filter-details.mobile-open{display:grid}}',
      '@media(prefers-reduced-motion:reduce){.mobile-filter-toggle .filter-toggle-icon{transition:none}}'
    ].join('');
    document.head.appendChild(style);
  }

  function enhanceProductCard(card) {
    if (!(card instanceof HTMLElement) || !card.matches('[data-product-card]')) return;
    card.setAttribute('role', 'article');
    card.setAttribute('tabindex', '0');
    const name = card.getAttribute('data-product-name') || 'Produkt';
    card.setAttribute('aria-label', name + '. Stlačením Enter otvoríte detail produktu.');
  }

  function associateFormLabels(root) {
    (root || document).querySelectorAll('.form-group, .filter-item, .auth-field').forEach(function (group) {
      const control = group.querySelector('input:not([type="hidden"]), select, textarea');
      const label = group.querySelector('label');
      const textLabel = group.querySelector('.form-label, .filter-label');
      if (!control) return;
      if (label && control.id) label.htmlFor = control.id;
      if (!label && !control.getAttribute('aria-label') && textLabel) {
        const text = String(textLabel.textContent || '').trim();
        if (text) control.setAttribute('aria-label', text);
      }
    });
  }

  function enhanceStorefront() {
    const catalog = document.getElementById('ponuka');
    const hero = document.querySelector('.hero');
    if (catalog && hero && hero.nextElementSibling !== catalog) {
      hero.after(catalog);
    }

    const details = document.getElementById('detailed-product-filters') ||
      document.querySelector('#ponuka .filter-details');
    let toggle = document.querySelector('#ponuka .mobile-filter-toggle');
    if (details && !details.id) details.id = 'detailed-product-filters';
    if (details && !toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mobile-filter-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', details.id);
      toggle.innerHTML = '<span>Podrobne filtre</span><span class="filter-toggle-icon" aria-hidden="true">&#8964;</span>';
      details.before(toggle);
      toggle.addEventListener('click', function () {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        details.classList.toggle('mobile-open', !expanded);
      });
    }

    document.querySelectorAll('[data-product-card]').forEach(enhanceProductCard);
    associateFormLabels(document);
    const grid = document.getElementById('products-grid');
    if (grid) {
      new MutationObserver(function (entries) {
        entries.forEach(function (entry) {
          entry.addedNodes.forEach(function (node) {
            if (!(node instanceof HTMLElement)) return;
            enhanceProductCard(node);
            node.querySelectorAll?.('[data-product-card]').forEach(enhanceProductCard);
          });
        });
      }).observe(grid, { childList: true, subtree: true });
    }

    if (catalog && location.hash === '#ponuka') {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          catalog.scrollIntoView({ block: 'start' });
        });
      });
    }
  }

  function adminImageReadyMessage() {
    if (!document.getElementById('img-status') || typeof setImageStatus !== 'function') return;
    if (typeof useLocalStorage !== 'undefined' && useLocalStorage) {
      setImageStatus('Lokálny režim: fotka zostane iba v tomto prehliadači. Pre verejný web použite Supabase režim.');
    } else if (typeof hasSupabaseWriteAuth === 'function' && !hasSupabaseWriteAuth()) {
      setImageStatus('Pred nahratím fotky pripojte hore „Supabase admin zápis“. Potom sa fotka bezpečne uloží do product-images a zobrazí sa všetkým návštevníkom.');
    } else {
      setImageStatus('Supabase admin je pripojený. Fotku môžete nahrať zo súboru.');
    }
  }

  async function secureProductImageUpload(file, productName) {
    if (typeof ensureSupabaseWriteAuth !== 'function' || !(await ensureSupabaseWriteAuth(false))) {
      throw new Error('Najprv pripojte Supabase admin zápis.');
    }
    const extension = PRODUCT_IMAGE_TYPES[file.type];
    if (!extension || file.size > PRODUCT_IMAGE_MAX_BYTES) {
      throw new Error('Povolené sú JPG, PNG alebo WebP súbory do 10 MB.');
    }
    const token = String(authSession?.access_token || '');
    if (!token) throw new Error('Supabase admin relácia chýba alebo vypršala.');
    const base = String(productName || 'produkt')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
      .toLowerCase().slice(0, 70) || 'produkt';
    const path = base + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + extension;
    const response = await fetchWithTimeout(
      SB_URL + '/storage/v1/object/product-images/' + encodeURIComponent(path),
      {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: 'Bearer ' + token,
          'Content-Type': file.type,
          'x-upsert': 'false'
        },
        body: file
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error('Storage ' + response.status + ': ' + text.slice(0, 400));
    }
    return SB_URL + '/storage/v1/object/public/product-images/' + encodeURIComponent(path);
  }

  function enhanceAdmin() {
    if (typeof saveProduct !== 'function' || window.__COMPUTRAX_IMAGE_SAVE_GUARD__) return;
    window.__COMPUTRAX_IMAGE_SAVE_GUARD__ = true;
    const originalSaveProduct = saveProduct;

    saveProduct = async function () {
      const file = typeof pendingImageFile !== 'undefined' ? pendingImageFile : null;
      const localMode = typeof useLocalStorage !== 'undefined' && useLocalStorage;
      if (file && !localMode) {
        const name = String(document.getElementById('f-name')?.value || '').trim();
        const price = Number(document.getElementById('f-price')?.value);
        if (name.length < 3 || !Number.isFinite(price) || price < 0) {
          return originalSaveProduct();
        }
        try {
          setImageStatus('Nahrávam fotku do Supabase Storage...');
          const imageUrl = await secureProductImageUpload(file, name);
          document.getElementById('f-image-url').value = imageUrl;
          pendingImageFile = null;
          setImageStatus('Fotka bola nahraná. Ukladám produkt...');
        } catch (error) {
          const message = typeof productImageUploadErrorMessage === 'function'
            ? productImageUploadErrorMessage(error)
            : String(error?.message || error);
          setImageStatus(message + ' Fotka aj údaje zostali zachované; skúste to znova.', true);
          if (typeof showToast === 'function') showToast('Fotku sa nepodarilo nahrať: ' + message, true);
          return;
        }
      }
      return originalSaveProduct();
    };

    document.addEventListener('click', function (event) {
      const action = event.target.closest?.('[data-admin-action]')?.dataset.adminAction;
      if (action === 'openModal' || action === 'openEdit') {
        setTimeout(adminImageReadyMessage, 80);
      }
    }, true);
  }

  addResponsiveStyles();
  function initializeEnhancements() {
    enhanceStorefront();
    enhanceAdmin();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEnhancements, { once: true });
  } else {
    initializeEnhancements();
  }
}());
