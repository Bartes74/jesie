'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';

export default function CollectionError({ reset }: { reset: () => void }) {
  const params = useParams<{ locale: string }>();
  const locale = params.locale === 'en' ? 'en' : 'pl';
  const pl = locale === 'pl';
  return <main id="main" className="hub-page page-width"><header className="hub-heading"><p className="eyebrow">jesie.pl</p><h1>{pl ? 'Kolekcje są chwilowo niedostępne.' : 'Collections are temporarily unavailable.'}</h1><p>{pl ? 'Zapisane zestawy pozostają na Twoim urządzeniu. Spróbuj ponownie za chwilę.' : 'Your saved selections remain on this device. Please try again shortly.'}</p></header><button type="button" className="primary-button" onClick={reset}>{pl ? 'Spróbuj ponownie' : 'Try again'}</button><p><Link href={`/${locale}#recipes`}>{pl ? 'Przejdź do przepisów' : 'Browse recipes'} →</Link></p></main>;
}
