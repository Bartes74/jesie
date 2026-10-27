/** Reviewed standalone replacements. Entries bind pixels to a culinary source,
 * independently of editable captions and filenames. */
export type CuratedRecipePhotoSource = {
  src: string;
  kind: 'hero' | 'step';
  recipeId: string;
  targetId: string | null;
  stepIndex: number | null;
  culinarySignature: string;
};

// Filled only after visual review of the exact final public file.
export const curatedRecipePhotoSources: readonly CuratedRecipePhotoSource[] = [
  {
    "src": "/images/steps/broccoli-cheddar-melting.webp",
    "kind": "step",
    "recipeId": "33ca830e-7e7a-4d05-918a-ef787078e13f",
    "targetId": "melt-cheddar",
    "stepIndex": 5,
    "culinarySignature": "75eb5077e61f5c62db87f537f19f4f6d"
  },
  {
    "src": "/images/steps/claypot-rice-yolk-mixing.webp",
    "kind": "step",
    "recipeId": "34ea63da-a656-4475-8226-16845d653087",
    "targetId": "mix_and_serve",
    "stepIndex": 8,
    "culinarySignature": "bdfd345805b4f5a81124af6f1920c8d5"
  },
  {
    "src": "/images/steps/buckwheat-crepe-pan-edge.webp",
    "kind": "step",
    "recipeId": "4e665432-51db-4aac-a8fe-57b3dca79f9e",
    "targetId": "cook_crepes",
    "stepIndex": 6,
    "culinarySignature": "c04b532d608c3c49af2f4d3547457d42"
  },
  {
    "src": "/images/steps/cassoulet-before-oven.webp",
    "kind": "step",
    "recipeId": "5583dea5-893c-4695-bc4d-a901ad010ecb",
    "targetId": "assemble",
    "stepIndex": 3,
    "culinarySignature": "f03aced1cd9f0234b4af305552ec1607"
  },
  {
    "src": "/images/steps/duck-plums-raw-preparation.webp",
    "kind": "step",
    "recipeId": "b29e73b4-859e-49e4-a775-86453aa34733",
    "targetId": "prepare_plums",
    "stepIndex": 0,
    "culinarySignature": "80d725b49af5071d98e1ca72b4d89814"
  },
  {
    "src": "/images/steps/duck-breast-cooked-slicing.webp",
    "kind": "step",
    "recipeId": "b29e73b4-859e-49e4-a775-86453aa34733",
    "targetId": "serve",
    "stepIndex": 7,
    "culinarySignature": "80d725b49af5071d98e1ca72b4d89814"
  },
  {
    "src": "/images/steps/stuffed-squash-hot-center-check.webp",
    "kind": "step",
    "recipeId": "ebeef8b5-9cbf-4f1a-96e4-61c4d048c11e",
    "targetId": "bake_filled_squash",
    "stepIndex": 8,
    "culinarySignature": "5ba4bf8f5c26000e3e8df1e876502bcf"
  },
  {
    "src": "/images/steps/sea-bass-parchment-sealing.webp",
    "kind": "step",
    "recipeId": "fc71fcf7-0428-4ac9-a13a-564a9d7a3439",
    "targetId": "choose_method",
    "stepIndex": 3,
    "culinarySignature": "e4fcfbdc06dae5fa0442637b4314bd31"
  },
  {
    "src": "/images/steps/sea-bass-backbone-removal.webp",
    "kind": "step",
    "recipeId": "fc71fcf7-0428-4ac9-a13a-564a9d7a3439",
    "targetId": "serve",
    "stepIndex": 6,
    "culinarySignature": "e4fcfbdc06dae5fa0442637b4314bd31"
  },
  {
    "src": "/images/steps/pumpkin-seeds-dry-toasting.webp",
    "kind": "step",
    "recipeId": "pumpkin-soup",
    "targetId": "serve",
    "stepIndex": 4,
    "culinarySignature": "199cf8253bd4f5d2e255b655927b931d"
  },
  {
    "src": "/images/heroes/spinach-pierogi-cutout-v2.webp",
    "kind": "hero",
    "recipeId": "spinach-pierogi",
    "targetId": null,
    "stepIndex": null,
    "culinarySignature": "123f52d3d6f9c6b6f685aba33708d343"
  }
];

export const curatedRecipePhotoPaths = curatedRecipePhotoSources.map(source => source.src);
