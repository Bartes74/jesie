import { ingredientCatalogResponse, parseIngredientCatalogQuery, PantryQueryError } from '@/lib/pantry-api';
import { publicRecipes } from '@/server/public/recipes';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    parseIngredientCatalogQuery(params);
    return Response.json(ingredientCatalogResponse(await publicRecipes(), params), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof PantryQueryError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
