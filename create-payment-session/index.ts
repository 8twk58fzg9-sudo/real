import { createClient } from "npm:@supabase/supabase-js@2.95.0";

type PaymentProvider = "gopay" | "stripe";

const MAX_BODY_BYTES = 4_096;
const allowedOrigins = new Set([
  "https://8twk58fzg9-sudo.github.io",
  "https://computrax.sk",
  "https://www.computrax.sk",
]);
const allowedFields = new Set([
  "provider", "order_number", "order_id", "amount", "total", "currency",
  "customer_email", "success_url", "cancel_url", "return_url",
]);

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function responseHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function json(origin: string, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...responseHeaders(origin), ...extra } });
}

function serverSecretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
    return keys.default || "";
  } catch {
    return "";
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonObject(
  req: Request,
  maxBytes: number,
): Promise<{ value?: Record<string, unknown>; error?: "invalid" | "too_large" }> {
  const reader = req.body?.getReader();
  if (!reader) return { error: "invalid" };
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { error: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "invalid" };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "invalid" };
  }
}

function safeReturnUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value);
    return isAllowedOrigin(parsed.origin) && !parsed.username && !parsed.password ? parsed.href : "";
  } catch {
    return "";
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !isAllowedOrigin(origin)) return json("", 403, { message: "Origin is not allowed" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (req.method !== "POST") {
    return json(origin, 405, { message: "Method not allowed" }, { Allow: "POST, OPTIONS" });
  }

  const contentType = req.headers.get("content-type") || "";
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json(origin, 415, { message: "Invalid payment request" });
  }
  if (contentLength > MAX_BODY_BYTES) return json(origin, 413, { message: "Payment request is too large" });

  const parsedBody = await readJsonObject(req, MAX_BODY_BYTES);
  if (parsedBody.error === "too_large") {
    return json(origin, 413, { message: "Payment request is too large" });
  }
  if (!parsedBody.value) return json(origin, 400, { message: "Invalid payment request" });
  const body = parsedBody.value;
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return json(origin, 400, { message: "Unexpected payment field" });
  }

  const provider: PaymentProvider = body.provider === "stripe" ? "stripe" : "gopay";
  const orderNumber = typeof body.order_number === "string" ? body.order_number.trim().toUpperCase() : "";
  const customerEmail = typeof body.customer_email === "string" ? body.customer_email.trim().toLowerCase() : "";
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "EUR";
  if (
    !/^CTX-[0-9]{8}-[A-Z0-9]{5}$/.test(orderNumber) ||
    customerEmail.length < 5 || customerEmail.length > 254 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail) ||
    currency !== "EUR"
  ) {
    return json(origin, 400, { message: "Invalid payment request" });
  }

  const returnUrl = safeReturnUrl(body.return_url || body.success_url);
  const cancelUrl = safeReturnUrl(body.cancel_url);
  if ((body.return_url || body.success_url) && !returnUrl) {
    return json(origin, 400, { message: "Invalid payment return URL" });
  }
  if (body.cancel_url && !cancelUrl) {
    return json(origin, 400, { message: "Invalid payment cancel URL" });
  }

  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  const requestKey = await sha256(forwarded.slice(0, 128));
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secretKey = serverSecretKey();
  if (!supabaseUrl || !secretKey) {
    return json(origin, 503, { message: "Payment service is temporarily unavailable" });
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error: limitError } = await admin.rpc("enforce_rate_limit", {
    p_key: `payment:ip:${requestKey}`,
    p_max_hits: 10,
    p_window_seconds: 600,
  });
  if (limitError) {
    if (/rate limit/i.test(limitError.message || "")) {
      return json(origin, 429, { message: "rate limit exceeded" }, { "Retry-After": "600" });
    }
    console.error("payment rate limit error", { code: limitError.code });
    return json(origin, 503, { message: "Payment service is temporarily unavailable" });
  }

  const { data: orderRows, error: orderError } = await admin.rpc("get_payment_order", {
    p_order_number: orderNumber,
    p_email: customerEmail,
  });
  if (orderError) {
    console.error("payment order lookup error", { code: orderError.code });
    return json(origin, 503, { message: "Payment service is temporarily unavailable" });
  }
  const order = Array.isArray(orderRows) ? orderRows[0] : orderRows;
  if (!order) return json(origin, 404, { message: "Order was not found" });
  if (order.payment_status === "paid") return json(origin, 409, { message: "Order is already paid" });
  if (order.payment_method && ![provider, "manual"].includes(order.payment_method)) {
    return json(origin, 409, { message: "Payment method does not match the order" });
  }

  const amount = Number(order.total);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    return json(origin, 409, { message: "Order total is invalid" });
  }

  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
  const gopayClientId = Deno.env.get("GOPAY_CLIENT_ID");
  const gopayClientSecret = Deno.env.get("GOPAY_CLIENT_SECRET");
  if (provider === "stripe" && !stripeSecret) {
    return json(origin, 503, { configured: false, provider, message: "Stripe is not configured" });
  }
  if (provider === "gopay" && (!gopayClientId || !gopayClientSecret)) {
    return json(origin, 503, { configured: false, provider, message: "GoPay is not configured" });
  }

  // Provider calls stay disabled until the real merchant account and webhook
  // signature verification are configured. The trusted order data above is the
  // only source that a future provider implementation may use.
  return json(origin, 501, {
    configured: false,
    provider,
    order_number: order.order_number,
    amount,
    currency: "EUR",
    return_url: returnUrl,
    cancel_url: cancelUrl,
    message: "Payment provider mapping is not active yet",
  });
});
