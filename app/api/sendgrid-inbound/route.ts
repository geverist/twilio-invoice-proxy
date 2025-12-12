// app/api/sendgrid-inbound/route.ts
export const runtime = 'nodejs';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse/sync';

function isFile(v: FormDataEntryValue): v is File {
  return typeof v !== 'string';
}

function safeKeyPart(s: string) {
  return (s || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160);
}

function utcPathPrefix(d: Date) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `inbound/${yyyy}/${mm}/${dd}`;
}

const s3 = new S3Client({ region: process.env.AWS_REGION });

export async function GET() {
  return new Response('sendgrid-inbound endpoint is alive', { status: 200 });
}

export async function POST(request: Request) {
  try {
    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.AWS_REGION;

    if (!bucket || !region) {
      console.error('Missing AWS env vars', {
        AWS_REGION: !!region,
        S3_BUCKET_NAME: !!bucket,
      });
      // Return 200 so SendGrid doesn't retry forever while you configure env vars
      return new Response('OK (missing env vars)', { status: 200 });
    }

    const form = await request.formData();

    const from = form.get('from')?.toString() ?? '';
    const to = form.get('to')?.toString() ?? '';
    const subject = form.get('subject')?.toString() ?? '';

    // Collect attachments (SendGrid commonly uses attachment1..N)
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

    // Pick first CSV attachment
    const csvAttachment = attachments.find((a) =>
      a.file.name.toLowerCase().endsWith('.csv')
    );

    if (!csvAttachment) {
      console.log(
        'Attachments present but no .csv found:',
        attachments.map((a) => ({
          key: a.key,
          name: a.file.name,
          type: a.file.type,
          size: a.file.size,
        }))
      );
      return new Response('OK (no csv)', { status: 200 });
    }

    const arr = await csvAttachment.file.arrayBuffer();
    const buf = Buffer.from(arr);
    const csvText = buf.toString('utf-8');

    // Parse CSV (expects header row)
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true,
    }) as Record<string, string>[];

    const columns = records[0] ? Object.keys(records[0]) : [];

    // Upload raw CSV to S3
    const now = new Date();
    const prefix = utcPathPrefix(now);
    const key = `${prefix}/${now.toISOString().replace(/[:]/g, '-')}_${safeKeyPart(
      csvAttachment.file.name
    )}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: csvText,
        ContentType: 'text/csv',
        Metadata: {
          from: safeKeyPart(from),
          to: safeKeyPart(to),
          subject: safeKeyPart(subject),
          attachmentkey: safeKeyPart(csvAttachment.key),
          filename: safeKeyPart(csvAttachment.file.name),
        },
      })
    );

    console.log('Inbound email', { from, to, subject });
    console.log('CSV attachment', {
      key: csvAttachment.key,
      name: csvAttachment.file.name,
      type: csvAttachment.file.type,
      size: csvAttachment.file.size,
      rows: records.length,
      columns,
    });
    console.log('Uploaded to S3', { bucket, s3Key: key });

    return new Response(`OK (uploaded ${records.length} rows)`, { status: 200 });
  } catch (err: any) {
    console.error('Error in sendgrid inbound handler:', err?.stack || err);
    // Return 200 to avoid SendGrid retry storms while iterating
    return new Response('OK (error logged)', { status: 200 });
  }
}
