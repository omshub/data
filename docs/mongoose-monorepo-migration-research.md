# Migrating Duplicated Mongoose Objects into a Shared Monorepo Package

## Research notes: gotchas, data-integrity risks, and schema best practices

> Scope note: this repository (`omshub/data`) is a data-crawling/scraping project and does not currently contain any Mongoose code. This document is a standalone research reference — written to be dropped into (or adapted for) any Node.js monorepo that is consolidating duplicated Mongoose schemas/models from multiple services or apps into a single shared package.

---

## 1. Why teams end up with duplicated Mongoose objects

Before planning the migration, it's worth naming the failure mode that got you here, since the migration plan has to actively counteract it:

- **Copy-paste bootstrapping.** A second service is spun up by copying an existing service's `models/` folder as a starting point. It diverges from day one.
- **No ownership boundary.** Nobody "owns" the `User` or `Order` schema, so each team patches its own copy when it needs a new field, and nobody back-ports the change.
- **Independent deploy cadences.** Service A ships a schema change; Service B (same collection) doesn't redeploy for weeks. The two copies silently drift apart while both are queried against the *same* underlying MongoDB collection.
- **Fear of tight coupling.** Some teams duplicate on purpose to avoid a shared dependency — but this trades compile-time coupling for much worse *runtime* coupling, because the collections are still coupled at the database level whether the code admits it or not.

The core insight that should drive the migration: **if two services read/write the same MongoDB collection, their schemas are already coupled.** Duplicating the Mongoose code doesn't remove the coupling, it just hides it and lets the two definitions silently diverge. Centralizing the schema doesn't add coupling — it makes coupling that already existed visible and enforced by the type system.

---

## 2. Gotchas and technical pitfalls

### 2.1 `OverwriteModelError: Cannot overwrite model once compiled`

This is the single most common error teams hit during/after migration. It happens because `mongoose.model(name, schema)` registers the compiled model globally on a connection; calling it twice with the same name (e.g., because two different bundled copies of the shared package both call it, or because of hot-reload/test-runner re-imports) throws.

**Mitigations:**
- Always guard model registration:
  ```ts
  export const User = mongoose.models.User ?? mongoose.model<UserDoc>('User', userSchema);
  ```
- Export **schemas** from the shared package, not compiled **models**, and let each consuming service (or connection) compile the model itself. This is the officially recommended pattern for multi-connection / multi-app setups (see §2.3).
- In test suites (Jest/Vitest) that reset the module registry between test files but not the Mongoose connection, this error is extremely common — use `mongoose.deleteModel(/.*/)` in global teardown, or the guard pattern above.

### 2.2 Multiple copies of the Mongoose library at runtime

Mongoose models, schema instances, and `ObjectId`s are only `instanceof`-compatible with the exact copy of Mongoose that created them. If your shared `@yourorg/models` package has its own `mongoose` in `dependencies`, and a consuming app also installs its own `mongoose`, npm/yarn/pnpm can end up hoisting **two separate copies** into `node_modules`. Symptoms:

- `doc instanceof mongoose.Document` returns `false`.
- `Schema.Types.ObjectId` comparisons fail across package boundaries.
- Plugins registered on "the" schema in one copy don't show up when accessed via the other copy.
- Two separate connection pools get created without anyone intending it.

**Mitigation:** declare `mongoose` as a **`peerDependency`** (and `peerDependenciesMeta.optional: false`) in the shared models package, never a regular `dependency`. This forces a single, top-level, deduplicated install of Mongoose across the whole workspace. Pin an exact major version range and enforce it with a workspace-wide `resolutions`/`overrides` field as a backstop.

### 2.3 Models are scoped to a connection — don't export compiled models from a shared package

A `mongoose.Model` is bound to whatever `Connection` compiled it (`mongoose.model()` uses the default global connection; `connection.model()` uses that specific connection). If two services in the monorepo each open their own connection to MongoDB (common — e.g., different pool sizes, different replica-set read preferences, or genuinely different databases in a multi-tenant setup), a model compiled in the shared package against the default connection is useless to a service using `createConnection()`.

**Best practice:** the shared package exports **`Schema` instances and TypeScript types**, plus a small factory function, and each consuming app is responsible for compiling the model against its own connection:

```ts
// @yourorg/models — schemas/user.schema.ts
export const userSchema = new Schema<UserDoc>({ ... });

// @yourorg/models — index.ts
export function registerUserModel(conn: mongoose.Connection) {
  return conn.models.User ?? conn.model<UserDoc>('User', userSchema);
}
```

This also sidesteps the `OverwriteModelError` entirely, since each connection gets its own model registry.

### 2.4 Plugin and middleware (hook) ordering

Mongoose applies `pre`/`post` hooks and plugins in registration order, and this order is semantically meaningful (e.g., a hashing plugin must run before a plugin that logs the hashed value). When schemas move into a shared package:

- Cross-cutting plugins (soft-delete, auditing, `updatedBy`, pagination helpers) get applied **inside the shared schema factory**, so all consumers get consistent behavior — but this means a consuming service can no longer silently skip or reorder them. Make plugin application explicit and documented per schema.
- **Discriminators are especially order-sensitive**: all `pre()`/`post()` hooks and plugins must be registered on the base schema *before* `baseModel.discriminator(...)` is called. If the shared package restructures a hierarchy into discriminators during the migration, audit hook registration order carefully — a hook added "for convenience" after the discriminator call silently won't apply to the child schema the way engineers expect.
- Global plugins (`mongoose.plugin(fn)`) registered by one service now apply to *every* schema created against that Mongoose instance, including ones from unrelated services sharing the process — a common source of "why does this random collection suddenly have a `deletedAt` field" bugs. Prefer schema-level `schema.plugin(fn)` over global `mongoose.plugin(fn)` in a shared-package world.

### 2.5 Index management and duplication

- If `autoIndex: true` (the Mongoose default outside production) is left on for multiple services pointed at the same collection, every service instance can race to build/drop indexes on boot, causing lock contention or transient query slowdowns in shared environments (e.g., shared staging DB).
- Consolidating schemas often reveals that two duplicated schemas defined **different indexes on the same fields** (or one has a unique index the other lacks). Merging them is not just a code change — it requires an actual `createIndex`/`dropIndex` migration against production data, and a uniqueness constraint newly introduced can fail outright if duplicate data already exists in the collection.
- Recommendation: set `autoIndex: false` / `autoIndex: process.env.NODE_ENV !== 'production'` in the shared connection config, and manage index changes explicitly through a migration tool (see §3.4) rather than relying on Mongoose to sync them at boot.

### 2.6 TypeScript type duplication and drift

Duplicated schemas are almost always paired with duplicated (and subtly inconsistent) hand-written TypeScript interfaces (`IUser`, `UserDocument`, `UserDTO`, ...). When consolidating:

- Generate types from the schema (`InferSchemaType<typeof userSchema>` or `mongoose.Schema<UserDoc, ...>` generics) rather than maintaining parallel interfaces — this is the single biggest source of runtime/compile-time mismatch in Mongoose codebases (a field renamed in the schema but not in the hand-written interface compiles fine and fails at runtime).
- Decide up front whether the shared package exports **wire-format DTOs** (plain objects, safe to send over the network / to a frontend) separately from **document types** (with Mongoose methods like `.save()`). Conflating them is a common integrity bug: leaking a full Mongoose document (with internal fields, `__v`, virtuals) through an API response that a *different* duplicated schema on the consumer side doesn't expect.

### 2.7 Build tooling / workspace mechanics

- **pnpm hardlinks:** pnpm's "injected" workspace dependencies materialize as hardlinks, not symlinks, when peer dependency graphs would otherwise mismatch. If the shared models package needs a build step (TS → JS), an editing loop where you change a schema and expect a sibling app to see it live can silently serve stale compiled output because the hardlinked copy wasn't rebuilt. Make sure the package has a working `dev`/`watch` build and that the monorepo task runner (Turborepo/Nx) declares the correct `build` → `dependsOn` graph so consumers always rebuild the shared package first.
- **CJS/ESM interop:** Mongoose ships as CJS. If the shared package is authored/bundled as ESM with `"type": "module"`, verify `import mongoose from 'mongoose'` default-interop works with your consumers' bundlers (Next.js, Vite, esbuild, tsx all handle this slightly differently). Test this explicitly rather than assuming.
- **Phantom dependencies:** pnpm's strict `node_modules` layout will surface places where a service was importing `mongoose` (or a helper) without declaring it, because it happened to be hoisted by npm/yarn previously. Expect a wave of "module not found" errors on migration to pnpm workspaces that are really missing `package.json` dependency declarations, not migration bugs per se.
- **Circular imports:** a shared `models` package that imports a shared `utils`/`validators` package, which itself imports something from `models` for typing, is a very easy trap once everything lives in one repo and editors auto-import. Keep a strict dependency direction: `types` → `schemas` → `models` → (consuming apps), never the reverse.

### 2.8 Versioning and consumers on stale versions of the shared package

Once schemas live in a versioned internal package (even with `workspace:*` protocol), a breaking schema change (renamed field, new required field, changed enum values) is now a **semver event**, not just a code review comment in one PR. A consumer that isn't redeployed yet, or that pins an older version, will:

- Fail validation on writes if a new field became `required: true` without a default.
- Silently drop fields on read if using `strict: true` and its cached document shape (fine) — but crash on write if it constructs documents its way against the new required shape.
- Misinterpret enum values if a `enum: [...]` list changed meaning without a migration.

**Mitigation:** treat the shared package like a public API — use Changesets (or equivalent) for semver bumps, require a major-version bump for anything that changes required-ness/types/enum values, and add a deprecation window (accept both old and new shapes for at least one release) for anything not doing an atomic monorepo-wide deploy.

---

## 3. Data integrity and consistency risks during migration

### 3.1 Schema drift is the root risk — audit before you unify

Before writing a single line of the "unified" schema, **diff the existing duplicated schemas field-by-field.** In practice you will find:
- Fields with the same name but different types (`price: Number` vs `price: String` storing formatted currency).
- Fields required in one copy, optional in the other — meaning production data almost certainly has documents missing that field.
- Different default values for the same field.
- Different casting/coercion behavior (e.g., one schema uses a custom `SchemaType`, the other uses `Mixed` and does manual validation in application code).
- Subtly different timestamp handling (`timestamps: true` in one, manual `createdAt`/`updatedAt` fields in the other — these can even have different types, e.g., `Date` vs. epoch `Number`).

Do not assume the "newer" or "more actively maintained" copy is correct — query production (or a recent restore) to see what shape the data is *actually* in. The schema you migrate to has to describe reality, not aspiration; a stricter schema than the real data will reject/`CastError` on existing documents the moment `strict`/validators are enabled.

### 3.2 Validation strictness changes are a data-integrity migration, not a refactor

If the unified schema tightens validation relative to *either* duplicate (new `required`, new `enum` restriction, new `min`/`max`, new `match` regex, switching `strict: false` to `strict: true` or `strictQuery` defaults), you must:
1. Run a read-only audit query against the real collection for documents that would fail the new validation.
2. Backfill/repair those documents (or explicitly decide they're acceptable exceptions and relax the constraint).
3. Only then deploy the stricter schema — otherwise existing documents become **unloadable or unsavable** the moment any service re-saves them (Mongoose re-validates the whole document on `.save()` by default, so touching one unrelated field on an old "bad" document can suddenly throw a `ValidationError` that has nothing to do with the field you meant to change).

### 3.3 The "two schemas, one collection" transition window

During migration there is almost always a window where old-shape and new-shape code both touch the same collection (rolling deploys, canary releases, or simply "service A migrated, service B hasn't yet"). Concretely dangerous patterns in this window:

- **Silent field stripping:** Mongoose drops any key not defined in the schema when `strict: true` (default) on write. If the new shared schema removed a field the old service still writes, that data is silently discarded on save by anything using the new schema — not an error, just quiet data loss.
- **Default value collisions:** if the old schema has no default for a field and the new one adds one, documents written by old code (without the field) suddenly get the new default the instant they're re-saved by new code — which can look like "data appeared from nowhere" in audits.
- **Discriminator key collisions:** if you're introducing discriminators as part of the consolidation (e.g., unifying `AdminUser`/`RegularUser` duplicated schemas into one base + discriminator), a document written by legacy code without the discriminator key won't be returned by the discriminator-filtered queries at all — it becomes invisible, not erroring, which is worse.
- **Recommendation:** use an explicit **dual-write / expand-contract pattern**: (1) *expand* — add new fields/relax old ones without removing anything, deploy everywhere; (2) *migrate* — backfill data, switch reads to the new shape; (3) *contract* — only once all consumers are confirmed on the new shared package version, remove the old fields/loosen constraints that are no longer needed. Never collapse expand/contract into one deploy across independently-deployed services.

### 3.4 Index changes need an explicit migration tool, not just a schema edit

Adding `unique: true` to a field that has duplicate data will fail to build the index (or in the worst case, if `background`/duplicate check timing allows it, corrupt uniqueness guarantees silently under old MongoDB versions). Use a real migration runner (`migrate-mongo`, or a custom scripted runbook) that:
1. Checks for existing violations before creating a unique index.
2. Creates new indexes with a distinct name if replacing an existing index, verifies via `explain()`/`collection.indexes()` before dropping the old one.
3. Runs index builds `background`/off-peak against production, not synchronously in application boot code.

### 3.5 `populate()` across previously-separate schemas

Consolidation often reveals that two duplicated schemas *referenced the same collection by different names/paths* (`ref: 'User'` vs `ref: 'Users'` vs a hardcoded ObjectId with no `ref` at all, resolved manually in application code). Unifying `ref` names is a breaking change for every `populate()` call across the codebase — grep for every `.populate(...)` call site referencing the affected collection names as part of the migration checklist, not just the schema files themselves.

### 3.6 Casting and coercion inconsistencies

Two duplicated schemas that both declare a field as, say, `Date`, can still behave differently if one attaches a custom `SchemaType` or a `set()`/`get()` transform (e.g., timezone normalization) and the other doesn't. After consolidation, previously "working" application code that depended on one service's lenient coercion (e.g., accepting `"2024-1-5"` and mongoose's forgiving Date parsing) may now go through the other service's stricter custom type and start throwing `CastError`. Add explicit tests for edge-case input values (empty strings, `null` vs `undefined`, numeric strings, alternate date formats) for every field where the two duplicates' behavior might have differed — this is easy to miss because it won't show up as a *type* diff between the schemas, only as a *behavioral* diff.

### 3.7 Timestamp and audit-field consistency

If one duplicate used `{ timestamps: true }` (Mongoose-managed `createdAt`/`updatedAt`) and the other managed these fields manually (or via a custom plugin with different field names, e.g. `created_at`), consolidating on one convention means historical documents from the other service will have `null`/missing values for whichever field wins. Decide explicitly: backfill historical values (even approximate, e.g., from `_id`'s embedded timestamp for `createdAt`) or accept and clearly document the gap — don't let it surface as a mystery "why do half our docs have no createdAt" bug months later.

---

## 4. Best practices for authoring Mongoose schemas (for the shared package)

### 4.1 Structural fundamentals

- **Always set `strict: true`** (the default) explicitly at the top of each schema definition for clarity, and set `strictQuery: true` (or handle the deprecation — Mongoose 7+ defaults `strictQuery` to follow `strict`) so queries can't silently pass through fields that don't exist on the schema.
- **Type every field explicitly.** Avoid `Schema.Types.Mixed` except at true, deliberate schema-free boundaries (e.g., a `metadata: Mixed` escape hatch that's explicitly documented as unvalidated) — `Mixed` disables change tracking for nested mutations unless you call `.markModified()`, which is a frequent source of "my update didn't save" bugs.
- **Use `{ timestamps: true }`** rather than hand-rolled `createdAt`/`updatedAt` fields, for consistency across every schema in the shared package.
- **Add `toJSON`/`toObject` transforms at the schema level** (strip `__v`, rename `_id` → `id`, remove sensitive fields like password hashes) so every consumer gets the same serialization behavior automatically, instead of each service hand-rolling its own DTO mapping (which is exactly the kind of duplication you're trying to eliminate).
- **Prefer `lean()` queries** wherever the result won't be mutated and saved back — returns plain objects, skips hydration cost, and is often 30-40% faster for read-heavy paths. Document this as the default recommendation in the shared package's README so consuming teams don't reach for full hydrated documents out of habit.

### 4.2 Validation

- Push validation into the schema (`required`, `min`/`max`, `enum`, `match`, custom validator functions) rather than in application-layer `if` statements scattered across services — this is the entire point of centralizing the schema: one validation source of truth.
- Prefer custom validator functions with clear, user-facing `message` strings over relying on generic `CastError`s bubbling up to API responses.
- For validation that depends on other fields or async lookups (e.g., "email must be unique"), use an **async validator** or a dedicated pre-save hook, and be explicit in comments about what happens on race conditions (validators are not a substitute for a unique index — always back a uniqueness *validator* with a real unique *index*, since the validator alone has a TOCTOU race under concurrent writes).

### 4.3 Business logic placement

- Keep schema **statics/methods** to genuinely model-intrinsic behavior (`user.comparePassword()`, `Order.findActiveByCustomer()`) — anything that orchestrates multiple models, calls external services, or encodes a specific service's business rules belongs in that service's own domain/service layer, not in the shared schema file. A shared package full of one service's business logic is just duplication moved one level up, and it re-couples services that should be independent.
- Avoid firing side effects (emails, webhooks, queue messages) from Mongoose middleware (`post('save')`) in a shared schema — a hook that makes sense for one consuming service becomes an unwanted (and hard-to-discover) side effect for every other consumer of that model. Keep shared-schema middleware limited to data-shape concerns (normalization, defaulting, soft-delete filtering).

### 4.4 Cross-cutting concerns via plugins

- Implement soft-delete, auditing (`createdBy`/`updatedBy`), optimistic concurrency (`__v` / a custom `version` key), and pagination helpers as **composable schema plugins** (`schema.plugin(softDeletePlugin)`), not copy-pasted into every schema file. This is the shared-package equivalent of the DRY principle the whole migration is chasing — don't recreate the duplication problem *inside* the new package.
- Apply plugins consistently and document, per schema, which plugins are applied and in what order (see §2.4 on why order matters).

### 4.5 TypeScript integration

- Define the raw document interface first, then type the schema against it: `new Schema<UserDoc>({...})`, so the compiler catches field name/type mismatches between the interface and the schema definition at authoring time.
- Where feasible, prefer `InferSchemaType` to derive types directly from the schema definition instead of maintaining a hand-written interface in parallel — eliminates an entire class of drift.
- Export three distinct type shapes from the package, clearly named, so consumers don't reach for the wrong one: the **hydrated document type** (has Mongoose instance methods), the **lean/plain-object type** (result of `.lean()`), and a **DTO/API-safe type** (post `toJSON` transform, safe to serialize to a client).

### 4.6 Discriminators for polymorphism

- Use discriminators instead of hand-rolled `type` fields with manual branching logic when you have genuinely overlapping schemas on the same collection (e.g., `Payment` base with `CardPayment`/`BankTransferPayment` children). This is very often *exactly* the situation duplicated schemas are approximating badly by hand.
- Register all `pre`/`post` hooks and plugins on the **base schema before calling `.discriminator()`** — hooks added afterward do not retroactively apply.
- Remember Mongoose blocks changing the discriminator key by default; if a document needs to change "type" post-creation, that needs an explicit, deliberate migration path, not a normal `.save()`.

### 4.7 Testing the shared package in isolation

- Give the shared package its own test suite using `mongodb-memory-server`, covering every validator, every plugin, and every discriminator branch, independent of any consuming app's test suite. This is what actually prevents regressions once multiple services depend on one package instead of each guarding their own copy.
- Snapshot-test the *serialized* (`toJSON`) shape of each model, so an accidental change to a `toJSON` transform (which silently changes every API response across every consumer) is caught in CI before publish.

---

## 5. Recommended directory structure for the shared models package

A shared Mongoose package benefits from separating **schema definition**, **model compilation**, **types**, and **cross-cutting plugins** into distinct, predictable locations — this is what actually keeps the package from re-accumulating the same duplication problem internally as it grows. A structure that has worked well in practice:

```
packages/
└── models/                         # e.g. @yourorg/models
    ├── package.json                # "mongoose" as a peerDependency, not a dependency
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts                 # single public entry point — re-exports only, no logic
    │   │
    │   ├── connection/
    │   │   └── create-connection.ts # helper for consumers to open a scoped mongoose.Connection
    │   │
    │   ├── plugins/                 # cross-cutting, composable schema plugins
    │   │   ├── soft-delete.plugin.ts
    │   │   ├── audit-fields.plugin.ts
    │   │   ├── pagination.plugin.ts
    │   │   └── index.ts
    │   │
    │   ├── shared/                  # reusable SchemaTypes / sub-schemas embedded by multiple models
    │   │   ├── address.subschema.ts
    │   │   ├── money.schema-type.ts
    │   │   └── index.ts
    │   │
    │   └── user/                    # one folder PER MODEL — the core organizing unit
    │       ├── user.types.ts        # UserDoc interface / InferSchemaType source of truth
    │       ├── user.schema.ts       # `new Schema<UserDoc>({...})` + validators + hooks + plugin() calls
    │       ├── user.statics.ts      # static/query-helper methods, kept out of the schema file itself
    │       ├── user.methods.ts      # instance methods (e.g. comparePassword)
    │       ├── user.model.ts        # exported factory: registerUserModel(conn) -> Model<UserDoc>
    │       ├── user.dto.ts          # API-safe / serialized shape, derived from user.schema's toJSON
    │       └── index.ts             # per-model barrel: re-export types/schema/model factory only
    │
    │   └── order/                   # each additional model gets the same five-file shape
    │       ├── order.types.ts
    │       ├── order.schema.ts
    │       ├── order.statics.ts
    │       ├── order.methods.ts
    │       ├── order.model.ts
    │       ├── order.dto.ts
    │       └── index.ts
    │
    │   └── payment/                 # example of a discriminator base + children
    │       ├── payment.types.ts
    │       ├── payment.schema.ts        # base schema — all hooks/plugins registered here first
    │       ├── payment.model.ts
    │       ├── card-payment.schema.ts   # child: payment.schema.discriminator('Card', ...)
    │       ├── bank-payment.schema.ts   # child: payment.schema.discriminator('Bank', ...)
    │       └── index.ts
    │
    └── test/
        ├── setup.ts                  # mongodb-memory-server bootstrap
        ├── user.schema.test.ts
        ├── order.schema.test.ts
        └── payment.discriminators.test.ts
```

**Why this shape, specifically:**

- **One folder per model, not one giant `schemas/` and a separate giant `models/` folder.** Co-locating a model's schema, types, statics, methods, and DTO means a reviewer changing `user.schema.ts` sees the related statics/DTO files in the same diff review, and it's immediately obvious when a change to the schema wasn't reflected in the DTO — the exact drift this whole migration exists to prevent.
- **`*.model.ts` exports a factory function, not a compiled model** (per §2.3) — `registerUserModel(conn)` — so the package never assumes a single global connection and never hits `OverwriteModelError` from being imported twice.
- **`*.types.ts` is the single source of truth for the document shape.** Either hand-write the interface here and type the schema against it, or derive the type via `InferSchemaType` here and import it everywhere else — never redefine the shape in a second location.
- **`*.dto.ts` is separate from `*.types.ts` on purpose** — the hydrated Mongoose document type and the "safe to send over the wire" type are different concerns (§2.6) and collapsing them is a common source of accidental data leaks (internal fields, `__v`, unpopulated ObjectId refs reaching a client).
- **`plugins/` and `shared/` live at the top level, outside any single model's folder**, specifically so they're visibly reusable — if a behavior only ever gets used by one model, it doesn't belong here, it belongs inside that model's own folder (don't pre-abstract).
- **Discriminator families (`payment/`) get their own folder with the base schema first**, making the "hooks/plugins must be registered before `.discriminator()` is called" ordering constraint (§2.6/§4.6) structurally visible — the base schema file is read top-to-bottom before the child files even exist in the directory listing.
- **`index.ts` at both the package root and per-model level is a re-export barrel only** — no logic lives there. This keeps the public API surface reviewable in one small file per model, and makes it trivial to see (and intentionally control) exactly what a consuming service is allowed to import.
- **Tests live in a top-level `test/` directory mirroring model names**, not co-located `*.test.ts` next to each schema — this is a matter of taste, but keeping the `src/` tree free of test files makes the package's build output (what actually gets published/consumed) unambiguous at a glance.

**Anti-patterns to explicitly avoid:**
- A flat `schemas/` folder with 40 files and no per-model grouping — forces reviewers to jump between distant files to see one model's full picture, which is exactly how the original duplication drifted unnoticed in the first place.
- Compiling and exporting models directly from `index.ts` (`export const User = mongoose.model(...)`) — reintroduces the connection-scoping and `OverwriteModelError` problems this structure is designed to avoid.
- Mixing consumer-specific business logic into `*.statics.ts`/`*.methods.ts` because "it's convenient" — if only one service ever calls it, it doesn't belong in the shared package at all.

---

## 6. Migration approach (step-by-step summary)

1. **Inventory.** Find every duplicated schema across the monorepo/repos; diff them field-by-field, index-by-index, hook-by-hook (§3.1).
2. **Audit real data.** Query production/staging for documents that violate what the unified schema will require (§3.2).
3. **Design the shared package** using the structure in §5, deciding up front on connection strategy (§2.3), plugin composition (§2.4/§4.4), and typing strategy (§2.6/§4.5).
4. **Author the unified schema(s)** as an additive, backward-compatible superset first — don't remove or tighten anything yet (expand phase, §3.3).
5. **Publish internally** (`workspace:*` or a versioned internal registry package) with `mongoose` as a `peerDependency` (§2.2).
6. **Migrate consumers one at a time**, each switching its imports to the shared package while keeping runtime behavior identical; run the shared package's own test suite (§4.7) plus each consumer's existing tests.
7. **Backfill data** for any field/index that the *eventual* stricter schema will need but old data lacks (§3.2/§3.4).
8. **Contract**: once every consumer is confirmed on the shared package, remove now-dead legacy fields, tighten validators, add previously-deferred unique indexes, and bump a major version if any of this is a breaking change for a laggard consumer (§2.8/§3.3).
9. **Delete the duplicated schema files** from each service only after its production traffic has run against the shared package for a full deploy cycle with no regressions.
10. **Keep the shared package's CI gate strict**: schema changes should require a changelog entry and, for anything touching `required`/`enum`/index uniqueness, an explicit data-migration/backfill script checked in alongside the schema change (§3.2/§3.4).

---

## Sources consulted

- [best way to split mongoose models in a monorepo · Issue #9166 · Automattic/mongoose](https://github.com/Automattic/mongoose/issues/9166)
- [Mongoose FAQ](https://mongoosejs.com/docs/faq.html)
- [Best practices for managing Mongoose models and migrations? · Discussion #13064 · Automattic/mongoose](https://github.com/Automattic/mongoose/discussions/13064)
- [Fixing "Cannot Overwrite Model Once Compiled" — Sling Academy](https://www.slingacademy.com/article/fixing-nodejs-mongoose-cannot-overwrite-model-error/)
- [Mongoose Discriminators docs](https://mongoosejs.com/docs/discriminators.html)
- [Mongoose Discriminator: The non-DRY way to inherit schema properties](https://techinsights.manisuec.com/mongodb/mongoose-discriminator-non-dry-way-inherit-properties/)
- [Mongoose Schemas guide](https://mongoosejs.com/docs/guide.html)
- [MongoDB schema design best practices — educative.io](https://www.educative.io/courses/learn-mongodb/lta/best-practices-for-schema-design)
- [Mongoose Connections docs](https://mongoosejs.com/docs/connections.html)
- [Stop using Mongoose's default connection — dev.to](https://dev.to/maixuanhan/stop-using-the-mongoose-s-default-connection-4nnj)
- [Multi-database with Mongoose — dev.to](https://dev.to/woovi/multidatabase-with-mongoose-1m76)
- [pnpm Workspaces docs](https://pnpm.io/workspaces)
- [pnpm doesn't respect workspace package peerDependencies · Issue #3558](https://github.com/pnpm/pnpm/issues/3558)
- [Understanding package dependencies within a pnpm monorepo — dev.to](https://dev.to/adamgoth/understanding-package-dependencies-within-a-pnpm-monorepo-19ge)
- [Detect and Prevent Database Schema Drift — Liquibase](https://www.liquibase.com/blog/database-drift)
- [Understanding Schema Drift: Causes, Impact & Solutions — Acceldata](https://www.acceldata.io/blog/schema-drift)
