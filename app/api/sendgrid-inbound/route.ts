// app/api/sendgrid-inbound/route.ts
export const runtime = 'nodejs';

export async function GET() {
  return new Response('sendgrid-inbound endpoint is alive', { status: 200 });
}

export async function POST(request: Request) {
  console.log('Hit /api/sendgrid-inbound');

  const bodyText = await request.text();
  console.log('Body snippet:', bodyText.slice(0, 200));

  return new Response('OK', { status: 200 });
}
