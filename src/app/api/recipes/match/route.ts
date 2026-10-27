import { parseRecipeMatchQuery, PantryQueryError, recipeMatchesResponse } from '@/lib/pantry-api';
import { publicRecipes } from '@/server/public/recipes';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    parseRecipeMatchQuery(params);
    return Response.json(recipeMatchesResponse(await publicRecipes(), params), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof PantryQueryError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
