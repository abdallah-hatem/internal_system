'use client';

import { Camera, CircleAlert, RotateCcw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ImportPhoto } from './photo';
import { useAddPhoto, type ImportRequest } from './queries';
import { useRefusal } from '../requests/use-refusal';

/**
 * Adding photographs, one at a time, to a request that already exists.
 *
 * The photos are the point of this feature. A part number is often wrong or
 * absent and a picture of the thing in someone's hand is what identifies it, so
 * this has to survive the connection it will actually be used on: a phone in a
 * workshop, uploading a 3 MB photo over whatever signal is in the building.
 *
 * Three things follow from that, and they are the whole design here.
 *
 * **One request per photo, and the text is already saved.** The API separates
 * the two calls on purpose. Nothing typed into the form is at risk from an
 * upload that fails, because by the time this component is on screen the
 * request is stored.
 *
 * **A failure is per photo, not per batch.** Each file carries its own state,
 * and a failed one keeps its `File` in memory so `retry` is one tap — not
 * "choose the photo again", which on a phone means going back through the
 * camera roll to find which of four it was.
 *
 * **One at a time.** Not for politeness: the limit of six is counted on the
 * server per call, and six photos posted at once would all read a count of
 * three and all be accepted. Sequential also means the progress bar the shop is
 * watching is the one file actually moving.
 */

/**
 * What the server will accept, said here so a refusal is instant.
 *
 * These are not a second definition of the rule — the API still decides, and a
 * file that slips past these gets `TOO_MANY_PHOTOS` or `FILE_TOO_LARGE` and is
 * shown exactly as any other refusal. What they buy is not making a shop on a
 * slow connection spend ninety seconds uploading a 20 MB photo in order to be
 * told no. The wording comes from the `errors` namespace, so the reader gets
 * the same sentence either way round.
 */
const MAX_PHOTOS = 6;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MB = 8;

type Upload = {
  key: string;
  file: File;
  /** A local object URL, so the shop sees the photo before it has arrived. */
  preview: string;
  state: 'queued' | 'uploading' | 'failed';
  /** Null while the browser is not reporting a total; the bar goes striped. */
  percent: number | null;
  message?: string;
};

let counter = 0;

export function PhotoUploader({ request }: { request: ImportRequest }) {
  const t = useTranslations('imports');
  const tErrors = useTranslations('errors');
  const tCommon = useTranslations('common');
  const refusal = useRefusal();

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addPhoto = useAddPhoto();
  // Stable across renders, but read through a ref so the queue effect does not
  // list a mutation object among its dependencies and re-run on every render.
  const upload = addPhoto.mutateAsync;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  const stored = request.photos.length;
  const room = MAX_PHOTOS - stored - uploads.length;

  /** Object URLs are document-lifetime handles; nothing else revokes them. */
  const previews = useRef(new Set<string>());
  const forget = useCallback((url: string) => {
    if (previews.current.delete(url)) URL.revokeObjectURL(url);
  }, []);
  useEffect(() => {
    const held = previews.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  /**
   * The queue, pumped one file at a time.
   *
   * `busy` is a ref rather than state because the effect re-runs on every
   * `setUploads` — including the progress ticks — and a state flag would be one
   * render behind, which is enough to start the same file twice.
   */
  const busy = useRef(false);
  const id = request.id;

  useEffect(() => {
    if (busy.current) return;
    const next = uploads.find((u) => u.state === 'queued');
    if (!next) return;

    busy.current = true;
    setUploads((list) =>
      list.map((u) => (u.key === next.key ? { ...u, state: 'uploading', percent: 0 } : u)),
    );

    uploadRef
      .current({
        id,
        file: next.file,
        onProgress: (percent) =>
          setUploads((list) =>
            list.map((u) => (u.key === next.key ? { ...u, percent } : u)),
          ),
      })
      .then(() => {
        // Gone from the queue because it is now on the request itself: the
        // mutation wrote the server's answer into the cache, so the photo below
        // is the stored one rather than a local copy pretending to be it.
        setUploads((list) => list.filter((u) => u.key !== next.key));
        forget(next.preview);
      })
      .catch((err: unknown) => {
        setUploads((list) =>
          list.map((u) =>
            u.key === next.key
              ? { ...u, state: 'failed', percent: null, message: refusal(err) }
              : u,
          ),
        );
      })
      .finally(() => {
        busy.current = false;
        // Nudge the effect: the state change above may not name a new queued
        // file, and without this the next one would sit until something else
        // rendered.
        setUploads((list) => [...list]);
      });
    // `refusal` and `forget` are stable; `uploads` is what drives this.
  }, [uploads, id, forget, refusal]);

  const choose = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const accepted: Upload[] = [];
    let refused: string | null = null;
    let space = room;

    for (const file of Array.from(files)) {
      if (space <= 0) {
        refused = tErrors('TOO_MANY_PHOTOS', { max: MAX_PHOTOS });
        break;
      }
      if (file.size === 0) {
        refused = tErrors('FILE_EMPTY');
        continue;
      }
      if (file.size > MAX_BYTES) {
        refused = tErrors('FILE_TOO_LARGE', { maxMb: MAX_MB });
        continue;
      }
      // An empty type is not a refusal: a HEIC straight off an iPhone often
      // arrives with none, and the server reads the actual bytes anyway.
      if (file.type && !file.type.startsWith('image/')) {
        refused = tErrors('FILE_NOT_AN_IMAGE');
        continue;
      }

      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      accepted.push({
        key: `${Date.now()}-${counter++}`,
        file,
        preview,
        state: 'queued',
        percent: null,
      });
      space -= 1;
    }

    setRejected(refused);
    if (accepted.length) setUploads((list) => [...list, ...accepted]);
    // Cleared so choosing the same file again still fires `change` — a shop
    // retaking one photo picks the identical filename, and the browser calls
    // that no change at all.
    if (inputRef.current) inputRef.current.value = '';
  };

  const retry = (key: string) =>
    setUploads((list) =>
      list.map((u) =>
        u.key === key ? { ...u, state: 'queued', percent: null, message: undefined } : u,
      ),
    );

  const drop = (key: string) =>
    setUploads((list) => {
      const going = list.find((u) => u.key === key);
      if (going) forget(going.preview);
      return list.filter((u) => u.key !== key);
    });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-700">{t('photos')}</h2>
        <span className="text-xs text-gray-500">
          {t('photoCount', { count: stored, max: MAX_PHOTOS })}
        </span>
      </div>

      <p className="text-xs text-gray-500">{t('photosIntro')}</p>

      {(request.photos.length > 0 || uploads.length > 0) && (
        <ul className="grid grid-cols-3 gap-2">
          {request.photos.map((photo, index) => (
            <li key={photo.id}>
              <ImportPhoto
                path={photo.url}
                alt={t('photoAlt', { name: request.productName, number: index + 1 })}
                className="aspect-square w-full rounded-xl"
              />
            </li>
          ))}

          {uploads.map((item) => (
            <li key={item.key} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.preview}
                alt=""
                className={`aspect-square w-full rounded-xl bg-gray-100 object-cover ${
                  item.state === 'failed' ? 'opacity-40' : 'opacity-70'
                }`}
              />

              {item.state !== 'failed' && (
                <div className="absolute inset-x-1 bottom-1 h-1.5 overflow-hidden rounded-full bg-white/70">
                  <div
                    role="progressbar"
                    aria-label={t('uploading')}
                    aria-valuenow={item.percent ?? undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className={`h-full bg-brand-600 ${
                      item.percent === null ? 'w-full animate-pulse' : ''
                    }`}
                    style={item.percent === null ? undefined : { width: `${item.percent}%` }}
                  />
                </div>
              )}

              {item.state === 'failed' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-xl bg-red-50/80 p-1">
                  <button
                    type="button"
                    onClick={() => retry(item.key)}
                    className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-red-800"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    {tCommon('retry')}
                  </button>
                  <button
                    type="button"
                    onClick={() => drop(item.key)}
                    aria-label={t('removePhoto')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-800"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* One message per failed photo, under the grid, because the tile itself
          is too small to hold a sentence a shop can act on. */}
      {uploads
        .filter((u) => u.state === 'failed' && u.message)
        .map((u) => (
          <p
            key={`${u.key}-message`}
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-800"
          >
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              {u.file.name ? `${u.file.name} — ` : ''}
              {u.message}
            </span>
          </p>
        ))}

      {rejected && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-800"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{rejected}</span>
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => choose(e.target.files)}
        className="sr-only"
        // Labelled by the button below, which is the control a person sees. The
        // input itself is off screen rather than `display: none`, so the camera
        // still opens on browsers that ignore a hidden input.
        aria-hidden
        tabIndex={-1}
      />

      <button
        type="button"
        disabled={room <= 0}
        onClick={() => inputRef.current?.click()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 disabled:opacity-50"
      >
        <Camera className="h-5 w-5" aria-hidden />
        {room > 0 ? t('addPhoto') : t('photoLimitReached', { max: MAX_PHOTOS })}
      </button>
    </section>
  );
}
