import { ToolError } from './errors.js';

export interface DocRef {
  documentId: string;
  tabId?: string;
}

const ID = /^[A-Za-z0-9_-]{25,}$/;
const EXAMPLE =
  'Expected a Google Doc URL like https://docs.google.com/document/d/1AbC...xyz/edit or a document ID like 1AbC...xyz.';

function invalid(input: string, why?: string): ToolError {
  const shown = input.length > 120 ? `${input.slice(0, 117)}...` : input;
  return new ToolError(
    'INVALID_DOC_REF',
    `"${shown}" is not a Google Doc URL or ID.${why ? ` ${why}` : ''} ${EXAMPLE}`,
  );
}

/** Parses a Google Doc ID or URL (including /u/<n>/ variants and ?tab=). */
export function parseDocRef(input: string): DocRef {
  const raw = input.trim();
  if (ID.test(raw)) return { documentId: raw };

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw invalid(input);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid(input);
  if (url.hostname.toLowerCase() !== 'docs.google.com') throw invalid(input);

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'document') {
    const kind = segments[0];
    if (kind === 'spreadsheets' || kind === 'presentation' || kind === 'forms') {
      throw invalid(
        input,
        `That link is a Google ${kind === 'spreadsheets' ? 'Sheet' : kind === 'presentation' ? 'Slides deck' : 'Form'}, not a Doc.`,
      );
    }
    throw invalid(input);
  }
  let i = 1;
  if (segments[i] === 'u' && /^\d+$/.test(segments[i + 1] ?? '')) i += 2;
  if (segments[i] !== 'd') throw invalid(input);
  const id = segments[i + 1] ?? '';
  if (id === 'e') {
    throw invalid(
      input,
      'Published-to-web links cannot be used; open the doc and copy the URL from the address bar.',
    );
  }
  if (!ID.test(id)) throw invalid(input);

  const ref: DocRef = { documentId: id };
  const tab =
    url.searchParams.get('tab') ?? new URLSearchParams(url.hash.replace(/^#/, '')).get('tab');
  if (tab) ref.tabId = tab;
  return ref;
}

export function docUrl(documentId: string, tabId?: string): string {
  const base = `https://docs.google.com/document/d/${documentId}/edit`;
  return tabId ? `${base}?tab=${encodeURIComponent(tabId)}` : base;
}
