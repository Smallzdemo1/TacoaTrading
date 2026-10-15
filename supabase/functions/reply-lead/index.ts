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

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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
    const authHeader = req.headers.get('Authorization') ?? '';
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: userData, error: userError } = await asUser.auth.getUser();
    if (userError || !userData?.user?.email) return json(401, { ok: false, error: 'Please sign in again.' });
    const { data: isAdmin, error: adminError } = await asUser.rpc('is_admin');
    if (adminError || isAdmin !== true) return json(403, { ok: false, error: 'Not allowed.' });

    const body = await req.json();
    const leadId = (body.leadId ?? '').toString().trim();
    const subject = (body.subject ?? '').toString().trim();
    const message = (body.message ?? '').toString().trim();

    if (!leadId || !subject || !message) {
      return json(400, { ok: false, error: 'Subject and message are required.' });
    }
    if (subject.length > 200 || /[\r\n]/.test(subject)) {
      return json(400, { ok: false, error: 'Subject must be one line of up to 200 characters.' });
    }
    if (message.length > 10000) {
      return json(400, { ok: false, error: 'Message is too long.' });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // The recipient always comes from the saved enquiry, never from the request.
    const { data: lead, error: leadError } = await admin
      .from('leads')
      .select('id, first_name, email, status')
      .eq('id', leadId)
      .single();
    if (leadError || !lead) return json(404, { ok: false, error: 'Enquiry not found.' });
    if (!lead.email) return json(400, { ok: false, error: 'This enquiry has no email address. Call the customer instead.' });

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
        to: lead.email,
        bcc: businessEmail,
        replyTo: businessEmail,
        subject,
        text: message,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${esc(message).replace(/\n/g, '<br />')}</div>`
      });
    } catch (mailError) {
      console.error('Reply email failed', mailError);
      return json(502, { ok: false, error: 'The email could not be sent. Please try again.' });
    }

    const { error: logError } = await admin.from('lead_replies').insert([{
      lead_id: lead.id,
      sent_by: userData.user.email,
      to_email: lead.email,
      subject,
      body: message
    }]);
    if (logError) console.error('Reply log failed', logError);

    if (lead.status === 'new') {
      await admin.from('leads').update({ status: 'contacted' }).eq('id', lead.id);
    }

    return json(200, { ok: true, message: 'Reply sent.' });
  } catch (error) {
    console.error('reply-lead error', error);
    return json(500, { ok: false, error: 'Something went wrong while sending the reply.' });
  }
});
