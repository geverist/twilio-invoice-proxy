export const runtime = 'nodejs';

import { parse } from 'csv-parse/sync';

function isFile(v: FormDataEntryValue): v is File {
  return typeof v !== 'string';
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();

    const from = form.get('from')?.toString() ?? '';
    const to = form.get('to')?.toString() ?? '';
    const subject = form.get('subject')?.toString() ?? '';

    // Collect all attachment files (attachment1, attachment2, ...)
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

    // Pick the first CSV attachment (or adjust logic as needed)
    const csvAttachment = attachments.find((a) =>
      a.file.name.toLowerCase().endsWith('.csv')
    );

    if (!csvAttachment) {
      console.log(
        'Attachments present but no .csv found:',
        attachments.map((a) => ({ key: a.key, name: a.file.name, type: a.file.type, size: a.file.size }))
      );
      return new Response('OK (no csv)', { status: 200 });
    }

    const buf = Buffer.from(await csvAttachment.file.arrayBuffer());
    const csvText = buf.toString('utf-8');

    // Parse CSV (assumes header row)
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true,
    }) as Record<string, string>[];

    console.log('Inbound email', { from, to, subject });
    console.log('CSV attachment', {
      key: csvAttachment.key,
      name: csvAttachment.file.name,
      type: csvAttachment.file.type,
      size: csvAttachment.file.size,
      rows: records.length,
      columns: records[0] ? Object.keys(records[0]) : [],
    });

    // TODO: next steps:
    // - write raw CSV to S3
    // - upsert records into DB
    // For now just acknowledge receipt:
    return new Response(`OK (parsed ${records.length} rows)`, { status: 200 });
  } catch (err: any) {
    console.error('Error in sendgrid inbound handler:', err?.stack || err);
    // Still return 200 so SendGrid doesn't hammer retries while you're iterating
    return new Response('OK (error logged)', { status: 200 });
  }
}

export async function GET() {
  return new Response('sendgrid-inbound endpoint is alive', { status: 200 });
}
