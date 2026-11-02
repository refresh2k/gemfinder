// Price-wording scrub for server-returned text. The UI shows no price,
// cost, spend, free, or billing wording; the server still reports spend
// accounting for its logs, so anything the server sends for display
// passes through here first. Pure logic, unit-tested in node.
export function scrubPriceWording(text) {
  return String(text || '')
    .replace(/check the dashboard for actual billing\.?/gi, '')
    .replace(/\$[\d,.]+(?:–\$?[\d,.]+)?/g, '')
    .replace(/stopping before spending/gi, 'stopping before sending')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
