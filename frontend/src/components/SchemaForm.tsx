import { invalidProps } from '../formErrors';
import { FieldHelp } from './FieldHelp';

export interface SchemaProperty {
  title?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: (string | number)[];
  'x-enum-labels'?: Record<string, string>;
}

export interface JsonSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  description?: string;
}

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

function inputType(prop: SchemaProperty): string {
  if (prop.format === 'password') return 'password';
  if (prop.type === 'number' || prop.type === 'integer') return 'number';
  return 'text';
}

function humanizeOption(v: string | number): string {
  if (typeof v === 'number') return String(v);
  return v.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function SchemaForm({ schema, value, onChange, errors = {} }: SchemaFormProps) {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);
  const required = new Set(schema.required ?? []);

  const update = (key: string, next: unknown) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <>
      {entries.map(([key, prop]) => {
        const label = prop.title ?? key;
        const current = value[key];
        if (prop.type === 'boolean') {
          return (
            <div className="switch-row" key={key}>
              <div className="sr-text">
                <div className="t">{label}</div>
                {prop.description ? <div className="d">{prop.description}</div> : null}
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={Boolean(current)}
                  onChange={(e) => update(key, e.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
          );
        }
        const error = errors[key];
        const helpId = `sf-${key}-help`;
        const decorate = {
          ...invalidProps(error, helpId, Boolean(error ?? prop.description)),
          'aria-required': required.has(key) ? (true as const) : undefined,
        };
        const labelEl = (
          <label htmlFor={`sf-${key}`}>
            {label}
            {required.has(key) ? <span className="req" aria-hidden="true">*</span> : null}
          </label>
        );
        const help = <FieldHelp id={helpId} error={error}>{prop.description}</FieldHelp>;
        if (prop.enum && prop.enum.length > 0) {
          const numeric = prop.enum.every((o) => typeof o === 'number');
          return (
            <div className="field" key={key}>
              {labelEl}
              <select
                id={`sf-${key}`}
                aria-label={label}
                {...decorate}
                value={current == null ? '' : String(current)}
                onChange={(e) => update(key, numeric ? Number(e.target.value) : e.target.value)}
              >
                {prop.enum.map((opt) => {
                  const labels = prop['x-enum-labels'];
                  const text = labels?.[String(opt)] ?? humanizeOption(opt);
                  return (
                    <option key={String(opt)} value={String(opt)}>{text}</option>
                  );
                })}
              </select>
              {help}
            </div>
          );
        }
        const type = inputType(prop);
        return (
          <div className="field" key={key}>
            {labelEl}
            <input
              id={`sf-${key}`}
              type={type}
              aria-label={label}
              {...decorate}
              value={current == null ? '' : String(current)}
              onChange={(e) => {
                const raw = e.target.value;
                update(key, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
              }}
            />
            {help}
          </div>
        );
      })}
    </>
  );
}
