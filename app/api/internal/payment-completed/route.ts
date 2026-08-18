import { NextRequest } from 'next/server';
import { handleNajikiWebhook } from '@/app/api/webhooks/najiki/handler';

export async function POST(req: NextRequest) {
  return handleNajikiWebhook(req);
}
