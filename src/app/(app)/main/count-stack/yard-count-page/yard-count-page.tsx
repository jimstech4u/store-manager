'use client';

import { useCallback, useMemo, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { countableEmpties, countYard, type CountPart, type CountableShape } from '@/lib/stacks/yard';
import { messageOf } from '@/lib/format';
import styles from './yard-count-page.module.css';

/**
 * Walking the yard with the phone in one hand.
 *
 * A PAGE, like the stock count and for the same reason: nobody does this in a hurry, it survives a
 * rotation, and a sheet would put the keyboard over the box being typed into.
 *
 * ONE PASS, ONE CALL. A yard is counted in a single walk, so every stack is sent together and the
 * server stamps them all with the same moment. Counting stack by stack over five separate round
 * trips would give each one a different `counted_at`, and a lorry arriving halfway through the walk
 * would then be counted against some stacks and not others.
 */
export default function YardCountPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const read = useCallback(() => countableEmpties(store!.id), [store]);
  const area = useLoadArea<CountableShape[]>(read, [store?.id ?? ''], {
    onFail: showProblem,
    whenNot: !store,
  });

  /*
   * WHICH WAY THIS SHOP COUNTS.
   *
   * By maker is the default because that is what a distributor's yard is — one stack of NBL crates,
   * not six sorted by which beer was in them last. They are the same physical crate, and asking a
   * shop to split the stack by label is asking for a number nobody can honestly give.
   */
  const [grain, setGrain] = useState<'group' | 'shape'>('group');

  /** What has been typed, keyed by whichever grain the box belongs to. */
  const [byShape, setByShape] = useState<Record<string, string>>({});
  const [byGroup, setByGroup] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  /** The maker-and-unit stacks, assembled from the shapes so the client invents no grouping. */
  const groups = useMemo(() => {
    const out = new Map<
      string,
      { groupId: string; groupName: string; storeUnitId: string; unitPlural: string; items: number }
    >();
    for (const c of area.data ?? []) {
      if (!c.groupId) continue;
      const key = `${c.groupId}::${c.storeUnitId}`;
      const found = out.get(key);
      if (found) found.items += 1;
      else
        out.set(key, {
          groupId: c.groupId,
          groupName: c.groupName ?? '',
          storeUnitId: c.storeUnitId,
          unitPlural: c.unitPlural,
          items: 1,
        });
    }
    return [...out.values()].sort((a, b) =>
      `${a.groupName} ${a.unitPlural}`.localeCompare(`${b.groupName} ${b.unitPlural}`),
    );
  }, [area.data]);

  /*
   * Only what somebody actually typed.
   *
   * A BLANK IS NOT A NOUGHT. "None in the yard" and "nobody looked at that stack" are different
   * facts, and a walk that stops halfway must not silently record nought for everything unvisited.
   * Zero typed in is an answer and is sent as one.
   */
  const parts: CountPart[] = useMemo(() => {
    if (grain === 'shape') {
      return (area.data ?? [])
        .filter((c) => (byShape[c.productUnitId] ?? '').trim() !== '')
        .map((c) => ({
          productUnitId: c.productUnitId,
          qty: Number(byShape[c.productUnitId]),
        }));
    }
    return groups
      .filter((g) => (byGroup[`${g.groupId}::${g.storeUnitId}`] ?? '').trim() !== '')
      .map((g) => ({
        categoryId: g.groupId,
        storeUnitId: g.storeUnitId,
        qty: Number(byGroup[`${g.groupId}::${g.storeUnitId}`]),
      }));
  }, [grain, area.data, byShape, byGroup, groups]);

  const bad = parts.some((p) => !Number.isFinite(p.qty) || p.qty < 0);

  if (!store) return null;

  const save = async () => {
    setState('busy');
    setFailure(null);
    try {
      await countYard({
        storeId: store.id,
        parts,
        note: note.trim() || null || undefined,
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
        to, so the shop cannot be told what it is holding.
      </Explain>

      <LoadArea area={area} what="what comes back">
        {(shapes) =>
          shapes.length === 0 ? (
            <InfoPanel tone="info" title="Nothing comes back yet">
              Tick &ldquo;this comes back&rdquo; on an item&rsquo;s shape and its crates and bottles
              appear here.
            </InfoPanel>
          ) : (
            <>
              {/*
                COUNT THE STACK, OR COUNT THE LABELS.

                Not a display preference — it changes what is recorded. A maker count is
                authoritative for the maker's total and says nothing about the split, which is the
                truth about a yard where the crates are interchangeable.
              */}
              <div className={styles.tabs} role="tablist" aria-label="How you are counting">
                <button
                  type="button"
                  role="tab"
                  aria-selected={grain === 'group'}
                  className={`${styles.tab} ${grain === 'group' ? styles.tabOn : ''}`}
                  onClick={() => setGrain('group')}
                >
                  By maker
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={grain === 'shape'}
                  className={`${styles.tab} ${grain === 'shape' ? styles.tabOn : ''}`}
                  onClick={() => setGrain('shape')}
                >
                  Item by item
                </button>
              </div>

              <p className={styles.lede}>
                {grain === 'group'
                  ? 'One stack at a time. A crate is a crate whatever was in it last, so you do not have to sort them.'
                  : 'Only if you keep them apart. Most yards do not.'}
              </p>

              {grain === 'group' ? (
                <div className={styles.boxes}>
                  {groups.map((g) => {
                    const key = `${g.groupId}::${g.storeUnitId}`;
                    return (
                      <Field
                        key={key}
                        label={`${g.groupName} ${g.unitPlural.toLowerCase()}`}
                        hint={`${g.items} ${g.items === 1 ? 'item' : 'items'} use these`}
                        numeric
                        optional
                        value={byGroup[key] ?? ''}
                        onChange={(e) =>
                          setByGroup((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        placeholder="—"
                      />
                    );
                  })}
                </div>
              ) : (
                <div className={styles.boxes}>
                  {shapes.map((c) => (
                    <Field
                      key={c.productUnitId}
                      label={`${c.productName} ${c.unitPlural.toLowerCase()}`}
                      numeric
                      optional
                      value={byShape[c.productUnitId] ?? ''}
                      onChange={(e) =>
                        setByShape((prev) => ({ ...prev, [c.productUnitId]: e.target.value }))
                      }
                      placeholder="—"
                    />
                  ))}
                </div>
              )}

              <InfoPanel tone="info" title="Leave a stack blank if you did not get to it">
                A blank means nobody looked, and nothing is recorded for it. A nought means you
                looked and there were none — type the nought, because those are different answers
                and only one of them is a count.
              </InfoPanel>

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
                  <Button
                    onClick={() => void save()}
                    disabled={parts.length === 0 || bad}
                    fullWidth
                  >
                    {parts.length === 0
                      ? 'Nothing counted yet'
                      : `Record ${parts.length} ${parts.length === 1 ? 'stack' : 'stacks'}`}
                  </Button>
                </AsyncAction>
              </div>
            </>
          )
        }
      </LoadArea>
    </PageScaffold>
  );
}
