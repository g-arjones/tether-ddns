# Render Docstrings and Field Descriptions on Modals — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

Provider and hook config forms are generated from `model_json_schema()`, which
already carries the config model's **class docstring** (as the schema's
top-level `description`) and per-field `description`s. Today the UI shows none of
the class docstrings and only renders a field `description` for boolean fields.
This surfaces both: a plugin blurb under the picker, and help text under every
field. No backend change — the data already exists in the schema.

## Changes

### `frontend/src/components/SchemaForm.tsx`

- Render `prop.description` as help text under **every** field type (text,
  number, password, enum), not just booleans.
- Add a small helper/JSX so each non-boolean field renders, after its input, a
  `<div className="field-help">{prop.description}</div>` when a description is
  present. The boolean branch already shows the description and is unchanged.

### `frontend/src/components/DomainModal.tsx` and `HookModal.tsx`

- The `JsonSchema` type gains an optional `description?: string` (the class
  docstring).
- Under the provider/hook `<select>`, render the selected plugin's
  `schema.description` as a blurb, e.g.
  `{schema.description ? <p className="modal-blurb">{schema.description}</p> : null}`.
- `SchemaForm`'s exported `JsonSchema` interface adds `description?: string`.

### `frontend/src/styles.css`

- Add `.field-help` (small, muted text under a field) and `.modal-blurb`
  (muted paragraph under the picker) styles consistent with existing
  `.switch-row .d` / muted text.

## Testing

**Frontend (Vitest):**

- `SchemaForm` renders a text field's `description` as help text.
- `DomainModal` (or `HookModal`) renders the selected plugin's class-docstring
  blurb from `schema.description`.

## Out of Scope

- Any backend/schema change (descriptions already come from
  `model_json_schema()`).
- Markdown rendering of descriptions (plain text only).
- Adding descriptions to models that don't have them (authoring content is
  separate from rendering it).
