'use client';

import { useEffect, useState, useRef } from 'react';
import { ReceiptPreview } from '@/components/receipt/ReceiptPreview';
import { LogoRejected, normaliseReceiptLogo } from '@/lib/image-pipeline';
import styles from './settings-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { CheckIcon, RefreshIcon } from '@/components/ui/Icon';
import { useNav } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { ROLE_DESCRIPTION, ROLE_LABEL } from '@/lib/permissions';
import { getSupabase } from '@/lib/supabase/client';
import { useTheme } from '@/context/ThemeContext';

/** Common thermal roll widths, offered as shortcuts beside a free field — like a print dialog. */
const PRESET_WIDTHS = [40, 58, 80, 100];

interface StoreRow {
  is_public: boolean;
  public_description: string | null;
  code: string | null;
}

interface Settings {
  printer_width_mm: string;
  receipt_header: string | null;
  receipt_footer: string | null;
  transfer_bank_name: string | null;
  transfer_account_no: string | null;
  transfer_account_name: string | null;
  show_transfer_details: boolean;
  receipt_logo_path: string | null;
  receipt_logo_width_pct: number;
}

/**
 * Store settings — role-gated, and stored in the database rather than on the device.
 *
 * A shop's configuration belongs to the shop. Staff change phones, phones get replaced, and
 * re-entering the printer width and bank details on every new device is exactly the friction
 * that makes people stop using a tool.
 *
 * The role gate is enforced in RLS as well as here: hiding a control is a courtesy to the user,
 * never a security measure. A staff member who reached this screen and submitted anyway would be
 * refused by the database.
 */
export default function SettingsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store, user, signOut } = useAuth();
  const { can, role } = usePermission();
  const { theme, storedTheme, setTheme } = useTheme();

  // The logo picker's hidden input, and the state around preparing one.
  const logoInput = useRef<HTMLInputElement | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [shop, setShop] = useState<StoreRow | null>(null);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void (async () => {
      const { data, error: err } = await getSupabase().rpc('ensure_store_settings', {
        p_store_id: store.id,
      });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        return;
      }
      const row = (Array.isArray(data) ? data[0] : data) as Settings;
      // Defaulted here as well as in the column: a settings row written before 0046 comes back
      // with null, and a null width would render the logo at zero and look like a broken upload.
      setSettings({ ...row, receipt_logo_width_pct: row.receipt_logo_width_pct ?? 60 });
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  // A count on the button, not just a label. "Waiting for you" with no number gives no reason
  // to tap it; "3 waiting" does.
  useEffect(() => {
    if (!store || !can('records.confirm')) return;
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase().rpc('pending_review', { p_store_id: store.id });
      if (cancelled || !data) return;
      const q = data as { products: unknown[]; customers: unknown[]; stock_entries: unknown[] };
      setPending(q.products.length + q.customers.length + q.stock_entries.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [store, can]);

  // The public storefront row lives on `stores`, not `store_settings`.
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase()
        .from('stores')
        .select('is_public, public_description, code')
        .eq('id', store.id)
        .maybeSingle();
      if (!cancelled && data) setShop(data as StoreRow);
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const saveShop = async (next: Partial<StoreRow>) => {
    if (!store || !shop) return;
    const merged = { ...shop, ...next };
    setShop(merged);

    // Turning the storefront on needs a code for people to find it by.
    if (merged.is_public && !merged.code) {
      const { data } = await getSupabase().rpc('ensure_store_code', { p_store_id: store.id });
      if (data) merged.code = data as string;
      setShop({ ...merged });
    }

    await getSupabase()
      .from('stores')
      .update({ is_public: merged.is_public, public_description: merged.public_description })
      .eq('id', store.id);
  };

  const patch = (next: Partial<Settings>) =>
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));

  const save = async () => {
    if (!store || !settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { error: err } = await getSupabase()
        .from('store_settings')
        .update({
          printer_width_mm: Number(settings.printer_width_mm) || 80,
          receipt_header: settings.receipt_header,
          receipt_footer: settings.receipt_footer,
          transfer_bank_name: settings.transfer_bank_name,
          transfer_account_no: settings.transfer_account_no,
          transfer_account_name: settings.transfer_account_name,
          show_transfer_details: settings.show_transfer_details,
          receipt_logo_path: settings.receipt_logo_path,
          receipt_logo_width_pct: settings.receipt_logo_width_pct,
        })
        .eq('store_id', store.id);
      if (err) throw err;
      setSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save your settings');
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;
  if (!settings && !error) return <FullPageMessage title="Loading settings" tone="loading" />;

  const editable = can('store.settings');

  return (
    <PageScaffold
      onBack={goBack}
      title="Settings"
      subtitle={store.name}
      /*
       * Saving is a header action now.
       *
       * It was a bar pinned to the foot of a long scrolling form, which meant it sat on top of
       * whatever field was being edited at the bottom of the screen. In the header it is in the
       * same place whatever the form is doing, and it can show its own busy state.
       */
      actions={
        editable
          ? [
              {
                key: 'save',
                icon: busy ? <RefreshIcon /> : <CheckIcon />,
                onClick: save,
                ariaLabel: busy ? 'Saving your settings' : 'Save settings',
              },
            ]
          : undefined
      }
    >
      {error && (
        <InfoPanel tone="danger" title="Could not save">
          {error}
        </InfoPanel>
      )}
      {saved && (
        <InfoPanel tone="success" title="Saved">
          Everyone in this shop will see these settings, on any device.
        </InfoPanel>
      )}

      {can('store.settings') && (
        <>
          <h2 className={styles.section}>Money</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('bank_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>Bank accounts</span>
              <span className={styles.sectionNote}>
                Where customers transfer money, and which one the counter offers first
              </span>
            </span>
          </button>
        </>
      )}

      {can('staff.manage') && (
        <>
          <h2 className={styles.section}>Your team</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('staff_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>People who work here</span>
              <span className={styles.sectionNote}>
                Add staff, set what each of them can do, remove someone who has left
              </span>
            </span>
          </button>
        </>
      )}

      {can('records.confirm') && (
        <>
          <h2 className={styles.section}>Checks</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('review_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>Things waiting for you</span>
              <span className={styles.sectionNote}>
                Products, customers and stock your staff added while serving customers
              </span>
            </span>
            {pending > 0 && <span className={styles.badge}>{pending}</span>}
          </button>
        </>
      )}

      {!editable && (
        <InfoPanel tone="info" title="You can look, but not change these">
          Shop settings are changed by the owner. You are signed in as{' '}
          {ROLE_LABEL[role ?? 'staff']}.
        </InfoPanel>
      )}

      {settings && (
        <>
          <h2 className={styles.section}>Receipt printer</h2>

          <div className={styles.presets}>
            {PRESET_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`${styles.preset} ${
                  Number(settings.printer_width_mm) === w ? styles.presetActive : ''
                }`}
                onClick={() => editable && patch({ printer_width_mm: String(w) })}
                disabled={!editable}
                aria-pressed={Number(settings.printer_width_mm) === w}
              >
                {w}mm
              </button>
            ))}
          </div>

          <Field
            label="Paper width"
            numeric
            suffix="mm"
            value={settings.printer_width_mm}
            onChange={(e) => patch({ printer_width_mm: e.target.value })}
            disabled={!editable}
            hint="Any width between 30 and 250. Use the buttons above for the common sizes."
            help={
              <Explain label="Which one do I have?">
                It is usually printed on the roll or its packaging. If you are not sure, 80mm is
                the most common and 58mm is the small handheld kind. Narrow rolls print each item
                stacked rather than in columns, because there is not enough width for both.
              </Explain>
            }
          />

          <Field
            label="Line above the receipt"
            optional
            value={settings.receipt_header ?? ''}
            onChange={(e) => patch({ receipt_header: e.target.value })}
            disabled={!editable}
            placeholder="Shop address or phone number"
          />

          {/*
            The logo, prepared for the paper it is going on.
            A receipt printer is one bit per dot and 40mm or 80mm wide, so a colour logo has to be
            trimmed, scaled and reduced to pure black and white before it means anything. Doing
            that here, and showing the result, means the shop approves what will actually print
            rather than what looks good on a phone.
          */}
          <div className={styles.logoBlock}>
            <p className={styles.label}>Logo on the receipt</p>

            <input
              ref={logoInput}
              type="file"
              accept="image/*"
              className={styles.hiddenInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || !store) return;
                setLogoBusy(true);
                setLogoError(null);
                try {
                  // Dots across the paper at the usual 203dpi: 8 dots per millimetre, less a
                  // little margin. Preparing at the real dot count means no resampling later.
                  const dots = Math.round(Number(settings.printer_width_mm) * 8 * 0.9);
                  const { blob } = await normaliseReceiptLogo(file, { widthPx: dots });

                  const path = `${store.id}/store/receipt-logo-${Date.now().toString(36)}.png`;
                  const up = await getSupabase()
                    .storage.from('media')
                    .upload(path, blob, { contentType: 'image/png', upsert: true });
                  if (up.error) throw new Error(up.error.message);

                  patch({ receipt_logo_path: path });
                } catch (err) {
                  // A rejection carries an explanation of what is wrong with the picture and what
                  // would work instead; anything else is a genuine failure.
                  setLogoError(
                    err instanceof LogoRejected
                      ? err.message
                      : err instanceof Error
                        ? err.message
                        : 'That logo could not be used.',
                  );
                } finally {
                  setLogoBusy(false);
                }
              }}
            />

            <div className={styles.logoActions}>
              <Button
                variant="secondary"
                busy={logoBusy}
                disabled={!editable}
                onClick={() => logoInput.current?.click()}
              >
                {settings.receipt_logo_path ? 'Change logo' : 'Add a logo'}
              </Button>
              {settings.receipt_logo_path && (
                <Button
                  variant="ghost"
                  disabled={!editable}
                  onClick={() => patch({ receipt_logo_path: null })}
                >
                  Remove it
                </Button>
              )}
            </div>

            <p className={styles.sectionNote}>
              A wide picture works best — roughly three times as wide as it is tall, and at least
              {' '}{Math.round(Number(settings.printer_width_mm) * 8 * 0.45)} pixels across. It is
              printed in plain black and white, so a simple mark reads better than a photograph.
            </p>

            {logoError && (
              <InfoPanel tone="warning" title="That picture will not print well">
                {logoError}
              </InfoPanel>
            )}

            {settings.receipt_logo_path && (
              <Field
                label="How wide on the paper"
                numeric
                suffix="%"
                value={String(settings.receipt_logo_width_pct)}
                onChange={(e) =>
                  patch({ receipt_logo_width_pct: Number(e.target.value) || 60 })
                }
                disabled={!editable}
                hint="A share of the paper width, so it stays right if you change printers."
              />
            )}
          </div>

          <Field
            label="Line at the bottom"
            optional
            value={settings.receipt_footer ?? ''}
            onChange={(e) => patch({ receipt_footer: e.target.value })}
            disabled={!editable}
            placeholder="Thank you for your patronage"
          />

          {/* Everything above, as it will print. Shown before the bank details so a mistake in
              the header or the logo is caught here rather than by a customer. */}
          <ReceiptPreview
            widthMm={Number(settings.printer_width_mm) || 80}
            header={settings.receipt_header}
            footer={settings.receipt_footer}
            logoPath={settings.receipt_logo_path}
            logoWidthPct={settings.receipt_logo_width_pct}
            shopName={store?.name ?? 'Your shop'}
            transfer={
              settings.show_transfer_details && settings.transfer_account_no
                ? `${settings.transfer_bank_name ?? ''}
${settings.transfer_account_no}
${settings.transfer_account_name ?? ''}`.trim()
                : null
            }
          />

          <h2 className={styles.section}>Bank details on receipts</h2>
          <p className={styles.sectionNote}>
            Printed on receipts so a customer paying later knows where to send the money.
          </p>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.show_transfer_details}
              onChange={(e) => patch({ show_transfer_details: e.target.checked })}
              disabled={!editable}
            />
            <span>Show my bank details on receipts</span>
          </label>

          {settings.show_transfer_details && (
            <>
              <Field
                label="Bank"
                value={settings.transfer_bank_name ?? ''}
                onChange={(e) => patch({ transfer_bank_name: e.target.value })}
                disabled={!editable}
                placeholder="First Bank"
              />
              <Field
                label="Account number"
                numeric
                value={settings.transfer_account_no ?? ''}
                onChange={(e) => patch({ transfer_account_no: e.target.value })}
                disabled={!editable}
                placeholder="0123456789"
              />
              <Field
                label="Account name"
                value={settings.transfer_account_name ?? ''}
                onChange={(e) => patch({ transfer_account_name: e.target.value })}
                disabled={!editable}
                placeholder={store.name}
              />
              <InfoPanel tone="info" title="Old receipts keep their old details">
                Changing these does not alter receipts already issued — each one keeps the account
                it was printed with.
              </InfoPanel>
            </>
          )}
        </>
      )}

      {editable && shop && (
        <>
          <h2 className={styles.section}>Public storefront</h2>
          <p className={styles.sectionNote}>
            Off by default. Your prices and what you sell are your own business — turn this on
            only if you want shoppers to find you.
          </p>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={shop.is_public}
              onChange={(e) => void saveShop({ is_public: e.target.checked })}
            />
            <span>List my shop publicly</span>
          </label>

          {shop.is_public && (
            <>
              <Field
                label="A line about your shop"
                optional
                value={shop.public_description ?? ''}
                onChange={(e) => setShop({ ...shop, public_description: e.target.value })}
                onBlur={() => void saveShop({})}
                placeholder="Drinks and provisions, wholesale and retail"
              />
              <InfoPanel tone="info" title={`Your shop code is ${shop.code ?? '…'}`}>
                Give this to customers. They can open{' '}
                <strong>/s/{shop.code ?? 'CODE'}</strong> to see what you sell.
                <Explain label="What do shoppers see?">
                  Your shop name, what you sell, your selling prices, any bulk prices, and whether
                  something is in stock. They never see what you paid for anything, how much you
                  hold, your customers, or who owes you.
                </Explain>
              </InfoPanel>
            </>
          )}
        </>
      )}

      <h2 className={styles.section}>This device</h2>

      <div className={styles.themeRow} role="group" aria-label="Appearance">
        {(['light', 'dark', 'system'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.preset} ${storedTheme === t ? styles.presetActive : ''}`}
            onClick={() => setTheme(t)}
            aria-pressed={storedTheme === t}
          >
            {t === 'system' ? 'Follow phone' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <p className={styles.sectionNote}>
        Currently showing {theme}. This is per device, not shared with your staff.
      </p>

      <h2 className={styles.section}>You</h2>
      <div className={styles.you}>
        <p className={styles.youName}>{user?.email}</p>
        <p className={styles.sectionNote}>
          {ROLE_LABEL[role ?? 'staff']} — {ROLE_DESCRIPTION[role ?? 'staff']}
        </p>
      </div>

      <Button variant="secondary" size="large" fullWidth onClick={() => void signOut()}>
        Sign out
      </Button>
    </PageScaffold>
  );
}
