'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CameraIcon, CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { Field } from '@/components/ui/Field';
import { UnitsEditor, unitProblems } from '@/components/catalog/UnitsEditor';
import { GroupPicker } from '@/components/catalog/GroupPicker';
import {
  GROUPS_SCOPE,
  groupsFor,
  setProductGroups,
  useProductGroups,
  type ProductGroup,
} from '@/lib/stacks/product-groups';
import { BarcodeScanner } from '@/components/catalog/BarcodeScanner';
import { DiscountsEditor, type Discount } from '@/components/catalog/DiscountsEditor';
import { useNav } from '@academix-admin/navigation-stack';
import {
  fetchDiscounts,
  saveDiscounts,
  saveProductUnits,
  SHAPES_SCOPE,
  useProductUnits,
  useStoreUnits,
  type ProductUnit,
  type StoreUnit,
} from '@/lib/stacks/product-units';
import { getSupabase } from '@/lib/supabase/client';
import { hasStockHistory, setProductLowStock, stockMoved, type Product } from '@/lib/stacks/catalog-stack';
import { countsChanged } from '@/lib/stacks/count-gate';
import styles from './ProductForm.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useLoadArea } from '@/components/ui/LoadArea';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { formatQtySpoken, messageOf, pluralUnit } from '@/lib/format';
import { isAllowedQty, snapQty, stockRules } from '@/lib/quantity-rules';
import { baseQtyByShape, stockInShapes } from '@/lib/shape-quantities';
import { productExpiryLayers, setProductExpiry } from '@/lib/stacks/expiry';

/**
 * Add a product, or change one. The BODY of a page — see `product-form-page`.
 *
 * ONE FORM, ONE PRODUCT. It used to ask "how do you count it?" and "what is a pack?", which is the
 * one-pack-per-product model: a base unit, one pack, one price. Real trade does not fit it. Cooking
 * oil arrives in bags and in kilogrammes and leaves by the litre; beer arrives in crates and leaves
 * as crates, half crates and single bottles. A shop with any of that had to either lie to the form
 * or keep the real answer in its head.
 *
 * So the form asks what the item IS — its name and the codes you find it by — and then the two
 * questions that actually matter: what it is bought in, what it is sold in, and what a customer
 * pays for buying more of it.
 *
 * A NEW PRODUCT IS CREATED BEFORE ITS UNITS ARE SAVED, because units and prices hang off an id
 * that does not exist until then. If the units fail to save, the item still exists — unconfigured,
 * and visibly so: the stock screen names anything that can arrive but never leave.
 *
 * Reachable from three places on purpose — the Stock list, a product's own page, and the picker in
 * the middle of a sale. The last one matters most: a customer asks for something the shop sells but
 * has never entered, and the alternatives are abandoning the receipt or writing the sale down on
 * paper. Both happen, and both end with the ledger being wrong.
 */

/*
 * The global units a product row can be measured in.
 *
 * `products.base_unit` is a foreign key to a fixed list and is now only a fallback label — the
 * shop's own units carry the meaning. It is no longer asked for: it is worked out from the
 * smallest thing the shop said it sells, and falls back to pieces, which is what most goods are.
 */
const UNITS = [
  { code: 'piece', label: 'Pieces — bottles, cans, wraps, items' },
  { code: 'kg', label: 'Kilograms — rice, garri, cement' },
  { code: 'g', label: 'Grams' },
  { code: 'litre', label: 'Litres' },
  { code: 'cl', label: 'Centilitres' },
  { code: 'metre', label: 'Metres — cloth, cable' },
  { code: 'yard', label: 'Yards — cloth' },
] as const;

export interface ProductFormResult {
  id: string;
  name: string;
  /**
   * The row as it now stands, for a list to patch itself with.
   *
   * It used to hand back only an id and a name, on the reasoning that a new product's cost, stock
   * and pack are computed elsewhere and fabricating them would put wrong numbers on screen. That
   * is true of a product that has TRADED. A product created ten seconds ago has nothing on the
   * shelf and nothing spent on it, and saying so is not a guess — it is the only correct answer.
   * So the list takes this row and shows it, with no round trip to be told what it already knows.
   */
  row: Product;
  /** New here, as opposed to an edit — the list inserts rather than patches. */
  created: boolean;
}

export function ProductForm({
  onSaved,
  onCancel,
  storeId,
  /** Editing when given; creating when not. */
  product,
  /** Prefills the name when opened from a search that found nothing. */
  initialName = '',
  onCreateUnit,
  onCreateGroup,
  minimum = false,
}: {
  onSaved: (result: ProductFormResult) => void;
  onCancel: () => void;
  storeId: string;
  product?: Product | null;
  initialName?: string;
  /**
   * Hands over to whoever can push the page that invents a new unit.
   *
   * The form does not push it itself: this component is rendered from three stacks, and a
   * component reaching for a route by name breaks the moment it is reused where that route does
   * not exist — the same reason the customer picker asks its caller.
   */
  onCreateUnit?: (name: string) => void;
  /** Hands over to whoever can push the form that names a new group. */
  onCreateGroup?: (name: string) => void;
  /**
   * ASK ONLY WHAT THE SALE NEEDS, and ask it properly.
   *
   * Set when this form is pushed from a counter with a customer waiting. It does not hide
   * anything — every field is still here, below — it changes which ones are REQUIRED and which
   * sections start folded.
   *
   * The three it adds are required in this mode and not in the other, because at a counter they
   * are knowable and later they are not: what is on the shelf right now, whether the container
   * comes back, and how many are already out. A shop that answers them a day later is guessing.
   */
  minimum?: boolean;
}) {
  const nav = useNav();
  const editing = Boolean(product);

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  // Folded at a counter, open everywhere else. See the disclosure below.
  const [showCodes, setShowCodes] = useState(false);

  /*
   * The opening facts, and why they are REQUIRED WITH ZERO ALLOWED.
   *
   * "None on the shelf" and "nobody looked" are different facts, and only one of them means the
   * next person can trust the figure. Leaving these optional makes every new item silently claim
   * nothing is out and nothing is owed — which is right most of the time and catastrophic the rest,
   * because nobody ever goes back to check a blank they did not know they left.
   *
   * So the form insists on an answer and accepts 0 as one.
   */
  /*
   * A BOX PER SHAPE, keyed by the shape.
   *
   * One box could only ever be one shape's figure, and the form never said which — a shop counting
   * Goldberg has crates on the shelf AND loose bottles, and was being asked for a single number.
   * The count screen learnt this already: a shelf of three packs and five bottles had to be entered
   * as 3.208 packs, worked out in somebody's head in front of the shelf.
   */
  const [shelfByShape, setShelfByShape] = useState<Record<string, string>>({});

  /*
   * THE OPENING FIGURE IS THE ONE IN THE BOXES — while it is still an opening figure.
   *
   * "is the input box for crate is 5 and bottle is 6 the intial stock ... and have users edit
   * that in the input box, but cannot after a stock history exist."
   *
   * That is the right distinction, and it is the one I got wrong twice. An item with NO movements
   * has an opening figure and nothing else: it is a statement somebody typed, and correcting a
   * typo in it should be typing over it. Once stock has MOVED, the same boxes mean something
   * different — they are a fresh physical count, measured against what the system expects — and a
   * box pre-filled with the system's own expectation is answered by pressing Save, which records
   * "I counted, and it agreed" when nobody counted and buries the difference a count exists to
   * find. So: filled and editable before there is a history, and not offered at all after.
   *
   * Seeded ONCE per item, keyed by id. A flag set for the component's lifetime is how this form
   * came to open a second item holding the first one's boxes.
   */
  const shelfSeeded = useRef<string | null | undefined>(undefined);
  /** A recount changes the current shelf, never the opening movement it corrects. */
  const [stockReason, setStockReason] = useState('');

  /*
   * WHAT ONE OF THEM COST, in the shape the shop buys in.
   *
   * `open_stock_by_count` has taken a unit cost since 0078 and this form has always sent null, so a
   * shop opening with a full shelf opened with no cost against it: every margin read as pure profit
   * until the first delivery dragged the average up from zero.
   *
   * One figure, not one per shape. A crate cost and a bottle cost are the same fact said twice and
   * can contradict each other; a shop knows what it pays for a crate.
   */
  /*
   * WHEN IT GOES OFF — and a shelf is routinely more than one answer.
   *
   * The same product is often two or three deliveries deep with different dates on it: forty
   * crates going off in March and twelve in June. That is two facts, and averaging them into one
   * loses the only one worth acting on. So the dates are LINES, and the quantities on them have to
   * add up to what was counted above — the two are descriptions of one shelf.
   *
   * Entirely optional. Plenty of stock has no date on it at all, and a form that insisted would be
   * asking most shops to invent one.
   */
  /*
   * DATED STOCK, LINE BY LINE — and each line says WHICH SHAPE.
   *
   * The first version asked "how many crates" and a date, over and over, because it assumed a
   * shelf is all one shape. It is not: eight crates going off in September, three more in October,
   * and two loose bottles in October as well. Three lines, two shapes, and the old form could only
   * express the first two.
   *
   * So a line is a shape, a quantity and a date, added one at a time — and `storeUnitId` is what
   * makes the arithmetic work, because the count they have to add up to is in BASE units and a
   * crate is not a bottle.
   */
  const [batches, setBatches] = useState<
    { key: string; storeUnitId: string; qty: string; expiresOn: string }[]
  >([]);

  /** The line being composed, above the list. Not a blank row IN the list: an abandoned half-typed
   *  line would otherwise be saved as stock with no date, or a date with no stock. */
  /*
   * WHETHER THIS ITEM HAS EVER HAD STOCK — which decides whether the edit form may offer to open it.
   *
   * A shop adds an item in a hurry and skips the count, the dates and the empties, then comes back
   * to fill them in. That has to work, and it has to work WITHOUT adding stock twice: opening stock
   * is a movement, so offering it on an item that already has movements would add to the shelf
   * rather than describe it.
   *
   * `null` while the answer is unknown, so the section stays hidden rather than flashing open and
   * then away — and an item being CREATED has no id to ask about, which is its own answer.
   */
  const [hadStock, setHadStock] = useState<boolean | null>(null);
  useEffect(() => {
    if (!product?.id) {
      setHadStock(false);
      return;
    }
    let alive = true;
    void hasStockHistory(product.id)
      .then((has) => alive && setHadStock(has))
      // Unknown stays unknown: guessing "no" here is the guess that doubles a shelf.
      .catch(() => alive && setHadStock(true));
    return () => {
      alive = false;
    };
  }, [product?.id]);

  const [batchUnit, setBatchUnit] = useState<string>('');
  const [batchQty, setBatchQty] = useState('');
  const [batchDate, setBatchDate] = useState('');

  /*
   * THIS ITEM'S OWN "RUNNING LOW" LEVEL, if it is an exception.
   *
   * Blank means "use the shop's rule", which is the right default for almost everything. A shop
   * sets this on the few lines it cannot afford to run out of — and on the slow ones it does not
   * want shouting at it.
   */
  const [lowStock, setLowStock] = useState(
    product?.ownLowStockLevel == null ? '' : String(product.ownLowStockLevel),
  );


  /*
   * AND THE EMPTIES THE SHOP ITSELF IS HOLDING, per shape that comes back.
   *
   * This box used to ask "Containers already out with customers", which is a different question
   * with a different owner: what a customer owes is entered against THAT CUSTOMER, on the customer
   * form, through `backfill_empties` — which takes a customer id, because an obligation without
   * one belongs to nobody. Asked here it had no customer to attach to, and the answer was
   * accordingly written nowhere: a required field, guarded on save, whose value never left the
   * component. A field that cannot change anything is worse than a missing one, because it looks
   * answered.
   *
   * What the product form CAN answer for is the empty crates and bottles stacked in the shop's own
   * yard on the day it starts.
   */
  const [emptiesByShape, setEmptiesByShape] = useState<Record<string, string>>({});


  /*
   * What it is bought and sold in, and the cheaper prices for buying more.
   *
   * Held here and saved with the name, so a shop answers the whole question in one place. For an
   * item being edited these arrive from the server; for a new one they start empty and the form
   * refuses to save until at least one thing is sellable.
   */
  const {
    units: existingUnits,
    loaded: existingUnitsLoaded,
    error: existingUnitsError,
    reload: reloadExistingUnits,
  } = useProductUnits(product?.id ?? null);
  const { units: storeUnits, add: addStoreUnit, loaded: storeUnitsLoaded } = useStoreUnits(storeId);
  /*
   * WHICH GROUPS THIS IS IN — several, on purpose.
   *
   * Goldberg is a beer, it comes in a PET bottle, and Nigerian Breweries made it. Three groupings
   * answering three different questions, and a distributor uses all of them — because the EMPTIES
   * belong to the brewery and are interchangeable across everything bought from it. An NBL crate
   * takes any NBL bottle, so "who made it" is what the lorry asks when it comes to collect, and
   * "what shelf does it sit on" is a different question entirely.
   */
  const { groups, add: addGroup, loaded: groupsLoaded } = useProductGroups(storeId ?? null);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [pickingGroups, setPickingGroups] = useState(false);
  const groupPickerId = useId();

  const [units, setUnits] = useState<ProductUnit[]>([]);

  /*
   * THE SHAPES THE SHELF IS COUNTED IN — the shop's own answer, not a guess about size.
   *
   * `is_counted` exists for exactly this: a distributor counts crates, not bottles, even when it
   * sells both. Falling back to every shape when nothing is ticked, because a form that asks for
   * nothing on an item whose shapes are all untick ed cannot record any opening stock at all, and
   * silently having no stock is the failure this section exists to prevent.
   */
  /*
   * EVERY SHAPE GETS A BOX.
   *
   * This filtered on `is_counted` and fell back to all shapes when nothing was ticked. The tick is
   * gone — a shape exists because the shop has a word for it, and anything it has a word for it can
   * count — so the fallback is the whole rule. Named shapes only: a half-typed row has no word yet.
   */
  const countedShapes = units.some((u) => u.name.trim() !== '')
    ? units.filter((u) => u.name.trim() !== '')
    : units;


  /** And the shapes that come back empty — a crate and a bottle answer separately. */
  const returnableShapes = units.filter((u) => u.isReturnable);

  /*
   * WHAT EACH SHAPE IS WORTH, worked out here rather than read off the shape.
   *
   * `baseQty` is derived by a trigger on save, so every shape on an item being added still says 1
   * — including the crate the shop has just said holds twelve bottles. Multiplying by it would
   * record twelve crates as twelve bottles.
   */
  const baseOf = baseQtyByShape(units);
  const totalFrom = (typed: Record<string, string>, shapes: ProductUnit[]) =>
    shapes.reduce((sum, u) => {
      const said = Number(typed[u.storeUnitId]);
      return sum + (Number.isFinite(said) ? said : 0) * (baseOf[u.storeUnitId] ?? 0);
    }, 0);

  /*
   * THE SHAPE A COST IS ASKED IN.
   *
   * What the shop BUYS in, because that is the figure on the invoice. Failing that the biggest
   * shape it counts in, which is the next closest thing to how the stock arrives.
   */
  const costShape =
    units.find((u) => u.isBought) ??
    [...countedShapes].sort((a, b) => (baseOf[b.storeUnitId] ?? 1) - (baseOf[a.storeUnitId] ?? 1))[0];

  /*
   * The dated lines are in the SHAPE THE COST IS IN — the biggest counted shape, the one a shop
   * says "forty crates" about — so they are converted to base units the same way the count is
   * before the two are compared.
   */
  /*
   * What the dated lines come to, IN BASE UNITS — each converted by its own shape.
   *
   * This used the cost shape for every line, which was only ever right when the whole shelf was
   * one shape. Two bottles counted as two crates is the kind of wrong that balances on screen and
   * is refused by the server.
   */
  const batchBase = batches.reduce(
    (sum, b) => sum + (Number(b.qty) || 0) * (baseOf[b.storeUnitId] ?? 1),
    0,
  );
  const anyBatch = batches.length > 0;

  const shelfBase = totalFrom(shelfByShape, countedShapes);
  const anyShelfSaid = countedShapes.some((u) => (shelfByShape[u.storeUnitId] ?? '').trim() !== '');

  /*
   * WHAT THE BOXES WERE FILLED WITH, so a count is only taken when somebody changed them.
   *
   * The edit form fills the boxes with what is on hand, so "something is in the boxes" was true on
   * every save — and every save of an item with a history, a new name or a new price included,
   * demanded "why is this count being corrected?" and recorded a recount nobody made. A count now
   * happens when the figures differ from the ones loaded into them; a box left as it was is not a
   * count.
   */
  const [seededShelf, setSeededShelf] = useState<Record<string, string> | null>(null);
  const shelfEdited =
    seededShelf === null
      ? anyShelfSaid
      : countedShapes.some(
          (u) => (shelfByShape[u.storeUnitId] ?? '').trim() !== (seededShelf[u.storeUnitId] ?? '').trim(),
        );

  /*
   * "WHEN DOES IT GO OFF?" AND "EXPIRY DATES ALREADY RECORDED" WERE THE SAME SECTION TWICE.
   *
   * The shop spotted it: "they are same dry duplicate that we did not see". One composed new
   * dated lots and listed them; the other listed the lots already on the shelf so their dates
   * could be corrected. Two headings, two layouts, two places to look - for one question, which
   * is "what is on this shelf, and when does each part of it go off".
   *
   * So there is one section now. THE LINES COME FIRST, which is also what was asked for, and the
   * form to add another sits under them: a shop reads what it has already said before saying
   * anything else, and a composer above its own output reads as though the list belonged to the
   * next thing rather than the last.
   */

  /*
   * The groups this product is already in.
   *
   * Only when editing: a new product has none, and asking the server about an id that does not
   * exist yet is a round trip whose answer is always empty.
   *
   * READ, THEN COPIED ONCE into the form. It used to be copied only on success and otherwise left
   * at none — and the form's save then wrote none over the product's real groups. The form now
   * waits for this (see `seedStatus`), so what is saved always started from what was there.
   */
  const editingId = product?.id ?? null;

  useEffect(() => {
    if (shelfSeeded.current === editingId) return;
    /*
     * FILLED WHETHER OR NOT THE SHELF HAS A HISTORY — asked for twice, and right both times.
     *
     * I first left this empty once stock had moved, on the reasoning that a box pre-filled with
     * the system's own figure gets answered by pressing Save, recording "I counted and it agreed"
     * when nobody counted. That danger is real but it is already answered elsewhere on this form:
     * an item with a history REQUIRES a written reason before a count is accepted, so nothing is
     * recorded by pressing Save alone.
     *
     * What was left was a section headed "What you have now" showing nothing, on an item holding
     * five crates — which reads as the form having failed to load, and is the one thing a shop
     * cannot be asked to work around.
     */
    if (!editing || !existingUnitsLoaded) return;
    if (countedShapes.length === 0) return;
    shelfSeeded.current = editingId;
    const onHand = Number(product?.onHand ?? 0);
    if (!(onHand > 0)) return;
    /*
     * Split largest shape first, the way the shelf is read: 66 is 5 crates and 6 bottles, not
     * 66 bottles and not 5.5 crates. The remainder falls to the next shape down, which is what
     * `stockInShapes` says in words — this is the same arithmetic, put in the boxes.
     */
    const bySize = [...countedShapes].sort(
      (a, b) => (baseOf[b.storeUnitId] ?? 1) - (baseOf[a.storeUnitId] ?? 1),
    );
    let left = onHand;
    const next: Record<string, string> = {};
    bySize.forEach((u, i) => {
      const per = baseOf[u.storeUnitId] ?? 1;
      const whole = i === bySize.length - 1 ? left / per : Math.floor(left / per);
      next[u.storeUnitId] = String(Number(whole.toFixed(4)));
      left -= whole * per;
    });
    setShelfByShape(next);
    setSeededShelf(next);
  }, [editing, editingId, hadStock, existingUnitsLoaded, countedShapes, baseOf, product?.onHand]);
  const expirySeed = useLoadArea(() => productExpiryLayers(editingId as string), [editingId], {
    key: `product-expiry-lots:${editingId ?? 'none'}`,
    scope: SHAPES_SCOPE,
    whenNot: !editingId,
  });

  /** The lots already on this shelf. Empty on a new item, which has none by definition. */
  const lotsOnShelf = editing ? (expirySeed.data ?? []) : [];

  /*
   * DATING STOCK THAT IS ALREADY THERE (0224).
   *
   * "we could not even edit the expiry date ... the only thing stopped from editing is initial
   * stock and empties when history exists." The composer below belonged to the opening count, so
   * it vanished the moment an item had a history — and an item counted without dates has no lot
   * to correct either, so there was nowhere at all to say when it goes off.
   *
   * With a history, the lines date part of what is on the shelf and NOT YET DATED: the shelf less
   * the lots that already carry a date. They move no stock — `date_shelf_stock` splits an undated
   * lot, or makes one for stock that has none.
   */
  const datingExisting = editing && hadStock === true;
  /*
   * Lots shown as RECORDED — date correctable, quantity fixed — only once the item has a history.
   * Before that they are still the opening's own lines, and they are loaded into the editable list
   * below instead: the latest ones given are the ones kept (`set_opening_stock`).
   */
  const recordedLots = datingExisting ? lotsOnShelf : [];

  /*
   * BEFORE STOCK HISTORY, THE DATED LOTS ARE THE OPENING'S LINES, editable like the shelf.
   *
   * Loaded once per item into the list the shop edits, each in the largest shape it fills exactly
   * (2 Cans rather than 48 pieces), and remembered so a save that changed nothing writes nothing.
   */
  const batchesSeeded = useRef<string | null>(null);
  const [seededBatches, setSeededBatches] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || hadStock !== false || !editingId) return;
    if (batchesSeeded.current === editingId) return;
    if (!existingUnitsLoaded || countedShapes.length === 0 || expirySeed.data == null) return;
    batchesSeeded.current = editingId;
    const bySize = [...countedShapes].sort(
      (a, b) => (baseOf[b.storeUnitId] ?? 1) - (baseOf[a.storeUnitId] ?? 1),
    );
    const lines = (expirySeed.data ?? [])
      .filter((l) => l.expiresOn && Number(l.remaining) > 0)
      .map((l, i) => {
        const left = Number(l.remaining);
        const shape =
          bySize.find((u) => left % (baseOf[u.storeUnitId] ?? 1) === 0) ?? bySize[bySize.length - 1];
        const per = baseOf[shape.storeUnitId] ?? 1;
        return {
          key: `seed-${l.layerId ?? i}`,
          storeUnitId: shape.storeUnitId,
          qty: String(left / per),
          expiresOn: l.expiresOn as string,
        };
      });
    setBatches(lines);
    setSeededBatches(JSON.stringify(lines.map(({ storeUnitId, qty, expiresOn }) => [storeUnitId, qty, expiresOn])));
  }, [editing, editingId, hadStock, existingUnitsLoaded, countedShapes, baseOf, expirySeed.data]);
  const batchesEdited =
    JSON.stringify(batches.map(({ storeUnitId, qty, expiresOn }) => [storeUnitId, qty, expiresOn])) !==
    (seededBatches ?? '[]');
  const datedOnShelf = recordedLots
    .filter((l) => l.expiresOn)
    .reduce((sum, l) => sum + l.remaining, 0);
  const dateRoom = datingExisting ? Math.max(shelfBase - datedOnShelf, 0) : shelfBase;
  const canAddBatches =
    countedShapes.length > 0 &&
    (datingExisting ? dateRoom > 0 : (!editing || hadStock === false) && shelfBase > 0);
  const [expiryDates, setExpiryDates] = useState<Record<string, string>>({});
  const [expiryUpdating, setExpiryUpdating] = useState<string | null>(null);
  /*
   * WHY THIS DATE IS BEING CORRECTED, asked on the lot being corrected.
   *
   * `saveExpiry` demanded `stockReason` — the "why is this count being corrected?" box, which only
   * appears when the shop is ALSO entering a fresh shelf count. Anyone correcting just a date got
   * "Say why this expiry date is being corrected" over a screen with nowhere to say it. The Save
   * button could not succeed at all unless two unrelated corrections happened to be made together.
   */
  const [expiryReason, setExpiryReason] = useState<Record<string, string>>({});
  const groupsSeed = useLoadArea(() => groupsFor(editingId as string), [editingId], {
    key: `product-groups-of:${editingId ?? 'none'}`,
    scope: GROUPS_SCOPE,
    whenNot: !editingId,
  });
  const groupsSeeded = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (groupsSeeded.current === editingId || !groupsSeed.data) return;
    groupsSeeded.current = editingId;
    setGroupIds(groupsSeed.data.map((g) => g.id));
  }, [editingId, groupsSeed.data]);

  /*
   * Whether the rest of the form has anything to attach itself to.
   *
   * NOT `unitProblems(units) === null`, which is the save rule and is stricter — it wants a sold
   * shape and every measurement filled in. Gating on that makes the sections below flicker out
   * while somebody is halfway through typing "12" into a crate, which is worse than showing them
   * early. One named shape is enough for "how many on the shelf?" to have an answer.
   */
  const hasAShape = units.some((u) => u.name.trim() !== '');
  const [discounts, setDiscounts] = useState<Discount[]>([]);

  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = useProblem();

  /*
   * Fill from props once the product arrives.
   *
   * As a page this mounts before `useProduct` has resolved an edit target, so the fields start
   * empty and fill in when it does. Keyed on the product itself rather than on a visibility flag,
   * which is what the sheet used — and what made it show the PREVIOUS product's details when
   * opened a second time, so the seller edited the wrong record.
   */
  useEffect(() => {
    setName(product?.name ?? initialName);
    setSku(product?.sku ?? '');
    setBarcode(product?.barcode ?? '');
  }, [product, initialName]);

  /*
   * The units this item already has, once they arrive.
   *
   * Copied into local state rather than edited in place: this is a form, and nothing reaches the
   * shop until Save. Guarded on length so a re-render cannot overwrite edits in progress with the
   * server's copy — the same shape as filling the name above.
   */
  /*
   * A unit invented on the pushed page, put straight into the picker.
   *
   * This page never unmounts while the unit form sits on top of it, so nothing would otherwise
   * tell the picker the shop has a new word — and it was missing until somebody reloaded. Added
   * to the cache rather than refetched: this device made the change and already knows the answer.
   */
  const onUnitCreatedRef = useRef<(unit: StoreUnit) => void>(() => {});
  onUnitCreatedRef.current = (unit) => addStoreUnit(unit);

  useEffect(() => {
    const cleanup = nav.provideObject(
      'onUnitCreated',
      () => (unit: StoreUnit) => onUnitCreatedRef.current(unit),
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  /*
   * And the same for a group, including TICKING IT.
   *
   * Somebody who has just gone and named "Nigerian Breweries" has said what this product's maker
   * is; landing back on a picker where it exists but is not chosen asks the question twice.
   */
  const onGroupCreatedRef = useRef<(group: ProductGroup) => void>(() => {});
  onGroupCreatedRef.current = (group) => {
    addGroup(group);
    setGroupIds((prev) => (prev.includes(group.id) ? prev : [...prev, group.id]));
  };

  useEffect(() => {
    const cleanup = nav.provideObject(
      'onGroupCreated',
      () => (group: ProductGroup) => onGroupCreatedRef.current(group),
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  // Copied once the server has answered — an answer of none included, which is not the same as
  // not having heard yet.
  const seeded = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seeded.current === editingId || !existingUnitsLoaded) return;
    seeded.current = editingId;
    setUnits(existingUnits);
  }, [editingId, existingUnits, existingUnitsLoaded]);

  // The discount bands, read and copied once, the same way — a failed read used to leave none, and
  // saving then deleted every band the item had.
  const discountsSeed = useLoadArea(() => fetchDiscounts(editingId as string), [editingId], {
    key: `product-discounts:${editingId ?? 'none'}`,
    scope: SHAPES_SCOPE,
    whenNot: !editingId,
  });
  const discountsSeeded = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (discountsSeeded.current === editingId || !discountsSeed.data) return;
    discountsSeeded.current = editingId;
    setDiscounts(discountsSeed.data);
  }, [discountsSeed.data, editingId]);

  /*
   * The unit a product ROW is measured in.
   *
   * `products.base_unit` points at a fixed global list and is only a fallback label now — the
   * shop's own units carry the meaning. Rather than asking a question whose answer is already
   * implied, it is read off the smallest thing the shop said it sells, matched by name, and falls
   * back to pieces. A shop selling litres gets litres; a shop selling crates of drinks gets pieces,
   * which is what a crate is made of.
   */
  const impliedBaseUnit = (): string => {
    const sold = units.filter((u) => u.isSold);
    if (sold.length === 0) return 'piece';
    const smallest = sold.reduce((a, b) => (b.baseQty < a.baseQty ? b : a));
    const match = UNITS.find((g) => g.code === smallest.name.toLowerCase());
    return match?.code ?? 'piece';
  };


  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      problem.show('Give the item a name.');
      return;
    }

    /*
     * REQUIRED, AND ZERO IS AN ANSWER.
     *
     * Blank is refused; "0" is accepted and recorded. The difference is the whole point — a shop
     * that has run out of something is a fact worth writing down, and a shop that never looked is
     * a figure nobody should trust. Only in `minimum` mode, because that is the moment somebody is
     * standing in front of the shelf.
     */
    const shelfBlank = countedShapes.filter(
      (u) => (shelfByShape[u.storeUnitId] ?? '').trim() === '',
    );
    if (minimum && shelfBlank.length > 0) {
      problem.show(
        `How many ${shelfBlank.map((u) => u.plural.toLowerCase()).join(' and ')} are on the shelf ` +
          'right now? Put 0 where there are none.',
      );
      return;
    }
    /*
     * A CONTAINER THAT COMES BACK NEEDS A MAKER TO COME BACK TO.
     *
     * The pool is the maker plus the shape — "Nigerian Breweries (NBL) crate" — which is how the
     * shop's own pools are named and why any NBL crate settles any other. Both halves are already
     * on the form, so nothing is asked twice; what cannot be worked out is a product in no group at
     * all, and that is asked once here rather than per shape, because the answer is the same for
     * every shape on the item.
     */
    if (units.some((u) => u.isReturnable) && groupIds.length === 0) {
      problem.show(
        'Say who makes this before saying its containers come back. Empties go back to whoever ' +
          'made them, so a crate needs a maker to go back to.',
      );
      return;
    }

    /*
     * Required with ZERO ACCEPTED at a counter. Blank and nought are different facts, and a form
     * that takes a blank makes every new item silently claim it is holding nothing.
     *
     * Asked of each shape that comes back, because a shop holding forty empty crates and no loose
     * bottles has two different answers and one box could carry neither honestly.
     */
    const emptiesBlank = returnableShapes.filter(
      (u) => (emptiesByShape[u.storeUnitId] ?? '').trim() === '',
    );
    if (minimum && emptiesBlank.length > 0) {
      problem.show(
        `How many empty ${emptiesBlank.map((u) => u.plural.toLowerCase()).join(' and ')} are you ` +
          'holding? Put 0 where you have none.',
      );
      return;
    }

    const wrong = unitProblems(units);
    if (wrong) {
      problem.show(wrong);
      return;
    }

    setSaving(true);
    try {
      const supabase = getSupabase();
      let id = product?.id ?? '';

      if (editing && product) {
        const { error } = await supabase.rpc('update_product', {
          p_product_id: product.id,
          p_name: trimmed,
          // Empty string CLEARS; null leaves alone. The form always knows its own value, so it
          // always sends one — a blank box means the seller removed the code.
          p_sku: sku.trim(),
          p_barcode: barcode.trim(),
          p_category_id: null,
          /*
           * No list price any more.
           *
           * Price belongs to a UNIT — a crate and a bottle are not the same money — and asking for
           * one figure per product is what produced a receipt reading "1 piece, ₦4,500" for
           * something sold by the pack. Null leaves whatever is there alone.
           */
          p_list_price: null,
        });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.rpc('create_product', {
          p_store_id: storeId,
          p_name: trimmed,
          p_base_unit: impliedBaseUnit(),
          // The one-pack model, no longer asked for and no longer sent.
          p_pack_name: null,
          p_pack_qty: null,
          p_list_price: null,
          p_price_per_pack: false,
        });
        if (error) throw error;
        id = data as string;

        // Codes are a second call: create_product predates them and widening it would mean a
        // second overload of a function half the app already calls.
        if (sku.trim() || barcode.trim()) {
          await supabase.rpc('update_product', {
            p_product_id: id,
            p_name: null,
            p_sku: sku.trim(),
            p_barcode: barcode.trim(),
            p_category_id: null,
            p_list_price: null,
          });
        }
      }

      /*
       * WHAT KIND OF THING IT IS, saved against the id.
       *
       * After the product exists, because a new one has no id until `create_product` answers.
       * `set_product_groups` also keeps `products.category_id` pointing at the first group — the
       * stock list and the receipt still read that column, and it has exactly one writer so it
       * cannot drift.
       */
      await setProductGroups(id, groupIds);

      /*
       * Units before discounts, because a discount points at a unit.
       *
       * Saving the units also rebuilds what the till reads, so the sale units a band refers to
       * exist by the time the bands are written.
       */
      await saveProductUnits(id, units);
      await saveDiscounts(id, discounts);

      /*
       * Only when it has actually changed. Writing it every save would touch the column on every
       * edit of a name, and `null` and `0` mean different things here — sending one for the other
       * would silently switch an item between "use the shop's rule" and "tell me only at none".
       */
      const wantedLow = lowStock.trim() === '' ? null : Number(lowStock);
      const hadLow =
        product?.ownLowStockLevel == null ? null : Number(product.ownLowStockLevel);
      /*
       * Only when it has actually changed, and only when this form was in a position to know what
       * it was. `ownLowStockLevel` is undefined on a row that came from a reader which does not
       * return it — a search result handed straight to the form, say — and writing on the strength
       * of that would clear a level the form never showed.
       */
      const knew = !product || product.ownLowStockLevel !== undefined;
      if (knew && wantedLow !== hadLow) await setProductLowStock(id, wantedLow);

      /*
       * The opening facts, AFTER the units — a count is in base units and the units define them.
       *
       * Ordered rather than parallel, and deliberately: if the returnable link fails, the shop
       * still has an item it can sell, and the failure says so. The reverse — a returnable pool
       * pointing at a product whose units never saved — is a row nobody can read.
       */
      /*
       * SUMMED INTO BASE UNITS, with each shape's worth taken from the TREE.
       *
       * `open_stock_by_count` counts in base units, and the shapes were just saved, so their own
       * `baseQty` is still the placeholder 1 this device started them at. `baseQtyByShape` walks
       * what the shop actually said — twelve bottles to a crate — which is the only figure here
       * that is not a guess.
       */
      /*
       * WHAT THE SHELF NOW HOLDS, when this save wrote it — handed back on the row so every list
       * shows it at once. The row used to keep the figure the form was opened with, and each list
       * was patched with that: Chivita set to 3 Cans went on reading 3 pieces everywhere.
       */
      let shelfWritten: number | null = null;
      const batchLines = batches
        .filter((b) => Number(b.qty) > 0)
        .map((b) => ({
          qty: Number(b.qty) * (baseOf[b.storeUnitId] ?? 1),
          expires_on: b.expiresOn || null,
        }));

      if (!editing && anyShelfSaid) {
        shelfWritten = shelfBase;
        const { error } = await supabase.rpc('open_stock_by_count', {
          p_store_id: storeId,
          p_product_id: id,
          p_qty: shelfBase,
          /*
           * DIVIDED DOWN TO THE BASE UNIT, because that is what the writer stores.
           *
           * The shop said what a crate cost; stock is held in whatever the crate is made of. Sent
           * as typed it would record a bottle costing what twelve of them cost, and every margin on
           * the item would be wrong by a factor of twelve for as long as this stock lasted.
           */
          p_unit_cost:
            /*
             * NO COST IS ASKED FOR HERE ANY MORE.
             *
             * The form asked "what one crate cost you" beside the opening count, and a shop
             * setting up rarely knows — the answer was a guess that then became the margin on
             * every sale until the first delivery corrected it. A guess written into a cost is
             * worse than no cost: it looks like a figure somebody checked.
             *
             * Opening stock now lands with no cost and the first delivery sets it, which is where
             * the shop has a real number on a real invoice.
             */
            null,
          p_note: 'Counted when the item was added',
          /*
           * The dated lots, in base units like the count, or nothing at all. The server refuses a
           * set that does not add up to the count rather than quietly preferring one of them.
           */
          p_batches: anyBatch
            ? batches
                .filter((b) => Number(b.qty) > 0)
                .map((b) => ({
                  // In base units, each by ITS OWN shape: a crate of twelve and a loose bottle
                  // land on the same shelf and have to be counted in the same thing.
                  qty: Number(b.qty) * (baseOf[b.storeUnitId] ?? 1),
                  expires_on: b.expiresOn || null,
                }))
            : null,
        });
        if (error) throw error;
      } else if (editing && hadStock === false && (shelfEdited || batchesEdited) && anyShelfSaid) {
        /*
         * BEFORE STOCK HISTORY, THE SHELF FIGURE IS THE OPENING — and setting it is not a
         * correction. No reason, no count difference, nothing waiting for approval: the opening is
         * set to what is typed, and the dated lots to the latest ones given (0231).
         *
         * It used to go through a correction count, which recorded the new figure beside a ledger
         * that never moved — the shop set Chivita to 3 Cans and every screen went on saying 3
         * pieces. Once anything sells, is delivered or is damaged, this section is read-only and
         * the shelf changes by a count.
         */
        const { error } = await supabase.rpc('set_opening_stock', {
          p_product_id: id,
          p_qty: shelfBase,
          p_batches: batchLines.length > 0 ? batchLines : null,
        });
        if (error) throw error;
        shelfWritten = shelfBase;
      }

      if (datingExisting && anyBatch) {
        const { error: dateError } = await supabase.rpc('date_shelf_stock', {
          p_product_id: id,
          p_batches: batches
            .filter((b) => Number(b.qty) > 0)
            .map((b) => ({
              qty: Number(b.qty) * (baseOf[b.storeUnitId] ?? 1),
              expires_on: b.expiresOn || null,
            })),
          p_reason: stockReason.trim() || 'Dated on the shelf, from the item',
        });
        if (dateError) throw dateError;
      }

      /*
       * STOCK MOVED, so every screen showing it re-reads — the lists, the item's page, stock in
       * shapes, and whatever asks "was this counted today". A quantity is never taken on this
       * device's word alone: another till may be selling the same shelf.
       */
      if (shelfWritten !== null || (datingExisting && anyBatch)) {
        stockMoved();
        countsChanged();
      }

      /*
       * ONE POOL PER SHAPE THAT COMES BACK, and the pool's name is worked out.
       *
       * Maker plus shape: "Nigerian Breweries (NBL) crate". That is how the shop's pools are
       * already named, and it is the reason an NBL crate settles any other NBL crate whatever was
       * in it. `set_product_returnable` matches case-insensitively and creates only when nothing
       * matches, so a product whose maker and shape line up with an existing pool joins that one.
       *
       * `kind` follows the tree. A shape that goes inside something bigger is what was INSIDE the
       * container — the bottles — and one that goes inside nothing is the container itself. That is
       * the distinction `returnables_for_sale` branches on, and getting it wrong owes the customer
       * the wrong quantity for ever.
       */
      const maker = groups.find((g) => g.id === groupIds[0])?.name ?? '';

      /*
       * THE SHAPES AS SAVED, because a new one has no id until the shop has it.
       *
       * `saveProductUnits` replaces the list and does not hand the rows back, so the ids in local
       * state are blank for anything added on this visit. Naming a pool against a blank id would
       * store no shape at all and put the obligation back to a row per pool — four crates owing
       * four crates AND forty-eight bottles.
       */
      const { data: savedShapes } = await supabase.rpc('product_units_for', { p_product_id: id });
      const idOf = (storeUnitId: string) =>
        ((savedShapes ?? []) as { id: string; store_unit_id: string }[]).find(
          (r) => r.store_unit_id === storeUnitId,
        )?.id ?? null;
      /*
       * Keyed by shape, because the count of what is in the yard needs the same pool.
       *
       * `set_product_returnable` RETURNS the pool id — it is the thing that creates or finds it —
       * so keeping the answer costs nothing. Reading it back afterwards would be a second round
       * trip to learn something this device was just told, and the first attempt at it called an
       * RPC that does not exist.
       */
      const poolByShape: Record<string, string> = {};

      for (const u of units.filter((x) => x.isReturnable)) {
        const goesInsideSomething = units.some((x) => x.definedAgainst === u.storeUnitId);
        const { data: poolId, error } = await supabase.rpc('set_product_returnable', {
          p_store_id: storeId,
          p_product_id: id,
          p_category_name: `${maker} ${u.name}`.trim(),
          p_kind: goesInsideSomething ? 'content' : 'container',
          p_qty_per_base_unit: 1,
          p_deposit: 0,
          /*
            WHICH SHAPE this pool is for, so a sale can owe in the shape it sold.
            Four crates out owes four crates — not four crates and forty-eight bottles, which is
            what a pool with no shape against it produces.
          */
          p_product_unit_id: idOf(u.storeUnitId),
        });
        if (error) throw error;
        if (poolId) poolByShape[u.storeUnitId] = poolId as string;
      }

      /*
       * AND WHAT IS IN THE SHOP'S OWN YARD, counted per pool.
       *
       * After the pools, not with them: the count points at a pool, and `set_product_returnable`
       * is what creates or finds it. Read back rather than assumed, for the same reason the shapes
       * are — the pool may be one this shop already had, under an id this device has never seen.
       *
       * A shape left blank writes nothing. Zero is an answer and is recorded as one; a blank is
       * "nobody looked", and inventing a nought for it would put a figure on the yard that nobody
       * ever counted.
       */
      if (returnableShapes.length > 0) {
        for (const u of returnableShapes) {
          const said = (emptiesByShape[u.storeUnitId] ?? '').trim();
          if (said === '') continue;
          const pool = poolByShape[u.storeUnitId];
          if (!pool) continue;

          const { error } = await supabase.rpc('count_empties_on_hand', {
            p_store_id: storeId,
            p_category_id: pool,
            p_qty: Number(said) || 0,
            p_note: editing ? 'Counted while the product was corrected' : 'Counted when the item was added',
          });
          if (error) throw error;
        }
      }

      /*
       * The row, built from what this device just did.
       *
       * Nothing here is invented: a brand-new item has nothing on the shelf and nothing spent on
       * it, and an edited one keeps the figures it already had while taking the name and codes
       * that were just typed.
       */
      const row: Product = {
        ...(product ?? {
          baseUnit: impliedBaseUnit(),
          categoryId: null,
          categoryName: null,
          avgUnitCost: '0',
          costIsEstimated: false,
          onHand: '0',
          packId: null,
          packName: null,
          packQty: null,
          listPrice: null,
          // A new item is judged by the shop's own rule until somebody gives it one of its own.
          lowStockLevel: null,
          ownLowStockLevel: null,
        }),
        id,
        /*
         * The level as of this save, over whatever the spread above brought in.
         *
         * `lowStockLevel` is the RESOLVED figure and the shop's general level is not known here,
         * so when the exception is being removed the old resolved value is kept until the re-read
         * says otherwise — a moment of the previous answer, rather than a card that says no level
         * at all on a shop that has one.
         */
        ownLowStockLevel: wantedLow === null ? null : String(wantedLow),
        lowStockLevel:
          wantedLow === null ? (product?.lowStockLevel ?? null) : String(wantedLow),
        name: trimmed,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
        ...(shelfWritten !== null ? { onHand: String(shelfWritten) } : {}),
      };

      onSaved({ id, name: trimmed, row, created: !editing });
    } catch (e) {
      problem.show(messageOf(e, 'That could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const saveExpiry = async (layerId: string, was: string | null) => {
    const next = (expiryDates[layerId] ?? was ?? '').trim() || null;
    if (next === was) return;
    /*
     * ITS OWN REASON, falling back to the count's only when one is genuinely being made. The
     * button that calls this is disabled until there is one, so this is the backstop rather than
     * the message anybody should ever see.
     */
    const why = (expiryReason[layerId] ?? '').trim() || stockReason.trim();
    if (!why) {
      problem.show('Say why this expiry date is being corrected.');
      return;
    }
    setExpiryUpdating(layerId);
    try {
      await setProductExpiry({ layerId, expiresOn: next, reason: why });
      setExpiryDates((current) => {
        const updated = { ...current };
        delete updated[layerId];
        return updated;
      });
      setExpiryReason((current) => {
        const updated = { ...current };
        delete updated[layerId];
        return updated;
      });
      await expirySeed.reload();
    } catch (e) {
      problem.show(messageOf(e, 'That expiry date could not be corrected.'));
    } finally {
      setExpiryUpdating(null);
    }
  };

  /*
   * AN ITEM BEING EDITED OPENS ONLY ONCE WHAT IT ALREADY HAS IS KNOWN.
   *
   * Shapes, groups and discount bands are each read and copied into the form, and the save writes
   * all three back as whole sets. Before, the form was usable while they were still arriving — or
   * after one had failed — so changing the price and pressing Save could replace the item's shapes,
   * groups or bands with nothing. The page's header stays; this part says what it is waiting for.
   */
  const waitFor = (
    known: boolean,
    error: string | null,
    what: string,
    onRetry: () => void,
  ): PageStatus | null =>
    known ? null : error ? { state: 'error', what, error, onRetry } : { state: 'loading', what };
  const seedStatus: PageStatus = !editingId
    ? { state: 'ready' }
    : (waitFor(existingUnitsLoaded, existingUnitsError, 'the shapes it comes in', reloadExistingUnits) ??
      waitFor(groupsSeed.data !== null, groupsSeed.error, 'its groups', groupsSeed.reload) ??
      waitFor(discountsSeed.data !== null, discountsSeed.error, 'its discounts', discountsSeed.reload) ?? {
        state: 'ready',
      });
  if (seedStatus.state !== 'ready') return <PageState status={seedStatus}>{() => null}</PageState>;

  return (
    <>
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not saved" />

      {/*
        No heading over the first question.

        "What it is" sat directly above "What is it called?", under a page already titled "Add an
        item you sell" — the same thing said three times before a shop has typed anything. The rule
        and the space below still separate this from the next section, which is what the heading
        was really for.
      */}
      <Field
        label="What is it called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Coca-Cola PET 60cl"
        hint="Write it the way you and your customers say it."
        autoFocus
      />

      {/*
        THE CODES FOLD AWAY WHEN THERE IS SOMEBODY WAITING.

        Nothing is removed — every field is one tap down — but a seller adding something mid-sale
        met "Your own code" and "Barcode" before anything the sale needs. `minimum` was changing
        which fields are required and leaving the order alone, which is half a job: the fastest way
        to make a form feel long is to put its optional half first.
      */}
      {minimum ? (
        <>
          <button
            type="button"
            className={styles.disclosure}
            onClick={() => setShowCodes((v) => !v)}
            aria-expanded={showCodes}
          >
            {showCodes ? 'Hide codes and barcode' : 'Codes and barcode'}
            <span aria-hidden="true">{showCodes ? '\u2212' : '+'}</span>
          </button>
          {showCodes && (
            <>
      <Field
        label="Your own code"
        optional
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="CC-PET-60"
        hint="Anything short you use to find it quickly. Leave empty if you do not use codes."
      />

      {/*
        Thirteen digits off a curved label, at a counter.

        Typed, that is the kind of task people abandon halfway — and a wrong barcode is worse than
        none, because it will match the wrong thing later. The phone already has a scanner.
      */}
      <Field
        label="Barcode"
        optional
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        placeholder="5449000000996"
        hint="The number under the bars on the label, if it has one."
      />

      <Button variant="secondary" fullWidth onClick={() => setScanning(true)}>
        <CameraIcon /> Scan it with the camera
      </Button>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onRead={(code) => {
          setBarcode(code);
          setScanning(false);
        }}
      />
            </>
          )}
        </>
      ) : (
        <>
      <Field
        label="Your own code"
        optional
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="CC-PET-60"
        hint="Anything short you use to find it quickly. Leave empty if you do not use codes."
      />

      {/*
        Thirteen digits off a curved label, at a counter.

        Typed, that is the kind of task people abandon halfway — and a wrong barcode is worse than
        none, because it will match the wrong thing later. The phone already has a scanner.
      */}
      <Field
        label="Barcode"
        optional
        value={barcode}
        onChange={(e) => setBarcode(e.target.value)}
        placeholder="5449000000996"
        hint="The number under the bars on the label, if it has one."
      />

      <Button variant="secondary" fullWidth onClick={() => setScanning(true)}>
        <CameraIcon /> Scan it with the camera
      </Button>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onRead={(code) => {
          setBarcode(code);
          setScanning(false);
        }}
      />
        </>
      )}

      {/*
        What it is bought in and sold in.

        This replaced "How do you count it?" and "What is a pack?" — the one-pack-per-product
        model, which real trade does not fit: oil arrives in bags and in kilogrammes and leaves by
        the litre, beer arrives in crates and leaves as crates, half crates and single bottles. A
        shop with any of that had to either lie to the form or keep the real answer in its head.

        The single "Price each" went with it. Price belongs to a UNIT — a crate and a bottle are
        not the same money — and one figure per product is what produced a receipt reading
        "1 piece, ₦4,500" for something sold by the pack.
      */}
      {/*
        WHAT KIND OF THING THIS IS.

        The form sent `p_category_id: null` on every save since it was written, so the stock list
        showed a category nothing could set — a field that cannot change anything, which is worse
        than a missing one because it looks answered.

        Above the shapes because a group says WHAT this is and a shape says how it is handled, and
        because the shapes gate everything below them: anything that does not depend on a shape
        belongs before that gate.
      */}
      <h2 className={styles.section}>What kind of thing is it?</h2>
      <p className={styles.sectionNote}>
        Groups are yours to name. A distributor usually wants the brewery — NBL, Guinness — and a
        shopkeeper usually wants the shelf. A product can be in as many as it needs.
      </p>

      <div className={styles.groups}>
        {groupIds.length > 0 && (
          <ul className={styles.groupChips}>
            {groupIds.map((id) => {
              const g = groups.find((x) => x.id === id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={styles.groupChip}
                    onClick={() => setGroupIds((prev) => prev.filter((x) => x !== id))}
                    aria-label={`Take it out of ${g?.name ?? 'this group'}`}
                  >
                    {g?.name ?? 'A group'} <CloseIcon size="0.9em" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          className={styles.groupAdd}
          onClick={() => setPickingGroups(true)}
        >
          <PlusIcon /> {groupIds.length > 0 ? 'Add another group' : 'Choose its groups'}
        </button>
      </div>

      <GroupPicker
        loading={!groupsLoaded}
        id={groupPickerId}
        isOpen={pickingGroups}
        close={() => setPickingGroups(false)}
        groups={groups}
        chosen={groupIds}
        onToggle={(id) =>
          setGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
        }
        /*
          THE SAME GESTURE AS "Add a unit you use" — a pushed form, not a silent call.

          This used to call `createGroup` straight from the picker behind a guard that began
          `if (!storeId || !typed.trim()) return;`. The sheet OPENS with an empty search box and the
          button reads "Make a new group" in that state, so the commonest press of it — open the
          sheet, press the only thing offering to add something — returned immediately and did
          nothing. No group, no page, no error. A control that cannot fail and cannot succeed.

          It also had nowhere to report a failure to: the catch was empty, on the reasoning that
          the picker stays open and the shop can try another name, which tells somebody whose group
          was refused precisely nothing.

          Pushed by the CALLER, like the unit form, because this component is rendered inside a
          stack and cannot know which one it is in.
        */
        onAddNew={(typed) => {
          /*
            CLOSED FIRST, then handed over — the way the unit picker does it.

            The sheet does not close itself when the form it asked for is pushed, so it stayed open
            OVER the new page: the group form arrived underneath the picker, with its own name field
            and its Make it button covered by the list the shop had just left. Everything worked and
            none of it could be reached.
          */
          setPickingGroups(false);
          onCreateGroup?.(typed);
        }}
      />

      <h2 className={styles.section}>The shapes it comes in</h2>
      <p className={styles.sectionNote}>
        A crate, and the bottles inside it. Say what each holds once, then tick what it is for —
        buying, selling, counting, deposits. Everything else on this item reads these.
      </p>
      <UnitsEditor
        units={units}
        setUnits={setUnits}
        storeUnits={storeUnits}
        storeUnitsLoading={!storeUnitsLoaded}
        onCreateUnit={(unitName) => onCreateUnit?.(unitName)}
      />

      {/*
        WHAT IS TRUE RIGHT NOW, asked while somebody is standing in front of the shelf.

        Only when creating. Editing an item a week later and being asked "how many are on the
        shelf?" invites a guess, and a guess written into stock is worse than no figure — it looks
        like a count.

        Required in `minimum` mode with ZERO ACCEPTED. Blank and nought are different facts and the
        form refuses to conflate them: a shop that has run out is worth recording, a shop that never
        looked is a number nobody should trust.
      */}
      {/*
        NOTHING BELOW THIS UNTIL THERE IS A SHAPE.

        Every question under here is ABOUT a shape. "On the shelf right now" is a number in one of
        them, and twelve means nothing until the form knows twelve of what; the container question
        asks about a shape nobody has named. Both used to sit there from the first keystroke, and in
        `minimum` mode they were marked required — so the fastest path through the form demanded
        answers it had not yet made answerable.

        A line rather than nothing at all, because a form that silently grows as you type it is
        unsettling. Say what is waiting and why.
      */}
      {!hasAShape && (
        <p className={styles.waiting}>
          Say what it comes in first. What is on the shelf, and whether the container comes back,
          are both about a shape — they will appear here once there is one.
        </p>
      )}

      {/*
        THE OPENING FACTS — on a new item, and on one that never got them.

        This was `!editing`, full stop, and the reasoning was sound: asking "how many are on the
        shelf?" a week later invites a guess, and a guess written into stock is worse than no
        figure because it looks like a count. But a shop that added an item in a hurry and skipped
        it had no way back at all, and their shelf stayed at nought for ever.

        So it is offered when the item has NEVER had stock recorded. Once it has, this section is
        gone and the count screen is the way — which is the right tool anyway: it records a count
        as a count, with the variance, rather than as an opening.
      */}
      {hasAShape && (
        <>
          <h2 className={styles.section}>What you have now</h2>
          <p className={styles.sectionNote}>
            {!editing
              ? 'Counted on the shelf, not worked out from deliveries. Most shops starting here have stock and no delivery history, and an invented delivery invents a cost.'
              : hadStock === false
                ? 'Still the opening: nothing has sold, been delivered or damaged since. Set it here as often as you need — once it moves, it changes by a count.'
                : hadStock === true
                  ? 'What is on the shelf now. It has moved since it was opened, so it changes by a count, not here.'
                  : 'Checking whether anything has moved it since it was opened…'}
          </p>
          {/*
            A BOX PER COUNTED SHAPE. "Crates on the shelf" and "Bottles on the shelf", not one
            number that never said which it meant.
          */}
          <div className={styles.shapeBoxes}>
            {countedShapes.map((u) => {
              /*
               * WHOLE ONES, IN EVERY BOX (0222).
               *
               * The shelf boxes used to take a half wherever the shape SELLS in halves, and offered
               * ½ and ¼ buttons for it — which is how Malta Guinness went in as 133.5 cans. A half
               * is how a can is sold, not how a shelf is counted: the half on the shelf is 12
               * pieces, and it goes in the Piece box. Only a weighed thing takes a fraction.
               */
              const rules = stockRules(u);
              const said = shelfByShape[u.storeUnitId] ?? '';
              const asNumber = Number(said);
              const offGrid =
                said.trim() !== '' && Number.isFinite(asNumber) && !isAllowedQty(asNumber, rules);
              const per = baseOf[u.storeUnitId] ?? 1;

              return (
                <div key={u.storeUnitId} className={styles.shapeBox}>
                <Field
                  label={u.plural}
                  numeric
                  required={minimum}
                  // After stock history the shelf changes by a count, not here.
                  readOnly={editing && hadStock !== false}
                  value={said}
                  onChange={(e) =>
                    setShelfByShape((prev) => ({ ...prev, [u.storeUnitId]: e.target.value }))
                  }
                  onBlur={() => {
                    if (said.trim() === '' || !Number.isFinite(asNumber)) return;
                    const snapped = snapQty(asNumber, rules);
                    if (snapped !== asNumber) {
                      setShelfByShape((prev) => ({
                        ...prev,
                        [u.storeUnitId]: String(snapped),
                      }));
                    }
                  }}
                  placeholder="0"
                  whole={u.wholeDigit}
                  error={
                    offGrid
                      ? `${u.plural} are counted in whole ones — put the part in a smaller shape.`
                      : null
                  }
                  hint={per > 1 ? `one is ${per}` : undefined}
                />

                </div>
              );
            })}
          </div>

          <p className={styles.sectionNote}>
            {minimum
              ? 'Put 0 where there are none. "None" and "did not look" are different answers.'
              : 'Leave them blank if you would rather count later.'}
          </p>


          {/* ── When it goes off ──────────────────────────────────────────────── */}
          {(canAddBatches || recordedLots.length > 0 || (editing && expirySeed.error)) && (
            <>
              <h3 className={styles.subsection}>When does it go off?</h3>
              <p className={styles.sectionNote}>
                {canAddBatches
                  ? datingExisting
                    ? 'Date what is on the shelf without one. It moves no stock — it only says which of it goes off when, and that sells first.'
                    : 'Only if it has a date on it. A shelf two deliveries deep has two lines, and they are not always the same shape.'
                  : 'Correct the date on a lot still on the shelf. It never changes its quantity, cost, or the order stock is sold in.'}
              </p>

              {editing && expirySeed.error && (
                <p className={styles.batchWarn}>
                  The dated lots could not be loaded: {expirySeed.error}
                </p>
              )}
              {editing && !expirySeed.error && expirySeed.data === null && (
                <p className={styles.sectionNote}>Loading the dated lots…</p>
              )}

              {/*
                THE LINES, ABOVE THE FORM THAT ADDS ONE.

                Two kinds sit here and they are genuinely different, so they look different: a lot
                ALREADY ON THE SHELF can have its date corrected but not its quantity — that
                quantity is stock history — while a line being added now can be taken off again,
                because nothing has been written yet.
              */}
              {recordedLots.map((layer) => {
                const value = expiryDates[layer.layerId] ?? layer.expiresOn ?? '';
                const changed = (value || null) !== layer.expiresOn;
                const why = expiryReason[layer.layerId] ?? '';
                const ready = changed && (why.trim() !== '' || stockReason.trim() !== '');
                return (
                  <div key={layer.layerId} className={styles.expiryLot}>
                    {/*
                      SAID IN THE SHAPES THE SHOP COUNTS IN.

                      This printed the raw base figure — "66 already on the shelf" — which is true
                      and useless: nobody has 66 of anything, they have 5 crates and 6 bottles.
                      The shop asked for this everywhere the base unit is still leaking through.
                    */}
                    <p className={styles.expiryLotWhat}>
                      {stockInShapes(
                        countedShapes.map((u) => ({
                          name: u.name,
                          plural: u.plural,
                          baseQty: baseOf[u.storeUnitId] ?? 1,
                          onHandBase: Number(layer.remaining),
                        })),
                      )}{' '}
                      <span>already on the shelf</span>
                    </p>
                    <Field
                      label="Goes off"
                      type="date"
                      value={value}
                      onChange={(e) =>
                        setExpiryDates((current) => ({
                          ...current,
                          [layer.layerId]: e.target.value,
                        }))
                      }
                    />
                    {/*
                      ASKED ONLY ONCE THE DATE HAS MOVED, and asked here rather than anywhere else.
                      A box demanding a reason for a correction nobody has made yet is a box that
                      reads as required before there is anything to explain.
                    */}
                    {changed && stockReason.trim() === '' && (
                      <div className={styles.expiryLotWhy}>
                        <Field
                          label="Why is this date being corrected?"
                          required
                          value={why}
                          onChange={(e) =>
                            setExpiryReason((current) => ({
                              ...current,
                              [layer.layerId]: e.target.value,
                            }))
                          }
                          placeholder="For example: keyed from the wrong carton"
                        />
                      </div>
                    )}

                    {/* Last, because it is the one control that commits the change. */}
                    {changed && (
                      <Button
                        variant="secondary"
                        className={styles.expiryLotSave}
                        busy={expiryUpdating === layer.layerId}
                        disabled={!ready || expiryUpdating !== null}
                        onClick={() => void saveExpiry(layer.layerId, layer.expiresOn)}
                      >
                        Save this date
                      </Button>
                    )}
                  </div>
                );
              })}

              {batches.length > 0 && (
                <ul className={styles.batchList}>
                  {batches.map((b) => {
                    const shape = countedShapes.find((u) => u.storeUnitId === b.storeUnitId);
                    const many = Number(b.qty) || 0;
                    return (
                      <li key={b.key} className={styles.batchLine}>
                        <button
                          type="button"
                          className={styles.batchRemove}
                          onClick={() => setBatches((prev) => prev.filter((x) => x.key !== b.key))}
                          aria-label="Remove this date"
                        >
                          <CloseIcon />
                        </button>
                        <span className={styles.batchWhat}>
                          {formatQtySpoken(many)}{' '}
                          {shape ? (many === 1 ? shape.name : shape.plural).toLowerCase() : ''}
                        </span>
                        <span className={styles.batchWhen}>
                          {b.expiresOn ? new Date(b.expiresOn).toLocaleDateString() : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              {editing && !expirySeed.error && recordedLots.length === 0 && !canAddBatches && (
                <p className={styles.sectionNote}>There are no dated lots on this shelf.</p>
              )}

              {/*
                ONE FORM, AND A LIST — not a form per line.

                It was a pair of boxes repeated down the page, one set per date, each asking "how
                many crates" because it assumed the whole shelf was crates. A shop with eight
                crates going off in September, three in October and two loose bottles in October
                could not say the third thing at all. Composing above and listing below is also
                how every other repeated thing in this app works: a charge, a deposit, a payment.
              */}
              {canAddBatches && (
              <div className={styles.batchCompose}>
                {countedShapes.length > 1 && (
                  <label className={styles.batchShape}>
                    <span className={styles.batchShapeLabel}>Shape</span>
                    <select
                      className={styles.batchSelect}
                      value={batchUnit || countedShapes[0].storeUnitId}
                      onChange={(e) => setBatchUnit(e.target.value)}
                    >
                      {countedShapes.map((u) => (
                        <option key={u.storeUnitId} value={u.storeUnitId}>
                          {u.plural}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {/*
                  The same amounts the shelf is counted in. A dated lot is part of that same
                  shelf, so "eight and a quarter crates going off in March" is the same typing
                  mistake here as it is above, and is caught the same way.
                */}
                {(() => {
                  const chosenShape =
                    countedShapes.find(
                      (u) => u.storeUnitId === (batchUnit || countedShapes[0].storeUnitId),
                    ) ?? countedShapes[0];
                  const rules = stockRules(chosenShape);
                  const asNumber = Number(batchQty);
                  const offGrid =
                    batchQty.trim() !== '' &&
                    Number.isFinite(asNumber) &&
                    !isAllowedQty(asNumber, rules);
                  return (
                    <Field
                      label="How many"
                      numeric
                      whole={chosenShape.wholeDigit}
                      value={batchQty}
                      onChange={(e) => setBatchQty(e.target.value)}
                      onBlur={() => {
                        if (batchQty.trim() === '' || !Number.isFinite(asNumber)) return;
                        const snapped = snapQty(asNumber, rules);
                        if (snapped !== asNumber) setBatchQty(String(snapped));
                      }}
                      placeholder="0"
                      error={
                        offGrid
                          ? `${chosenShape.plural} do not come in ${batchQty} — ` +
                            `${formatQtySpoken(snapQty(asNumber, rules))}?`
                          : null
                      }
                    />
                  );
                })()}
                <Field
                  label="Goes off"
                  type="date"
                  value={batchDate}
                  onChange={(e) => setBatchDate(e.target.value)}
                />

                <Button
                  variant="secondary"
                  fullWidth
                  disabled={!(Number(batchQty) > 0) || batchDate === ''}
                  onClick={() => {
                    const unit = batchUnit || countedShapes[0].storeUnitId;
                    setBatches((prev) => [
                      ...prev,
                      {
                        key: `${Date.now().toString(36)}-${prev.length}`,
                        storeUnitId: unit,
                        qty: batchQty,
                        expiresOn: batchDate,
                      },
                    ]);
                    /*
                     * The quantity and the date clear; the SHAPE does not. A shelf two deliveries
                     * deep is usually two lines of the same shape, and re-picking it every time is
                     * a tap for nothing.
                     */
                    setBatchQty('');
                    setBatchDate('');
                  }}
                >
                  <PlusIcon /> Add this date
                </Button>
              </div>
              )}

              {/*
                WHAT IS STILL UNDATED, counted down as the lines go on.

                The shop asked for this the way the count screen does it when stock is missing:
                the total stands there and each line takes from it, so somebody working down a
                delivery note can see how much is left to account for WHILE they account for it.

                Said in the shapes they counted in, not in base units. "340 of 500" means nothing
                to somebody holding crates; "13 crates and 4 bottles still to date" is the same
                fact in the words they used to type it.
              */}
              {dateRoom - batchBase > 0 && (
                <p className={styles.batchLeft}>
                  <span>Still to date</span>
                  <span className={styles.batchLeftQty}>
                    {stockInShapes(
                      countedShapes.map((u) => ({
                        name: u.name,
                        plural: u.plural,
                        baseQty: baseOf[u.storeUnitId] ?? 1,
                        onHandBase: dateRoom - batchBase,
                      })),
                    )}
                  </span>
                </p>
              )}

              {anyBatch && batchBase === dateRoom && (
                <p className={`${styles.batchLeft} ${styles.batchLeftDone}`}>
                  <span>Every one is dated.</span>
                </p>
              )}

              {/*
                AND THE OTHER WAY, which is not a remainder but a mistake. Said before saving, not
                after: the server refuses a set that does not add up, and being told at the save
                button — having typed a whole item — is being told too late.
              */}
              {batchBase > dateRoom && (
                <p className={styles.batchWarn}>
                  The dates cover{' '}
                  {stockInShapes(
                    countedShapes.map((u) => ({
                      name: u.name,
                      plural: u.plural,
                      baseQty: baseOf[u.storeUnitId] ?? 1,
                      onHandBase: batchBase,
                    })),
                  )}{' '}
                  {datingExisting ? ' but only ' : ' but you counted '}
                  {stockInShapes(
                    countedShapes.map((u) => ({
                      name: u.name,
                      plural: u.plural,
                      baseQty: baseOf[u.storeUnitId] ?? 1,
                      onHandBase: dateRoom,
                    })),
                  )}
                  {datingExisting
                    ? ' is on the shelf without a date.'
                    : '. They describe the same shelf, so they have to agree.'}
                </p>
              )}
            </>
          )}

          {/*
            The arithmetic said back, because nobody should have to trust a multiplication they
            cannot see. The count screen says the same thing for the same reason.
          */}
          {anyShelfSaid && countedShapes.length > 1 && (
            <p className={styles.saidBack}>
              That is{' '}
              {stockInShapes(
                countedShapes.map((u) => ({
                  name: u.name,
                  plural: u.plural,
                  baseQty: baseOf[u.storeUnitId] ?? 1,
                  onHandBase: shelfBase,
                })),
              )}{' '}
              on the shelf.
            </p>
          )}

          {/*
            AND WHAT IT COST, in the shape it is bought in.

            Optional, because a shop that genuinely does not know should not be made to invent a
            figure — an invented cost is worse than none, since it looks like a measurement. Left
            blank the stock opens with no cost and the first delivery sets it.
          */}
{/*
            AND THE EMPTIES IN THE SHOP'S OWN YARD, one box per shape that comes back.

            Not "already out with customers" — that is a fact about a CUSTOMER, entered against
            that customer on the customer form, and the answer given here was written nowhere at
            all. This is the other half a shop can actually see on day one: the stack of empty
            crates and loose empty bottles it is holding before it has sold anything.
          */}
          {/*
            AND ONLY FOR AN ITEM WITH NO GROUP.

            An item in a group is counted BY MAKER: a shop does not count Gulder crates and Star
            crates, it counts NBL crates, because that is what goes back on the lorry and what the
            yard screen totals. Asking per item as well would be asking the same crates twice, and
            the two answers would disagree the moment anybody moved one.

            So the box appears for the ungrouped items — the ones counted item by item, which is
            exactly the split the yard already makes.
          */}
          {returnableShapes.length > 0 && groupIds.length === 0 && (
            <>
              <h2 className={styles.section}>Empties you are holding</h2>
              <p className={styles.sectionNote}>
                Empty {returnableShapes.map((u) => u.plural.toLowerCase()).join(' and ')} stacked in
                your own yard right now — not the ones customers still have. What a customer owes
                you is entered on that customer.
              </p>

              <div className={styles.shapeBoxes}>
                {returnableShapes.map((u) => (
                  <Field
                    key={u.storeUnitId}
                    label={`Empty ${u.plural.toLowerCase()}`}
                    numeric
                    whole
                    required={minimum}
                    value={emptiesByShape[u.storeUnitId] ?? ''}
                    onChange={(e) =>
                      setEmptiesByShape((prev) => ({ ...prev, [u.storeUnitId]: e.target.value }))
                    }
                    placeholder="0"
                  />
                ))}
              </div>

              <p className={styles.sectionNote}>
                {minimum
                  ? 'Put 0 where you have none. "None" and "nobody looked" are different answers.'
                  : 'Leave them blank if you would rather count them later.'}
              </p>
            </>
          )}
        </>
      )}

      {/*
        WHEN TO BE TOLD THIS ONE IS RUNNING OUT.

        The shop sets a general level in Settings and it covers everything; this is the exception,
        and it wins wherever it is set. A shop learns which lines those are from selling them — it
        is the item that ran out on a Saturday that earns its own level — so this cannot live in the
        add-an-item half of the form, which is where it first went and where an existing item could
        never reach it.

        BLANK IS NOT ZERO. Blank puts the item back under the shop's rule; 0 is a real level meaning
        "tell me only when there are none at all", which is right for something rare that is ordered
        in when somebody asks.
      */}
      <h2 className={styles.section}>Tell me when it runs low</h2>
      <p className={styles.sectionNote}>
        Only if this one is different from the rest. Otherwise it follows the shop&apos;s general
        level, set in Settings.
      </p>
      <Field
        label={`Warn me at this many ${pluralUnit(impliedBaseUnit(), 2)}`}
        numeric
        value={lowStock}
        onChange={(e) => setLowStock(e.target.value)}
        placeholder="Use the shop's level"
      />

      <h2 className={styles.section}>Cheaper for buying more</h2>
      <p className={styles.sectionNote}>
        A price that applies once a customer takes enough of them. Optional.
      </p>
      <DiscountsEditor
        discounts={discounts}
        setDiscounts={setDiscounts}
        soldUnits={units.filter((u) => u.isSold)}
      />

      {/*
        The actions sit at the end of the page, not pinned to its foot.

        A pinned bar costs a row of the form on every phone this runs on, and this form is already
        eight fields long. Scrolling to the bottom to commit is also the honest gesture: you have
        just been asked eight questions, and the last thing you should see before saving is your
        answer to the eighth.
      */}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button busy={saving} onClick={() => void save()}>
          {editing ? 'Save changes' : 'Add it'}
        </Button>
      </div>
    </>
  );
}
