export function langName(code: string, uiLang: string): string {
  try {
    return new Intl.DisplayNames([uiLang], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
