import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (n: number) => '$' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n: number) => (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const smtpHost = Deno.env.get('SMTP_HOST');
    const smtpPort = Number(Deno.env.get('SMTP_PORT') ?? '465');
    const smtpUser = Deno.env.get('SMTP_USER');
    const smtpPass = Deno.env.get('SMTP_PASS');
    const businessEmail = Deno.env.get('BUSINESS_EMAIL') ?? 'info@tacoatrading.com';
    const smtpFrom = Deno.env.get('SMTP_FROM') ?? `Tacoa General Trading <${businessEmail}>`;

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json(500, { ok: false, error: 'Supabase environment variables are not configured.' });
    }
    if (!smtpHost || !smtpUser || !smtpPass) {
      return json(500, { ok: false, error: 'Email (SMTP) is not configured.' });
    }

    // Only a signed-in admin may send. is_admin() runs as the caller, so it checks their own JWT.
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: userData, error: userError } = await asUser.auth.getUser();
    if (userError || !userData?.user?.email) return json(401, { ok: false, error: 'Please sign in again.' });
    const { data: isAdmin, error: adminError } = await asUser.rpc('is_admin');
    if (adminError || isAdmin !== true) return json(403, { ok: false, error: 'Not allowed.' });

    const body = await req.json();
    const receiptId = (body.receiptId ?? '').toString().trim();
    const to = (body.to ?? '').toString().trim();
    const pdfBase64 = (body.pdfBase64 ?? '').toString();

    if (!receiptId) return json(400, { ok: false, error: 'Receipt is required.' });
    if (to.length > 254 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(to)) {
      return json(400, { ok: false, error: 'Enter a valid email address.' });
    }
    if (pdfBase64 && (pdfBase64.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pdfBase64))) {
      return json(400, { ok: false, error: 'The PDF attachment is not valid.' });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // The receipt content always comes from the database, never from the request.
    const { data: receipt, error: receiptError } = await admin
      .from('receipts')
      .select('id, receipt_no, customer_name, total_amount, created_at, sales(qty_sold, unit_price, total_amount, detail, inventory(product_name))')
      .eq('id', receiptId)
      .single();
    if (receiptError || !receipt) return json(404, { ok: false, error: 'Receipt not found.' });

    const receiptNo = 'TAC-' + String(receipt.receipt_no).padStart(6, '0');
    const dateText = new Date(receipt.created_at).toLocaleString('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Harare'
    });
    const lines = (receipt.sales ?? []) as Array<{
      qty_sold: number; unit_price: number; total_amount: number; detail: string | null; inventory: { product_name: string } | null;
    }>;

    const rowsHtml = lines.map((l) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e3ece7">${esc(l.inventory?.product_name ?? 'Item')}${l.detail ? `<br /><span style="color:#555;font-size:12px">${esc(l.detail)}</span>` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #e3ece7;text-align:right">${qtyFmt(l.qty_sold)} sqm</td>
        <td style="padding:8px;border-bottom:1px solid #e3ece7;text-align:right">${money(l.unit_price)}</td>
        <td style="padding:8px;border-bottom:1px solid #e3ece7;text-align:right">${money(l.total_amount)}</td>
      </tr>`).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:640px">
        <h2 style="margin:0 0 4px;color:#0e4d2b">Tacoa General Trading</h2>
        <p style="margin:0 0 16px;color:#555">913 Industrial Road, Kwekwe, Midlands, Zimbabwe<br />+263 77 772 6221 &middot; ${esc(businessEmail)}</p>
        <p>${receipt.customer_name ? 'Hi ' + esc(receipt.customer_name) + ',' : 'Hello,'}</p>
        <p>Thank you for your purchase. Your receipt is below${pdfBase64 ? ' and attached as a PDF' : ''}.</p>
        <p style="margin:16px 0 6px"><strong>Receipt ${esc(receiptNo)}</strong><br />${esc(dateText)}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr style="background:#eaf5ef;text-align:left">
            <th style="padding:8px">Item</th><th style="padding:8px;text-align:right">Qty</th>
            <th style="padding:8px;text-align:right">Price / sqm</th><th style="padding:8px;text-align:right">Amount</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot><tr>
            <td colspan="3" style="padding:10px 8px;text-align:right"><strong>Total</strong></td>
            <td style="padding:10px 8px;text-align:right"><strong>${money(receipt.total_amount)}</strong></td>
          </tr></tfoot>
        </table>
        <p style="margin-top:20px">Please keep this receipt as proof of purchase. Reply to this email or call us if you have any questions.</p>
      </div>`;

    const text = [
      'Tacoa General Trading',
      `Receipt ${receiptNo} - ${dateText}`,
      '',
      ...lines.map((l) => `${l.inventory?.product_name ?? 'Item'}${l.detail ? ' (' + l.detail + ')' : ''}: ${qtyFmt(l.qty_sold)} sqm x ${money(l.unit_price)} = ${money(l.total_amount)}`),
      '',
      `Total: ${money(receipt.total_amount)}`
    ].join('\n');

    const nodemailer = await import('npm:nodemailer@^7.0.0');
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      requireTLS: smtpPort !== 465,
      auth: { user: smtpUser, pass: smtpPass }
    });

    try {
      await transporter.sendMail({
        from: smtpFrom,
        to,
        bcc: businessEmail,
        replyTo: businessEmail,
        subject: `Your receipt ${receiptNo} from Tacoa General Trading`,
        text,
        html,
        attachments: pdfBase64
          ? [{ filename: `Receipt-${receiptNo}.pdf`, content: pdfBase64, encoding: 'base64', contentType: 'application/pdf' }]
          : []
      });
    } catch (mailError) {
      console.error('Receipt email failed', mailError);
      return json(502, { ok: false, error: 'The email could not be sent. Please try again.' });
    }

    await admin.from('receipts').update({ emailed_at: new Date().toISOString() }).eq('id', receipt.id);

    return json(200, { ok: true, message: 'Receipt emailed.' });
  } catch (error) {
    console.error('send-receipt error', error);
    return json(500, { ok: false, error: 'Something went wrong while sending the receipt.' });
  }
});
