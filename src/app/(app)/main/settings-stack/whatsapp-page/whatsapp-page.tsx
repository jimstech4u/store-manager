'use client';

import { useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { WhatsAppIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf } from '@/lib/format';
import styles from './whatsapp-page.module.css';

/**
 * THE SHOP ON WHATSAPP — linking this member's own WhatsApp to the Store Manager assistant.
 *
 * "A WhatsApp bot that owners and workers chat with in natural language." One number is the bot.
 * Here a signed-in member makes a one-time code and sends it to that number from their phone (the
 * button opens the chat with it already typed); from then on that WhatsApp number speaks for them,
 * with exactly the permissions they have in the app. Listed below with a way to unlink — their own,
 * or anybody's for whoever runs the shop.
 */
interface LinkRow {
  id: string;
  wa_phone: string;
  display: string | null;
  linked_at: string;
  mine: boolean;
  member_name: string;
}

const BOT = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '').replace(/[^\d]/g, '');

export default function WhatsAppPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();
  const ask = useConfirm();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState<LinkRow | null>(null);

  const links = useResource<LinkRow[]>({
    key: `whatsapp-links:${store?.id ?? 'none'}`,
    scope: 'settings_flow',
    enabled: Boolean(store),
    read: async () => {
      const { data, error } = await getSupabase().rpc('my_whatsapp_links', { p_store_id: store?.id });
      if (error) throw error;
      return (data ?? []) as LinkRow[];
    },
  });

  if (!store) return null;

  const status: PageStatus = links.data
    ? { state: 'ready' }
    : links.error
      ? { state: 'error', what: 'your linked numbers', error: String(links.error), onRetry: links.reload }
      : { state: 'loading', what: 'your linked numbers' };

  const makeCode = async () => {
    setBusy(true);
    try {
      const { data, error } = await getSupabase().rpc('create_whatsapp_link_code', { p_store_id: store.id });
      if (error) throw error;
      setCode(String(data));
    } catch (e) {
      problem.show(messageOf(e, 'Could not make a code. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const chatLink = code && BOT ? `https://wa.me/${BOT}?text=${encodeURIComponent(`Link ${code}`)}` : null;

  return (
    <PageScaffold onBack={goBack} title="WhatsApp" subtitle="Ask the shop questions from WhatsApp">
      <ProblemDialog problem={problem} title="Not done" />
      <PageState status={status}>
        {() => (
          <>
            <Explain label="What can it do?">
              Chat with Store Manager on WhatsApp in plain English: &ldquo;How much Trophy is left?&rdquo;,
              &ldquo;Sales today&rdquo;, &ldquo;Who owes me?&rdquo;, &ldquo;Send Mrs Adeola&rsquo;s statement for
              this month&rdquo;, &ldquo;Print her last receipt&rdquo;. It answers as you — it sees only what you
              can see in the app. Recording sales and payments from WhatsApp is coming next.
            </Explain>

            {!BOT && (
              <InfoPanel tone="warning" title="The shop’s WhatsApp number is not set up yet">
                Once the WhatsApp number is connected, you can link yours here.
              </InfoPanel>
            )}

            {code ? (
              <div className={styles.codeBox}>
                <span className={styles.codeLabel}>Your code — send it to the Store Manager number</span>
                <span className={styles.code}>{code}</span>
                <span className={styles.codeNote}>Good for 15 minutes, once. Send it from the WhatsApp you want linked.</span>
                {chatLink && (
                  <a className={styles.waButton} href={chatLink} target="_blank" rel="noreferrer">
                    <WhatsAppIcon /> Open WhatsApp with the code
                  </a>
                )}
                {BOT && <span className={styles.codeNote}>Or message +{BOT} with the code.</span>}
              </div>
            ) : (
              <Button fullWidth busy={busy} busyLabel="Making a code" disabled={!BOT} onClick={() => void makeCode()}>
                <WhatsAppIcon /> Link my WhatsApp
              </Button>
            )}

            <h2 className={styles.section}>Linked numbers</h2>
            {(links.data ?? []).length === 0 ? (
              <p className={styles.none}>No WhatsApp number is linked yet.</p>
            ) : (
              <ul className={styles.list}>
                {(links.data ?? []).map((l) => (
                  <li key={l.id} className={styles.row}>
                    <span className={styles.rowBody}>
                      <span className={styles.rowName}>+{l.wa_phone}{l.display ? ` · ${l.display}` : ''}</span>
                      <span className={styles.rowMeta}>
                        {l.mine ? 'You' : l.member_name} · linked {new Date(l.linked_at).toLocaleDateString()}
                      </span>
                    </span>
                    <Button size="small" variant="secondary" onClick={() => setUnlinking(l)}>
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </PageState>

      {unlinking && (
        <ConfirmDialog
          controller={ask}
          title="Unlink this number?"
          message={`+${unlinking.wa_phone} will stop speaking for ${unlinking.mine ? 'you' : unlinking.member_name}. It can be linked again with a new code.`}
          confirmText="Unlink"
          onDismiss={() => setUnlinking(null)}
          onConfirm={() => {
            const target = unlinking;
            setUnlinking(null);
            void (async () => {
              const { error } = await getSupabase().rpc('revoke_whatsapp_link', { p_link_id: target.id });
              if (error) problem.show(messageOf(error, 'Could not unlink it.'));
              links.reload();
            })();
          }}
        />
      )}
    </PageScaffold>
  );
}
