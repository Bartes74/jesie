import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getMediaBlob } from '@/server/media/storage';
import sharp from 'sharp';
import type { Ingredient } from '@/lib/recipes';
import type { MediaTile } from '@/lib/recipe-media';
import { getDb } from '../db';
import { aiAssets, aiJobs, ingredientImages } from './schema';
import { capturedIngredientStyleProfile, ingredientImageIdentity, ingredientStyleProfile, isOpaqueStudioIngredientProfile, staticIngredientPhoto, type IngredientImageIdentity } from './ingredient-profile';
import { AiError } from './errors';
import { ingredientPhotoIdentity, lemonIngredientPhotoIssue } from '@/lib/citrus-photo-policy';
import { reviewedIngredientPhotoCompatible, reviewedIncompatibleIngredientPhotoSources } from '@/lib/ingredient-photo-reviews';

type Database=ReturnType<typeof getDb>;
type Transaction=Parameters<Parameters<Database['transaction']>[0]>[0];
type AssetRow=typeof aiAssets.$inferSelect;
type JobRow=typeof aiJobs.$inferSelect;
export type ReusableIngredientImage={key:string;photo:MediaTile;asset:AssetRow|null};
const approvedIngredientModel='openai/gpt-image-2.5/sunburst/text-to-image';

export async function findReusableIngredient(db:Database|Transaction, ingredient:Ingredient, styleProfile=ingredientStyleProfile):Promise<ReusableIngredientImage|null>{
  const identity=ingredientImageIdentity(ingredient,styleProfile);
  const rows=await db.select({entry:ingredientImages,asset:aiAssets,job:aiJobs}).from(ingredientImages)
    .innerJoin(aiAssets,eq(ingredientImages.assetId,aiAssets.id)).innerJoin(aiJobs,eq(aiAssets.jobId,aiJobs.id))
    .where(and(eq(ingredientImages.key,identity.key),inArray(ingredientImages.eligibility,['approved','usable']),eq(aiAssets.kind,'ingredient'))).orderBy(desc(ingredientImages.createdAt)).limit(25);
  for(const row of rows){
    if(reviewedIncompatibleIngredientPhotoSources.has(row.entry.photo.src))continue;
    if(lemonIngredientPhotoIssue(ingredient,row.entry.photo))continue;
    if(row.entry.photo.src!==`/media/${row.asset.id}`||row.entry.photo.columns!==1||row.entry.photo.rows!==1||row.entry.photo.index!==0)continue;
    const source=row.job.input.recipe.ingredients.find(item=>item.id===row.job.targetId);
    if(row.job.kind!=='ingredient'||!source||!reviewedIngredientPhotoCompatible(row.entry.photo.src,source,ingredient))continue;
    if(await hasConflictingIngredientPhoto(db,ingredient,row.entry.photo))continue;
    return {key:identity.key,photo:{...row.entry.photo,alt:ingredient.name},asset:row.asset};
  }
  const photo=staticIngredientPhoto(ingredient,styleProfile);
  return photo?{key:identity.key,photo,asset:null}:null;
}

export async function findIngredientProducer(db:Database|Transaction,key:string){
  const [job]=await db.select().from(aiJobs).where(and(eq(aiJobs.ingredientKey,key),isNull(aiJobs.reuseSourceJobId),isNull(aiJobs.ingredientResolvedAt),isNull(aiJobs.result),sql`${aiJobs.status}<>'failed'`)).limit(1);
  const source=job?.input.recipe.ingredients.find(item=>item.id===job.targetId);
  return job?.kind==='ingredient'&&source&&ingredientImageIdentity(source,capturedIngredientStyleProfile(job.input)).key===key?job:null;
}

export async function registerIngredientImage(tx:Transaction,job:JobRow,asset:AssetRow,verified:{hasTransparency?:boolean;styleProfile?:string}){
  const profile=capturedIngredientStyleProfile(job.input);
  if(job.kind!=='ingredient'||!job.targetId||verified.styleProfile!==profile|| (isOpaqueStudioIngredientProfile(profile)?verified.hasTransparency!==false:verified.hasTransparency!==true))return;
  const ingredient=job.input.recipe.ingredients.find(item=>item.id===job.targetId);if(!ingredient)return;
  if(reviewedIncompatibleIngredientPhotoSources.has(`/media/${asset.id}`))throw new AiError(409,'INGREDIENT_PHOTO_FORM_CONFLICT','Ta fotografia została odrzucona podczas przeglądu zgodności składnika.');
  if(asset.jobId!==job.id)throw new AiError(409,'INGREDIENT_PHOTO_FORM_CONFLICT','Fotografia musi pochodzić z tego samego zlecenia i dotyczyć tej samej postaci składnika.');
  const identity=ingredientImageIdentity(ingredient,profile);if(job.ingredientKey && job.ingredientKey!==identity.key)throw new AiError(409,'INGREDIENT_IDENTITY_CONFLICT','To zdjęcie dotyczy innej postaci składnika.');
  await insertCatalog(tx,identity,asset,job.id,'usable',ingredient);
}
async function hasConflictingIngredientPhoto(db:Database|Transaction,ingredient:Ingredient,photo:MediaTile){
  const rows=await db.select({entry:ingredientImages,job:aiJobs}).from(ingredientImages).innerJoin(aiJobs,eq(ingredientImages.sourceJobId,aiJobs.id))
    .where(and(inArray(ingredientImages.eligibility,['usable','approved']),sql`${ingredientImages.photo}->>'src'=${photo.src}`));
  return rows.some(({entry,job})=>{
    if(ingredientPhotoIdentity(entry.photo)!==ingredientPhotoIdentity(photo))return false;
    const source=job.input.recipe.ingredients.find(item=>item.id===job.targetId);
    return !source||!reviewedIngredientPhotoCompatible(photo.src,source,ingredient);
  });
}

/** Ready historical reuse jobs must recheck the immutable source before apply. */
export async function reusableIngredientPhotoSourceCompatible(db:Database|Transaction,ingredient:Ingredient,photo:MediaTile):Promise<boolean>{
  if(reviewedIncompatibleIngredientPhotoSources.has(photo.src))return false;
  const match=/^\/media\/([a-f0-9-]{36})$/i.exec(photo.src);
  if(!match||photo.columns!==1||photo.rows!==1||photo.index!==0)return false;
  const [row]=await db.select({asset:aiAssets,job:aiJobs}).from(aiAssets).innerJoin(aiJobs,eq(aiAssets.jobId,aiJobs.id)).where(eq(aiAssets.id,match[1]));
  const source=row?.job.input.recipe.ingredients.find(item=>item.id===row.job.targetId);
  return Boolean(row?.asset.kind==='ingredient'&&row.job.kind==='ingredient'&&source&&reviewedIngredientPhotoCompatible(photo.src,source,ingredient)&&!await hasConflictingIngredientPhoto(db,ingredient,photo));
}
async function insertCatalog(tx:Transaction,identity:IngredientImageIdentity,asset:AssetRow,sourceJobId:string,eligibility:'usable'|'approved',ingredient:Ingredient){
  const photo:MediaTile={src:`/media/${asset.id}`,columns:1,rows:1,index:0,alt:asset.alt,caption:asset.caption,aspectRatio:asset.width/asset.height};
  if(lemonIngredientPhotoIssue(ingredient,photo)||await hasConflictingIngredientPhoto(tx,ingredient,photo))throw new AiError(409,'INGREDIENT_PHOTO_FORM_CONFLICT','To zdjęcie jest przypisane do innego produktu lub niezgodnej postaci składnika. Zachowano istniejącą fotografię.');
  await tx.insert(ingredientImages).values({...identity,assetId:asset.id,sourceJobId,photo,eligibility}).onConflictDoNothing();
}

async function boundedBytes(stream:ReadableStream<Uint8Array>){
  const reader=stream.getReader();const chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>32*1024*1024){await reader.cancel();throw new Error('IMAGE_TOO_LARGE');}chunks.push(next.value);}}
  finally{reader.releaseLock();}return Buffer.concat(chunks,total);
}

/** Old applied photos are checked physically before entering the shared catalog. A failed GET blocks a new paid fallback. */
export async function prepareLegacyIngredient(ingredient:Ingredient, styleProfile=ingredientStyleProfile):Promise<void>{
  if(styleProfile!==ingredientStyleProfile)return;
  const db=getDb();const identity=ingredientImageIdentity(ingredient);
  const [already]=await db.select({key:ingredientImages.key}).from(ingredientImages).where(and(eq(ingredientImages.key,identity.key),inArray(ingredientImages.eligibility,['usable','approved']))).limit(1);
  if(already&&await findReusableIngredient(db,ingredient,styleProfile))return;
  const candidates=await db.select({asset:aiAssets,job:aiJobs}).from(aiAssets).innerJoin(aiJobs,eq(aiAssets.jobId,aiJobs.id)).where(and(eq(aiAssets.kind,'ingredient'),eq(aiJobs.status,'applied'),eq(aiJobs.model,approvedIngredientModel))).orderBy(desc(aiAssets.createdAt));
  for(const {asset,job} of candidates){
    const source=job.input.recipe.ingredients.find(item=>item.id===job.targetId);if(!source||ingredientImageIdentity(source).key!==identity.key)continue;
    const [prior]=await db.select({eligibility:ingredientImages.eligibility}).from(ingredientImages).where(and(eq(ingredientImages.key,identity.key),eq(ingredientImages.assetId,asset.id))).limit(1);
    if(prior?.eligibility==='rejected')continue;
    let bytes:Buffer;
    try{const blob=await getMediaBlob(asset.blobPathname);if(!blob||blob.statusCode!==200)throw new Error('IMAGE_NOT_FOUND');bytes=await boundedBytes(blob.stream);}
    catch{throw new AiError(503,'INGREDIENT_IMAGE_CHECK_UNAVAILABLE','Istniejące zdjęcie składnika wymaga ponownego odczytu. Nowe płatne zdjęcie nie zostało zlecone.');}
    let valid=false;
    try{const decoded=sharp(bytes,{limitInputPixels:8_500_000,failOn:'error'});const metadata=await decoded.metadata();if(metadata.hasAlpha&&(metadata.pages??1)===1&&metadata.width===asset.width&&metadata.height===asset.height){const alpha=(await decoded.extractChannel('alpha').stats()).channels[0];valid=alpha.min<255&&alpha.max>0;}}
    catch{valid=false;}
    if(!valid)continue;
    await db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);await insertCatalog(tx,identity,asset,job.id,'approved',ingredient);});
    return;
  }
}

/** Called under the same budget lock as admissions; shared/inflight products cost nothing here. */
export async function missingIngredientKeys(db:Database|Transaction,ingredients:Ingredient[]):Promise<Set<string>>{
  const missing=new Set<string>();
  for(const ingredient of ingredients){const identity=ingredientImageIdentity(ingredient);if(await findReusableIngredient(db,ingredient)||await findIngredientProducer(db,identity.key))continue;missing.add(identity.key);}
  return missing;
}
