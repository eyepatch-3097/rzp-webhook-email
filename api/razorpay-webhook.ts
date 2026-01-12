import type { VercelRequest, VercelResponse } from "vercel";
import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false, // required for signature verification
  },
};

// --- Product links ---
const BLUEPRINT_LINK =
  "https://drive.google.com/drive/folders/1S8n0feXCtWhDDufW-toGcgO3n-2LDvGm";
const COMPLETE_KIT_LINK =
  "https://drive.google.com/drive/folders/1ktVOK--idZkGvE8ko20uRbgD_Xj7-Zqq";

// --- Price points (in paise) ---
const PRICE_BLUEPRINT_PAISE = 14900;
const PRICE_COMPLETE_PAISE = 24900;

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyRazorpaySignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

async function sendEmailViaResend(opts: {
  resendApiKey: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  html: string;
}) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.fromEmail,
      to: [opts.toEmail],
      subject: opts.subject,
      html: opts.html,
    }),
  });

  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

function buildEmailContent(params: {
  amountPaise: number;
  currency: string;
  paymentId: string;
  reference: string;
}) {
  const { amountPaise, currency, paymentId, reference } = params;
  const amountRupees = (amountPaise ?? 0) / 100;

  const isBlueprint = amountPaise === PRICE_BLUEPRINT_PAISE;
  const isComplete = amountPaise === PRICE_COMPLETE_PAISE;

  let kitTitle = "Tactical BA Playbook";
  let linksHtml = "";

  if (isBlueprint) {
    kitTitle = "Tactical BA Blueprint";
    linksHtml = `
      <ul style="margin:10px 0 0; padding-left:18px">
        <li>
          <b>Tactical BA Blueprint</b>:
          <a href="${BLUEPRINT_LINK}" target="_blank" rel="noopener noreferrer">Open folder</a>
        </li>
      </ul>
    `;
  } else if (isComplete) {
    kitTitle = "Tactical BA Complete Package";
    linksHtml = `
      <ul style="margin:10px 0 0; padding-left:18px">
        <li>
          <b>Tactical BA Blueprint</b>:
          <a href="${BLUEPRINT_LINK}" target="_blank" rel="noopener noreferrer">Open folder</a>
        </li>
        <li style="margin-top:6px">
          <b>Tactical BA Complete Kit</b>:
          <a href="${COMPLETE_KIT_LINK}" target="_blank" rel="noopener noreferrer">Open folder</a>
        </li>
      </ul>
    `;
  } else {
    // Fallback (if new price point comes later)
    kitTitle = "Tactical BA Purchase";
    linksHtml = `
      <p style="margin:10px 0 0">
        Thanks for your purchase. Your payment was received, but this amount doesn’t match ₹149 or ₹249.
        Reply to this email with your Payment ID and we’ll help you immediately.
      </p>
    `;
  }

  const subject = `Your ${kitTitle} access links ✅`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 10px">Payment confirmed ✅</h2>

      <p style="margin:0 0 10px">
        Thanks for your purchase! Your payment of <b>${currency} ${amountRupees}</b> was successful.
      </p>

      <div style="border:1px solid #eee; border-radius:10px; padding:12px; margin:12px 0">
        <div style="font-weight:600; margin-bottom:6px">Your access links</div>
        ${linksHtml}
      </div>

      <p style="margin:10px 0 0; color:#444">
        <b>Reference:</b> ${reference}<br/>
        <b>Payment ID:</b> ${paymentId}
      </p>

      <p style="margin:14px 0 0; color:#666; font-size:12px">
        If you face any access issues, reply to this email with your Payment ID.
      </p>
    </div>
  `;

  return { subject, html };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.MAIL_FROM;
  const fallbackTo = process.env.FALLBACK_TO_EMAIL; // optional (testing)

  if (!webhookSecret || !resendApiKey || !fromEmail) {
    console.error("Missing env vars", {
      hasWebhookSecret: !!webhookSecret,
      hasResendApiKey: !!resendApiKey,
      hasFromEmail: !!fromEmail,
    });
    return res.status(500).send("Missing env vars");
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-razorpay-signature"] as string | undefined;

  if (!verifyRazorpaySignature(rawBody, signature, webhookSecret)) {
    console.warn("Invalid Razorpay signature");
    return res.status(401).send("Invalid signature");
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    console.error("Invalid JSON body");
    return res.status(400).send("Invalid JSON");
  }

  const ev = event?.event as string | undefined;
  console.log("Webhook event:", ev);

  // Only act on success events
  if (ev === "payment.captured" || ev === "payment_link.paid") {
    const payment = event?.payload?.payment?.entity;
    const paymentLink = event?.payload?.payment_link?.entity;

    // Email locations vary by flow; fallbackTo is optional for testing.
    const toEmail =
      payment?.email ||
      payment?.notes?.email ||
      paymentLink?.customer?.email ||
      fallbackTo;

    const amountPaise: number =
      payment?.amount ?? paymentLink?.amount ?? 0;

    const currency: string =
      payment?.currency ?? paymentLink?.currency ?? "INR";

    const paymentId: string = payment?.id ?? "NA";

    const reference: string =
      paymentLink?.reference_id ??
      paymentLink?.id ??
      payment?.order_id ??
      "NA";

    console.log("Resolved email:", toEmail);
    console.log("Amount (paise):", amountPaise, "Currency:", currency);
    console.log("Payment ID:", paymentId, "Reference:", reference);

    if (!toEmail) {
      console.log("No buyer email found in payload; skipping email send.");
      return res.status(200).json({ ok: true, note: "No email found in payload" });
    }

    const { subject, html } = buildEmailContent({
      amountPaise,
      currency,
      paymentId,
      reference,
    });

    const emailResp = await sendEmailViaResend({
      resendApiKey,
      fromEmail,
      toEmail,
      subject,
      html,
    });

    console.log("Resend response:", emailResp.status, emailResp.text);

    if (!emailResp.ok) {
      // Return 200 to avoid Razorpay retry spam; use logs to diagnose.
      return res.status(200).json({ ok: false, resend_error: emailResp.text });
    }

    return res.status(200).json({ ok: true });
  }

  // Ignore everything else, but ACK
  return res.status(200).json({ ok: true, ignored: ev });
}
