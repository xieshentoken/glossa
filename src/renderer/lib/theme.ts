import { useEffect, useState } from 'react';
import type { Theme } from '../../shared/types';

// The main process sets the chosen theme on nativeTheme, so the page's
// prefers-color-scheme already says what is shown ('system' resolved).
const query = () => window.matchMedia('(prefers-color-scheme: dark)');

export function useShownTheme(): Theme {
  const [dark, setDark] = useState(() => query().matches);
  useEffect(() => {
    const q = query();
    const on = () => setDark(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return dark ? 'dark' : 'light';
}
