export interface SchemaProperty {
  title?: string;
  type?: string;
  format?: string;
  description?: string;
}

export interface JsonSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}

function inputType(prop: SchemaProperty): string {
  if (prop.format === 'password') return 'password';
  if (prop.type === 'number' || prop.type === 'integer') return 'number';
  return 'text';
}

export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
  const properties = schema.properties ?? {};
  const entries = Object.entries(properties);

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
        const type = inputType(prop);
        return (
          <div className="field" key={key}>
            <label htmlFor={`sf-${key}`}>{label}</label>
            <input
              id={`sf-${key}`}
              type={type}
              aria-label={label}
              value={current == null ? '' : String(current)}
              onChange={(e) => {
                const raw = e.target.value;
                update(key, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
              }}
            />
          </div>
        );
      })}
    </>
  );
}
