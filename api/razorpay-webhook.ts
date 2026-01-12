import type { VercelRequest, VercelResponse } from "vercel";
import crypto from "crypto";

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!;
  const resendKey = process.env.RESEND_API_KEY!;
  const fromEmail = process.env.MAIL_FROM!; // e.g. "Payments <payments@yourdomain.com>"

  if (!webhookSecret || !resendKey || !fromEmail) return res.status(500).send("Missing env vars");

  const rawBody = await readRawBody(req);
  const sig = req.headers["x-razorpay-signature"] as string | undefined;

  if (!verifySignature(rawBody, sig, webhookSecret)) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(rawBody.toString("utf8"));

  // ✅ Payment Page / Payment Link success event
  if (event.event === "payment_link.paid") {
    const paymentLink = event?.payload?.payment_link?.entity;
    const payment = event?.payload?.payment?.entity;

    const toEmail = paymentLink?.customer?.email;      // <--- IMPORTANT
    const toPhone = paymentLink?.customer?.contact;
    const amount = (payment?.amount ?? paymentLink?.amount ?? 0) / 100;
    const paymentId = payment?.id ?? "NA";
    const ref = paymentLink?.reference_id ?? paymentLink?.id ?? "NA";

    if (!toEmail) return res.status(200).json({ ok: true, note: "No customer email in payload" });

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: "Payment successful ✅",
        html: `
          <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
            <h2 style="margin:0 0 8px">Payment successful ✅</h2>
            <p style="margin:0 0 8px">We received <b>₹${amount}</b>.</p>
            <p style="margin:0 0 8px">Reference: <b>${ref}</b></p>
            <p style="margin:0 0 8px">Payment ID: <b>${paymentId}</b></p>
            <p style="margin:0 0 8px">Phone: <b>${toPhone ?? "NA"}</b></p>
          </div>
        `,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("Resend error:", err);
      // Return 200 so Razorpay doesn’t keep retrying; check Vercel logs to fix.
      return res.status(200).json({ ok: false, resend_error: err });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true, ignored: event.event });
}
