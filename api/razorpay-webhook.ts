import type { VercelRequest, VercelResponse } from "vercel";
import crypto from "crypto";

// IMPORTANT: We need the RAW body for signature verification.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.MAIL_FROM; // e.g. "Payments <payments@yourdomain.com>"
  const fallbackTo = process.env.FALLBACK_TO_EMAIL; // optional for debugging

  if (!webhookSecret || !resendApiKey || !fromEmail) {
    return res.status(500).send("Missing env vars");
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-razorpay-signature"] as string | undefined;

  const ok = verifyRazorpaySignature(rawBody, signature, webhookSecret);
  if (!ok) return res.status(401).send("Invalid signature");

  const event = JSON.parse(rawBody.toString("utf8"));

  // ✅ Choose one event that represents success in your flow.
  // Common: "payment.captured" OR "order.paid"
  if (event.event === "payment.captured") {
    const payment = event?.payload?.payment?.entity;

    // You only get email here if you collected it during checkout.
    const toEmail =
      payment?.email ||
      payment?.notes?.email ||
      fallbackTo; // fallback for testing

    if (!toEmail) {
      // Still return 200 so Razorpay doesn't retry forever
      return res.status(200).json({ ok: true, note: "No email found in payment payload" });
    }

    const amountInRupees = (payment.amount ?? 0) / 100;
    const paymentId = payment.id;

    // Send email via Resend
    const emailResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: "Payment successful ✅",
        html: `
          <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
            <h2 style="margin:0 0 8px">Payment successful ✅</h2>
            <p style="margin:0 0 8px">We received your payment of <b>₹${amountInRupees}</b>.</p>
            <p style="margin:0 0 8px">Payment ID: <b>${paymentId}</b></p>
            <p style="margin:16px 0 0;color:#666;font-size:12px">If you have questions, reply to this email.</p>
          </div>
        `,
      }),
    });

    if (!emailResp.ok) {
      const err = await emailResp.text();
      // Return 200 to avoid Razorpay retry spam, but log error for you in Vercel
      console.error("Resend error:", err);
      return res.status(200).json({ ok: false, resend_error: err });
    }

    return res.status(200).json({ ok: true });
  }

  // For all other events, just ack
  return res.status(200).json({ ok: true, ignored: event.event });
}
