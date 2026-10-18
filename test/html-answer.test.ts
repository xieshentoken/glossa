import { describe, expect, it } from 'vitest';
import { markdownPage } from '../src/main/output';
import { htmlAnswer, htmlAnswerParts } from '../src/shared/html-answer';

describe('HTML answers', () => {
  it('recognises an answer written as HTML, fenced or not, and leaves Markdown alone', () => {
    expect(htmlAnswer('```html\n<div><b>Like I am five</b></div>\n```')).toBe('<div><b>Like I am five</b></div>');
    expect(htmlAnswer('<!doctype html><html><body><p>Hi</p></body></html>')).toContain('<p>Hi</p>');
    expect(htmlAnswer('**Like I am five** — a <b>bold</b> idea')).toBeNull();
    expect(htmlAnswer('<p>unclosed')).toBeNull();
  });

  it('keeps the body and styles, drops scripts', () => {
    const p = htmlAnswerParts('<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>x</p><script>bad()</script></body></html>');
    expect(p).toEqual({ styles: 'p{color:red}', body: '<p>x</p>' });
  });

  it('shows an HTML answer rendered, under the same script-free page policy', async () => {
    const page = await markdownPage('```html\n<style>h2{color:teal}</style><section><h2>ELI5</h2><p>A pot of water…</p></section>\n```', { theme: 'light', lang: 'en', title: 't' });
    expect(page).toContain('<section><h2>ELI5</h2>');
    expect(page).toContain('h2{color:teal}');
    expect(page).not.toContain('&lt;section');
    expect(page).toContain("default-src 'none'");
  });
});
