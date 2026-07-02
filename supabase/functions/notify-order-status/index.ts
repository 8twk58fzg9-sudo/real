import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MAX_BODY_BYTES = 2_048;
const allowedOrigins = new Set([
  "https://8twk58fzg9-sudo.github.io",
  "https://computrax.sk",
  "https://www.computrax.sk",
]);
const allowedFields = new Set(["order_id", "status"]);
const allowedStatuses = new Set(["confirmed", "packed", "sent", "done", "cancelled"]);

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
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

function json(origin: string, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
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

function publicApiKey(): string {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}") as Record<string, string>;
    return keys.default || "";
  } catch {
    return "";
  }
}

async function readPayload(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return null;
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

function cleanEmail(value: unknown): string {
  const email = String(value || "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) ? email : "";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] || char);
}

function statusCopy(status: string): { label: string; subject: string; message: string } {
  const copies: Record<string, { label: string; subject: string; message: string }> = {
    confirmed: {
      label: "Potvrdená",
      subject: "Vaša objednávka bola potvrdená",
      message: "Objednávku sme prijali a pripravujeme ju na spracovanie.",
    },
    packed: {
      label: "Zabalená",
      subject: "Vaša objednávka je zabalená",
      message: "Objednávka je pripravená na odovzdanie dopravcovi.",
    },
    sent: {
      label: "Odoslaná",
      subject: "Vaša objednávka bola odoslaná",
      message: "Objednávku sme odovzdali na doručenie. Informácie od dopravcu môžu prísť samostatne.",
    },
    done: {
      label: "Dokončená",
      subject: "Objednávka bola dokončená",
      message: "Objednávku evidujeme ako dokončenú. Ďakujeme za nákup.",
    },
    cancelled: {
      label: "Zrušená",
      subject: "Objednávka bola zrušená",
      message: "Objednávku evidujeme ako zrušenú. Ak je to neočakávané, kontaktujte nás.",
    },
  };
  return copies[status] ||
    { label: status, subject: "Zmena stavu objednávky", message: "Stav objednávky sa zmenil." };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !isAllowedOrigin(origin)) return json("", 403, { message: "Origin is not allowed" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (req.method !== "POST") return json(origin, 405, { message: "Method not allowed" });

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return json(origin, 401, { message: "Authentication required" });

  const payload = await readPayload(req);
  if (!payload || Object.keys(payload).some((key) => !allowedFields.has(key))) {
    return json(origin, 400, { message: "Invalid request" });
  }
  const orderId = Number(payload.order_id);
  const status = String(payload.status || "");
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !allowedStatuses.has(status)) {
    return json(origin, 400, { message: "Invalid order or status" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = publicApiKey();
  const secretKey = serverSecretKey();
  if (!supabaseUrl || !publishableKey || !secretKey) {
    return json(origin, 503, { message: "Service configuration is incomplete" });
  }

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return json(origin, 401, { message: "Invalid or expired session" });

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: adminMarker, error: adminError } = await admin
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (adminError || !adminMarker) return json(origin, 403, { message: "Admin access required" });

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id,order_number,customer_name,customer_email,total,status")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return json(origin, 503, { message: "Order lookup failed" });
  if (!order) return json(origin, 404, { message: "Order not found" });
  if (order.status !== status) return json(origin, 409, { message: "Order status changed again; refresh admin" });

  const recipient = cleanEmail(order.customer_email);
  if (!recipient) return json(origin, 422, { message: "Order has no valid customer email" });

  const { data: previous } = await admin
    .from("order_status_notifications")
    .select("id,delivery_status,updated_at")
    .eq("order_id", orderId)
    .eq("status", status)
    .maybeSingle();
  if (previous?.delivery_status === "sent") {
    return json(origin, 200, { ok: true, email_sent: true, already_sent: true });
  }
  if (previous?.delivery_status === "pending" &&
    Date.now() - new Date(previous.updated_at).getTime() < 120_000) {
    return json(origin, 409, { message: "Notification is already being processed" });
  }

  let notificationId = previous?.id;
  if (notificationId) {
    const { error } = await admin.from("order_status_notifications").update({
      delivery_status: "pending",
      error_code: null,
      requested_by: userData.user.id,
      updated_at: new Date().toISOString(),
    }).eq("id", notificationId);
    if (error) return json(origin, 503, { message: "Notification lock failed" });
  } else {
    const { data, error } = await admin.from("order_status_notifications").insert({
      order_id: orderId,
      status,
      delivery_status: "pending",
      requested_by: userData.user.id,
    }).select("id").single();
    if (error?.code === "23505") return json(origin, 409, { message: "Notification is already being processed" });
    if (error || !data) return json(origin, 503, { message: "Notification lock failed" });
    notificationId = data.id;
  }

  const resendKey = Deno.env.get("RESEND_API_KEY") || "";
  const fromEmail = Deno.env.get("NOTIFICATION_FROM_EMAIL") || "";
  const supportEmail = cleanEmail(Deno.env.get("NOTIFICATION_TO_EMAIL") || "computerax.sk@gmail.com");
  if (!resendKey || !fromEmail) {
    await admin.from("order_status_notifications").update({
      delivery_status: "failed",
      error_code: "email_not_configured",
      updated_at: new Date().toISOString(),
    }).eq("id", notificationId);
    return json(origin, 503, { message: "Email provider is not configured" });
  }

  const copy = statusCopy(status);
  const orderNumber = String(order.order_number || `#${order.id}`).slice(0, 80);
  const customerName = String(order.customer_name || "zákazník").trim().slice(0, 120);
  const total = Number(order.total || 0).toFixed(2).replace(".", ",");
  const providerResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [recipient],
      reply_to: supportEmail || undefined,
      subject: `Computrax: ${copy.subject} (${orderNumber})`,
      text: [
        `Dobrý deň ${customerName},`,
        "",
        copy.message,
        `Objednávka: ${orderNumber}`,
        `Stav: ${copy.label}`,
        `Celková suma: ${total} €`,
        "",
        supportEmail ? `Otázky: ${supportEmail}` : "",
        "Computrax",
      ].filter(Boolean).join("\n"),
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033">
        <h1 style="font-size:24px">Computrax</h1>
        <p>Dobrý deň ${escapeHtml(customerName)},</p>
        <p>${escapeHtml(copy.message)}</p>
        <div style="padding:16px;border:1px solid #dbe3ef;border-radius:8px">
          <p><strong>Objednávka:</strong> ${escapeHtml(orderNumber)}</p>
          <p><strong>Stav:</strong> ${escapeHtml(copy.label)}</p>
          <p><strong>Celková suma:</strong> ${escapeHtml(total)} €</p>
        </div>
        ${supportEmail ? `<p>Otázky: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>` : ""}
      </div>`,
    }),
  });

  const providerBody = await providerResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!providerResponse.ok) {
    await admin.from("order_status_notifications").update({
      delivery_status: "failed",
      error_code: `resend_${providerResponse.status}`,
      updated_at: new Date().toISOString(),
    }).eq("id", notificationId);
    console.error("order status email failed", { status: providerResponse.status });
    return json(origin, 502, { message: "Email provider rejected the message" });
  }

  await admin.from("order_status_notifications").update({
    delivery_status: "sent",
    provider_id: String(providerBody.id || "").slice(0, 160) || null,
    error_code: null,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", notificationId);

  return json(origin, 200, { ok: true, email_sent: true });
});
