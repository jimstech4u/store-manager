import type { Metadata } from 'next';
import styles from './privacy.module.css';

export const metadata: Metadata = {
  title: 'Privacy policy — Store Manager',
  description: 'What Store Manager keeps, who handles it, and how to have it removed.',
};

/**
 * WHAT THE PRODUCT ACTUALLY DOES WITH PEOPLE'S DATA, in words a shop or a customer can read.
 *
 * A public page: Meta will not let the WhatsApp app go live without one, and a customer whose name
 * is in a shop's records is owed it anyway. Every sentence describes something the code does; if
 * the code changes what is kept or who receives it, this page changes with it.
 */
const CONTACT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? '';

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <h1>Privacy policy</h1>
      <p className={styles.updated}>Last updated 30 October 2026</p>
      <p>
        Store Manager helps shops and distributors keep their sales, stock, customers and money
        records. This page says what is kept, who handles it, and how to have it removed.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li>
          <strong>Shop accounts:</strong> the name, email, phone and role of the people who use a
          shop&rsquo;s account.
        </li>
        <li>
          <strong>Shop records:</strong> sales, payments, stock, deliveries, suppliers, deposits and
          empties that a shop enters.
        </li>
        <li>
          <strong>Customers of a shop:</strong> the name, phone number, balance, receipts and empties
          the shop records about them.
        </li>
        <li>
          <strong>WhatsApp:</strong> if you link your WhatsApp to the assistant, your number, your
          WhatsApp profile name, the messages and photos you send it, its replies, and what it looked
          up to answer.
        </li>
      </ul>

      <h2>How it is used</h2>
      <p>
        To run the shop&rsquo;s records, show them to the people the shop has given access, produce
        receipts and statements, and answer questions asked through the WhatsApp assistant. The
        assistant acts as the person who linked their number and can only see what that person can
        see in the app.
      </p>

      <h2>Who handles it</h2>
      <p>We use these services to run Store Manager, and they process data for that purpose:</p>
      <ul>
        <li>Supabase, which stores the records and accounts.</li>
        <li>Vercel, which hosts the site.</li>
        <li>Meta (WhatsApp), which carries messages to and from the assistant.</li>
        <li>
          AI model providers (currently Groq, Google and OpenRouter). Your message, and the shop
          records looked up to answer it, are sent to one of them to produce the reply. Some of these
          services may use what they receive from free plans to improve their models.
        </li>
      </ul>
      <p>We do not sell personal data.</p>

      <h2>Receipt links</h2>
      <p>
        A receipt link can be opened by anyone who has it. A shop can withdraw a link it has shared.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Business records are kept for as long as the shop uses Store Manager, because a shop&rsquo;s
        accounts have to stay complete. Corrections are added to the record rather than erasing what
        came before.
      </p>

      <h2 id="delete">Removing your data</h2>
      <ul>
        <li>
          <strong>WhatsApp:</strong> send &ldquo;unlink&rdquo; to the assistant, or unlink your number
          in Settings → WhatsApp. It stops acting for you straight away.
        </li>
        <li>
          <strong>A customer of a shop:</strong> ask that shop, which keeps your records.
        </li>
        <li>
          <strong>Anything else:</strong>{' '}
          {CONTACT ? (
            <>
              email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and tell us what you would like removed.
            </>
          ) : (
            <>ask the shop you deal with, and it will pass your request to us.</>
          )}
        </li>
      </ul>
    </main>
  );
}
