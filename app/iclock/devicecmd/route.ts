import { NextRequest, NextResponse } from 'next/server';

// Device responding with the execution status of a command
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  const rawBody = await req.text();
  console.log(`[ZKTeco ADMS] DeviceCmd POST from SN: ${sn}`);
  console.log(`[ZKTeco ADMS] Payload:\n${rawBody}`);

  // Return OK to acknowledge receiving the command execution result
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
