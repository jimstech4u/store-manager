'use client';

import { useLocation, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { DocumentActions, usePrintWidth } from '@/components/ui/DocumentActions';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { PRINT_SCOPE, type PrintSpec } from '@/components/ui/PrintShare';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { useThisPrinter } from '@/lib/stacks/printer';
import { receiptLines } from '@/lib/escpos-text';
import type { ReceiptImageInput } from '@/lib/share';
import styles from './print-page.module.css';

/**
 * ANY LIST, ON PAPER OR SHARED — the page `usePrintShare().open(spec)` pushes.
 *
 * The push names a channel; the page that pushed it publishes the document's builder there. The
 * document is read once, kept under its channel's key (a failed read keeps nothing made up, and
 * Try again reads it again), and shown as the roll will print it: the page's `data-print-root`, so
 * the browser's print prints the roll and not the screen. Under it, what a receipt offers.
 *
 * Reached any other way — a reload, an old link — there is no builder to ask, and the page says to
 * open it again from where it came from rather than printing something it cannot vouch for.
 */
export default function PrintPage() {
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const channel = (location?.params?.then as string | undefined) ?? '';

  const published = useObject<() => PrintSpec | null>(channel || 'print:none', {
    global: true,
    scope: PRINT_SCOPE,
  });
  const spec = published.isProvided ? published.getter()() : null;

  const doc = useResource<ReceiptImageInput>({
    key: `print-doc:${channel || 'none'}`,
    scope: PRINT_SCOPE,
    enabled: Boolean(spec),
    deps: [channel],
    read: async () => spec!.build(),
  });

  const width = usePrintWidth(store?.id ?? null);
  const printer = useThisPrinter(store?.id ?? null, width);

  if (!store) return null;

  const status: PageStatus = doc.data
    ? { state: 'ready' }
    : !spec
      ? {
          state: 'empty',
          title: 'Nothing to print',
          body: 'Open it again from the list or page it came from.',
        }
      : doc.error
        ? { state: 'error', what: 'this document', error: String(doc.error), onRetry: doc.reload }
        : { state: 'loading', what: 'everything on it' };

  return (
    <PageScaffold onBack={goBack} title={spec?.title ?? 'Print or share'} subtitle={store.name}>
      <PageState status={status}>
        {() =>
          doc.data && (
            <>
              <div
                className={styles.paper}
                data-print-root
                style={{ ['--receipt-width' as string]: `${width}mm` }}
              >
                <PrintPreview lines={receiptLines(doc.data, printer.layout)} layout={printer.layout} />
              </div>
              <DocumentActions
                storeId={store.id}
                doc={doc.data}
                filename={spec?.filename ?? 'document'}
                title={spec?.title ?? store.name}
                message={spec?.message ?? spec?.title ?? store.name}
                whatsapp={spec?.whatsapp}
              />
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
