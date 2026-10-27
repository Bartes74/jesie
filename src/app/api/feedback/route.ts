import { handleReaderFeedback } from '@/server/reader-feedback';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handleReaderFeedback(request); }
