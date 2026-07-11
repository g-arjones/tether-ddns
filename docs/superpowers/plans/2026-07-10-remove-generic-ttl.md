# Remove Generic Domain TTL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead generic domain-level TTL so the Cloudflare form no longer shows a duplicate TTL; providers own their TTL.

**Architecture:** Delete `ttl` from `DomainConfig`/`DomainInput` (backend) and from the domain type, modal, and card (frontend). No provider changes.

**Tech Stack:** Python 3.12 (pydantic); React + TypeScript + Vite.

## Global Constraints

- Python `>=3.12`. Strict gates: flake8, mypy (`mypy .`), pyright strict (`pyright tether_ddns`), ruff. Backend coverage ≥ 90 via `pytest test/`.
- Frontend: strict TS; `tsc --noEmit` clean; Vitest + coverage thresholds; Playwright e2e passes.
- Backward-compat: pydantic `extra='ignore'` (default) drops a stale `ttl` key from old config files — no migration needed.
- Venv at `.venv` (`source .venv/bin/activate`; project uses `uv`).

---

## Task 1: Backend — drop domain TTL

**Files:**
- Modify: `tether_ddns/config.py`, `tether_ddns/api.py`
- Test: `test/unit/test_api.py` (and any config test referencing `ttl`)

- [ ] **Step 1: Remove the fields**

- In `tether_ddns/config.py`, delete the `DomainConfig` line `ttl: str = 'Auto'`.
- In `tether_ddns/api.py`, delete the `DomainInput` line `ttl: str = 'Auto'`.

- [ ] **Step 2: Update tests**

Grep the backend tests for `ttl` (`grep -rn "ttl" test/`). In `test/unit/test_api.py`, remove any `'ttl': ...` from domain create/update JSON payloads and any assertion on a returned `ttl`. Do NOT touch Cloudflare provider tests (their `ttl` is provider config, still valid).

- [ ] **Step 3: Verify**

Run: `python -m pytest test/ -q` → all pass, coverage ≥ 90.
Lint: `ruff check tether_ddns/config.py tether_ddns/api.py`, `flake8 ...`, `mypy .`, `pyright tether_ddns`. Fix violations.

- [ ] **Step 4: Commit**

```bash
git add tether_ddns/config.py tether_ddns/api.py test/unit/test_api.py
git commit -m "refactor: remove dead generic domain TTL from backend"
```

---

## Task 2: Frontend — drop domain TTL

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/components/DomainModal.tsx`, `frontend/src/components/DomainCard.tsx`
- Test: `frontend/src/components/DomainModal.test.tsx`, `frontend/src/components/DomainCard.test.tsx`

- [ ] **Step 1: Remove from the type**

In `frontend/src/types.ts`, remove `ttl: string | number;` from the `DomainConfig` interface.

- [ ] **Step 2: Remove from the modal**

In `frontend/src/components/DomainModal.tsx`:
- Remove `ttl: string;` from `DomainFormValue`.
- Remove `ttl: '300',` from `EMPTY`.
- Remove `ttl: String(editing.ttl),` from the edit-prefill `setForm({...})`.
- Remove the entire TTL field block:
```tsx
          <div className="field">
            <label htmlFor="fTtl">TTL <span className="hint">(seconds)</span></label>
            <select id="fTtl" value={form.ttl} onChange={(e) => setForm({ ...form, ttl: e.target.value })}>
              <option value="Auto">Auto</option>
              <option value="60">60</option>
              <option value="120">120</option>
              <option value="300">300</option>
              <option value="600">600</option>
              <option value="3600">3600</option>
            </select>
          </div>
```

- [ ] **Step 3: Remove from the card**

In `frontend/src/components/DomainCard.tsx`, remove the meta span `<span>· TTL {domain.ttl}</span>`.

- [ ] **Step 4: Update the frontend tests**

- `frontend/src/components/DomainModal.test.tsx`: remove `ttl: '300',` from the domain fixture; if a test asserts the submitted payload includes `ttl`, drop that assertion.
- `frontend/src/components/DomainCard.test.tsx`: remove `ttl: 'Auto',` from the domain prop fixture; remove any `TTL` text assertion.

- [ ] **Step 5: Verify**

Run: `cd frontend && npx tsc --noEmit` → clean (this will flag any missed `ttl` reference).
Run: `cd frontend && npx vitest run --coverage` → pass thresholds.
Run: `cd frontend && npm run build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/components/DomainModal.tsx frontend/src/components/DomainCard.tsx frontend/src/components/DomainModal.test.tsx frontend/src/components/DomainCard.test.tsx
git commit -m "refactor: remove generic domain TTL field from the UI"
```

---

## Task 3: Verify + e2e

**Files:** none.

- [ ] **Step 1: e2e + live**

Run: `cd frontend && npx playwright test` → both pass (the add-domain flow no longer fills a TTL; ensure the e2e didn't reference the TTL select — update the selector if it did).
Optionally build+serve and confirm the Cloudflare provider now shows a single "Ttl" field (its own) and DuckDNS shows none.

---

## Self-Review Notes

- **Spec coverage:** backend `DomainConfig`/`DomainInput` ttl removed (T1), frontend type/modal/card ttl removed (T2), e2e/live verify (T3). Cloudflare's provider-owned `ttl` untouched.
- **Type consistency:** removing `ttl` from `DomainConfig`/`DomainFormValue`/`DomainInput` is caught by `mypy`/`tsc` if any reference is missed.
- **Placeholders:** none. Backward-compat via pydantic extra-ignore is noted.
