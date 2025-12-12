// app/api/sendgrid-inbound/route.ts
export const runtime = 'nodejs';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse/sync';

function isFile(v: FormDataEntryValue): v is File {
  return typeof v !== 'string';
}

function safeKeyPart(s: string) {
  return (s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

// Try to extract YYYY-MM from filename like "...-2025-10.csv"
function extractYearMonth(filename: string): { year?: string; month?: string } {
  const m = filename.match(/(20\d{2})[-_](0[1-9]|1[0-2])\.csv$/i);
  if (!m) return {};
  return { year: m[1], month: m[2] };
}

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export async function GET() {
  return new Response('sendgrid-inbound endpoint is alive', { status: 200 });
}

export async function POST(request: Request) {
  try {
    const bucket = process.env.S3_BUCKET_NAME || 'twilio-invoice-data';
    const region = process.env.AWS_REGION;

    // Safe debug (no secrets)
    console.log('AWS env present', {
      region,
      bucket,
      akid_prefix: (process.env.AWS_ACCESS_KEY_ID || '').slice(0, 4),
      akid_len: (process.env.AWS_ACCESS_KEY_ID || '').length,
      sk_len: (process.env.AWS_SECRET_ACCESS_KEY || '').length,
    });

    if (!region || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      console.error('Missing AWS env vars (region/access keys).');
      return new Response('OK (missing AWS env vars)', { status: 200 });
    }

    const form = await request.formData();

    const from = form.get('from')?.toString() ?? '';
    const to = form.get('to')?.toString() ?? '';
    const subject = form.get('subject')?.toString() ?? '';

    // Collect attachment1..N
    const attachments: { key: string; file: File }[] = [];
    for (const [key, value] of form.entries()) {
      if (key.toLowerCase().startsWith('attachment') && isFile(value)) {
        attachments.push({ key, file: value });
      }
    }

    if (attachments.length === 0) {
      console.log('No attachments found', { from, to, subject });
      return new Response('OK (no attachments)', { status: 200 });
    }

    const csvAttachment = attachments.find((a) => a.file.name.toLowerCase().endsWith('.csv'));
    if (!csvAttachment) {
      console.log('No .csv attachment found', attachments.map(a => a.file.name));
      return new Response('OK (no csv)', { status: 200 });
    }

    const buf = Buffer.from(await csvAttachment.file.arrayBuffer());
    const csvText = buf.toString('utf-8');

    // Optional parse (still useful for logging/validating)
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true,
    }) as Record<string, string>[];

    const { year, month } = extractYearMonth(csvAttachment.file.name);
    const now = new Date();
    const iso = now.toISOString().replace(/[:]/g, '-'); // safe for S3 keys

    const y = year || String(now.getUTCFullYear());
    const m = month || String(now.getUTCMonth() + 1).padStart(2, '0');

    const s3Key =
      `billing/raw/year=${y}/month=${m}/received_at=${iso}/` +
      `${safeKeyPart(csvAttachment.file.name)}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: csvText,
        ContentType: 'text/csv',
        // Encryption at rest (SSE-S3). If you want KMS, we can switch this.
        ServerSideEncryption: 'AES256',
        Metadata: {
          from: safeKeyPart(from),
          to: safeKeyPart(to),
          subject: safeKeyPart(subject),
          attachmentkey: safeKeyPart(csvAttachment.key),
        },
      })
    );

    console.log('Uploaded billing CSV to S3', {
      bucket,
      s3Key,
      rows: records.length,
      columns: records[0] ? Object.keys(records[0]) : [],
    });

    return new Response(`OK (uploaded ${records.length} rows)`, { status: 200 });
  } catch (err: any) {
    console.error('Error in sendgrid inbound handler:', err?.stack || err);
    return new Response('OK (error logged)', { status: 200 });
  }
}
