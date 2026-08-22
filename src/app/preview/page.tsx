'use client';

import { useState } from 'react';
import styles from './page.module.css';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel, WorkedExample } from '@/components/ui/Explain';
import { ClipboardCheckIcon, WarningIcon } from '@/components/ui/Icon';
import { useTheme } from '@/context/ThemeContext';
import { describeVariance, formatMoney, formatQty } from '@/lib/format';

/**
 * Foundation preview.
 *
 * Not the product — a working demonstration of the two things that must be right before any
 * real screen is built: the design system (touch sizes, contrast, type scale, theming) and the
 * help pattern. It uses the CRODS numbers from STORE_MANAGER_SCENARIOS.md so the concept can be
 * judged against a real case rather than lorem ipsum.
 */

const OPENING = 1200;
const RECEIVING = 0;
const SALES = 340;
const DAMAGED = 3;
const EXPECTED = OPENING + RECEIVING - SALES - DAMAGED; // 857
const AVG_COST = 283.333334;

export default function FoundationPreview() {
  const { theme, storedTheme, setTheme } = useTheme();
  const [counted, setCounted] = useState('851');

  const countedNum = counted === '' ? null : Number(counted);
  const variance =
    countedNum === null || Number.isNaN(countedNum) ? null : countedNum - EXPECTED;
  const lossValue = variance !== null && variance < 0 ? Math.abs(variance) * AVG_COST : 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.brand}>Store Manager</h1>
            <p className={styles.tagline}>Stock, sales and accounts</p>
          </div>
          <button
            type="button"
            className={styles.themeToggle}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            // The button's job is not obvious from an icon alone, so it says what it does.
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.section}>
          <InfoPanel tone="info" title="This is a foundation preview">
            The design system and help pattern, shown against a real stock count. Nothing here
            saves yet — the database it will talk to is built and tested, but the screens are
            not written.
          </InfoPanel>
        </section>

        {/* ── CRODS ────────────────────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <ClipboardCheckIcon /> Stock count
          </h2>
          <p className={styles.sectionNote}>Coca-Cola PET 60cl · counted today</p>

          <div className={styles.card}>
            <div className={styles.crodsRow}>
              <span className={styles.crodsLabel}>
                <span className={styles.crodsLetter} aria-hidden="true">O</span>
                Opening stock
              </span>
              <span className={styles.crodsValue}>{formatQty(OPENING)}</span>
            </div>
            <div className={styles.crodsRow}>
              <span className={styles.crodsLabel}>
                <span className={styles.crodsLetter} aria-hidden="true">R</span>
                Received
              </span>
              <span className={styles.crodsValue}>{formatQty(RECEIVING)}</span>
            </div>
            <div className={styles.crodsRow}>
              <span className={styles.crodsLabel}>
                <span className={styles.crodsLetter} aria-hidden="true">S</span>
                Sold
              </span>
              <span className={styles.crodsValue}>−{formatQty(SALES)}</span>
            </div>
            <div className={styles.crodsRow}>
              <span className={styles.crodsLabel}>
                <span className={styles.crodsLetter} aria-hidden="true">D</span>
                Damaged
              </span>
              <span className={styles.crodsValue}>−{formatQty(DAMAGED)}</span>
            </div>

            <div className={`${styles.crodsRow} ${styles.crodsExpected}`}>
              <span className={styles.crodsLabel}>
                <strong>Should be on the shelf</strong>
              </span>
              <span className={styles.crodsValue}>
                <strong>{formatQty(EXPECTED)}</strong>
              </span>
            </div>

            <Explain label="How is this worked out?">
              <p>
                Whatever you started with, plus anything that came in, minus what you sold and
                what was damaged. Then you count the shelf yourself — and if the two numbers
                disagree, something happened that nobody wrote down.
              </p>
              <WorkedExample
                label="Today"
                rows={[
                  { label: 'Opening stock', value: '1,200' },
                  { label: 'Received', value: '0' },
                  { label: 'Sold', value: '−340' },
                  { label: 'Damaged', value: '−3' },
                  { label: 'Should be on the shelf', value: '857', emphasis: true },
                ]}
              />
            </Explain>

            <div style={{ marginTop: 'var(--space-5)' }}>
              <Field
                label="Count on the shelf now"
                numeric
                required
                suffix="pieces"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                hint="Count it yourself and type what is actually there — not what you expect."
              />
            </div>

            {variance !== null && variance !== 0 && (
              <div className={styles.varianceCard} role="alert">
                <p className={styles.varianceHead}>
                  <WarningIcon />
                  {variance < 0 ? 'Stock is missing' : 'More stock than expected'}
                </p>
                <p className={styles.varianceNumber}>
                  {describeVariance(variance, 'piece')}
                </p>
                {lossValue > 0 && (
                  <p className={styles.varianceMeaning}>
                    That is <strong>{formatMoney(lossValue)}</strong> at what this stock cost
                    you. Before closing today, say what happened — a miscount, breakage nobody
                    logged, or a sale that was never recorded.
                  </p>
                )}
              </div>
            )}

            {variance === 0 && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <InfoPanel tone="success" title="Everything matches">
                  The shelf agrees with the records. You can close today.
                </InfoPanel>
              </div>
            )}

            <div className={styles.actions}>
              <Button variant="primary" size="large" fullWidth>
                Save count
              </Button>
              <Button variant="secondary" size="large" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        </section>

        {/* ── Landed cost ──────────────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>What a delivery really cost</h2>
          <p className={styles.sectionNote}>
            The calculation most businesses do wrong — and the reason a sale can lose money
            while looking profitable.
          </p>

          <div className={styles.card}>
            <WorkedExample
              label="100 packs of Coca-Cola PET"
              rows={[
                { label: 'Invoice (100 packs at ₦3,200)', value: '₦320,000' },
                { label: 'Delivery', value: '₦15,000' },
                { label: 'Distribution', value: '₦5,000' },
                { label: 'Total paid', value: '₦340,000' },
                { label: 'True cost per bottle', value: '₦283.33', emphasis: true },
                { label: 'True cost per pack', value: '₦3,400', emphasis: true },
              ]}
              note={
                <>
                  Going by the ₦3,200 invoice, selling a pack at ₦3,300 looks like ₦100 profit.
                  It is a <strong>₦100 loss</strong>.
                </>
              }
            />
          </div>
        </section>

        {/* ── Design system ────────────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Design system</h2>
          <p className={styles.sectionNote}>
            Body text is 17px, every tap target is at least 48px, and text contrast meets WCAG
            AAA in both themes. Currently showing: <strong>{theme}</strong>
            {storedTheme === 'system' ? ' (following your phone)' : ''}.
          </p>

          <div className={styles.card}>
            <div className={styles.actions} style={{ marginTop: 0 }}>
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
            </div>
            <div className={styles.actions}>
              <Button variant="danger">Danger</Button>
              <Button variant="ghost">Ghost</Button>
            </div>
            <div className={styles.actions}>
              <Button busy busyLabel="Saving your sale">Busy</Button>
              <Button disabled>Disabled</Button>
            </div>

            <div style={{ marginTop: 'var(--space-5)' }}>
              <Field
                label="Amount"
                numeric
                prefix="₦"
                placeholder="0"
                hint="Whole naira. Kobo is not used."
              />
              <Field
                label="Customer phone"
                type="tel"
                inputMode="tel"
                placeholder="0803 000 0000"
                hint="We find the customer by phone number, so a rough spelling of the name is fine."
              />
              <Field
                label="Quantity"
                numeric
                suffix="kg"
                placeholder="0"
                error="Enter how much was sold"
              />
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Colours</h2>
          <div className={styles.swatchGrid}>
            {[
              ['Primary', 'var(--primary)'],
              ['Surface', 'var(--surface)'],
              ['Sunken', 'var(--surface-sunken)'],
              ['Danger', 'var(--danger)'],
              ['Warning', 'var(--warning)'],
              ['Success', 'var(--success)'],
            ].map(([name, value]) => (
              <div className={styles.swatch} key={name}>
                <div className={styles.swatchColor} style={{ background: value }} />
                <div className={styles.swatchName}>{name}</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
