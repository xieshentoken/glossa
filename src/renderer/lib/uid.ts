let seq = 0;

/** Short id of lowercase letters and digits (the form saved cards are checked against). */
export const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
