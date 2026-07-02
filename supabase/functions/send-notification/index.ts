import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MAX_BODY_BYTES = 16_384;
const allowedOrigins = new Set([
  "https://8twk58fzg9-sudo.github.io",
  "https://computrax.sk",
  "https://www.computrax.sk",
]);
const allowedFields = new Set(["to_email", "from_name", "from_email", "phone", "message"]);

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function headers(origin: string): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin)) {
    result["Access-Control-Allow-Origin"] = origin;
    result["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    result["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    result["Access-Control-Max-Age"] = "600";
  }
  return result;
}

function json(origin: string, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers(origin), ...extra } });
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

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (!text || new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function clean(value: unknown, max: number): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanMessage(value: unknown): string {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 4000);
}

function inquiryKind(message: string): "contact" | "b2b" | "order" {
  if (message.startsWith("--- DOPYT PRE ŠKOLU / FIRMU ---")) return "b2b";
  if (message.startsWith("--- NOVÁ OBJEDNÁVKA ---")) return "order";
  return "contact";
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !isAllowedOrigin(origin)) return json("", 403, { message: "Origin is not allowed" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return json(origin, 405, { message: "Method not allowed" }, { Allow: "POST, OPTIONS" });
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return json(origin, 415, { message: "Invalid request" });
  }

  const body = await readJson(req);
  if (!body || Object.keys(body).some((key) => !allowedFields.has(key))) {
    return json(origin, 400, { message: "Invalid request" });
  }
  const name = clean(body.from_name, 120);
  const email = clean(body.from_email, 254).toLowerCase();
  const phone = clean(body.phone, 32);
  const message = cleanMessage(body.message);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 5) {
    return json(origin, 400, { message: "Invalid contact details" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secretKey = serverSecretKey();
  if (!supabaseUrl || !secretKey) return json(origin, 503, { message: "Contact service is unavailable" });
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  const ipKey = await sha256(forwarded.slice(0, 128));
  const emailKey = await sha256(email);
  for (const [key, maxHits] of [[`inquiry:ip:${ipKey}`, 8], [`inquiry:email:${emailKey}`, 4]] as const) {
    const { error } = await admin.rpc("enforce_rate_limit", {
      p_key: key,
      p_max_hits: maxHits,
      p_window_seconds: 600,
    });
    if (error) {
      if (/rate limit/i.test(error.message || "")) {
        return json(origin, 429, { message: "rate limit exceeded" }, { "Retry-After": "600" });
      }
      console.error("inquiry rate limit error", { code: error.code });
      return json(origin, 503, { message: "Contact service is unavailable" });
    }
  }

  const kind = inquiryKind(message);
  const resendKey = Deno.env.get("RESEND_API_KEY") || "";
  const fromEmail = Deno.env.get("NOTIFICATION_FROM_EMAIL") || "";
  const recipient = Deno.env.get("NOTIFICATION_TO_EMAIL") || "computerax.sk@gmail.com";
  let emailStatus: "not_configured" | "sent" | "failed" = "not_configured";

  if (resendKey && fromEmail) {
    try {
      const subject = kind === "b2b" ? `Computrax: B2B dopyt od ${name}` :
        kind === "order" ? `Computrax: objednávka od ${name}` :
        `Computrax: kontaktný formulár od ${name}`;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [recipient],
          reply_to: email,
          subject,
          text: `${message}\n\nKontakt: ${name}\nE-mail: ${email}\nTelefón: ${phone || "neuvedený"}`,
        }),
      });
      emailStatus = response.ok ? "sent" : "failed";
      if (!response.ok) console.error("notification provider error", { status: response.status });
    } catch {
      emailStatus = "failed";
    }
  }

  const { error: insertError } = await admin.from("inquiries").insert({
    kind,
    customer_name: name,
    customer_email: email,
    customer_phone: phone || null,
    message,
    email_delivery_status: emailStatus,
  });
  if (insertError) {
    console.error("inquiry insert error", { code: insertError.code });
    return json(origin, 503, { message: "Contact service is unavailable" });
  }

  return json(origin, emailStatus === "sent" ? 200 : 202, {
    ok: true,
    stored: true,
    email_sent: emailStatus === "sent",
  });
});
