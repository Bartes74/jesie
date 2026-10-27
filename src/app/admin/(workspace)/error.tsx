'use client';
export default function EditorialFailure({ reset }: { reset: () => void }) { return <div className="admin-empty"><h2>Redakcja potrzebuje chwili.</h2><p>Nie udało się wczytać danych. Spróbuj ponownie.</p><button type="button" className="admin-button" onClick={reset}>Wczytaj ponownie</button></div>; }
