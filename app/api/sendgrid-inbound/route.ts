// app/api/sendgrid-inbound/route.ts
export const runtime = 'nodejs'; // we want Node APIs like Buffer

export async function POST(request: Request) {
  try {
    // Parse the multipart/form-data from SendGrid Inbound Parse
    const formData = await request.formData();

    const from = formData.get('from')?.toString() ?? '';
    const subject = formData.get('subject')?.toString() ?? '';

    // Find the CSV attachment (SendGrid will name them attachment1, attachment2, etc.)
    let csvFile: File | null = null;

    for (const [, value] of formData.entries()) {
      if (value instanceof File) {
        const filename = value.name || '';
        const type = value.type || '';

        if (type === 'text/csv' || filename.toLowerCase().endsWith('.csv')) {
          csvFile = value;
          break;
        }
      }
    }

    if (!csvFile) {
      console.error('No CSV attachment found');
      return new Response('No CSV attachment found', { status: 400 });
    }

    // Read attachment into a Buffer and base64 encode it
    const arrayBuffer = await csvFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentBase64 = buffer.toString('base64');

    // Build payload for your Twilio Function
    const payload = {
      from,
      subject,
      attachment: {
        filename: csvFile.name,
        mimeType: csvFile.type || 'text/csv',
        contentBase64,
      },
    };

    const twilioFunctionUrl = process.env.TWILIO_FUNCTION_URL;
    if (!twilioFunctionUrl) {
      console.error('TWILIO_FUNCTION_URL is not set');
      return new Response('TWILIO_FUNCTION_URL not configured', {
        status: 500,
      });
    }

    // Optional: shared secret for basic auth to the Twilio Function or your API gateway
    const authHeader = process.env.TWILIO_FUNCTION_AUTH_HEADER; // e.g. "Bearer xyz" or "Basic abc"

    const resp = await fetch(twilioFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Twilio Function error:', resp.status, text);
      return new Response('Error forwarding to Twilio Function', {
        status: 500,
      });
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Error in Vercel SendGrid handler:', err);
    return new Response('Server error', { status: 500 });
  }
}
