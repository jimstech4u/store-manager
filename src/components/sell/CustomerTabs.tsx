'use client';

import {
  PlusIcon,
  PersonPlusIcon,
  PersonMinusIcon,
  CloseIcon,
  ReturnIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ShareIcon,
} from '@/components/ui/Icon';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CustomerMenu } from './CustomerMenu';
import styles from './CustomerTabs.module.css';

/**
 * Who is being served, and what can be done about them.
 *
 * A counter serves several people at once — one waiting while another decides — so the sell screen
 * is a row of tabs, one per person. This puts the word "Customer" in front of that row, because a
 * row of names with no label is a row of names: it took explaining, every time, that these were
 * separate sales rather than a list of anything.
 *
 * THE FOUR ACTIONS ACT ON THE ACTIVE TAB. They used to be scattered — attaching somebody was a
 * chip halfway down the page, discarding a sale was a button at the very bottom, and taking over a
 * colleague's order was an icon in the page header that opened a panel over the order being
 * worked on. All four are the same kind of thing (something you do to THIS customer's sale) and
 * they belong in one place, next to the tab they apply to.
 *
 * The "+" stays separate from them, at the end of the tabs. It is the only one that does not act
 * on the active customer — it makes a new one — so it sits with the tabs it adds to rather than
 * with the actions that operate on what is already there.
 */
export function CustomerTabs({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onSetCustomer,
  onClearCustomer,
  onCloseTab,
  onClaim,
  onShare,
  onSettlePage,
  hasCustomer,
  orderCode,
  actionState = 'idle',
  actionProblem,
  onRetryAction,
  onDismissAction,
  busy = false,
}: {
  tabs: { id: string; name: string; amount: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSetCustomer: () => void;
  onClearCustomer: () => void;
  onCloseTab: () => void;
  onClaim: () => void;
  /** Hands the order's tracking link to the customer. */
  onShare: () => void;
  /**
   * Puts the order's first row back under the bar.
   *
   * The bar is pinned, so by the time somebody reaches for it the receipt has usually scrolled
   * beneath — and every control here is about the order, which they then cannot see. Touching any
   * of them settles the page so the first item sits directly under the bar.
   */
  onSettlePage?: () => void;
  /** Drives whether the person action reads as attaching or changing. */
  hasCustomer: boolean;
  /** The active order's handover code, or null while the shop is still assigning one. */
  orderCode?: string | null;
  /** The state of whichever action was last pressed — they share one footprint. */
  actionState?: AsyncState;
  actionProblem?: string | null;
  onRetryAction?: (() => void) | null;
  onDismissAction?: () => void;
  busy?: boolean;
}) {
  const noTab = activeId === null;

  /*
   * Has the active tab scrolled out of the row?
   *
   * The tabs scroll SIDEWAYS, and with a dozen customers open the one being served can easily be
   * off the left or right edge — so the four actions would be pointing at a tab nobody can see.
   * That is the moment to offer a way back to it, and it has nothing to do with how far down the
   * page has been scrolled, which is what this watched before and was simply the wrong question.
   */
  const rowRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const [activeVisible, setActiveVisible] = useState(true);

  const check = useCallback(() => {
    const row = rowRef.current;
    const tab = activeTabRef.current;
    if (!row || !tab) {
      setActiveVisible(true);
      return;
    }
    const r = row.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    // Mostly visible counts as visible: a sliver of a pill at the edge is not something to send
    // somebody chasing.
    const overlap = Math.min(r.right, t.right) - Math.max(r.left, t.left);
    setActiveVisible(overlap > t.width * 0.6);
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    check();

    row.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);

    /*
     * Re-checked whenever the page comes back, not only while it is being scrolled.
     *
     * "Active order" is showing or not on the strength of a measurement, and a measurement taken
     * before the browser was put in the background is worth nothing when it returns: the row is
     * re-laid-out, and the answer was decided while it had no layout at all. It showed the button
     * over a tab that was plainly on screen.
     *
     * A ResizeObserver covers the same thing for the row itself — tabs arriving from the shop, the
     * keyboard opening, the window changing shape.
     */
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    observer?.observe(row);

    return () => {
      row.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
      observer?.disconnect();
    };
  }, [check, tabs.length, activeId]);

  /*
   * Brings the active tab back into the row — SIDEWAYS ONLY.
   *
   * `scrollIntoView` was used here and it scrolls every scrollable ancestor, not just this row. So
   * centring a tab also nudged the page, and because both run on the same change it cancelled the
   * vertical settle that was starting at the same moment: the first tap worked and every one after
   * it did not. Setting `scrollLeft` touches this row and nothing else.
   */
  const showActiveTab = useCallback(() => {
    const row = rowRef.current;
    const tab = activeTabRef.current;
    if (!row || !tab) return;
    const target = tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, []);

  /** The first and last tabs, for the controls either side of "Active order". */
  const scrollToEnd = (edge: 'first' | 'last') => {
    const row = rowRef.current;
    if (!row) return;
    row.scrollTo({ left: edge === 'first' ? 0 : row.scrollWidth, behavior: 'smooth' });
  };

  /*
   * Whichever tab becomes active is brought into view.
   *
   * Starting a customer used to leave the new tab off the end of a long row — the shop had just
   * been told to serve somebody and the till showed no sign of it. The same applies to switching:
   * a tab tapped at the edge should finish the tap fully on screen rather than half under it.
   *
   * Keyed on the active id alone, so it never fights somebody scrolling the row by hand — moving
   * the row does not change which tab is active, so this does not fire.
   */
  useEffect(() => {
    if (!activeId) return;
    // A frame, so the tab that has only just been added is in the DOM to scroll to.
    const frame = requestAnimationFrame(showActiveTab);
    return () => cancelAnimationFrame(frame);
  }, [activeId, showActiveTab]);

  return (
    <div className={styles.bar}>
      {/*
        Three rows, stacked.

        All of it on one line left the tabs about 140px on a 390px phone — one customer's pill,
        with the "+" already scrolled out of sight. The tabs are the part that grows, so they get
        the full width, and the fixed furniture sits above and below them.
      */}
      <div className={styles.top}>
        {/*
          The same customers, as a searchable list.

          The strip is right for three tabs and useless for twenty — the person wanted is off the
          edge and you are dragging sideways hunting a name.
        */}
        {/*
          The menu and the word it belongs to, together on the left.

          "Customer" was floating between the menu and the code, reading as a heading for the row
          rather than a label for the button next to it.
        */}
        <span className={styles.lead}>
          <CustomerMenu tabs={tabs} activeId={activeId} onPick={onSelect} />
          <span className={styles.label}>Customer</span>
        </span>

        {/*
          The order code, on the same line as the label rather than in a row of its own further
          down the page.

          It is the handover: a seller reads it out and a colleague picks the same order up on
          their own phone. It belongs beside the customer it identifies. The dots hold its place
          while the shop is still assigning one, so the bar does not change height the moment it
          arrives — the page used to visibly jump while somebody was already reading it.
        */}
        {/*
          The code and the share are ONE control.

          The code is what a colleague is told; the share is how the customer gets it. Tapping
          either meant the same thing to everybody who tried it, so a separate icon with its own
          small target would have been a distinction only the code knew about.
        */}
        <button
          type="button"
          className={styles.codeButton}
          onClick={onShare}
          disabled={!orderCode}
          aria-label={orderCode ? `Share order ${orderCode}` : 'No order code yet'}
        >
          <span className={`${styles.code} ${orderCode ? '' : styles.codePending}`}>
            {orderCode ?? '·····'}
          </span>
          {orderCode && <ShareIcon size="1.1em" />}
        </button>
      </div>

      <div className={styles.tabsRow}>
      <div ref={rowRef} className={styles.tabs} role="tablist" aria-label="Customers being served">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            ref={tab.id === activeId ? activeTabRef : undefined}
            className={`${styles.tab} ${tab.id === activeId ? styles.tabActive : ''}`}
            onClick={() => { onSelect(tab.id); onSettlePage?.(); }}
            aria-selected={tab.id === activeId}
          >
            <span className={styles.tabName}>{tab.name}</span>
            <span className={styles.tabAmount}>{tab.amount}</span>
          </button>
        ))}

      </div>

      {/*
        The "+" sits OUTSIDE the scrolling tabs.

        Inside, it was pinned to the end of the row — so a shop with a dozen open orders had to
        scroll to the far end of them to start the next customer, which is the one moment nobody
        has time to scroll. It is fixed furniture, like the four actions, and only the tabs
        themselves grow.
      */}
      <button type="button" className={styles.add} onClick={() => { onAdd(); onSettlePage?.(); }} aria-label="Start another customer">
        <PlusIcon />
      </button>
      </div>

      {/*
        Four actions when the order is on screen — one when it is not.

        The bar is sticky, so scrolling into a long receipt leaves it at the top of the screen with
        its buttons still pointing at an order nobody can see any more. Acting on something out of
        sight is how the wrong tab gets closed, so once the order scrolls away the four collapse
        into a single control whose only job is to bring it back.

        The four states share ONE footprint. A spinner that pushes the tabs down, or an error
        message that appears underneath, moves the row at the moment somebody is tapping it.
      */}
      <AsyncAction
        state={actionState}
        problem={actionProblem}
        onRetry={onRetryAction}
        onDismiss={onDismissAction}
        label="Working on this customer"
      >
        {activeVisible ? (
          <div className={styles.actions} role="group" aria-label="What to do with this customer">
            <button
              type="button"
              className={`${styles.action} ${styles.attach}`}
              onClick={() => { onSetCustomer(); onSettlePage?.(); }}
              disabled={noTab || busy}
              aria-label={hasCustomer ? 'Change who this sale is for' : 'Say who this sale is for'}
            >
              <PersonPlusIcon />
              <span>{hasCustomer ? 'Change' : 'Add'}</span>
            </button>

            <button
              type="button"
              className={`${styles.action} ${styles.detach}`}
              onClick={() => { onClearCustomer(); onSettlePage?.(); }}
              // Nothing to remove when nobody is attached, and a control that does nothing is worse
              // than one that is plainly unavailable.
              disabled={noTab || !hasCustomer || busy}
              aria-label="Take the customer off this sale"
            >
              <PersonMinusIcon />
              <span>Remove</span>
            </button>

            <button
              type="button"
              className={`${styles.action} ${styles.discard}`}
              onClick={() => { onCloseTab(); onSettlePage?.(); }}
              disabled={noTab || busy}
              aria-label="Close this tab without selling"
            >
              <CloseIcon />
              <span>Close</span>
            </button>

            <button
              type="button"
              className={`${styles.action} ${styles.claim}`}
              onClick={() => { onClaim(); onSettlePage?.(); }}
              disabled={busy}
              aria-label="Take over an order using its code"
            >
              <ReturnIcon />
              <span>Take over</span>
            </button>
          </div>
        ) : (
          /*
           * Three controls, 1 : 2 : 1.
           *
           * With a row of customers long enough to hide the active one, "take me back to it" is
           * the common need and gets the width to say so. The two beside it go to the ends —
           * useful when the person wanted is the one started first, or the one started last, which
           * is most of the time.
           */
          <div className={styles.jumpRow}>
            <button
              type="button"
              className={styles.jump}
              onClick={() => { scrollToEnd('first'); onSettlePage?.(); }}
              aria-label="Show the first customer"
            >
              <ChevronLeftIcon />
            </button>

            <button type="button" className={styles.showActive} onClick={() => { showActiveTab(); onSettlePage?.(); }}>
              Active order
            </button>

            <button
              type="button"
              className={styles.jump}
              onClick={() => { scrollToEnd('last'); onSettlePage?.(); }}
              aria-label="Show the last customer"
            >
              <ChevronRightIcon />
            </button>
          </div>
        )}
      </AsyncAction>
    </div>
  );
}
