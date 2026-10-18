import type { GlossaApi } from '../shared/api';

declare global {
  interface Window {
    glossa: GlossaApi;
  }
}

export const api: GlossaApi = window.glossa;
