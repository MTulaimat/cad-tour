/**
 * Keyword registry: maps DXF block and layer names (English and Arabic) to library pieces.
 * Unknown names fall back to 'box', a neutral low volume in the block's footprint.
 */

interface Rule {
  type: string | ((w: number, d: number) => string);
  words: string[];
}

const bedBySize = (w: number, d: number) => (Math.min(w, d) > 1.15 ? 'bed-double' : 'bed-single');
// A chair drawn wider than a dining chair is an armchair (sizes unknown: a chair).
const chairBySize = (w: number, d: number) => (Math.min(w, d) >= 0.6 ? 'armchair' : 'chair');

// Order matters: more specific words first.
const RULES: Rule[] = [
  { type: 'nightstand', words: ['nightstand', 'night stand', 'bedside', 'komodin', 'كومودينو', 'كومود'] },
  { type: bedBySize, words: ['bed', 'beds', 'doublebeds', 'twinbeds', 'سرير', 'تخت'] },
  { type: 'armchair', words: ['armchair', 'arm chair', 'lounge chair', 'فوتيه', 'كرسي فوتيه'] },
  { type: 'sofa', words: ['sofa', 'couch', 'settee', 'كنبة', 'كنب', 'كنبه', 'صوفا', 'اريكة', 'أريكة'] },
  { type: 'coffee-table', words: ['coffee', 'tea table', 'side table', 'طاولة قهوة', 'طاولة جانبية'] },
  { type: 'desk', words: ['desk', 'مكتب'] },
  { type: 'bistro-table', words: ['bistro table', 'cafe table', 'round table'] },
  { type: 'dining-table', words: ['dining', 'table', 'tbl', 'طاولة', 'طاوله', 'سفرة', 'ترابيزة'] },
  { type: 'bistro-chair', words: ['bistro', 'outdoor chair'] },
  { type: 'bench', words: ['bench', 'مقعد', 'دكة'] },
  { type: 'wall-cabinet', words: ['wall cabinet', 'upper cabinet', 'wall unit'] },
  { type: chairBySize, words: ['chair', 'stool', 'seat', 'كرسي', 'كراسي'] },
  { type: 'wc', words: ['wc', 'toilet', 'tolias', 'water closet', 'mirhad', 'مرحاض', 'تواليت', 'كرسي افرنجي', 'افرنجي'] },
  { type: 'bathtub', words: ['bathtub', 'bath tub', 'tub', 'bath', 'بانيو', 'بانيه', 'حوض استحمام'] },
  { type: 'shower', words: ['shower', 'دش', 'دوش', 'شاور'] },
  { type: 'kitchen-sink', words: ['kitchen sink', 'sink k', 'kssdms', 'مجلى', 'حوض مطبخ'] },
  { type: 'vanity', words: ['basin', 'lavatory', 'washbasin', 'dmlo', 'lav', 'sink', 'vanity', 'مغسلة', 'مغسله', 'حوض'] },
  { type: 'kitchen-hob', words: ['hob', 'stove', 'gazz', 'cooker', 'range', 'oven', 'فرن', 'موقد', 'بوتاجاز', 'غاز'] },
  { type: 'fridge', words: ['fridge', 'refrigerator', 'frig', 'ثلاجة', 'ثلاجه', 'براد'] },
  { type: 'kitchen-counter', words: ['counter', 'kitchen', 'worktop', 'cabinet base', 'مطبخ', 'رخامة', 'كاونتر'] },
  { type: 'wardrobe', words: ['wardrobe', 'closet', 'armoire', 'cupboard', 'خزانة', 'خزانه', 'دولاب', 'خزائن'] },
  { type: 'bookshelf', words: ['bookshelf', 'bookcase', 'shelf', 'shelves', 'مكتبة', 'رفوف', 'رف'] },
  { type: 'tv-unit', words: ['tv unit', 'tv stand', 'tv', 'television', 'media', 'تلفزيون', 'شاشة'] },
  { type: 'sideboard', words: ['sideboard', 'buffet', 'credenza', 'dresser', 'console', 'بوفيه', 'تسريحة'] },
  { type: 'plant', words: ['plant', 'tree', 'flower', 'نبات', 'نبتة', 'زرع', 'شجرة'] },
  { type: 'floor-lamp', words: ['lamp', 'light', 'مصباح', 'اباجورة', 'أباجورة'] },
  { type: 'rug', words: ['rug', 'carpet', 'mat', 'سجاد', 'سجادة', 'موكيت'] },
];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** True when `word` occurs in `name` as a whole token (Latin) or as a substring (Arabic). */
function contains(name: string, word: string): boolean {
  if (/[؀-ۿ]/.test(word)) return name.includes(word);
  const re = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
  return re.test(name);
}

/**
 * Picks a furniture type for a block or layer name. `w` and `d` are the footprint size in meters,
 * used to tell single from double beds.
 */
export function matchFurnitureType(names: string[], w = Number.NaN, d = Number.NaN): string | null {
  for (const raw of names) {
    const name = normalize(raw);
    if (!name) continue;
    for (const rule of RULES) {
      if (rule.words.some((word) => contains(name, normalize(word)))) {
        return typeof rule.type === 'function' ? rule.type(w, d) : rule.type;
      }
    }
  }
  return null;
}
