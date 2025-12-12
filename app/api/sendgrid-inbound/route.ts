// app/api/sendgrid-inbound/route.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client as PgClient } from 'pg';
import { parse } from 'csv-parse/sync';

export const runtime = 'nodejs'; // we want Node APIs like Buffer

// --- S3 helper ---
async function archiveToS3(buffer: Buffer, filename: string, mimeType: string | undefined) {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.AWS_REGION;

  if (!bucket || !region) {
    console.warn('S3_BUCKET or AWS_REGION not set; skipping S3 archive');
    return;
  }

  const s3 = new S3Client({ region });

  const key = `twilio-invoices/${new Date().toISOString()}-${filename}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'text/csv',
    }),
  );

  console.log(`Stored CSV to s3://${bucket}/${key}`);
}

// --- DB helper (Postgres example) ---
async function upsertRowsToPostgres(rows: any[]) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('DATABASE_URL not set; skipping DB upsert');
    return;
  }

  const client = new PgClient({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    for (const row of rows) {
      // Map CSV columns to DB columns here.
      // Adjust these to match your actual invoice CSV fields.
      const invoiceId = row['Invoice Number'];
      const accountSid = row['Account SID'];
      const product = row['Product'];
      const usageDate = row['Usage Date'];
      const quantity = Number(row['Quantity'] || 0);
      const unitPrice = Number(row['Unit Price'] || 0);
      const total = Number(row['Total'] || 0);

      if (!invoiceId || !accountSid || !product || !usageDate) {
        // Skip malformed rows
        continue;
      }

      await client.query(
        `
        INSERT INTO twilio_invoice_lines (
          invoice_id,
          account_sid,
          product,
          usage_date,
          quantity,
          unit_price,
          total
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (invoice_id, account_sid, product, usage_date)
        DO UPDATE SET
          quantity   = EXCLUDED.quantity,
          unit_price = EXCLUDED.unit_price,
          total      = EXCLUDED.total
        `,
        [invoiceId, accountSid, product, usageDate, quantity, unitPrice, total],
      );
    }

    await client.query('COMMIT');
    console.log(`Upserted ${rows.length} rows into Postgres`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

export async function POST(request: Request) {
  try {
    // 1) Parse multipart/form-data from SendGrid Inbound Parse
    const formData = await request.formData();

    const from = formData.get('from')?.toString() ?? '';
    const subject = formData.get('subject')?.toString() ?? '';
    console.log(`Inbound email from=${from}, subject="${subject}"`);

    // 2) Find the CSV attachment
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

    // 3) Read attachment into a Buffer
    const arrayBuffer = await csvFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 4) Optional: archive raw CSV to S3
    await archiveToS3(buffer, csvFile.name, csvFile.type);

    // 5) Parse CSV into rows using csv-parse
    const text = buffer.toString('utf8');
    const rows = parse(text, {
      columns: true,          // use first row as headers
      skip_empty_lines: true, // ignore empty lines
      trim: true,
    }) as any[];

    console.log(`Parsed ${rows.length} CSV rows`);

    // 6) Upsert into DB (Postgres example)
    await upsertRowsToPostgres(rows);

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Error in invoice handler:', err);
    return new Response('Server error', { status: 500 });
  }
}
