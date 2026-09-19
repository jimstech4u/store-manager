'use client';

import { useCallback, useMemo, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { countableEmpties, countYard, type CountPart, type CountableShape, YARD_SCOPE } from '@/lib/stacks/yard';
import { messageOf } from '@/lib/format';
import styles from './yard-count-page.module.css';

/** A maker whose containers come back, and the unit most of its items come back in. */
interface Maker {
  groupId: string;
  groupName: string;
  storeUnitId: string;
  items: number;
}

/** An item that belongs to no maker, with every shape of it that comes back. */
interface LooseItem {
  productId: string;
  productName: string;
  shapes: CountableShape[];
}

/** One counted stack, as it is listed before recording. */
interface Line {
  key: string;
  what: string;
  kind: 'maker' | 'item';
  qty: string;
  part: CountPart;
}

/**
 * Walking the yard with the phone in one hand.
 *
 * ONE FORM, NOT A WALL OF BOXES. It opened with a box for every maker and every item at once, which
 * is the thing the site's composer rule exists to prevent: nobody counts every stack on every walk,
 * and a page of twenty empty boxes has nineteen that do not apply today. It is the same composer as
 * the empties on a new customer now — pick what the stack is, say how many, Add — and what has been
 * counted is listed above until it is recorded.
 *
 * BY MAKER AND ITEM BY ITEM DO NOT OVERLAP. A stack of NBL crates is counted as NBL: they are the
 * same physical crate whatever beer was in them last, so asking for the split is asking for a number
 * nobody can give. So "By maker" offers makers only, and "Item by item" offers only the items that
 * belong to no maker. An item is counted in exactly one of the two places, never both.
 *
 * ONE PASS, ONE CALL. Everything listed is sent together, so every stack carries the same moment.
 */
export default function YardCountPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const read = useCallback(() => countableEmpties(store!.id), [store]);
  const area = useLoadArea<CountableShape[]>(read, [store?.id ?? ''], {
    key: `yard-countable:${store?.id ?? 'none'}`,
    scope: YARD_SCOPE,
    onFail: showProblem,
    whenNot: !store,
  });

  const [tab, setTab] = useState<'maker' | 'item'>('maker');
  const [picking, setPicking] = useState<'maker' | 'item' | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const [chosenMaker, setChosenMaker] = useState<Maker | null>(null);
  const [makerQty, setMakerQty] = useState('');
  const [chosenItem, setChosenItem] = useState<LooseItem | null>(null);
  const [itemQty, setItemQty] = useState<Record<string, string>>({});

  const [note, setNote] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * THE MAKERS, each with the unit most of its items come back in.
   *
   * A maker is counted as ONE figure, so it has to be recorded against one unit — the one the most
   * items use, which is crates for a brewery. Worked out here from the shapes already loaded rather
   * than asked, because the shop is not choosing between crates and bottles when it says "120 NBL".
   */
  const makers = useMemo<Maker[]>(() => {
    const byGroup = new Map<string, { name: string; units: Map<string, Set<string>> }>();
    for (const c of area.data ?? []) {
      if (!c.groupId) continue;
      const g = byGroup.get(c.groupId) ?? { name: c.groupName ?? '', units: new Map() };
      const products = g.units.get(c.storeUnitId) ?? new Set<string>();
      products.add(c.productId);
      g.units.set(c.storeUnitId, products);
      byGroup.set(c.groupId, g);
    }
    return [...byGroup.entries()]
      .map(([groupId, g]) => {
        const [storeUnitId] = [...g.units.entries()].sort((a, b) => b[1].size - a[1].size)[0];
        const items = new Set([...g.units.values()].flatMap((set) => [...set])).size;
        return { groupId, groupName: g.name, storeUnitId, items };
      })
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [area.data]);

  /* ITEMS WITH NO MAKER — the only ones "Item by item" offers. */
  const looseItems = useMemo<LooseItem[]>(() => {
    const byProduct = new Map<string, LooseItem>();
    for (const c of area.data ?? []) {
      if (c.groupId) continue;
      const it = byProduct.get(c.productId) ?? {
        productId: c.productId,
        productName: c.productName,
        shapes: [],
      };
      it.shapes.push(c);
      byProduct.set(c.productId, it);
    }
    return [...byProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName));
  }, [area.data]);

  if (!store) return null;

  /*
   * A COUNT REPLACES, it does not add.
   *
   * Counting NBL twice on one walk means the first figure was wrong, not that there are two stacks —
   * so the line for the same stack is swapped for the new one rather than summed.
   */
  const putLines = (next: Line[]) =>
    setLines((prev) => [
      ...prev.filter((l) => !next.some((n) => n.key === l.key)),
      ...next,
    ]);

  /*
   * A BLANK IS NOT A NOUGHT. "None in the yard" and "nobody looked" are different facts, so a box
   * left empty adds nothing — and a nought typed in is a count and is recorded as one.
   */
  const said = (v: string | undefined) =>
    v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;

  const save = async () => {
    setState('busy');
    setFailure(null);
    try {
      await countYard({
        storeId: store.id,
        parts: lines.map((l) => ({ ...l.part, qty: Number(l.qty) })),
        note: note.trim() || undefined,
      });
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setFailure(messageOf(e, 'Could not record that count.'));
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Count the yard" subtitle="The empties standing here">
      <ProblemDialog problem={problem} title="Could not read what you keep" />

      <Explain label="Why count the empties too?">
        Because a crate is worth money and it is the only part of the stock that comes back. Once a
        stack has been counted, every crate a customer returns and every one that goes back on a
        lorry keeps it right on its own — until then there is nothing for those movements to be added
        to.
      </Explain>

      <LoadArea area={area} what="what comes back">
        {() => (
          <>
            <div className={styles.tabs} role="tablist" aria-label="How you are counting">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'maker'}
                className={`${styles.tab} ${tab === 'maker' ? styles.tabOn : ''}`}
                onClick={() => setTab('maker')}
              >
                By maker
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'item'}
                className={`${styles.tab} ${tab === 'item' ? styles.tabOn : ''}`}
                onClick={() => setTab('item')}
              >
                Item by item
              </button>
            </div>

            <p className={styles.lede}>
              {tab === 'maker'
                ? 'One stack per maker. A crate is a crate whatever was in it last, so you do not sort them.'
                : 'Only items that belong to no maker — anything with a maker is counted under that maker.'}
            </p>

            {/* What has been counted so far, from either tab, until it is recorded. */}
            {lines.length > 0 && (
              <ul className={styles.lineList}>
                {lines.map((l) => (
                  <li key={l.key} className={styles.lineRow}>
                    <span>
                      {l.qty} {l.what}
                      <span className={styles.lineKind}>
                        {l.kind === 'maker' ? ' · by maker' : ' · item'}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={styles.lineRemove}
                      onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                      aria-label={`Remove ${l.what}`}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button type="button" className={styles.addLine} onClick={() => setPicking(tab)}>
              <PlusIcon /> {tab === 'maker' ? 'Add a maker' : 'Add an item'}
            </button>

            {/*
              HOW MANY, once something is chosen — on the page, never in the sheet. The sheet's job
              is choosing, and it closes the moment a choice is made.
            */}
            {chosenMaker && (
              <div className={styles.composer}>
                <p className={styles.composerWho}>{chosenMaker.groupName}</p>
                <Field
                  label="How many"
                  numeric
                  autoFocus
                  value={makerQty}
                  onChange={(e) => setMakerQty(e.target.value)}
                  placeholder="0"
                />
                <div className={styles.composerActions}>
                  <Button variant="secondary" onClick={() => setChosenMaker(null)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={!said(makerQty)}
                    onClick={() => {
                      putLines([
                        {
                          key: `maker:${chosenMaker.groupId}`,
                          what: chosenMaker.groupName,
                          kind: 'maker',
                          qty: makerQty.trim(),
                          part: {
                            categoryId: chosenMaker.groupId,
                            storeUnitId: chosenMaker.storeUnitId,
                            qty: 0,
                          },
                        },
                      ]);
                      setChosenMaker(null);
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}

            {chosenItem && (
              <div className={styles.composer}>
                <p className={styles.composerWho}>{chosenItem.productName}</p>
                <div className={styles.shapeBoxes}>
                  {chosenItem.shapes.map((sh) => (
                    <Field
                      key={sh.productUnitId}
                      label={chosenItem.shapes.length === 1 ? 'How many' : sh.unitPlural}
                      numeric
                      autoFocus={chosenItem.shapes.length === 1}
                      value={itemQty[sh.productUnitId] ?? ''}
                      onChange={(e) =>
                        setItemQty((prev) => ({ ...prev, [sh.productUnitId]: e.target.value }))
                      }
                      placeholder="0"
                    />
                  ))}
                </div>
                <div className={styles.composerActions}>
                  <Button variant="secondary" onClick={() => setChosenItem(null)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={!chosenItem.shapes.some((sh) => said(itemQty[sh.productUnitId]))}
                    onClick={() => {
                      putLines(
                        chosenItem.shapes
                          .filter((sh) => said(itemQty[sh.productUnitId]))
                          .map((sh) => ({
                            key: `item:${sh.productUnitId}`,
                            what: `${chosenItem.productName} ${sh.unitPlural.toLowerCase()}`,
                            kind: 'item' as const,
                            qty: itemQty[sh.productUnitId].trim(),
                            part: { productUnitId: sh.productUnitId, qty: 0 },
                          })),
                      );
                      setChosenItem(null);
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}

            <Field
              label="Note"
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Counted after the Tuesday lorry"
            />

            {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
            <div className={styles.actions}>
              <AsyncAction state={state} problem={failure} label="Recording this count">
                <Button onClick={() => void save()} disabled={lines.length === 0} fullWidth>
                  {lines.length === 0
                    ? 'Nothing counted yet'
                    : `Record ${lines.length} ${lines.length === 1 ? 'stack' : 'stacks'}`}
                </Button>
              </AsyncAction>
            </div>

            {/* A CHOICE IS A SHEET: a list to pick from, closed the moment something is picked. */}
            <BottomSheet
              open={picking === 'maker'}
              onClose={() => setPicking(null)}
              title="Which maker?"
            >
              {makers.length === 0 ? (
                <p className={styles.pickNone}>
                  No maker has items that come back. Put an item under a maker on its form.
                </p>
              ) : (
                <ul className={styles.pickList}>
                  {makers.map((m) => (
                    <li key={m.groupId}>
                      <button
                        type="button"
                        className={styles.pickRow}
                        onClick={() => {
                          setChosenMaker(m);
                          setMakerQty(
                            lines.find((l) => l.key === `maker:${m.groupId}`)?.qty ?? '',
                          );
                          setChosenItem(null);
                          setPicking(null);
                        }}
                      >
                        <span className={styles.pickName}>{m.groupName}</span>
                        <span className={styles.pickMeta}>
                          {m.items} {m.items === 1 ? 'item' : 'items'} come back
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </BottomSheet>

            <BottomSheet
              open={picking === 'item'}
              onClose={() => setPicking(null)}
              title="Which item?"
            >
              {looseItems.length === 0 ? (
                <p className={styles.pickNone}>
                  Every item that comes back belongs to a maker, so it is counted by maker.
                </p>
              ) : (
                <ul className={styles.pickList}>
                  {looseItems.map((it) => (
                    <li key={it.productId}>
                      <button
                        type="button"
                        className={styles.pickRow}
                        onClick={() => {
                          setChosenItem(it);
                          setItemQty(
                            Object.fromEntries(
                              it.shapes.map((sh) => [
                                sh.productUnitId,
                                lines.find((l) => l.key === `item:${sh.productUnitId}`)?.qty ?? '',
                              ]),
                            ),
                          );
                          setChosenMaker(null);
                          setPicking(null);
                        }}
                      >
                        <span className={styles.pickName}>{it.productName}</span>
                        <span className={styles.pickMeta}>
                          {it.shapes.map((sh) => sh.unitPlural.toLowerCase()).join(' and ')} come
                          back
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </BottomSheet>

            {lines.length === 0 && (
              <InfoPanel tone="info" title="Only the stacks you count">
                Add each stack as you reach it. Anything you do not add is left as it was — a stack
                nobody looked at is not recorded as empty.
              </InfoPanel>
            )}
          </>
        )}
      </LoadArea>
    </PageScaffold>
  );
}
