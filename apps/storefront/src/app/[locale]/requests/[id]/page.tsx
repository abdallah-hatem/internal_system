import { setRequestLocale } from 'next-intl/server';

import { RequestDetail } from '../../../../components/requests/request-detail';

/**
 * One request.
 *
 * The id is passed straight down and never used to build a heading here: the
 * request number is what a shop recognises, and it arrives with the record. A
 * request belonging to someone else is a 404 from the API — the lookup is
 * scoped by the shop on the token rather than checked afterwards — and the
 * detail component says so in the reader's language.
 */
export default async function RequestPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  return (
    <div className="mx-auto max-w-2xl">
      <RequestDetail id={id} />
    </div>
  );
}
