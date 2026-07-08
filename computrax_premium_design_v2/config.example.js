// Copy this file to config.js during deployment.
// Do not put service_role, secret, GoPay, iDoklad, SMTP, or other private keys here.
// Browser config may contain only public/publishable values.
window.COMPUTRAX_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  // Supabase anon/publishable key only. Never use service_role in frontend.
  SUPABASE_ANON_KEY: 'PASTE_PUBLIC_SUPABASE_ANON_KEY_HERE',
  SUPPORT_EMAIL: 'computerax.sk@gmail.com',

  // Optional server-side notification endpoint, e.g. Supabase Edge Function.
  // Store SMTP/provider/API secrets in that function's environment variables.
  EMAIL_ENDPOINT: ''
});
