import { setRequestLocale } from 'next-intl/server';

import { ImportDetail } from '../../../../components/imports/import-detail';

/**
 * One import request.
 *
 * The id is passed straight down and never used to build a heading here: what
 * a shop recognises is the name of the part they asked for, and that arrives
 * with the record. A request belonging to someone else is a 404 from the API —
 * the lookup is scoped by the shop on the token rather than checked afterwards
 * — and the detail component says so in the reader's language.
 */
export default async function ImportPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  return (
    <div className="mx-auto max-w-2xl">
      <ImportDetail id={id} />
    </div>
  );
}
