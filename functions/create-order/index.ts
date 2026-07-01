import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MAX_BODY_BYTES = 32_768;
const allowedOrigins = new Set([
  "https://8twk58fzg9-sudo.github.io",
  "https://computrax.sk",
  "https://www.computrax.sk",
]);
const allowedPayloadFields = new Set([
  "order_number", "client_order_key", "customer_name", "customer_email", "customer_phone",
  "address", "delivery_key", "delivery", "items", "service_ids", "total", "note",
  "terms_accepted", "terms_accepted_at", "payment_method", "payment_status",
  "payment_reference", "payment_url", "reservation_expires_at",
  "warehouse_sync_status", "warehouse_reference",
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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

function safeDatabaseError(message: string): { status: number; message: string } {
  const text = message.toLowerCase();
  if (text.includes("rate limit") || text.includes("too many recent orders")) {
    return { status: 429, message: "rate limit exceeded" };
  }
  if (text.includes("not enough stock")) return { status: 409, message: "Not enough stock" };
  if (text.includes("product not found") || text.includes("product is not available")) {
    return { status: 409, message: "Product is not available" };
  }
  if (text.includes("duplicate order number")) return { status: 409, message: "Duplicate order number" };
  if (text.includes("invalid customer email")) return { status: 400, message: "Invalid customer email" };
  if (text.includes("invalid customer phone")) return { status: 400, message: "Invalid customer phone" };
  if (text.includes("invalid delivery") || text.includes("delivery address")) {
    return { status: 400, message: "Invalid delivery address" };
  }
  if (text.includes("service selection")) return { status: 400, message: "Invalid service selection" };
  if (text.includes("purchase item")) return { status: 400, message: "Invalid purchase item" };
  if (text.includes("terms")) return { status: 400, message: "Terms must be accepted" };
  if (text.includes("invalid order") || text.includes("unexpected order field")) {
    return { status: 400, message: "Invalid order metadata" };
  }
  return { status: 503, message: "Order service is temporarily unavailable" };
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
    return json(origin, 415, { message: "Invalid order request" });
  }
  if (contentLength > MAX_BODY_BYTES) return json(origin, 413, { message: "Order request is too large" });

  const parsedBody = await readJsonObject(req, MAX_BODY_BYTES);
  if (parsedBody.error === "too_large") return json(origin, 413, { message: "Order request is too large" });
  if (!parsedBody.value) return json(origin, 400, { message: "Invalid order request" });
  const body = parsedBody.value;

  if (Object.keys(body).length !== 1 || !("order_payload" in body)) {
    return json(origin, 400, { message: "Invalid order request" });
  }
  const payload = body.order_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json(origin, 400, { message: "Invalid order payload" });
  }
  const orderPayload = payload as Record<string, unknown>;
  if (Object.keys(orderPayload).some((key) => !allowedPayloadFields.has(key))) {
    return json(origin, 400, { message: "Unexpected order field" });
  }
  if (
    typeof orderPayload.order_number !== "string" ||
    typeof orderPayload.client_order_key !== "string" ||
    typeof orderPayload.customer_email !== "string" ||
    typeof orderPayload.customer_name !== "string" ||
    typeof orderPayload.delivery_key !== "string" ||
    !Array.isArray(orderPayload.items) || orderPayload.items.length < 1 || orderPayload.items.length > 20 ||
    !Array.isArray(orderPayload.service_ids) || orderPayload.service_ids.length > 10 ||
    typeof orderPayload.total !== "number" || !Number.isFinite(orderPayload.total)
  ) {
    return json(origin, 400, { message: "Invalid order payload" });
  }

  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  const requestKey = await sha256(forwarded.slice(0, 128));
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secretKey = serverSecretKey();
  if (!supabaseUrl || !secretKey) {
    return json(origin, 503, { message: "Order service is temporarily unavailable" });
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error: limitError } = await admin.rpc("enforce_rate_limit", {
    p_key: `order:ip:${requestKey}`,
    p_max_hits: 8,
    p_window_seconds: 600,
  });
  if (limitError) {
    const rateLimited = /rate limit/i.test(limitError.message || "");
    if (rateLimited) {
      return json(origin, 429, { message: "rate limit exceeded" }, { "Retry-After": "600" });
    }
    console.error("create-order rate limit error", { code: limitError.code });
    return json(origin, 503, { message: "Order service is temporarily unavailable" });
  }

  const { data, error } = await admin.rpc("create_order_and_purchase", { order_payload: orderPayload });
  if (error) {
    const safe = safeDatabaseError(error.message || "");
    if (safe.status >= 500) console.error("create-order database error", { code: error.code });
    return json(
      origin,
      safe.status,
      { message: safe.message },
      safe.status === 429 ? { "Retry-After": "600" } : {},
    );
  }
  return json(origin, 200, data);
});
