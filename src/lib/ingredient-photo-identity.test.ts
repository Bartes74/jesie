import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ingredient } from './recipes';
import { ingredientIdentityParts, ingredientPhotoIdentitiesCompatible, ingredientPhotoSemanticIdentity, ingredientPhotosCompatible } from './ingredient-photo-identity';

const subject=(pl:string,en:string,note?:Ingredient['note'])=>({name:{pl,en},note});

test('semantic comparison preserves synonyms and ordinary cuts, draining and recipe roles',()=>{
  for(const [source,target] of [
    [subject('masło pokrojone w kostkę','diced butter'),subject('masło','butter')],
    [subject('ricotta','ricotta'),subject('ricotta odsączona','drained ricotta')],
    [subject('jajka do ciasta','Eggs for cake'),subject('całe jajka do kremu kawowego','whole eggs for coffee cream')],
    [subject('masło do posmarowania formy','butter for greasing the tin'),subject('masło niesolone','unsalted butter')],
    [subject('posiekana cebula','chopped onion'),subject('cebula','onion')],
    [subject('czosnek','garlic cloves'),subject('czosnek','garlic')],
    [subject('czosnek','garlic'),subject('ząbek czosnku','garlic clove')],
    [subject('cukier','caster sugar'),subject('cukier kryształ','granulated sugar')],
  ]) assert(ingredientPhotosCompatible(source,target),JSON.stringify([source,target]));
});

test('different products and material transformations cannot share a source photograph',()=>{
  for(const [source,target] of [
    [subject('masło','butter'),subject('czosnek','garlic')],
    [subject('oliwa','olive oil'),subject('olej rzepakowy','rapeseed oil')],
    [subject('woda','water'),subject('woda z gotowania makaronu','pasta cooking water')],
    [subject('cukier','sugar'),subject('cukier puder','icing sugar')],
    [subject('orzechy włoskie','walnuts'),subject('mielone orzechy włoskie','ground walnuts')],
    [subject('surowy kurczak','raw chicken'),subject('ugotowany kurczak','cooked chicken')],
    [subject('szpinak','spinach'),subject('mrożony szpinak','frozen spinach')],
    [subject('ciecierzyca sucha','dried chickpeas'),subject('ciecierzyca z puszki','canned chickpeas')],
    [subject('masło','butter'),subject('masło roztopione','melted butter')],
    [subject('jajko','egg'),subject('jajko roztrzepane','beaten egg')],
    [subject('śmietanka 30%','whipping cream 30%'),subject('śmietanka 36%','whipping cream 36%')],
    [subject('skórka cytrynowa','lemon zest'),subject('sok z cytryny','lemon juice')],
    [subject('cebula w całości','whole onion'),subject('posiekana cebula','chopped onion')],
    [subject('masło','butter'),subject('masło pokrojone w kostkę','diced butter')],
  ]) assert.equal(ingredientPhotosCompatible(source,target),false,JSON.stringify([source,target]));
});

test('explicit static truth distinguishes opposite preparation states but permits unspecified cuts',()=>{
  assert.equal(ingredientPhotoIdentitiesCompatible({product:'ginger',forms:['unpeeled']},{product:'ginger',forms:['peeled']}),false);
  assert.equal(ingredientPhotoIdentitiesCompatible({product:'apple',forms:['uncored']},{product:'apple',forms:['cored','sliced']}),false);
  assert.equal(ingredientPhotoIdentitiesCompatible({product:'butter',forms:['diced']},{product:'butter',forms:[]}),true);
  assert.equal(ingredientPhotoIdentitiesCompatible({product:'butter',forms:[]},{product:'butter',forms:['diced']}),false);
  assert.equal(ingredientPhotoIdentitiesCompatible({product:'ricotta',forms:[]},{product:'ricotta',forms:['drained']}),true);
  assert.equal(ingredientPhotoSemanticIdentity(subject('nieobrany imbir','unpeeled ginger')).product,'ginger');
});

test('wine sweetness and culinary roles do not turn liquid wine or butter into dried or pureed products',()=>{
  const dryRed=subject('wytrawne czerwone wino','dry red wine'),plainRed=subject('czerwone wino','red wine');
  assert(ingredientPhotosCompatible(plainRed,dryRed));
  assert.equal(ingredientPhotoSemanticIdentity(dryRed).product,'red-wine');
  assert(!ingredientPhotoSemanticIdentity(dryRed).forms.includes('dried'));
  assert(ingredientIdentityParts(dryRed).form.includes('dried'),'The historical catalog key parts remain unchanged.');
  assert.equal(ingredientPhotosCompatible(subject('suszone płatki czerwonego wina','dried red wine flakes'),dryRed),false);
  assert(ingredientPhotosCompatible(subject('białe wino','white wine'),subject('wytrawne białe wino','dry white wine')));
  assert.deepEqual(ingredientPhotoSemanticIdentity(subject('zimne masło w kostkach do puree','cold diced butter for mash')).forms,['diced']);
});

test('preparation weight qualifiers require peeled seedless flesh without relabelling whole counted squash',()=>{
  const flesh=subject('dynia piżmowa','butternut squash',{pl:'Masa po obraniu i usunięciu pestek.',en:'Weight after peeling and removing seeds.'});
  assert.deepEqual(ingredientPhotoSemanticIdentity(flesh),{product:'butternut-squash',forms:['deseeded','peeled']});
  assert(!ingredientPhotoSemanticIdentity(subject('dynia piżmowa','butternut squash')).forms.includes('peeled'));
});

test('intensified direct preparation notes remain explicit without changing old identity parts',()=>{
  const garlic=subject('czosnek','garlic',{pl:'Bardzo drobno posiekany.',en:'Very finely chopped.'});
  assert(ingredientPhotoSemanticIdentity(garlic).forms.includes('chopped'));
  assert.equal(ingredientIdentityParts(garlic).form,'plain');
  assert(ingredientPhotoSemanticIdentity(subject('czosnek','garlic',{pl:'Drobno posiekaj.',en:'Finely chop.'})).forms.includes('chopped'));
});

test('comparison-only aliases and roles leave the stored historical product/form parts intact',()=>{
  const role=subject('jajka do ciasta','Eggs for cake'),plain=subject('jajka','Eggs');
  const before=ingredientIdentityParts(role);
  assert(ingredientPhotosCompatible(role,plain));
  assert.deepEqual(ingredientIdentityParts(role),before);
  assert.notEqual(ingredientIdentityParts(role).product,ingredientIdentityParts(plain).product,'Historical role wording is not rewritten in persisted image identities.');
  assert.equal(ingredientPhotosCompatible(subject('',''),subject('','')),false,'Empty source labels are not evidence of a product match.');
});
