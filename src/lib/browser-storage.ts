"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const memory = new Map<string, string>();
function read(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("zgotuj-storage", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("zgotuj-storage", callback);
  };
}
const serverSnapshot = () => null;

function deserialize<T>(raw: string | null, fallback: T, validate?: (value: unknown) => value is T): T {
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (validate) return validate(value) ? value : fallback;
    if (value === null || typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback)) return fallback;
    return value as T;
  } catch { return fallback; }
}

export function useLocalStorage<T>(key: string, fallback: T, validate?: (value: unknown) => value is T) {
  const snapshot = useCallback(() => read(key), [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const value = useMemo(() => deserialize(raw, fallback, validate), [raw, fallback, validate]);
  const setValue = useCallback((next: T | ((previous: T) => T)) => {
    const previous = deserialize(read(key), fallback, validate);
    const result = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
    const serialized = JSON.stringify(result);
    memory.set(key, serialized);
    try { window.localStorage.setItem(key, serialized); } catch {}
    window.dispatchEvent(new Event("zgotuj-storage"));
  }, [key, fallback, validate]);
  return [value, setValue] as const;
}

const EMPTY_SAVED: string[] = [];
const isSavedIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string");
export function useSavedRecipes() {
  const [savedIds, setSavedIds] = useLocalStorage("zgotuj:favorite-recipes:v1", EMPTY_SAVED, isSavedIds);
  const toggleSaved = useCallback((id: string) => {
    setSavedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  }, [setSavedIds]);
  return { savedIds, toggleSaved };
}
