import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { getAdminSession } from '@/server/auth';
export const pageAdmin = cache(async () => { const session = await getAdminSession(); if (!session) redirect('/admin/login'); return session; });
