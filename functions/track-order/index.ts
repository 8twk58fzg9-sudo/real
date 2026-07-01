import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MAX_BODY_BYTES = 2_048;
const allowedOrigins = new Set([
  "https://8twk58fzg9-sudo.github.io",
  "https://computrax.sk",
  "https://www.computrax.sk",
]);

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function responseHeaders(origin: string): HeadersInit {
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

function json(origin: string, status: number, body: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders(origin), ...extra },
  });
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

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !isAllowedOrigin(origin)) {
    return json("", 403, { message: "Origin is not allowed." });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(origin, 405, { message: "Method not allowed." }, { Allow: "POST, OPTIONS" });
  }

  const contentType = req.headers.get("content-type") || "";
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json(origin, 415, { message: "Invalid request." });
  }
  if (contentLength > MAX_BODY_BYTES) return json(origin, 413, { message: "Request is too large." });

  const parsedBody = await readJsonObject(req, MAX_BODY_BYTES);
  if (parsedBody.error === "too_large") return json(origin, 413, { message: "Request is too large." });
  if (!parsedBody.value) return json(origin, 400, { message: "Invalid request." });
  const body = parsedBody.value;

  const allowedFields = new Set(["order_number", "email"]);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return json(origin, 400, { message: "Invalid request." });
  }

  const orderNumber = typeof body.order_number === "string" ? body.order_number.trim().toUpperCase() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (
    !/^CTX-[0-9]{8}-[A-Z0-9]{5}$/.test(orderNumber) ||
    email.length < 5 || email.length > 254 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  ) {
    return json(origin, 400, { message: "Skontrolujte číslo objednávky a e-mail." });
  }

  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  const requestKey = await sha256(forwarded.slice(0, 128));
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secretKey = serverSecretKey();
  if (!supabaseUrl || !secretKey) {
    return json(origin, 503, { message: "Sledovanie je dočasne nedostupné." });
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await admin.rpc("track_customer_order", {
    p_order_number: orderNumber,
    p_email: email,
    p_request_key: requestKey,
  });

  if (error) {
    const rateLimited = /rate limit/i.test(error.message || "");
    if (rateLimited) {
      return json(
        origin,
        429,
        { message: "Príliš veľa pokusov. Skúste to neskôr." },
        { "Retry-After": "60" },
      );
    }
    console.error("track-order database error", { code: error.code });
    return json(origin, 503, { message: "Sledovanie je dočasne nedostupné." });
  }

  const order = Array.isArray(data) ? data[0] : data;
  if (!order) return json(origin, 404, { message: "Objednávka sa nenašla." });
  return json(origin, 200, order);
});
