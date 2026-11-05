import { formatUsd } from './money.js';
import { formatPeriodLabel, reportIdempotencyKey, type DateRange, type PeriodKind } from './periods.js';

export type EmailCategoryTotal = { name: string; totalCents: number };

export type EmailDocument = {
  idempotencyKey: string;
  periodKind: PeriodKind;
  periodStart: string;
  periodEnd: string;
  timezone: 'America/Denver';
  subject: string;
  text: string;
  html: string;
  categories: EmailCategoryTotal[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanName(name: string): string {
  const text = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (/https?:|www\.|@/i.test(text)) return 'Category';
  return text;
}

/**
 * Category totals only. No balances, net worth, account numbers, merchants, or a visible URL.
 * The Open Ours control is an HTML button whose href is the configured origin, and only then.
 */
export function renderEmailReport(input: {
  kind: PeriodKind;
  range: DateRange;
  categories: readonly { name: string; totalCents: number }[];
  openOursOrigin: string | null;
}): EmailDocument {
  const categories = input.categories.map((category) => ({
    name: cleanName(category.name),
    totalCents: category.totalCents,
  }));
  const label = formatPeriodLabel(input.kind, input.range);
  const noun = input.kind === 'week' ? 'week' : input.kind === 'month' ? 'month' : 'year';
  const subject = `Ours ${noun} categories · ${label}`;
  const lines = categories.map((category) => `${category.name}  ${formatUsd(category.totalCents)}`);
  const body = [
    'Ours',
    `${noun[0]?.toUpperCase()}${noun.slice(1)} of ${label}`,
    'America/Denver',
    '',
    ...(lines.length > 0 ? lines : ['No category totals for this period.']),
    '',
    'Category totals only.',
    'Transfers, debt payments, and unreviewed items are not listed.',
  ];
  const text = body.join('\n');
  const rows =
    categories.length === 0
      ? '<tr><td style="padding:8px 0;">No category totals for this period.</td></tr>'
      : categories
          .map(
            (category) =>
              `<tr><td style="padding:8px 0;">${escapeHtml(category.name)}</td><td style="padding:8px 0;text-align:right;">${escapeHtml(formatUsd(category.totalCents))}</td></tr>`,
          )
          .join('');
  const button = input.openOursOrigin
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(input.openOursOrigin)}/" style="display:inline-block;background:#8c3e2f;color:#fffdf8;text-decoration:none;padding:12px 18px;border-radius:999px;">Open Ours</a></p>`
    : '';
  const html = `<!DOCTYPE html><html lang="en"><body style="margin:0;background:#f6f1e8;color:#2a2118;font-family:Georgia,serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px;"><table role="presentation" width="100%" style="max-width:480px;"><tr><td><p style="margin:0 0 4px;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;">Ours</p><h1 style="font-size:22px;margin:0 0 4px;">${escapeHtml(noun)} of ${escapeHtml(label)}</h1><p style="margin:0 0 16px;">America/Denver</p><table role="presentation" width="100%">${rows}</table><p style="margin:16px 0 0;">Category totals only.</p><p style="margin:4px 0 0;">Transfers, debt payments, and unreviewed items are not listed.</p>${button}</td></tr></table></td></tr></table></body></html>`;
  return {
    idempotencyKey: reportIdempotencyKey(input.kind, input.range),
    periodKind: input.kind,
    periodStart: input.range.start,
    periodEnd: input.range.end,
    timezone: 'America/Denver',
    subject,
    text,
    html,
    categories,
  };
}

export function visibleEmailText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
