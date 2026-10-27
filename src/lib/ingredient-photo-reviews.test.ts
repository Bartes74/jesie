import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedIngredientPhotoCompatible, reviewedIncompatibleIngredientPhotoSources } from './ingredient-photo-reviews';

test('visually rejected wine and squash photographs cannot return through their old labels',()=>{
  const wine={name:{pl:'wytrawne czerwone wino',en:'dry red wine'}};
  for(const src of reviewedIncompatibleIngredientPhotoSources)assert.equal(reviewedIngredientPhotoCompatible(src,wine,wine),false);
});

test('reviewed whole garlic remains useful for plain garlic but not an explicitly chopped target',()=>{
  const plain={name:{pl:'czosnek',en:'garlic'}};
  const chopped={...plain,note:{pl:'Bardzo drobno posiekany.',en:'Very finely chopped.'}};
  const src='/media/7ca03eb5-9c93-4bc9-a757-2ace68688d03';
  assert.equal(reviewedIngredientPhotoCompatible(src,chopped,chopped),false,'Actual reviewed pixels override an inaccurate source note.');
  assert.equal(reviewedIngredientPhotoCompatible(src,chopped,plain),true,'Valid existing plain-garlic uses are preserved.');
});
