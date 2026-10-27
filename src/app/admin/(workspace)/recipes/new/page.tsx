import { pageAdmin } from '@/server/auth-page';
import { NewRecipeForm } from '@/components/admin/NewRecipeForm';
export default async function NewRecipePage() { await pageAdmin(); return <NewRecipeForm />; }
