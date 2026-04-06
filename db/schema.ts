import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// ── products ────────────────────────────────────────────────────────────────

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    barcode: text('barcode').notNull().unique(),
    name: text('name').notNull(),
    brand: text('brand'),
    category: text('category', {
      enum: ['food', 'grooming', 'supplement'],
    }).notNull(),
    // Populated by subcategory inference in M2.5 (Recommendations backing API).
    // Used to cluster products for alternative ranking (e.g. 'sunscreen', 'shave').
    subcategory: text('subcategory'),
    imageFront: text('image_front'),
    imageIngredients: text('image_ingredients'),
    imageNutrition: text('image_nutrition'),
    rawIngredients: text('raw_ingredients'),
    source: text('source', {
      enum: ['off', 'obf', 'dsld', 'commercial', 'user'],
    }).notNull(),
    sourceId: text('source_id'),
    score: smallint('score'),
    scoreBreakdown: jsonb('score_breakdown'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    categoryScoreIdx: index('products_category_score_idx').on(
      table.category,
      table.score,
    ),
  }),
);

// ── product_ingredients ─────────────────────────────────────────────────────

export const productIngredients = pgTable(
  'product_ingredients',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    normalized: text('normalized').notNull(),
    flag: text('flag', {
      enum: ['positive', 'neutral', 'caution', 'negative'],
    }),
    reason: text('reason'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.productId, table.position] }),
  }),
);

// ── ingredient_dictionary ───────────────────────────────────────────────────

export const ingredientDictionary = pgTable('ingredient_dictionary', {
  normalized: text('normalized').primaryKey(),
  displayName: text('display_name').notNull(),
  flag: text('flag', {
    enum: ['positive', 'neutral', 'caution', 'negative'],
  }).notNull(),
  category: text('category'),
  evidenceUrl: text('evidence_url'),
  notes: text('notes'),
  fertilityRelevant: text('fertility_relevant').default('false'),
  testosteroneRelevant: text('testosterone_relevant').default('false'),
});

// ── user_submissions ────────────────────────────────────────────────────────

export const userSubmissions = pgTable('user_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  barcode: text('barcode').notNull(),
  photos: jsonb('photos').notNull(),
  ocrText: text('ocr_text'),
  status: text('status', {
    enum: ['pending', 'in_review', 'published', 'rejected'],
  })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type ProductIngredientRow = typeof productIngredients.$inferSelect;
export type NewProductIngredientRow = typeof productIngredients.$inferInsert;
