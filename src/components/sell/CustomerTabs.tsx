'use client';

import { PlusIcon, PersonPlusIcon, PersonMinusIcon, CloseIcon, ReturnIcon } from '@/components/ui/Icon';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
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
  hasCustomer,
  orderCode,
  activeInView = true,
  onShowActive,
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
  /** Drives whether the person action reads as attaching or changing. */
  hasCustomer: boolean;
  /** The active order's handover code, or null while the shop is still assigning one. */
  orderCode?: string | null;
  /** Whether the active order's own box is on screen. Drives the collapse below. */
  activeInView?: boolean;
  /** Scrolls the active order back into view. */
  onShowActive?: () => void;
  /** The state of whichever action was last pressed — they share one footprint. */
  actionState?: AsyncState;
  actionProblem?: string | null;
  onRetryAction?: (() => void) | null;
  onDismissAction?: () => void;
  busy?: boolean;
}) {
  const noTab = activeId === null;

  return (
    <div className={styles.bar}>
      {/*
        Three rows, stacked.

        All of it on one line left the tabs about 140px on a 390px phone — one customer's pill,
        with the "+" already scrolled out of sight. The tabs are the part that grows, so they get
        the full width, and the fixed furniture sits above and below them.
      */}
      <div className={styles.top}>
        <span className={styles.label}>Customer</span>

        {/*
          The order code, on the same line as the label rather than in a row of its own further
          down the page.

          It is the handover: a seller reads it out and a colleague picks the same order up on
          their own phone. It belongs beside the customer it identifies. The dots hold its place
          while the shop is still assigning one, so the bar does not change height the moment it
          arrives — the page used to visibly jump while somebody was already reading it.
        */}
        <span className={`${styles.code} ${orderCode ? '' : styles.codePending}`}>
          {orderCode ?? '·····'}
        </span>
      </div>

      <div className={styles.tabsRow}>
      <div className={styles.tabs} role="tablist" aria-label="Customers being served">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={`${styles.tab} ${tab.id === activeId ? styles.tabActive : ''}`}
            onClick={() => onSelect(tab.id)}
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
      <button type="button" className={styles.add} onClick={onAdd} aria-label="Start another customer">
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
        {activeInView ? (
          <div className={styles.actions} role="group" aria-label="What to do with this customer">
            <button
              type="button"
              className={`${styles.action} ${styles.attach}`}
              onClick={onSetCustomer}
              disabled={noTab || busy}
              aria-label={hasCustomer ? 'Change who this sale is for' : 'Say who this sale is for'}
            >
              <PersonPlusIcon />
              <span>{hasCustomer ? 'Change' : 'Add'}</span>
            </button>

            <button
              type="button"
              className={`${styles.action} ${styles.detach}`}
              onClick={onClearCustomer}
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
              onClick={onCloseTab}
              disabled={noTab || busy}
              aria-label="Close this tab without selling"
            >
              <CloseIcon />
              <span>Close</span>
            </button>

            <button
              type="button"
              className={`${styles.action} ${styles.claim}`}
              onClick={onClaim}
              disabled={busy}
              aria-label="Take over an order using its code"
            >
              <ReturnIcon />
              <span>Take over</span>
            </button>
          </div>
        ) : (
          <button type="button" className={styles.showActive} onClick={onShowActive}>
            Active order
          </button>
        )}
      </AsyncAction>
    </div>
  );
}
