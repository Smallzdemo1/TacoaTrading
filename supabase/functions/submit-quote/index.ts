import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'Method not allowed.' }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }

  try {
    const body = await req.json();

    const firstName = (body.firstName ?? '').toString().trim();
    const lastName = (body.lastName ?? '').toString().trim();
    const phone = (body.phone ?? '').toString().trim();
    const email = (body.email ?? '').toString().trim();
    const inquiryType = (body.inquiry ?? '').toString().trim();
    const message = (body.message ?? '').toString().trim();
    const location = (body.location ?? '').toString().trim();

    if (!firstName || !lastName || !phone || !inquiryType || !message) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Please fill in all required fields.' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Supabase environment variables are not configured.' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const { data: lead, error: insertError } = await supabase
      .from('leads')
      .insert([
        {
          first_name: firstName,
          last_name: lastName,
          phone,
          email: email || null,
          inquiry_type: inquiryType,
          message,
          location: location || null
        }
      ])
      .select()
      .single();

    if (insertError) {
      throw insertError;
    }

    const businessEmail = Deno.env.get('BUSINESS_EMAIL') ?? 'info@tacoatrading.com';
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const resendFrom = Deno.env.get('RESEND_FROM') ?? 'Tacoa General Trading <onboarding@resend.dev>';
    const smtpHost = Deno.env.get('SMTP_HOST');
    const smtpPort = Number(Deno.env.get('SMTP_PORT') ?? '465');
    const smtpUser = Deno.env.get('SMTP_USER');
    const smtpPass = Deno.env.get('SMTP_PASS');
    const smtpFrom = Deno.env.get('SMTP_FROM') ?? `Tacoa General Trading <${businessEmail}>`;
    let emailWarning = null;

    const esc = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const emailHtml = `
      <h2>New Tacoa enquiry</h2>
      <p><strong>Name:</strong> ${esc(firstName)} ${esc(lastName)}</p>
      <p><strong>Phone:</strong> ${esc(phone)}</p>
      <p><strong>Email:</strong> ${email ? esc(email) : 'Not provided'}</p>
      <p><strong>Inquiry Type:</strong> ${esc(inquiryType)}</p>
      <p><strong>Location:</strong> ${location ? esc(location) : 'Not provided'}</p>
      <p><strong>Message:</strong></p>
      <p>${esc(message).replace(/\n/g, '<br />')}</p>
    `;

    try {
      if (smtpHost && smtpUser && smtpPass) {
        const nodemailer = await import('npm:nodemailer@^7.0.0');
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          requireTLS: smtpPort !== 465,
          auth: {
            user: smtpUser,
            pass: smtpPass
          }
        });

        await transporter.sendMail({
          from: smtpFrom,
          to: businessEmail,
          replyTo: email || undefined,
          subject: `New enquiry from ${firstName} ${lastName}`,
          html: emailHtml
        });
      } else if (resendApiKey) {
        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: resendFrom,
            to: [businessEmail],
            subject: `New enquiry from ${firstName} ${lastName}`,
            html: emailHtml
          })
        });

        const emailResult = await emailResponse.json().catch(() => ({ message: 'Unknown error sending email.' }));

        if (!emailResponse.ok) {
          console.error('Resend email failed', emailResponse.status, emailResult);
          emailWarning = 'The enquiry was saved, but the email notification could not be sent yet.';
        }
      }
    } catch (emailError) {
      console.error('Email sending failed', emailError);
      emailWarning = 'The enquiry was saved, but the email notification could not be sent yet.';
    }

    return new Response(
      JSON.stringify({
        ok: true,
        message: emailWarning ? 'Enquiry submitted successfully. ' + emailWarning : 'Enquiry submitted successfully.',
        warning: emailWarning,
        lead
      }),
      {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Something went wrong while processing the enquiry.';

    return new Response(
      JSON.stringify({ ok: false, error: message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
