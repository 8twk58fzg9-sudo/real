// Computrax public runtime config.
// This file may be uploaded to GitHub Pages only with public/publishable values.
// Never paste service_role, SMTP, GoPay, iDoklad, provider private, or other secret keys here.
window.COMPUTRAX_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://aryjaqexfgalxaiseqtp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_x6sSWhw3on9bi_C1EQdTCg_nz09VWoX',
  SUPPORT_EMAIL: 'computerax.sk@gmail.com',
  EMAIL_ENDPOINT: 'https://aryjaqexfgalxaiseqtp.supabase.co/functions/v1/send-notification'
});

// Small compatibility layer shared by the storefront and admin on GitHub Pages.
const computraxEnhancements = document.createElement('script');
computraxEnhancements.src = 'site-enhancements.js?v=20260702e';
computraxEnhancements.async = false;
document.head.appendChild(computraxEnhancements);
