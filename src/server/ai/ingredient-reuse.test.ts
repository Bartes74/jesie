import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ingredient } from '@/lib/recipes';
import type { MediaTile } from '@/lib/recipe-media';
import { findIngredientProducer, findReusableIngredient, registerIngredientImage, reusableIngredientPhotoSourceCompatible } from './ingredient-reuse';
import { ingredientImageIdentity, paperIngredientStyleProfile } from './ingredient-profile';
import { AiError } from './errors';

const ingredient=(form:'juice'|'zest'):Ingredient=>({id:form,name:{pl:form==='juice'?'sok cytrynowy':'skórka cytrynowa',en:`lemon ${form}`},amount:{kind:'exact',value:'1'},unit:'g',scaling:'linear',group:{pl:'',en:''}});
const photo:MediaTile={src:'/media/citrus-asset',columns:1,rows:1,index:0,alt:{pl:'Cytryna',en:'Lemon'}};
function fixture(form:'juice'|'zest'){
  const item=ingredient(form);
  const identity=ingredientImageIdentity(item,paperIngredientStyleProfile);
  const job={id:`source-${form}`,kind:'ingredient',targetId:item.id,ingredientKey:identity.key,input:{recipe:{ingredients:[item]},aiPhotography:{ingredientStyleProfile:paperIngredientStyleProfile}}};
  const asset={id:'citrus-asset',jobId:job.id,kind:'ingredient',alt:item.name,caption:{pl:'',en:''},width:1024,height:1024};
  const entry={...identity,photo,sourceJobId:job.id};
  return {job,asset,entry};
}
function generic(pl:string,en:string,note?:Ingredient['note']){
  const base=fixture('juice'),item={...ingredient('juice'),name:{pl,en},note};
  const identity=ingredientImageIdentity(item,paperIngredientStyleProfile);
  base.job.input.recipe.ingredients=[item];base.job.ingredientKey=identity.key;
  base.entry={...base.entry,...identity};return base;
}
function database(results:unknown[][]){
  const inserts:unknown[]=[];
  const db={select(){
    const rows=results.shift()??assert.fail('Unexpected extra catalog read.');
    const query={from(){return query;},innerJoin(){return query;},where(){return query;},orderBy(){return query;},limit:async()=>rows,
      then(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown){return Promise.resolve(rows).then(resolve,reject);}};
    return query;
  },insert(){return{values(value:unknown){inserts.push(value);return{onConflictDoNothing:async()=>{}};}};}};
  return{db:db as unknown as Parameters<typeof findReusableIngredient>[0],inserts};
}
const conflict=(error:unknown)=>error instanceof AiError&&error.code==='INGREDIENT_PHOTO_FORM_CONFLICT';

test('catalog reuse verifies the real source ingredient rather than trusting a stored identity key',async()=>{
  const correct=fixture('juice'),wrongSource=fixture('zest');
  const h=database([[{...correct,job:wrongSource.job}]]);
  assert.equal(await findReusableIngredient(h.db,ingredient('juice'),paperIngredientStyleProfile),null);
  const bound=database([[{...correct,entry:{...correct.entry,photo:{...photo,src:'/media/another-asset'}}}]]);
  assert.equal(await findReusableIngredient(bound.db,ingredient('juice'),paperIngredientStyleProfile),null);
});

test('catalog reuse rejects the exact same photo already bound to the opposite citrus form',async()=>{
  const correct=fixture('juice'),opposite=fixture('zest');
  const h=database([[correct],[opposite]]);
  assert.equal(await findReusableIngredient(h.db,ingredient('juice'),paperIngredientStyleProfile),null);
  const good=database([[correct],[]]);
  assert.equal((await findReusableIngredient(good.db,ingredient('juice'),paperIngredientStyleProfile))?.photo.src,photo.src);
});

test('registration cannot give an existing zest photo a juice key, but distinct crops remain distinct',async()=>{
  const correct=fixture('juice'),opposite=fixture('zest');
  const h=database([[opposite]]);
  await assert.rejects(registerIngredientImage(h.db as Parameters<typeof registerIngredientImage>[0],correct.job as unknown as Parameters<typeof registerIngredientImage>[1],correct.asset as unknown as Parameters<typeof registerIngredientImage>[2],{styleProfile:paperIngredientStyleProfile,hasTransparency:false}),conflict);
  assert.equal(h.inserts.length,0);
  const good=database([[{...opposite,entry:{...opposite.entry,photo:{...photo,columns:4,rows:3,index:2}}}]]);
  await registerIngredientImage(good.db as Parameters<typeof registerIngredientImage>[0],correct.job as unknown as Parameters<typeof registerIngredientImage>[1],correct.asset as unknown as Parameters<typeof registerIngredientImage>[2],{styleProfile:paperIngredientStyleProfile,hasTransparency:false});
  assert.equal(good.inserts.length,1);
});

test('non-citrus catalog keys cannot override the captured product or material form',async()=>{
  const butter=generic('masło','butter'),garlic=generic('czosnek','garlic');
  const corrupt=database([[{...garlic,entry:{...garlic.entry,...butter.entry}}]]);
  assert.equal(await findReusableIngredient(corrupt.db,butter.job.input.recipe.ingredients[0],paperIngredientStyleProfile),null);
  const ground=generic('mielone orzechy włoskie','ground walnuts'),whole=generic('orzechy włoskie','walnuts');
  const collision=database([[whole]]);
  await assert.rejects(registerIngredientImage(collision.db as Parameters<typeof registerIngredientImage>[0],ground.job as unknown as Parameters<typeof registerIngredientImage>[1],ground.asset as unknown as Parameters<typeof registerIngredientImage>[2],{styleProfile:paperIngredientStyleProfile,hasTransparency:false}),conflict);
  assert.equal(collision.inserts.length,0);
});

test('ready reuse receipts and pending producers recheck source bindings rather than trusting old keys',async()=>{
  const butter=generic('masło','butter'),garlic=generic('czosnek','garlic');
  const id='304e18dc-246a-4d12-8b27-ff1ea6708d8e';
  const saved={...photo,src:`/media/${id}`};
  const oldReceipt=database([[{...garlic,asset:{...garlic.asset,id}}]]);
  assert.equal(await reusableIngredientPhotoSourceCompatible(oldReceipt.db,butter.job.input.recipe.ingredients[0],saved),false);
  const forgedProducer=database([[{...garlic.job,ingredientKey:butter.entry.key}]]);
  assert.equal(await findIngredientProducer(forgedProducer.db,butter.entry.key),null);
});
