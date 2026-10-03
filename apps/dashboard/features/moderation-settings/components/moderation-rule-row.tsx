import type { ModerationRuleCatalogEntry, ModerationSettingsRule } from '@moderator/contracts';

import { Input } from '@/components/ui/input';

type Props = {
  rule: ModerationRuleCatalogEntry;
  configured?: ModerationSettingsRule;
  onChange: (value: ModerationSettingsRule | undefined) => void;
};

export function ModerationRuleRow({ rule, configured, onChange }: Props) {
  const editable = rule.strength === 'STRONG' && rule.supported_actions.length > 0;
  const id = `${rule.rule_id}-${rule.rule_version}`;
  return (
    <article className="space-y-4 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <h3 className="font-semibold">{rule.name}</h3>
        <p className="text-sm text-muted-foreground">
          {rule.category.replaceAll('_', ' ')} · Severity {rule.severity}/4 · {rule.strength}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {rule.rule_id} · Version {rule.rule_version}
        </p>
      </div>
      {!editable ? (
        <p className="text-sm text-muted-foreground">
          This rule requires context and supports no automatic actions.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <label htmlFor={`${id}-action`} className="text-sm font-medium">
              Action for {rule.name}
            </label>
            <select
              id={`${id}-action`}
              value={configured?.action ?? 'NONE'}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              onChange={(event) => {
                const action = event.target.value;
                if (action === 'NONE') {
                  onChange(undefined);
                  return;
                }
                const reference = {
                  rule_id: rule.rule_id,
                  rule_version: rule.rule_version,
                  minimum_severity: configured?.minimum_severity ?? rule.severity,
                };
                if (action === 'TIMEOUT') {
                  onChange({
                    ...reference,
                    action,
                    duration_seconds:
                      configured?.action === 'TIMEOUT' ? configured.duration_seconds : 30,
                  });
                } else if (action === 'DELETE' || action === 'BAN') {
                  onChange({ ...reference, action });
                }
              }}
            >
              <option value="NONE">No automatic action</option>
              {rule.supported_actions.map((action) => (
                <option key={action} value={action}>
                  {action === 'DELETE'
                    ? 'Delete message'
                    : action === 'TIMEOUT'
                      ? 'Timeout author'
                      : 'Ban author'}
                </option>
              ))}
            </select>
          </div>
          {configured && (
            <div className="space-y-2">
              <label htmlFor={`${id}-severity`} className="text-sm font-medium">
                Minimum severity for {rule.name}
              </label>
              <select
                id={`${id}-severity`}
                value={configured.minimum_severity}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                onChange={(event) =>
                  onChange({ ...configured, minimum_severity: Number(event.target.value) })
                }
              >
                {[1, 2, 3, 4].map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}/4
                  </option>
                ))}
              </select>
            </div>
          )}
          {configured?.action === 'TIMEOUT' && (
            <div className="space-y-2">
              <label htmlFor={`${id}-duration`} className="text-sm font-medium">
                Timeout seconds for {rule.name}
              </label>
              <Input
                id={`${id}-duration`}
                type="number"
                min={1}
                max={86_400}
                step={1}
                required
                value={
                  Number.isFinite(configured.duration_seconds) ? configured.duration_seconds : ''
                }
                onChange={(event) =>
                  onChange({ ...configured, duration_seconds: event.target.valueAsNumber })
                }
              />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
