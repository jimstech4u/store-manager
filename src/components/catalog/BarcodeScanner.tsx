'use client';

import { useEffect, useRef, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import styles from './BarcodeScanner.module.css';

/**
 * Point the camera at the bars and read the number.
 *
 * The form has always asked for a barcode and the shop has always had to type it — thirteen digits
 * off a curved label, at a counter, which is exactly the kind of task people give up on. Every
 * supermarket in the world solves this with a scanner; a phone already has one.
 *
 * TWO DECODERS, because the platform this runs on decides. `BarcodeDetector` is built into
 * Chrome and Android WebView and is the fastest thing available. Safari does not have it — and
 * Safari on a phone is what most of these shops are using — so `@zxing/browser` is loaded, but
 * only when the camera is actually opened: it is a large dependency and nobody should pay for it
 * while looking at a stock list.
 *
 * THE CAMERA IS RELEASED THE MOMENT THIS CLOSES. A page that keeps a stream open leaves the
 * indicator light on, drains a battery somebody is trading on all day, and on some phones blocks
 * every other app from the camera until the tab is killed.
 */

type Decoder = { stop: () => void };

export function BarcodeScanner({
  open,
  onClose,
  onRead,
  title = 'Scan the barcode',
}: {
  open: boolean;
  onClose: () => void;
  /** The digits under the bars. Called once; this closes itself straight after. */
  onRead: (code: string) => void;
  title?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  /*
   * The reader is held in a ref rather than state.
   *
   * Cleanup must reach the exact instance that was started; putting it in state means a re-render
   * between starting and stopping can leave a stream running with nothing holding a handle to it.
   */
  const decoderRef = useRef<Decoder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const doneRef = useRef(false);

  // Fresh every time it opens: `onRead` fires once and the sheet closes.
  const readRef = useRef(onRead);
  readRef.current = onRead;

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    /*
     * The node as it is NOW, captured for the cleanup.
     *
     * `videoRef.current` read at teardown may be a different element, or null, by the time React
     * runs it — and then the stream is never detached from the one that actually had it.
     */
    const videoEl = videoRef.current;
    doneRef.current = false;
    setProblem(null);
    setStarting(true);

    const finish = (code: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      readRef.current(code.trim());
    };

    const start = async () => {
      try {
        /*
         * The BACK camera, and the widest view the phone will give.
         *
         * `facingMode: environment` is a request, not a guarantee — a laptop has only one camera —
         * so this must not fail when it cannot be honoured.
         */
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStarting(false);

        // ── The fast path, where the platform has one ──────────────────────────────
        const Native = (
          window as unknown as {
            BarcodeDetector?: new (o?: { formats?: string[] }) => {
              detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;

        if (Native) {
          const detector = new Native({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'],
          });
          const tick = window.setInterval(async () => {
            if (doneRef.current || !videoRef.current) return;
            try {
              const found = await detector.detect(videoRef.current);
              if (found.length > 0 && found[0].rawValue) finish(found[0].rawValue);
            } catch {
              // A frame that cannot be read is ordinary; the next one usually can.
            }
          }, 250);
          decoderRef.current = { stop: () => window.clearInterval(tick) };
          return;
        }

        // ── Safari, and anything else without it ───────────────────────────────────
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        if (cancelled) return;

        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current ?? undefined,
          (result) => {
            if (result) finish(result.getText());
          },
        );
        decoderRef.current = { stop: () => controls.stop() };
      } catch (e) {
        if (cancelled) return;
        setStarting(false);
        /*
         * Said in terms of what to do, not what failed.
         *
         * "NotAllowedError" tells a shopkeeper nothing. The two cases that actually happen are a
         * refused permission and a phone whose camera another app is holding.
         */
        const name = (e as { name?: string })?.name;
        setProblem(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'This needs permission to use the camera. Allow it in your browser settings, or type the number instead.'
            : 'The camera could not be opened. Something else may be using it — or type the number instead.',
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      decoderRef.current?.stop();
      decoderRef.current = null;
      // Every track, or the indicator light stays on and the battery goes with it.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoEl) videoEl.srcObject = null;
    };
  }, [open]);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <Button variant="secondary" fullWidth onClick={onClose}>
          Type it instead
        </Button>
      }
    >
      {problem ? (
        <InfoPanel tone="warning" title="Cannot use the camera">
          {problem}
        </InfoPanel>
      ) : (
        <>
          <div className={styles.frame}>
            {/* Muted and inline, or a phone takes the video full screen and the sheet is gone. */}
            <video ref={videoRef} className={styles.video} muted playsInline />
            <div className={styles.reticle} aria-hidden="true" />
          </div>
          <p className={styles.hint}>
            {starting
              ? 'Opening the camera…'
              : 'Hold the bars inside the box. It reads on its own.'}
          </p>
        </>
      )}
    </BottomSheet>
  );
}
