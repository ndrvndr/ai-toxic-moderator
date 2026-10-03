import {
  customBlacklistConfiguration,
  normalizeBlacklistPattern,
  type CustomBlacklistRule,
} from '@moderator/contracts';

export const CUSTOM_BLACKLIST_MATCHER_VERSION = 'blacklist-literal-1';

export type CustomBlacklistDecision = {
  matched: boolean;
  matched_rule_ids: string[];
  selected_rule_id: string | null;
  delete_message: boolean;
  author_action: { action: 'TIMEOUT'; duration_seconds: number } | { action: 'BAN' } | null;
};

const wordCharacters = /[\p{L}\p{M}\p{N}_]+/gu;
const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isDomain(host: string): boolean {
  const labels = host.split('.');
  return (
    host.length <= 253 &&
    labels.length > 1 &&
    labels.every((label) => hostnameLabel.test(label)) &&
    /^[a-z][a-z0-9-]*$/.test(labels[labels.length - 1] ?? '')
  );
}

/** Parse complete URL tokens; never search a URL path, query, or email for a host. */
function extractHosts(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const part of text.split(' ')) {
    const token = part.replace(/^[([{"'<]+/u, '').replace(/[)\]}"'>.,!;]+$/u, '');
    if (!token || token.includes('\\') || /[\p{Cc}\p{Cf}]/u.test(token)) continue;
    const explicitHttp = /^https?:\/\//u.test(token);
    // Bare hostnames are supported, but other schemes and protocol-relative URLs
    // are not silently converted into HTTP URLs.
    const bareHostWithPort = /^[^\s/:]+\.[^\s/:]+:\d+(?:[/?#]|$)/u.test(token);
    if (
      !explicitHttp &&
      ((/^[a-z][a-z0-9+.-]*:/u.test(token) && !bareHostWithPort) || token.startsWith('/'))
    )
      continue;
    if (explicitHttp && !/^https?:\/\/[^/]/u.test(token)) continue;
    try {
      const url = new URL(explicitHttp ? token : `https://${token}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      const host = url.hostname.toLowerCase().replace(/\.$/u, '');
      if (isDomain(host)) hosts.add(host);
    } catch {
      // Invalid or ambiguous tokens do not provide domain evidence.
    }
  }
  return hosts;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function priority(rule: CustomBlacklistRule): number {
  return rule.action === 'DELETE_BAN' ? 2 : rule.action === 'DELETE_TIMEOUT' ? 1 : 0;
}

function compareRules(left: CustomBlacklistRule, right: CustomBlacklistRule): number {
  const action = priority(right) - priority(left);
  if (action !== 0) return action;
  if (left.action === 'DELETE_TIMEOUT' && right.action === 'DELETE_TIMEOUT') {
    const duration = right.duration_seconds - left.duration_seconds;
    if (duration !== 0) return duration;
  }
  return compareIds(left.id, right.id);
}

/** Pure policy selection. This class does not send requests or resolve targets. */
export class CustomBlacklistMatcher {
  private readonly rules: CustomBlacklistRule[];

  constructor(configuration: unknown) {
    const parsed = customBlacklistConfiguration.parse(configuration);
    this.rules = parsed.enabled ? parsed.rules.filter((rule) => rule.enabled) : [];
  }

  match(rawText: string): CustomBlacklistDecision {
    if (typeof rawText !== 'string') throw new TypeError('Blacklist input must be text.');
    const text = normalizeBlacklistPattern(rawText);
    const words = new Set(text.match(wordCharacters) ?? []);
    const hosts = this.rules.some((rule) => rule.match_type === 'DOMAIN')
      ? extractHosts(text)
      : new Set<string>();
    const matches = this.rules
      .filter((rule) => {
        if (rule.match_type === 'WORD') return words.has(rule.pattern);
        if (rule.match_type === 'PHRASE') return text.includes(rule.pattern);
        return [...hosts].some(
          (host) => host === rule.pattern || host.endsWith(`.${rule.pattern}`),
        );
      })
      .sort(compareRules);
    const selected = matches[0];
    return {
      matched: Boolean(selected),
      matched_rule_ids: matches.map((rule) => rule.id).sort(compareIds),
      selected_rule_id: selected?.id ?? null,
      delete_message: Boolean(selected),
      author_action:
        selected?.action === 'DELETE_BAN'
          ? { action: 'BAN' }
          : selected?.action === 'DELETE_TIMEOUT'
            ? { action: 'TIMEOUT', duration_seconds: selected.duration_seconds }
            : null,
    };
  }
}
