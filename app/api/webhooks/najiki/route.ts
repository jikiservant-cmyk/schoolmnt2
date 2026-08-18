import { NextRequest } from 'next/server';
import { handleNajikiWebhook } from './handler';

export async function POST(req: NextRequest) {
  return handleNajikiWebhook(req);
}
