'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Explain, InfoPanel } from './Explain';
import { CameraIcon, CheckIcon, ImageIcon, StarIcon, TrashIcon } from './Icon';
import { Sheet } from './Sheet';
import { normaliseProductImage } from '@/lib/image-pipeline';
import { mediaUrl } from '@/lib/stacks/storefront';
import {
  addProductImage,
  makePrimaryImage,
  removeProductImage,
  useProductImages,
  type ProductImage,
} from '@/lib/stacks/product-media';
import styles from './PhotoUpload.module.css';

/**
 * Add and manage a product's pictures.
 *
 * The whole design turns on one decision: the picture is CLEANED UP AND SHOWN BACK before
 * anything is saved. A shop photographs a crate on a dusty counter, and what they see next is the
 * same crate on white, square, ready for the grid — with the original beside it and a way to keep
 * it if the tidy-up went wrong.
 *
 * That preview is doing real work. Automatic background removal is right most of the time and
 * wrong some of the time, and the difference is obvious to a person in a quarter of a second and
 * invisible to any test. Showing the result and asking is the only honest way to use a process
 * that cannot always succeed — and it means the failure mode is "they tick a box", not "the
 * catalogue quietly fills up with items that have holes in them".
 */
export function PhotoUpload({
  storeId,
  productId,
  productName,
  canManage,
}: {
  storeId: string;
  productId: string;
  productName: string;
  /** Without `products.manage` the pictures are shown but nothing can be changed. */
  canManage: boolean;
}) {
  const { images, loading, error, reload, setImages } = useProductImages(productId);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  const [pending, setPending] = useState<{
    original: string;
    cleaned: string;
    blob: Blob;
    file: File;
    backgroundRemoved: boolean;
  } | null>(null);
  const [keepBackground, setKeepBackground] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Object URLs are not garbage collected. Left alone, a shop photographing thirty products in one
  // sitting leaks thirty full-size bitmaps into a tab that is already tight on a cheap phone.
  const revoke = useRef<string[]>([]);
  const track = (url: string) => {
    revoke.current.push(url);
    return url;
  };
  useEffect(
    () => () => {
      revoke.current.forEach((u) => URL.revokeObjectURL(u));
      revoke.current = [];
    },
    [],
  );

  const prepare = useCallback(
    async (file: File, keep: boolean) => {
      setProblem(null);
      setWorking(true);
      try {
        const result = await normaliseProductImage(file, { keepBackground: keep });
        setPending({
          original: track(URL.createObjectURL(file)),
          cleaned: track(URL.createObjectURL(result.blob)),
          blob: result.blob,
          file,
          backgroundRemoved: result.backgroundRemoved,
        });
      } catch (e) {
        setProblem(e instanceof Error ? e.message : 'That picture could not be read.');
      } finally {
        setWorking(false);
      }
    },
    [],
  );

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input straight away, or picking the SAME file twice fires no change event and the
    // second attempt appears to do nothing at all.
    e.target.value = '';
    if (!file) return;
    setKeepBackground(false);
    void prepare(file, false);
  };

  /** Re-run the pipeline with the opposite background setting, on the file already chosen. */
  const toggleBackground = () => {
    if (!pending) return;
    const next = !keepBackground;
    setKeepBackground(next);
    void prepare(pending.file, next);
  };

  const save = async () => {
    if (!pending) return;
    setWorking(true);
    setProblem(null);
    try {
      const added = await addProductImage({
        storeId,
        productId,
        blob: pending.blob,
        alt: productName,
        sortOrder: images.length,
      });
      setImages([...images, added]);
      setPending(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That picture could not be saved.');
    } finally {
      setWorking(false);
    }
  };

  const remove = async (image: ProductImage) => {
    setWorking(true);
    setProblem(null);
    try {
      await removeProductImage(image);
      setImages(images.filter((i) => i.id !== image.id));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That picture could not be removed.');
    } finally {
      setWorking(false);
    }
  };

  const promote = async (image: ProductImage) => {
    setWorking(true);
    setProblem(null);
    try {
      setImages(await makePrimaryImage(images, image.id));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'The order could not be changed.');
      void reload();
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>Pictures</h3>
        <Explain label="Why add a picture?">
          A shopper looking at your storefront decides what to open from the picture alone. Items
          without one are opened far less often than items with one, whatever the price says.
          <br />
          <br />
          You do not need a studio. Stand the item on a plain surface — a table, a sheet of paper,
          the back of a carton — in daylight, and take one photo straight on. We tidy up the rest.
        </Explain>
      </div>

      {problem && (
        <InfoPanel tone="danger" title="That did not work">
          {problem}
        </InfoPanel>
      )}

      {images.length === 0 && !loading && (
        <p className={styles.emptyNote}>
          No pictures yet. This item shows as a coloured tile with its initials until you add one.
        </p>
      )}

      {error && (
        <InfoPanel tone="warning" title="Could not load the pictures">
          {error}
        </InfoPanel>
      )}

      <ul className={styles.grid}>
        {images.map((image, index) => (
          <li key={image.id} className={styles.tile}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl(image.path) ?? ''}
              alt={image.alt ?? productName}
              className={styles.tileImg}
              loading="lazy"
              decoding="async"
            />
            {index === 0 && (
              <span className={styles.primaryTag}>
                <StarIcon size="0.9em" /> Main
              </span>
            )}
            {canManage && (
              <div className={styles.tileActions}>
                {index !== 0 && (
                  <button
                    type="button"
                    className={styles.tileAction}
                    onClick={() => void promote(image)}
                    disabled={working}
                    aria-label={`Make picture ${index + 1} the main one`}
                  >
                    <StarIcon size="1.1em" />
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles.tileAction} ${styles.tileRemove}`}
                  onClick={() => void remove(image)}
                  disabled={working}
                  aria-label={`Remove picture ${index + 1}`}
                >
                  <TrashIcon size="1.1em" />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <div className={styles.addRow}>
          {/*
            Two inputs, not one. `capture` on a single input takes the phone straight to the camera
            and removes any way to choose a photo already taken — which is how most shops actually
            work, photographing a batch first and adding them later. Two buttons cost one line and
            keep both routes open.
          */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className={styles.hiddenInput}
            onChange={onPick}
            tabIndex={-1}
            aria-hidden="true"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className={styles.hiddenInput}
            onChange={onPick}
            tabIndex={-1}
            aria-hidden="true"
          />
          <Button
            variant="secondary"
            fullWidth
            busy={working && !pending}
            onClick={() => cameraRef.current?.click()}
          >
            <CameraIcon /> Take a photo
          </Button>
          <Button variant="secondary" fullWidth onClick={() => fileRef.current?.click()}>
            <ImageIcon /> Choose a picture
          </Button>
        </div>
      )}

      <Sheet
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Check the picture"
        footer={
          <div className={styles.sheetFooter}>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={working}>
              Cancel
            </Button>
            <Button busy={working} onClick={() => void save()}>
              <CheckIcon /> Use this picture
            </Button>
          </div>
        }
      >
        {pending && (
          <>
            <div className={styles.compare}>
              <figure className={styles.compareItem}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pending.original} alt="" className={styles.compareImg} />
                <figcaption className={styles.compareCaption}>What you took</figcaption>
              </figure>
              <figure className={styles.compareItem}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pending.cleaned} alt="" className={styles.compareImg} />
                <figcaption className={styles.compareCaption}>
                  What shoppers will see
                </figcaption>
              </figure>
            </div>

            <p className={styles.compareNote}>
              We straightened it, put it on a white background, and squared it up so it lines up
              with everything else in your shop.
            </p>

            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={keepBackground}
                onChange={toggleBackground}
                disabled={working}
              />
              <span>
                <strong>Keep the background</strong>
                <span className={styles.toggleNote}>
                  Tick this if part of the item was rubbed out, or if where it is standing matters.
                </span>
              </span>
            </label>

            {!keepBackground && !pending.backgroundRemoved && (
              <InfoPanel tone="info" title="The background was left as it was">
                It was too busy to remove safely. The picture is still straightened and squared up
                — for a cleaner result, stand the item against a plain wall or a sheet of paper and
                take it again.
              </InfoPanel>
            )}
          </>
        )}
      </Sheet>
    </section>
  );
}
