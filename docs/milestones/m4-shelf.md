# M4 — Shelf (Manual Product Collection)

**Status:** Implementation in progress
**Depends on:** M1 (products + scoring), M2.5 (subcategory inference for upgrades_available match)
**Exit criteria:** Expo client renders the Shelf tab against real backend data; the Recs tab can ship its single-release swap. `/api/shelf` GET / POST / PUT / DELETE return correct data; scan events bump `scan_date` for shelf items.

---

## Goal

Replace the Recs tab with a manual, user-curated product collection. Most men settle on a routine and rarely change it — the shelf organizes what a user already uses, verifies safety, and surfaces upgrade opportunities. See [cucumberdude/docs/product/FEATURES/SHELF.md](../../../cucumberdude/docs/product/FEATURES/SHELF.md) for the product spec (canonical source).

---

## Schema

Migration: [`db/migrations/0006_shelf_items.sql`](../../db/migrations/0006_shelf_items.sql).

```sql
CREATE TABLE shelf_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT NOT NULL,
  product_id         UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  scan_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  swapped_from_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name       TEXT NOT NULL,
  product_brand      TEXT,
  product_category   TEXT NOT NULL,
  current_score      SMALLINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE INDEX shelf_items_user_scan_date_idx ON shelf_items (user_id, scan_date DESC);
CREATE INDEX shelf_items_user_category_idx  ON shelf_items (user_id, product_category);
```

**Why denormalize product_name / brand / category / current_score:** spec calls for fast list rendering without joining `products` for every shelf row. Trade-off is staleness on rescore. Per-user shelf is bounded (target ~10–25 items), so a future refresh job or trigger is cheap; revisit if drift bites.

**`swapped_from_id` ON DELETE SET NULL** — preserves the swap label even if the swapped-out product later disappears from the catalog. The denormalized `product_name`/`brand` snapshot is captured at add-time, so the GET response can fall back to a label-only display if the FK clears.

---

## Endpoints

### `GET /api/shelf`

Fetch the authenticated user's shelf with stats.

```
Query:
  ?category=food|grooming|supplement|all   (default: all)
  ?sort=recent|alphabetical                (default: recent)

Response (ShelfResponse):
{
  items: ShelfItem[],
  stats: {
    total_count:        number,
    average_score:      number | null,   // null when scored_item_count < 3
    upgrades_available: number,
    scored_item_count:  number
  }
}
```

**`average_score`** — rounded mean of items with non-null score. Returned `null` when fewer than 3 items have scores; this masks early-stage noise on shelves dominated by null-scored entries (catalog ~57% null-score as of 2026-04-27).

**`upgrades_available`** — counts shelf items where:
- `current_score` is non-null, AND
- the product has a non-null `subcategory`, AND
- there exists a product in the same `subcategory` (excluding self) with non-null `score` strictly greater than the shelf item's `current_score`.

Subcategory match (not category) mirrors the recs API's matching unit — that's the smallest meaningful "comparable alternative" cluster. The product spec uses the word "category" but the spirit is "comparable alternative." Documented here, not changed in spec, because the recs API already established the precedent.

### `POST /api/shelf`

Add one or more products to the shelf.

```
Body (AddToShelfRequest):
{
  product_ids: string[]   // 1..MAX_BULK_ADD (currently 100)
}

Response (AddToShelfResponse):
{
  added:       string[],
  duplicates:  string[],
  errors:      string[],
  swap_candidates?: {
    [added_product_id: string]: SwapCandidate[]
  }
}
```

**`swap_candidates`** is populated only on the single-add path (`product_ids.length === 1` AND the add succeeded). The map key is the added product's id; the value is up to 5 lower-scored shelf items in the same `subcategory`, sorted ascending by `current_score`. The map is **omitted entirely** when there are no candidates — the FE branches on key presence (`if (response.swap_candidates) { … }`), no need to handle empty arrays.

Bulk add (history import) intentionally skips swap candidates; the post-add prompt would be too noisy when adding 5+ items at once.

Inserts use `ON CONFLICT (user_id, product_id) DO NOTHING`. Denormalized product fields are pulled from `products` in the same statement.

### `PUT /api/shelf/:id`

Limited update. Currently only `product_category` is editable. **`scan_date` is intentionally NOT updatable here** — it's auto-bumped server-side on scans (see scan hook below). The Expo client's "Update Shelf" button is informational; the backend updates `scan_date` regardless of whether the button is tapped.

```
Body (UpdateShelfRequest):
{
  product_category?: 'food' | 'grooming' | 'supplement'
}

Response: { updated: true } | { error, status: 404 }
```

### `DELETE /api/shelf/:id`

Remove a shelf item, optionally atomically linking the swap-from on a different shelf row (Flow 4 in product spec).

```
Body (optional, DeleteShelfRequest):
{
  swap_link_to_product_id?: string   // product_id of the row the user is "keeping"
}

Response (DeleteShelfResponse):
{
  deleted: boolean,
  linked:  boolean
}
```

When `swap_link_to_product_id` is provided, the operation runs in a transaction:
1. Look up the deleted item's `product_id`.
2. Set `swapped_from_id = <deleted item's product_id>` on the row matching the swap target.
3. Delete the original row.

Failure modes (rollback the whole operation):
- Target row not on the user's shelf → `400 swap_link_target_not_on_shelf`
- Deleted product == swap target product → `400 self_link_invalid`
- Shelf item not found → `404 not_found`

---

## Scan-date hook (no new endpoint)

`GET /api/products/scan/[barcode]` already records `scan_events` and writes the products cache. Both branches (cache hit + live lookup) now also fire:

```sql
UPDATE shelf_items SET scan_date = now(), updated_at = now()
WHERE user_id = $1 AND product_id = $2
```

No-op when the product isn't on the user's shelf. Wrapped in the existing `after()` background callback (cache hit branch) and the live-lookup `after()` block — non-blocking, never fails the scan response.

The Expo client does **not** call any "update shelf scan date" endpoint. `PUT /api/shelf/:id` does not accept `scan_date`. The single source of truth for `scan_date` is real barcode resolution.

---

## Frontend coupling

- **Type contract:** `types/guardscan.ts` defines `ShelfItem`, `ShelfResponse`, `ShelfStats`, `SwapCandidate`, `AddToShelfRequest/Response`, `UpdateShelfRequest`, `DeleteShelfRequest/Response`. The Expo app must mirror these structurally (it already imports from a parallel `types/guardscan.ts`).
- **Recs deletion:** the Expo client deletes the Recs tab in the same release. Backend leaves `/api/recommendations` in place for now — no client calls it, but removing it is a separate cleanup.
- **Toast component:** the Expo client must install a toast system before shipping (see product spec Prerequisites).

---

## Open questions / future

- **`current_score` refresh:** denormalized score will go stale on rescore. Options when this bites: (a) periodic backfill job that joins `products` and updates `shelf_items.current_score`, (b) trigger on `products` update. Defer until measured staleness is a problem.
- **Subcategory taxonomy:** if shelf upgrade detection misses obviously-comparable products because subcategory is null, expand the `inferSubcategory` vocabulary (lib/subcategory.ts) — same fix that benefits recs.
- **Push notifications:** "better alternative found for an item on your shelf" is a natural fit but deliberately out of scope for M4. Revisit after observing organic re-engagement.
