import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturedIngredientStyleProfile, currentIngredientStyleProfile, ingredientImageIdentity, ingredientPhotographyForm, ingredientStyleProfile, ingredientStudioBackgroundHex, isOpaqueStudioIngredientProfile, paperIngredientStyleProfile, staticIngredientPhoto, whiteIngredientStyleProfile } from './ingredient-profile';
import type { Ingredient } from '@/lib/recipes';
const ingredient=(pl:string,en:string,note?:Ingredient['note']):Ingredient=>({id:'test',name:{pl,en},note,amount:{kind:'exact',value:'1'},unit:'g',scaling:'linear',group:{pl:'',en:''}});
const key=(pl:string,en:string,note?:Ingredient['note'])=>ingredientImageIdentity(ingredient(pl,en,note)).key;

test('dry white wine means liquid wine rather than dried matter or wine vinegar', () => {
  const wine = ingredient('wytrawne białe wino', 'dry white wine');
  const identity = ingredientImageIdentity(wine);
  assert.equal(identity.product, 'white-wine'); assert.equal(identity.form, 'plain');
  assert.equal(identity.key, key('białe wino', 'white wine'));
  assert.notEqual(identity.key, key('biały ocet winny', 'white wine vinegar'));
  assert.notEqual(identity.key, key('białe wino w proszku', 'dried white wine powder'));
  assert.match(ingredientPhotographyForm(wine), /liquid white wine/);
  assert.equal(ingredientImageIdentity(ingredient('sucha bułka tarta', 'dry breadcrumbs')).form, 'dried');
});

test('dry red wine is prompted as liquid without rewriting its historical dried-key parts',()=>{
  const wine=ingredient('wytrawne czerwone wino','dry red wine');
  assert(ingredientImageIdentity(wine).form.includes('dried'));
  const form=ingredientPhotographyForm(wine);
  assert.match(form,/liquid red wine/);assert.match(form,/dry means low sweetness/);assert.match(form,/never flakes, powder or dried food/);
  assert.doesNotMatch(ingredientPhotographyForm(ingredient('zimne masło w kostkach do puree','cold diced butter for mash')),/pureed/);
});

test('unwhipped cream photography is explicit without changing established ingredient keys', () => {
  const cream = ingredient('śmietanka 30%', 'whipping cream');
  assert.equal(ingredientImageIdentity(cream, paperIngredientStyleProfile).key, '48077edb85724451e64682e95ad2053e8ab13e53d61ebf9f4ca1a6483376cee0');
  assert.match(ingredientPhotographyForm(cream), /pourable liquid unwhipped cream, 30%/);
  assert.match(ingredientPhotographyForm(cream), /never whipped peaks/);
});

test('curated bilingual product aliases share stable keys independently of amounts and purpose',()=>{
  assert.equal(key('Mąka pszenna','plain flour'),key('','all-purpose flour'));
  assert.equal(key('mąka do podsypywania','flour for dusting'),key('mąka pszenna','plain flour'));
  assert.equal(key('oliwa do dressingu','olive oil for the dressing'),key('oliwa','olive oil'));
  assert.equal(key('cebula, obrana','onion, peeled'),key('obrana cebula','peeled onion'));
});
test('product, preparation and style differences cannot collide',()=>{
  for(const [first,second] of [
    [ingredient('mleko','milk'),ingredient('mleczko kokosowe','coconut milk')],
    [ingredient('cukier','caster sugar'),ingredient('cukier puder','icing sugar')],
    [ingredient('pieprz mielony','ground black pepper'),ingredient('pieprz w ziarnach','whole black pepper')],
    [ingredient('szpinak','fresh spinach'),ingredient('szpinak mrożony','frozen spinach')],
    [ingredient('parmezan','parmesan'),ingredient('pecorino','pecorino romano')],
    [ingredient('mleko','milk'),ingredient('mleko owsiane','milk')],
  ])assert.notEqual(ingredientImageIdentity(first).key,ingredientImageIdentity(second).key);
  assert.notEqual(ingredientImageIdentity(ingredient('masło','butter')).key,ingredientImageIdentity(ingredient('masło','butter'),'different-style').key);
});
test('family cake breadcrumbs reuse the existing soup ingredient identity across bilingual aliases',()=>{
  const soup=ingredientImageIdentity(ingredient('Drobna bułka tarta','Fine dried breadcrumbs'));
  assert.equal(soup.product,'breadcrumbs');
  assert.equal(soup.form,'dried');
  for(const [pl,en] of [['Bułka tarta','Breadcrumbs'],['Sucha bułka tarta','Dry bread crumbs'],['','Fine breadcrumbs'],['Drobna bułka tarta','']]){
    assert.equal(key(pl,en),soup.key);
  }
});
test('breadcrumb reuse preserves fresh, toasted and panko preparation differences',()=>{
  const ordinary=key('Bułka tarta','Breadcrumbs');
  for(const [pl,en] of [
    ['Świeża bułka tarta','Fresh breadcrumbs'],
    ['Prażona bułka tarta','Toasted breadcrumbs'],
    ['Bułka tarta panko','Panko breadcrumbs'],
    ['Świeże pieczywo','Fresh bread'],
  ])assert.notEqual(key(pl,en),ordinary);
  assert.notEqual(key('Bułka tarta','Breadcrumbs',{pl:'Świeża.',en:'Fresh.'}),ordinary);
  assert.notEqual(key('Bułka tarta','Breadcrumbs',{pl:'Prażona.',en:'Roasted.'}),ordinary);
  assert.notEqual(key('Bułka tarta','Breadcrumbs',{pl:'',en:'Toasted.'}),ordinary);
});
test('direct form notes participate while optional later methods do not',()=>{
  assert.equal(key('orzechy włoskie mielone','ground walnuts'),key('orzechy włoskie','walnuts',{pl:'Drobno zmiel.',en:'Finely ground.'}));
  assert.notEqual(key('orzechy włoskie','whole walnuts'),key('orzechy włoskie','walnuts',{pl:'Drobno zmiel.',en:'Finely ground.'}));
  assert.equal(key('parmezan starty','grated parmesan'),key('parmezan','parmesan',{pl:'Zetrzyj drobno.',en:'Finely grate.'}));
  assert.notEqual(key('parmezan','parmesan'),key('parmezan','parmesan',{pl:'Zetrzyj drobno.',en:'Finely grate.'}));
  assert.equal(key('jajko','egg'),key('jajko','egg',{pl:'Przy ułamku jajka roztrzep je.',en:'For a fraction of an egg, beat it.'}));
  assert.equal(key('orzechy włoskie','walnuts'),key('orzechy włoskie','walnuts',{pl:'Dodaj posiekane później.',en:'Add chopped walnuts later.'}));
});
test('curated static photos are reused only for supported matching forms',()=>{
  const flour=staticIngredientPhoto(ingredient('Mąka pszenna','all-purpose flour'));assert(flour);assert.equal(flour.columns,4);assert.equal(flour.rows,3);assert.equal(flour.index,5);assert.equal(flour.src,'/images/ingredients-2.webp');
  assert.equal(staticIngredientPhoto(ingredient('mrożony szpinak','frozen spinach')),null);
  assert.equal(staticIngredientPhoto(ingredient('sok z cytryny','lemon juice'))?.src,'/images/lemon-juice.webp');
  assert.equal(staticIngredientPhoto(ingredient('mąka pszenna','plain flour'),'unapproved-style'),null);
  assert.equal(ingredientImageIdentity(ingredient('mąka','plain flour')).styleProfile,ingredientStyleProfile);
});

test('lemon juice and zest have separate canonical photos without changing historical alias keys',()=>{
  const juice=ingredient('sok z cytryny','lemon juice'),zest=ingredient('skórka z cytryny','lemon zest');
  assert.notEqual(ingredientImageIdentity(juice).key,ingredientImageIdentity(zest).key);
  assert.notEqual(ingredientImageIdentity(ingredient('sok cytrynowy','lemon juice')).key,ingredientImageIdentity(juice).key,'Historical identity keys retain their original meaning.');
  assert.equal(staticIngredientPhoto(ingredient('sok cytrynowy','lemon juice'))?.src,'/images/lemon-juice.webp');
  assert.equal(staticIngredientPhoto(ingredient('skórka cytrynowa','lemon zest'))?.src,'/images/lemon-zest.webp');
  assert.equal(staticIngredientPhoto(juice)?.src,'/images/lemon-juice.webp');
  assert.equal(staticIngredientPhoto(zest)?.src,'/images/lemon-zest.webp');
  assert.deepEqual([staticIngredientPhoto(juice)?.columns,staticIngredientPhoto(juice)?.rows,staticIngredientPhoto(juice)?.index],[1,1,0]);
});
test('white studio capture has a separate identity and never reuses a historical static cutout',()=>{
  const flour=ingredient('Mąka pszenna','Plain flour');
  assert.equal(capturedIngredientStyleProfile({}),ingredientStyleProfile);
  assert.equal(capturedIngredientStyleProfile({aiPhotography:{ingredientStyleProfile:'unknown-future-profile'}}),ingredientStyleProfile);
  assert.equal(capturedIngredientStyleProfile({aiPhotography:{ingredientStyleProfile:whiteIngredientStyleProfile}}),whiteIngredientStyleProfile);
  assert.notEqual(ingredientImageIdentity(flour).key,ingredientImageIdentity(flour,whiteIngredientStyleProfile).key);
  assert.equal(staticIngredientPhoto(flour,whiteIngredientStyleProfile),null);
});
test('paper studio identity matches the site colour and preserves both previous captured profiles',()=>{
  const flour=ingredient('Mąka pszenna','Plain flour');
  assert.equal(currentIngredientStyleProfile,paperIngredientStyleProfile);assert.equal(ingredientStudioBackgroundHex,'#FAF8F2');
  assert.equal(capturedIngredientStyleProfile({aiPhotography:{ingredientStyleProfile:paperIngredientStyleProfile}}),paperIngredientStyleProfile);
  assert.equal(capturedIngredientStyleProfile({aiPhotography:{ingredientStyleProfile:whiteIngredientStyleProfile}}),whiteIngredientStyleProfile);
  assert.equal(capturedIngredientStyleProfile({}),ingredientStyleProfile);
  assert(isOpaqueStudioIngredientProfile(paperIngredientStyleProfile));assert(isOpaqueStudioIngredientProfile(whiteIngredientStyleProfile));assert(!isOpaqueStudioIngredientProfile(ingredientStyleProfile));
  assert.notEqual(ingredientImageIdentity(flour,paperIngredientStyleProfile).key,ingredientImageIdentity(flour,whiteIngredientStyleProfile).key);
  assert.equal(staticIngredientPhoto(flour,paperIngredientStyleProfile),null);
});
test('direct diced, sliced, crushed and cooked notes describe distinct reusable preparation forms',()=>{
  for(const [preparedName,note] of [
    ['Diced carrot','Diced.'],['Sliced carrot','Sliced.'],['Crushed carrot','Crushed.'],['Cooked carrot','Cooked.'],
  ]){
    const prepared=key('',preparedName);
    assert.equal(prepared,key('marchewka','carrot',{pl:'',en:note}));
    assert.notEqual(prepared,key('marchewka','carrot'));
  }
  assert.equal(key('marchewka pokrojona w kostkę','diced carrot'),key('marchewka','carrot',{pl:'Pokrój w kostkę.',en:'Dice.'}));
  assert.equal(key('marchewka w plasterkach','sliced carrot'),key('marchewka','carrot',{pl:'Pokrój w plasterki.',en:'Slice.'}));
});
test('the initial Parmesan preparation remains explicit before subsequent usage instructions',()=>{
  const grated=key('parmezan starty','grated parmesan');
  assert.equal(grated,key('parmezan','parmesan',{pl:'Zetrzyj drobno; połowa do zupy, połowa do podania.',en:'Finely grate; half goes into the soup and half is added later.'}));
  assert.notEqual(grated,key('parmezan','whole parmesan'));
  assert.equal(key('parmezan','parmesan'),key('parmezan','parmesan',{pl:'Dodaj starty ser później.',en:'Add grated cheese later.'}));
});
