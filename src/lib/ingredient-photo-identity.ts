import type { Ingredient } from './recipes';
import { lemonIngredientPhotoForm } from './citrus-photo-policy';

const normalise = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ł/g, 'l').replace(/[^a-z0-9%]+/g, ' ').trim().replace(/\s+/g, ' ');

const products: [string, RegExp][] = [
  ['coconut-milk', /^(?:coconut milk|mleczko kokosowe|mleko kokosowe)$/],
  ['icing-sugar', /^(?:icing sugar|powdered sugar|confectioners sugar|cukier puder)$/],
  ['caster-sugar', /^(?:caster sugar|granulated sugar|white sugar|sugar|cukier|bialy cukier)$/],
  ['plain-wheat-flour', /^(?:plain flour|all purpose flour|wheat flour|flour|maka pszenna|maka)$/],
  ['olive-oil', /^(?:olive oil|extra virgin olive oil|oliwa|oliwa z oliwek)$/],
  ['rapeseed-oil', /^(?:rapeseed oil|canola oil|olej rzepakowy)$/],
  ['neutral-oil', /^(?:oil|neutral oil|vegetable oil|olej|olej neutralny|olej roslinny)$/],
  ['vegetable-stock', /^(?:vegetable stock|vegetable broth|bulion warzywny)$/],
  ['pasta-water', /^(?:pasta cooking water|woda z gotowania makaronu)$/],
  ['water', /^(?:water|woda)$/], ['milk', /^(?:milk|mleko|cows milk|mleko krowie)$/],
  ['whipping-cream', /^(?:whipping cream|heavy cream|double cream|smietanka(?: \d+%)?)$/],
  ['white-wine', /^(?:white wine|biale wino|wytrawne biale wino)$/],
  ['butter', /^(?:butter|unsalted butter|maslo|maslo niesolone)$/],
  ['salt', /^(?:salt|sol)$/], ['black-pepper', /^(?:black pepper|pepper|pieprz|pieprz czarny)$/],
  ['cinnamon', /^(?:cinnamon|cynamon)$/], ['nutmeg', /^(?:nutmeg|galka muszkatolowa)$/],
  ['baking-powder', /^(?:baking powder|proszek do pieczenia)$/],
  ['breadcrumbs', /^(?:(?:fine )?(?:breadcrumbs|bread crumbs)|(?:drobna )?bulka tarta)$/],
  ['egg', /^(?:egg|eggs|jajko|jajka|jaja)$/], ['tagliatelle', /^(?:tagliatelle)$/],
  ['onion', /^(?:onion|onions|cebula|cebule)$/], ['garlic', /^(?:garlic|garlic cloves|czosnek|zabki czosnku)$/],
  ['ginger', /^(?:ginger|imbir)$/], ['pumpkin', /^(?:pumpkin|pumpkin flesh|dynia|miazsz dyni)$/],
  ['pumpkin-seeds', /^(?:pumpkin seeds|pestki dyni)$/], ['spinach', /^(?:spinach|szpinak)$/],
  ['basil', /^(?:basil|bazylia)$/], ['sage', /^(?:sage|szalwia)$/],
  ['lemon', /^(?:lemon|lemons|cytryna|cytryny|cytryn)$/],
  ['apple', /^(?:apple|apples|jablko|jablka)$/], ['beetroot', /^(?:beetroot|beets|burak|buraki)$/],
  ['rocket', /^(?:rocket|arugula|rukola)$/], ['walnut', /^(?:walnut|walnuts|orzech wloski|orzechy wloskie)$/],
  ['mixed-berries', /^(?:mixed berries|berries|owoce jagodowe)$/],
  ['honey', /^(?:honey|miod)$/], ['ricotta', /^(?:ricotta)$/], ['feta', /^(?:feta|feta cheese)$/],
  ['mature-hard-cheese', /^(?:mature hard cheese|hard cheese|dojrzewajacy ser twardy|ser twardy)$/],
  ['parmesan', /^(?:parmesan|parmigiano reggiano|parmezan)$/], ['pecorino', /^(?:pecorino|pecorino romano)$/],
  ['broccoli', /^(?:broccoli|brokul)$/], ['chicken-stock', /^(?:chicken stock|chicken broth|bulion drobiowy|bulion z kurczaka)$/],
  ['chicken', /^(?:chicken|chicken meat|kurczak|mieso z kurczaka)$/], ['chicken-breast', /^(?:chicken breast|piers z kurczaka)$/],
  ['tomato', /^(?:tomato|tomatoes|pomidor|pomidory)$/], ['cucumber', /^(?:cucumber|ogorek|ogorki)$/],
  ['carrot', /^(?:carrot|carrots|marchew|marchewka|marchewki)$/], ['potato', /^(?:potato|potatoes|ziemniak|ziemniaki)$/],
  ['maple-syrup', /^(?:maple syrup|syrop klonowy)$/], ['chickpea', /^(?:chickpea|chickpeas|ciecierzyca)$/],
  ['balsamic-vinegar', /^(?:balsamic vinegar|ocet balsamiczny)$/],
];
const preparation: [string, RegExp][] = [
  ['ground', /\b(?:ground|grind|mielony|mielona|mielone|zmielony|zmielona|zmiel)\b/g],
  ['grated', /\b(?:grated|grate|starty|starta|starte|zetrzyj)\b/g],
  ['diced', /\b(?:diced|dice|cubed|cube|(?:pokrojony|pokrojona|pokrojone|pokroj) w kostke|w kostke)\b/g],
  ['chopped', /\b(?:chopped|chop|posiekany|posiekana|posiekane|posiekaj)\b/g],
  ['minced', /\b(?:minced|mince|drobno posiekany|drobno posiekane)\b/g],
  ['sliced', /\b(?:sliced|slice|pokroj w plasterki|w plasterkach|w plastrach)\b/g],
  ['crushed', /\b(?:crushed|crush|rozgnieciony|rozgnieciona|rozgniecione|rozgniec)\b/g],
  ['peeled', /\b(?:peeled|obrany|obrana|obrane|bez skorki|bez skory)\b/g],
  ['cored', /\b(?:cored|bez gniazd nasiennych)\b/g],
  ['deseeded', /\b(?:deseeded|seedless|bez pestek)\b/g],
  ['frozen', /\b(?:frozen|mrozony|mrozona|mrozone)\b/g],
  ['dried', /\b(?:dried|dry|suszone|suszony|suszona|suche|suchy|sucha)\b/g],
  ['roasted', /\b(?:roasted|pieczony|pieczona|pieczone|prazone|prazony)\b/g],
  ['cooked', /\b(?:cooked|boiled|ugotowany|ugotowana|ugotowane|gotowany|gotowana|gotowane)\b/g],
  ['canned', /\b(?:canned|tinned|z puszki|konserwowe)\b/g],
  ['drained', /\b(?:drained|odsaczona|odsaczony|odsaczone)\b/g],
  ['melted', /\b(?:melted|roztopione|roztopiony|roztopiona)\b/g],
  ['beaten', /\b(?:beaten|roztrzepane|roztrzepane|roztrzepany|roztrzepana)\b/g],
  ['pureed', /\b(?:pureed|puree|zmiksowane|zmiksowany)\b/g],
  ['juice', /\b(?:juice|sok z)\b/g], ['zest', /\b(?:zest of an?|zest|skorka z)\b/g],
  ['whole', /\b(?:whole|w calosci|caly|cala|cale|w ziarnach|peppercorns)\b/g],
];

function signature(name: string) {
  let rest=normalise(name); const forms=new Set<string>();
  // "Dry" describes the wine's sweetness, not dried physical matter. Keep
  // genuine dried/powder products distinct rather than stripping their form.
  if (/^dry white wine$/.test(rest)) rest = rest.replace(/^dry /, '');
  // Ordinary bułka tarta is dried; explicitly fresh crumbs must keep their moisture state.
  if(/\b(?:breadcrumbs|bread crumbs|bulka tarta)\b/.test(rest)&&/\b(?:fresh|swiezy|swieza|swieze)\b/.test(rest))forms.add('fresh');
  if(/\bpeppercorns\b/.test(rest)){forms.add('whole');rest=rest.replace(/\bpeppercorns\b/g,'black pepper');}
  if(/cinnamon sticks|cynamon w laskach/.test(rest)){forms.add('whole');rest=rest.replace(/cinnamon sticks/g,'cinnamon').replace(/cynamon w laskach/g,'cynamon');}
  for(const [form,pattern] of preparation){pattern.lastIndex=0;if(pattern.test(rest)){forms.add(form);pattern.lastIndex=0;rest=rest.replace(pattern,' ');}}
  if(forms.has('diced'))rest=rest.replace(/\bpokrojone\b/g,' ');
  rest=rest.replace(/\b(?:freshly|fresh|swiezy|swieza|swieze|finely|drobno|cold|zimne|warm|ciepla|cieply|hot|goraca|medium|sredniej wielkosci|niewoskowanej|unwaxed|washed|umytej)\b/g,' ')
    .replace(/\b(?:for|do)\s+(?:the )?(?:dough|ciasta|dusting|podsypywania|cooking water|wody|greasing (?:the )?(?:pan|tin)|posmarowania patelni|formy|apples|jablek|roasting|pieczenia|dressing|dressingu).*$/,' ')
    .replace(/\b(?:and|i)\b/g,' ').replace(/\s+/g,' ').trim();
  const product=products.find(([,pattern])=>pattern.test(rest))?.[0];
  return {product:product??`exact:${rest}`,forms,known:Boolean(product)};
}

export function ingredientIdentityParts(ingredient: Pick<Ingredient,'name'|'note'>): { product: string; form: string } {
  const pl=signature(ingredient.name.pl),en=signature(ingredient.name.en);
  const available=[pl,en].filter(item=>item.product!=='exact:');
  const known=available.filter(item=>item.known);
  // Conflicting known names are never silently conflated. Unknown products require an exact normalised bilingual match.
  const product=known.length===available.length && known.length>0 && new Set(known.map(item=>item.product)).size===1 ? known[0].product : `exact:${available.map(item=>item.product).sort().join('|')}`;
  const forms=new Set(available.flatMap(item=>[...item.forms]));
  for(const note of [ingredient.note?.pl,ingredient.note?.en]){
    if(!note)continue;const firstClause=note.split(/[.;:]/,1)[0];const text=normalise(firstClause);
    // Conditional substitutions and later cooking instructions do not describe the ingredient photograph.
    if(/\b(?:if|when|later|optional|add|dodaj|jesli|gdy|pozniej|potem)\b|for (?:a )?fraction|przy ulamku/.test(text))continue;
    if(product==='breadcrumbs'&&/^(?:fresh|swiezy|swieza|swieze)\b/.test(text))forms.add('fresh');
    if(product==='breadcrumbs'&&/^toasted\b/.test(text))forms.add('roasted');
    const describesForm=/^(?:finely |drobno |please |prosze )?(?:ground|grind|grated|grate|diced|dice|cubed|cube|chopped|chop|whole|minced|mince|sliced|slice|crushed|crush|peeled|cored|deseeded|seedless|frozen|dried|dry|roasted|cooked|boiled|canned|tinned|drained|melted|beaten|pureed|puree|juice|zest|zetrzyj|zmiel|posiekaj|pokroj|rozgniec|start|mielon|siek|obr|bez |mroz|suszon|such|pieczon|prazon|ugotowan|gotowan|z puszki|konserwow|odsaczon|roztopion|roztrzepan|zmiksowan|sok z|skorka z|w calosci|w ziarnach|w kostke|w plasterkach|w plastrach)/.test(text);
    if(describesForm)for(const form of signature(firstClause).forms)forms.add(form);
  }
  if(forms.has('zest')&&!forms.has('sliced'))forms.add('grated');
  if(product==='breadcrumbs'&&!forms.has('fresh'))forms.add('dried');
  if(['cinnamon','black-pepper','nutmeg'].includes(product)&&!forms.has('whole')&&!forms.has('ground'))forms.add('ground');
  if(product==='walnut'&&!['ground','chopped','minced','crushed','sliced'].some(form=>forms.has(form)))forms.add('whole');
  if(['chicken','chicken-breast'].includes(product)&&forms.has('minced')){forms.delete('minced');forms.add('ground');}
  if(product==='whipping-cream'){
    const percentage=`${ingredient.name.pl} ${ingredient.name.en}`.match(/(\d+(?:[.,]\d+)?)\s*%/);
    forms.add(`fat-${percentage?percentage[1].replace(',','.'):30}`);
  }
  const form=[...forms].sort().join('+')||'plain';
  return {product,form};
}

export type IngredientPhotoSemanticIdentity = { product: string; forms: readonly string[] };
export type IngredientPhotoSubject = Pick<Ingredient, 'name' | 'note'> & { id?: string };

function semanticName(value: string) {
  return normalise(value)
    .replace(/\b(?:very|bardzo)\s+(?=(?:finely|drobno)\b)/gu, '')
    .replace(/\b(?:for|do|na)\s+(?:the\s+)?(?:cake|dough|filling|coffee cream|cream|mash|puree|greasing|baking|cooking|serving|garnish|sauce|dressing|roasting|frying|ciasta|kremu|nadzienia|masy|smarowania|posmarowania|pieczenia|gotowania|podania|dekoracji|sosu|dressingu|smazenia|formy)\b.*$/u, '')
    .replace(/\bdry (?=(?:red|white|rose) wine\b)/gu, '')
    .replace(/\bswiezo\b/gu, '')
    .replace(/\bcukier krysztal\b/gu,'cukier').replace(/\bzabek czosnku\b/gu,'czosnek').replace(/\bgarlic clove\b/gu,'garlic cloves')
    .replace(/\bbez pestek i skorki\b/gu, '').replace(/\bmiazsz dyni\b/gu, 'dynia')
    .replace(/\bw kostkach\b/gu, 'w kostke').replace(/\b(?:pokrojone|pokrojony|pokrojona)\b/gu, '')
    .replace(/\b(?:raw|surowy|surowa|surowe|surowego|surowej|unpeeled|skin on|ze skorka|ze skora|nieobrany|nieobrana|nieobrane|uncored|z gniazdami nasiennymi)\b/gu, '')
    .replace(/\s+/gu, ' ').trim();
}

/** Comparison only: historical catalog keys continue to use ingredientIdentityParts. */
export function ingredientPhotoSemanticIdentity(ingredient: IngredientPhotoSubject): IngredientPhotoSemanticIdentity {
  const normalized = { ...ingredient, name: { pl: semanticName(ingredient.name.pl), en: semanticName(ingredient.name.en) },
    ...(ingredient.note ? { note: { pl: semanticName(ingredient.note.pl.split(/[.;:]/u,1)[0]), en: semanticName(ingredient.note.en.split(/[.;:]/u,1)[0]) } } : {}) };
  const identity = ingredientIdentityParts(normalized);
  const physical = new Set(identity.form === 'plain' ? [] : identity.form.split('+'));
  const citrusForm = lemonIngredientPhotoForm({ ...ingredient, id: ingredient.id ?? '' });
  if (citrusForm === 'conflict') return { product: 'lemon', forms: ['conflict'] };
  if (citrusForm) return { product: 'lemon', forms: [citrusForm, ...(citrusForm === 'zest' ? ['grated'] : [])] };
  const text = normalise(`${ingredient.name.pl} ${ingredient.name.en}`);
  const firstNotes=normalise(`${ingredient.note?.pl.split(/[.;:]/u,1)[0]??''} ${ingredient.note?.en.split(/[.;:]/u,1)[0]??''}`);
  if (/\b(?:raw|surowy|surowa|surowe|surowego|surowej)\b/u.test(text)) physical.add('raw');
  if (/\b(?:unpeeled|skin on|ze skorka|ze skora|nieobrany|nieobrana|nieobrane)\b/u.test(text)) physical.add('unpeeled');
  if (/\b(?:uncored|z gniazdami nasiennymi)\b/u.test(text)) physical.add('uncored');
  if(/\b(?:flesh|miazsz)\b/u.test(text)) { physical.add('peeled');physical.add('deseeded'); }
  if(/\b(?:weight|mass|masa|waga)\b/u.test(firstNotes)&&/\b(?:after peeling|peeled|po obraniu)\b/u.test(firstNotes))physical.add('peeled');
  if(/\b(?:weight|mass|masa|waga)\b/u.test(firstNotes)&&/\b(?:removing seeds|deseeded|seedless|usunieciu pestek|bez pestek)\b/u.test(firstNotes))physical.add('deseeded');
  let product=identity.product;
  if(/\b(?:salt and pepper|sol i pieprz)\b/u.test(text))product='salt-and-pepper';
  if(/\b(?:baking powder|proszek do pieczenia)\b/u.test(text))product='baking-powder';
  if(/\b(?:whipping cream|heavy cream|double cream|smietanka)\b/u.test(text)){
    product='whipping-cream';
    if(![...physical].some(form=>form.startsWith('fat-'))){const percent=text.match(/(\d+(?:[.,]\d+)?)\s*%/u);physical.add(`fat-${percent?percent[1].replace(',','.'):30}`);}
  }
  if(/\b(?:butternut|dyni\p{L}* pizmow\p{L}*)\b/u.test(text))product='butternut-squash';
  if(/\b(?:red wine|czerwone wino|wino czerwone)\b/u.test(text))product='red-wine';
  if(/\b(?:white wine|biale wino|wino biale)\b/u.test(text))product='white-wine';
  if(product==='red-wine'||product==='white-wine'){
    const powder=/\b(?:powder|flakes?|dried|dehydrated|proszek|sproszkowan\p{L}*|platk\p{L}*|suszon\p{L}*)\b/u.test(text);
    if(powder)physical.add('dried');else physical.delete('dried');
  }
  if(product==='salt-and-pepper'&&!physical.has('whole'))physical.add('ground');
  if(product==='tagliatelle'&&!physical.has('cooked')&&!/\b(?:fresh|swiezy|swieza|swieze)\b/u.test(text))physical.add('dried');
  return { product, forms: [...physical].sort() };
}

const appearance = (forms: ReadonlySet<string>) => ['juice', 'zest', 'pureed', 'ground'].filter(form => forms.has(form)).sort().join('+') || 'solid';
const preservation = (forms: ReadonlySet<string>) => ['canned', 'dried'].filter(form => forms.has(form)).sort().join('+') || 'fresh';

/** A source may illustrate cuts for an unspecified ingredient. Explicit target
 * preparation requires visible source evidence; material states stay distinct.
 */
export function ingredientPhotoIdentitiesCompatible(source: IngredientPhotoSemanticIdentity, target: IngredientPhotoSemanticIdentity): boolean {
  if (!source.product || /^(?:exact:)+$/u.test(source.product) || source.product !== target.product) return false;
  const a = new Set(source.forms), b = new Set(target.forms);
  if (a.has('conflict') || b.has('conflict')) return false;
  if (appearance(a) !== appearance(b) || preservation(a) !== preservation(b)) return false;
  for (const state of ['frozen', 'melted', 'beaten']) if (a.has(state) !== b.has(state)) return false;
  const cooked = (forms: ReadonlySet<string>) => forms.has('cooked') || forms.has('roasted');
  if (cooked(a) !== cooked(b)) return false;
  if (a.has('raw') && cooked(a) || b.has('raw') && cooked(b)) return false;
  const fat = (forms: ReadonlySet<string>) => [...forms].filter(form => form.startsWith('fat-')).sort().join('+');
  if (fat(a) !== fat(b)) return false;
  for (const preparation of ['diced','chopped','grated','sliced','crushed','minced','peeled','cored','deseeded']) {
    if(b.has(preparation)&&!a.has(preparation))return false;
  }
  for (const [positive, negative] of [['peeled', 'unpeeled'], ['cored', 'uncored'], ['deseeded', 'seeded']]) {
    if (a.has(positive) && b.has(negative) || a.has(negative) && b.has(positive)) return false;
  }
  return true;
}

export function ingredientPhotosCompatible(source: IngredientPhotoSubject, target: IngredientPhotoSubject): boolean {
  return ingredientPhotoIdentitiesCompatible(ingredientPhotoSemanticIdentity(source), ingredientPhotoSemanticIdentity(target));
}
