import 'server-only';
import { notFound } from 'next/navigation';
import { getRecipe, EditorialError } from './store';
export async function pageRecipe(id: string) { try { return await getRecipe(id); } catch (error) { if (error instanceof EditorialError && error.status === 404) notFound(); throw error; } }
