// app/api/sendgrid-inbound/route.ts
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const form = await request.formData();

  const keys: string[] = [];
  for (const [key, value] of form.entries()) {
    keys.push(key);
    if (typeof value === 'string') {
      console.log(`[field] ${key}=${value.slice(0, 200)}`);
    } else {
      console.log(
        `[file] ${key} name=${value.name} type=${value.type} size=${value.size}`
      );
    }
  }

  console.log('All form keys:', keys);

  return new Response('OK', { status: 200 });
}

