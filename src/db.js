const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')
const Database = require('better-sqlite3')

class StoreDb {
  constructor (dbPath, config) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.config = config
    this.momoOwner = config.momoOwner || '__momo__'
    this.catalog = null
    this.catalogMigrationDeferred = false
    this.offlineIdentityMergeDeferred = false
    this.transactionContext = new AsyncLocalStorage()
    this.init()
  }

  init () {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        uuid TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS items (
        item_key TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        nbt_json TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '',
        display_name_manual INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS balances (
        owner_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_uuid, item_key),
        FOREIGN KEY (item_key) REFERENCES items(item_key)
      );

      CREATE TABLE IF NOT EXISTS chests (
        chest_id TEXT PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        block_name TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chest_slots (
        chest_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (chest_id, slot),
        FOREIGN KEY (chest_id) REFERENCES chests(chest_id) ON DELETE CASCADE,
        FOREIGN KEY (item_key) REFERENCES items(item_key)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        player_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        items_json TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        deduction_key TEXT NOT NULL DEFAULT '',
        bot_id TEXT NOT NULL DEFAULT '',
        bot_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        username_lower TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        uuid TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS player_quotas (
        owner_uuid TEXT PRIMARY KEY,
        quota_slots INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS personal_warehouses (
        owner_uuid TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_by_uuid TEXT NOT NULL DEFAULT '',
        created_by_username TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS custom_warehouses (
        name_lower TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creator_uuid TEXT NOT NULL,
        creator_username TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS custom_warehouse_members (
        warehouse_name_lower TEXT NOT NULL,
        player_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (warehouse_name_lower, player_uuid),
        FOREIGN KEY (warehouse_name_lower) REFERENCES custom_warehouses(name_lower) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS warehouse_feature_settings (
        owner_uuid TEXT PRIMARY KEY,
        quick_shulker_extraction_enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS item_name_overrides (
        short_code TEXT PRIMARY KEY,
        item_key TEXT,
        item_id TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS global_item_aliases (
        alias_lower TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        item_key TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'normal',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS player_item_name_overrides (
        player_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_uuid, item_key),
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS player_item_aliases (
        player_uuid TEXT NOT NULL,
        alias_lower TEXT NOT NULL,
        alias TEXT NOT NULL,
        item_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_uuid, alias_lower),
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS player_item_display_names (
        player_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_uuid, item_key),
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS player_disabled_global_aliases (
        player_uuid TEXT NOT NULL,
        alias_lower TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_uuid, alias_lower),
        FOREIGN KEY (alias_lower) REFERENCES global_item_aliases(alias_lower) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS item_key_aliases (
        short_code TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS shulker_contents (
        shulker_item_key TEXT NOT NULL,
        contained_item_key TEXT NOT NULL,
        contained_item_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        slot_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (shulker_item_key, contained_item_key),
        FOREIGN KEY (shulker_item_key) REFERENCES items(item_key) ON DELETE CASCADE,
        FOREIGN KEY (contained_item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS web_login_tokens (
        owner_uuid TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        session_hash TEXT PRIMARY KEY,
        owner_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS inventory_mismatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        owner_uuid TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        item_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        nbt_json TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        balance_adjusted INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS active_recovery_tasks (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        type TEXT NOT NULL,
        actor_username TEXT NOT NULL DEFAULT '',
        owner_uuid TEXT NOT NULL DEFAULT '',
        owner_username TEXT NOT NULL DEFAULT '',
        owner_scope TEXT NOT NULL DEFAULT 'personal',
        vault_name TEXT NOT NULL DEFAULT '',
        target_username TEXT NOT NULL DEFAULT '',
        phase TEXT NOT NULL DEFAULT '',
        deduction_key TEXT NOT NULL DEFAULT '',
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bot_recovery_tasks (
        bot_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        actor_username TEXT NOT NULL DEFAULT '',
        owner_uuid TEXT NOT NULL DEFAULT '',
        owner_username TEXT NOT NULL DEFAULT '',
        owner_scope TEXT NOT NULL DEFAULT 'personal',
        vault_name TEXT NOT NULL DEFAULT '',
        target_username TEXT NOT NULL DEFAULT '',
        phase TEXT NOT NULL DEFAULT '',
        deduction_key TEXT NOT NULL DEFAULT '',
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS shulker_repack_recovery (
        bot_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'prepared',
        owner_uuid TEXT NOT NULL,
        owner_username TEXT NOT NULL DEFAULT '',
        old_box_item_key TEXT NOT NULL,
        source_chest_id TEXT NOT NULL DEFAULT '',
        target_item_json TEXT NOT NULL,
        before_amount INTEGER NOT NULL,
        requested_amount INTEGER NOT NULL,
        new_box_item_json TEXT NOT NULL DEFAULT '',
        extracted_items_json TEXT NOT NULL DEFAULT '[]',
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS inventory_reservations (
        reservation_id TEXT NOT NULL,
        owner_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (reservation_id, owner_uuid, item_key),
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bot_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        bot_name TEXT NOT NULL UNIQUE,
        profiles_folder TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS command_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        command_text TEXT NOT NULL,
        channel TEXT NOT NULL,
        receiver_bot_id TEXT NOT NULL DEFAULT '',
        receiver_bot_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS command_log_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_log_id INTEGER NOT NULL,
        target_username TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT 'private',
        bot_id TEXT NOT NULL DEFAULT '',
        bot_name TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (command_log_id) REFERENCES command_logs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS subscription_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS subscription_plans (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        quota_slots INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        features_json TEXT NOT NULL DEFAULT '[]',
        visible INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wallet_accounts (
        player_uuid TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        type TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        balance_before_cents INTEGER NOT NULL,
        balance_after_cents INTEGER NOT NULL,
        reference_type TEXT NOT NULL DEFAULT '',
        reference_id TEXT NOT NULL DEFAULT '',
        admin_uuid TEXT NOT NULL DEFAULT '',
        admin_username TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS warehouse_subscriptions (
        owner_uuid TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        cancelled_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
      );

      CREATE TABLE IF NOT EXISTS subscription_orders (
        id TEXT PRIMARY KEY,
        owner_uuid TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        payer_uuid TEXT NOT NULL,
        payer_username TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        previous_expires_at_ms INTEGER NOT NULL,
        new_expires_at_ms INTEGER NOT NULL,
        plan_name_snapshot TEXT NOT NULL,
        quota_slots_snapshot INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid',
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS subscription_cancellations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_uuid TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        previous_expires_at_ms INTEGER NOT NULL,
        admin_uuid TEXT NOT NULL DEFAULT '',
        admin_username TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS auto_registration_daily (
        day_key TEXT PRIMARY KEY,
        registration_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS unrecognized_payment_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_name TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS wallet_identity_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        ghost_uuid TEXT NOT NULL,
        real_uuid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_items_item_id ON items(item_id);
      CREATE INDEX IF NOT EXISTS idx_balances_item_key ON balances(item_key);
      CREATE INDEX IF NOT EXISTS idx_chest_slots_item_key ON chest_slots(item_key);
      CREATE INDEX IF NOT EXISTS idx_custom_warehouse_members_player ON custom_warehouse_members(player_uuid);
      CREATE INDEX IF NOT EXISTS idx_item_key_aliases_item_key ON item_key_aliases(item_key);
      CREATE INDEX IF NOT EXISTS idx_global_item_aliases_item_key ON global_item_aliases(item_key);
      CREATE INDEX IF NOT EXISTS idx_player_item_name_overrides_item ON player_item_name_overrides(item_key);
      CREATE INDEX IF NOT EXISTS idx_player_item_aliases_item ON player_item_aliases(player_uuid, item_key);
      CREATE INDEX IF NOT EXISTS idx_player_item_display_names_item ON player_item_display_names(item_key);
      CREATE INDEX IF NOT EXISTS idx_shulker_contents_contained_key ON shulker_contents(contained_item_key);
      CREATE INDEX IF NOT EXISTS idx_shulker_contents_contained_id ON shulker_contents(contained_item_id);
      CREATE INDEX IF NOT EXISTS idx_web_login_tokens_hash ON web_login_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_inventory_mismatches_status ON inventory_mismatches(status, kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_inventory_mismatches_item_key ON inventory_mismatches(item_key);
      CREATE INDEX IF NOT EXISTS idx_inventory_reservations_item ON inventory_reservations(owner_uuid, item_key);
      CREATE INDEX IF NOT EXISTS idx_command_logs_created ON command_logs(id DESC);
      CREATE INDEX IF NOT EXISTS idx_command_log_replies_command ON command_log_replies(command_log_id, id);
      CREATE INDEX IF NOT EXISTS idx_wallet_ledger_player ON wallet_ledger(player_uuid, id DESC);
      CREATE INDEX IF NOT EXISTS idx_wallet_ledger_created ON wallet_ledger(created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_subscription_orders_payer ON subscription_orders(payer_uuid, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_subscription_orders_owner ON subscription_orders(owner_uuid, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_unrecognized_payment_created ON unrecognized_payment_logs(created_at_ms DESC);
    `)

    this.ensureColumn('items', 'display_name_manual', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('transactions', 'bot_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('transactions', 'bot_name', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('transactions', 'deduction_key', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('global_item_aliases', 'category', "TEXT NOT NULL DEFAULT 'normal'")
    this.ensureColumn('active_recovery_tasks', 'items_json', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('active_recovery_tasks', 'deduction_key', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('bot_recovery_tasks', 'deduction_key', "TEXT NOT NULL DEFAULT ''")
    this.transaction(() => {
      const mismatchAdjustmentAdded = !this.db.prepare('PRAGMA table_info(inventory_mismatches)').all().some(column => column.name === 'balance_adjusted')
      this.ensureColumn('inventory_mismatches', 'balance_adjusted', 'INTEGER NOT NULL DEFAULT 0')
      if (!mismatchAdjustmentAdded) return
      // Older sync/withdraw paths already deducted these shortages but left
      // only their generated note as evidence. Migrate once before Web review.
      const update = this.db.prepare('UPDATE inventory_mismatches SET balance_adjusted = ? WHERE id = ?')
      for (const row of this.db.prepare("SELECT id, amount, note FROM inventory_mismatches WHERE kind = 'missing'").all()) {
        const match = String(row.note || '').match(/同步发现仓库实物少于账本，已自动扣除账面 x(\d+)/) ||
          String(row.note || '').match(/账面需修正 \d+，已自动扣除 (\d+)/)
        if (match) update.run(Math.min(Number(row.amount), Number(match[1])), row.id)
      }
    })
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_withdraw_deduction
      ON transactions (deduction_key, player_uuid)
      WHERE type = 'withdraw' AND deduction_key <> ''
    `)
    this.ensureColumn('players', 'default_owner_uuid', "TEXT NOT NULL DEFAULT ''")
    this.migrateManualItemNamesToOverrides()
    this.migratePlayerItemNameOverridesToAliases()
    this.migrateExistingPersonalWarehouses()
    const hasCraftOperations = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'craft_operations'").get()
    const staleReservations = this.db.prepare(hasCraftOperations
      ? `DELETE FROM inventory_reservations WHERE reservation_id NOT IN (
          SELECT id FROM craft_operations WHERE state NOT IN ('completed', 'complete', 'failed')
        )`
      : 'DELETE FROM inventory_reservations').run().changes
    if (staleReservations) console.log(`Released ${staleReservations} stale inventory reservation(s) from the previous process`)

    for (const username of this.config.admins || []) {
      this.addAdmin(username)
    }

    const cleanup = this.cleanupGhostOwners()
    if (cleanup.invalidQuotas || cleanup.orphanPlayers) {
      console.log(`Cleaned ghost owners: invalid quotas ${cleanup.invalidQuotas}, orphan players ${cleanup.orphanPlayers}`)
    }

    // 正版 v4 为准：同名离线 v3 身份的账本并入 v4 主号并删除 v3 行（见 autoMergeOfflineIdentities）。
    // 启动时执行一次即可覆盖存量；upsertPlayer 里的 canonicalPlayerUuid 保证后续离线身份上线自动改挂主号。
    const merged = this.autoMergeOfflineIdentities()
    if (merged.length) {
      console.log(`[identity] 已按“正版 UUID 为准”合并 ${merged.length} 个离线身份。`)
    }
  }

  setCatalog (catalog) {
    this.catalog = catalog
    // A durable craft journal refers to exact itemKeys. Do not migrate those
    // identities underneath an interrupted operation during process startup.
    if (this.hasPendingCraft()) {
      this.catalogMigrationDeferred = true
      return { deferred: true }
    }
    return this.applyCatalogMigration()
  }

  applyCatalogMigration () {
    this.catalogMigrationDeferred = true
    const migrated = this.canonicalizeItemKeys()
    if (migrated.moved > 0) {
      console.log(`Canonicalized ${migrated.moved} item keys, merged ${migrated.mergedBalances} balance rows`)
    }
    const indexed = this.rebuildShulkerContentIndex()
    this.catalogMigrationDeferred = false
    return { ...migrated, indexed }
  }

  runDeferredMigrations () {
    if (this.hasPendingCraft()) {
      return { deferred: this.catalogMigrationDeferred || this.offlineIdentityMergeDeferred }
    }
    const result = {}
    if (this.offlineIdentityMergeDeferred) {
      try {
        result.offlineIdentities = this.autoMergeOfflineIdentities({ throwOnError: true })
        this.offlineIdentityMergeDeferred = false
      } catch (error) {
        // Retain the flag so a later safe terminal transition can retry.
        console.warn(`[identity] deferred offline identity merge failed; will retry: ${error.message}`)
        result.offlineIdentityError = error
      }
    }
    if (this.catalogMigrationDeferred) {
      try {
        result.catalog = this.applyCatalogMigration()
      } catch (error) {
        // Keep the flag set so a later safe terminal transition can retry. A
        // failed migration must not turn an already-finished craft into a new
        // inventory mutation or lose the catalog work item.
        console.warn(`[catalog] deferred item-key migration failed; will retry: ${error.message}`)
        result.catalogError = error
      }
    }
    result.deferred = this.catalogMigrationDeferred || this.offlineIdentityMergeDeferred
    return result
  }

  rebuildShulkerContentIndex () {
    if (!this.catalog) return 0
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE item_id LIKE '%shulker_box'
    `).all()
    let indexed = 0
    this.transaction(() => {
      for (const row of rows) {
        this.replaceShulkerContentsForItem(row)
        indexed++
      }
    })
    return indexed
  }

  canonicalizeItemKeys () {
    this.assertNoPendingCraft()
    if (!this.catalog) return { moved: 0, mergedBalances: 0 }

    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, display_name_manual AS displayNameManual
      FROM items
      ORDER BY created_at ASC, item_key ASC
    `).all()

    const moves = []
    for (const row of rows) {
      const canonical = this.catalog.canonicalizeStoredItem(row)
      if (!canonical || canonical.itemKey === row.itemKey) continue
      moves.push({ old: row, canonical })
    }

    if (!moves.length) return { moved: 0, mergedBalances: 0 }

    let mergedBalances = 0
    this.transaction(() => {
      this.db.prepare('DELETE FROM shulker_contents').run()

      const insertBalance = this.db.prepare(`
        INSERT INTO balances (owner_uuid, item_key, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(owner_uuid, item_key) DO UPDATE SET
          amount = balances.amount + excluded.amount
      `)
      const oldBalances = this.db.prepare('SELECT owner_uuid AS ownerUuid, amount FROM balances WHERE item_key = ?')
      const deleteOldBalances = this.db.prepare('DELETE FROM balances WHERE item_key = ?')
      const updateSlots = this.db.prepare('UPDATE chest_slots SET item_key = ? WHERE item_key = ?')
      const updatePendingRepack = this.db.prepare('UPDATE shulker_repack_recovery SET old_box_item_key = ? WHERE old_box_item_key = ?')
      const oldPlayerOverrides = this.db.prepare(`
        SELECT player_uuid AS playerUuid, display_name AS displayName
        FROM player_item_name_overrides
        WHERE item_key = ?
      `)
      const insertPlayerOverride = this.db.prepare(`
        INSERT INTO player_item_name_overrides (player_uuid, item_key, item_id, display_name, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_uuid, item_key) DO UPDATE SET
          item_id = excluded.item_id,
          display_name = player_item_name_overrides.display_name,
          updated_at = CURRENT_TIMESTAMP
      `)
      const deletePlayerOverrides = this.db.prepare('DELETE FROM player_item_name_overrides WHERE item_key = ?')
      const movePlayerAliases = this.db.prepare('UPDATE player_item_aliases SET item_key = ?, updated_at = CURRENT_TIMESTAMP WHERE item_key = ?')
      const movePlayerDisplayNames = this.db.prepare('UPDATE player_item_display_names SET item_key = ?, updated_at = CURRENT_TIMESTAMP WHERE item_key = ?')
      const oldItemKeyAliases = this.db.prepare(`
        SELECT short_code AS shortCode, reason
        FROM item_key_aliases
        WHERE item_key = ?
      `)
      const insertItemKeyAlias = this.db.prepare(`
        INSERT OR IGNORE INTO item_key_aliases (short_code, item_key, reason)
        VALUES (?, ?, ?)
      `)
      const deleteItemKeyAliases = this.db.prepare('DELETE FROM item_key_aliases WHERE item_key = ?')
      const moveGlobalAliases = this.db.prepare('UPDATE global_item_aliases SET item_key = ?, updated_at = CURRENT_TIMESTAMP WHERE item_key = ?')
      const deleteOldItem = this.db.prepare('DELETE FROM items WHERE item_key = ?')
      const manualOverrideStmt = this.db.prepare(`
        UPDATE item_name_overrides
        SET item_key = COALESCE(item_key, ?),
            item_id = COALESCE(item_id, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE short_code = ?
      `)

      for (const move of moves) {
        this.upsertItem(move.canonical, { indexShulker: false })

        for (const balance of oldBalances.all(move.old.itemKey)) {
          insertBalance.run(balance.ownerUuid, move.canonical.itemKey, balance.amount)
          mergedBalances++
        }
        deleteOldBalances.run(move.old.itemKey)
        updateSlots.run(move.canonical.itemKey, move.old.itemKey)
        updatePendingRepack.run(move.canonical.itemKey, move.old.itemKey)
        for (const override of oldPlayerOverrides.all(move.old.itemKey)) {
          insertPlayerOverride.run(override.playerUuid, move.canonical.itemKey, move.canonical.itemId, override.displayName)
        }
        deletePlayerOverrides.run(move.old.itemKey)
        movePlayerAliases.run(move.canonical.itemKey, move.old.itemKey)
        movePlayerDisplayNames.run(move.canonical.itemKey, move.old.itemKey)
        const aliases = oldItemKeyAliases.all(move.old.itemKey)
        deleteItemKeyAliases.run(move.old.itemKey)
        for (const alias of aliases) {
          insertItemKeyAlias.run(alias.shortCode, move.canonical.itemKey, alias.reason || 'canonicalized_item_key')
        }
        moveGlobalAliases.run(move.canonical.itemKey, move.old.itemKey)

        const oldCode = this.shortCodeForItemKey(move.old.itemKey)
        const newCode = this.shortCodeForItemKey(move.canonical.itemKey)
        if (oldCode && oldCode !== newCode) {
          manualOverrideStmt.run(move.canonical.itemKey, move.canonical.itemId, oldCode)
        }

        deleteOldItem.run(move.old.itemKey)
      }
    })

    return { moved: moves.length, mergedBalances }
  }

  ensureColumn (table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  transaction (fn) {
    return this.db.transaction(fn)()
  }

  saveRecoveryTask (task, botId = 'legacy') {
    this.db.prepare(`
      INSERT INTO bot_recovery_tasks (
        bot_id, type, actor_username, owner_uuid, owner_username, owner_scope,
        vault_name, target_username, phase, deduction_key, items_json, updated_at
      )
      VALUES (@botId, @type, @actorUsername, @ownerUuid, @ownerUsername, @ownerScope,
        @vaultName, @targetUsername, @phase, @deductionKey, @itemsJson, CURRENT_TIMESTAMP)
      ON CONFLICT(bot_id) DO UPDATE SET
        type = excluded.type,
        actor_username = excluded.actor_username,
        owner_uuid = excluded.owner_uuid,
        owner_username = excluded.owner_username,
        owner_scope = excluded.owner_scope,
        vault_name = excluded.vault_name,
        target_username = excluded.target_username,
        phase = excluded.phase,
        deduction_key = excluded.deduction_key,
        items_json = excluded.items_json,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      botId: String(botId || 'legacy'),
      type: String(task.type || ''),
      actorUsername: String(task.actorUsername || ''),
      ownerUuid: String(task.ownerUuid || ''),
      ownerUsername: String(task.ownerUsername || ''),
      ownerScope: String(task.ownerScope || 'personal'),
      vaultName: String(task.vaultName || ''),
      targetUsername: String(task.targetUsername || ''),
      phase: String(task.phase || ''),
      deductionKey: String(task.deductionKey || ''),
      itemsJson: JSON.stringify(Array.isArray(task.items) ? task.items : [])
    })
  }

  getRecoveryTask (botId = 'legacy') {
    const row = this.db.prepare(`
      SELECT type, actor_username AS actorUsername, owner_uuid AS ownerUuid,
             owner_username AS ownerUsername, owner_scope AS ownerScope,
             vault_name AS vaultName, target_username AS targetUsername,
             phase, deduction_key AS deductionKey, items_json AS itemsJson, created_at AS createdAt, updated_at AS updatedAt
      FROM bot_recovery_tasks
      WHERE bot_id = ?
    `).get(String(botId || 'legacy'))
    if (!row) return null
    try {
      row.items = JSON.parse(row.itemsJson || '[]')
    } catch {
      row.items = []
    }
    return row
  }

  clearRecoveryTask (botId = 'legacy') {
    this.db.prepare('DELETE FROM bot_recovery_tasks WHERE bot_id = ?').run(String(botId || 'legacy'))
  }

  beginShulkerRepackRecovery (botId, details) {
    const id = String(botId || 'legacy')
    const targetItem = this.rowToItem(details.targetItem || {})
    const beforeAmount = Number(details.beforeAmount || 0)
    const requestedAmount = Number(details.requestedAmount || 0)
    if (!details.ownerUuid || !details.oldBoxItemKey || !targetItem.itemKey || beforeAmount <= 0 || requestedAmount <= 0) {
      throw new Error('invalid prepared shulker repack recovery')
    }
    try {
      this.db.prepare(`
        INSERT INTO shulker_repack_recovery (
          bot_id, state, owner_uuid, owner_username, old_box_item_key,
          source_chest_id, target_item_json, before_amount, requested_amount,
          message, updated_at
        ) VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        id,
        String(details.ownerUuid),
        String(details.ownerUsername || ''),
        String(details.oldBoxItemKey),
        String(details.sourceChestId || ''),
        JSON.stringify(targetItem),
        beforeAmount,
        requestedAmount,
        String(details.message || '')
      )
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new Error(`bot ${id} already has a pending shulker repack recovery`)
      }
      throw error
    }
    return this.getShulkerRepackRecovery(id)
  }

  markShulkerRepackPhysicalChange (botId, newBoxItem, extractedItems, message = '') {
    const id = String(botId || 'legacy')
    const box = this.rowToItem(newBoxItem || {})
    const extracted = (extractedItems || [])
      .map(item => ({ ...this.rowToItem(item), amount: Number(item.amount || 0) }))
      .filter(item => item.itemKey && item.amount > 0)
    if (!box.itemKey || !extracted.length) throw new Error('invalid physical shulker repack recovery update')
    const changed = this.db.prepare(`
      UPDATE shulker_repack_recovery
      SET state = 'physical_changed',
          new_box_item_json = ?,
          extracted_items_json = ?,
          message = CASE WHEN ? = '' THEN message ELSE ? END,
          updated_at = CURRENT_TIMESTAMP
      WHERE bot_id = ? AND state = 'prepared'
    `).run(JSON.stringify(box), JSON.stringify(extracted), String(message || ''), String(message || ''), id).changes
    if (!changed) throw new Error(`no prepared shulker repack recovery for bot ${id}`)
    return this.getShulkerRepackRecovery(id)
  }

  getShulkerRepackRecovery (botId = 'legacy') {
    const row = this.db.prepare(`
      SELECT bot_id AS botId, state, owner_uuid AS ownerUuid, owner_username AS ownerUsername,
             old_box_item_key AS oldBoxItemKey, source_chest_id AS sourceChestId,
             target_item_json AS targetItemJson, before_amount AS beforeAmount,
             requested_amount AS requestedAmount, new_box_item_json AS newBoxItemJson,
             extracted_items_json AS extractedItemsJson, message,
             created_at AS createdAt, updated_at AS updatedAt
      FROM shulker_repack_recovery WHERE bot_id = ? LIMIT 1
    `).get(String(botId || 'legacy'))
    if (!row) return null
    const parseItem = raw => {
      if (!raw) return null
      try {
        const item = JSON.parse(raw)
        return this.catalog?.canonicalizeStoredItem(item) || item
      } catch {
        return null
      }
    }
    row.targetItem = parseItem(row.targetItemJson)
    row.newBoxItem = parseItem(row.newBoxItemJson)
    try {
      row.extractedItems = JSON.parse(row.extractedItemsJson || '[]')
        .map(item => ({ ...(this.catalog?.canonicalizeStoredItem(item) || item), amount: Number(item.amount || 0) }))
        .filter(item => item.itemKey && item.amount > 0)
    } catch {
      row.extractedItems = []
    }
    return row
  }

  clearShulkerRepackRecovery (botId = 'legacy') {
    return this.db.prepare('DELETE FROM shulker_repack_recovery WHERE bot_id = ?').run(String(botId || 'legacy')).changes
  }

  commitShulkerRepackRecovery (botId = 'legacy') {
    const id = String(botId || 'legacy')
    return this.transaction(() => {
      const recovery = this.getShulkerRepackRecovery(id)
      if (!recovery) return null
      if (recovery.state !== 'physical_changed' || !recovery.newBoxItem?.itemKey || !recovery.extractedItems.length) {
        throw new Error(`shulker repack recovery for bot ${id} is not ready to commit`)
      }
      this.applyShulkerExtractionBalance(
        recovery.ownerUuid,
        recovery.oldBoxItemKey,
        recovery.newBoxItem,
        recovery.extractedItems,
        recovery.ownerUsername,
        recovery.message
      )
      this.clearShulkerRepackRecovery(id)
      return recovery
    })
  }

  resolveStuckShulkerRepack (botId = 'legacy', held = [], reason = '') {
    const id = String(botId || 'legacy')
    const recovery = this.getShulkerRepackRecovery(id)
    if (!recovery || recovery.state !== 'physical_changed') return null

    const heldByKey = new Map((Array.isArray(held) ? held : []).map(item => [item.itemKey, Number(item.amount || 0)]))
    const newBoxHeld = Boolean(recovery.newBoxItem?.itemKey) && (heldByKey.get(recovery.newBoxItem.itemKey) || 0) >= 1
    const groundedExtracted = (recovery.extractedItems || []).map(item => {
      const amount = Math.min(Number(item.amount || 0), heldByKey.get(item.itemKey) || 0)
      return amount > 0 ? { ...item, amount } : null
    }).filter(Boolean)

    // 按机器人背包实际持有的物品补账；背包里没有对应实物时绝不按记录盲补
    if (!newBoxHeld || !groundedExtracted.length) {
      this.transaction(() => {
        const current = this.getShulkerRepackRecovery(id)
        if (!current || current.state !== 'physical_changed') return
        this.addInventoryMismatch(
          'missing',
          current.ownerUuid,
          current.ownerUsername || '',
          { itemKey: current.oldBoxItemKey, itemId: current.newBoxItem?.itemId || '', displayName: current.newBoxItem?.displayName || current.oldBoxItemKey },
          1,
          `潜影盒重打包后机器人背包中没有对应实物，未按记录补账，已清除阻塞记录${reason ? `；来源：${reason}` : ''}。`
        )
        this.clearShulkerRepackRecovery(id)
      })
      return { recovery, committed: false, error: 'no matching held items' }
    }

    try {
      const exact = groundedExtracted.length === recovery.extractedItems.length &&
        groundedExtracted.every((item, index) => Number(item.amount) === Number(recovery.extractedItems[index].amount))
      let committed
      if (exact) {
        committed = this.commitShulkerRepackRecovery(id)
      } else {
        committed = this.transaction(() => {
          this.applyShulkerExtractionBalance(recovery.ownerUuid, recovery.oldBoxItemKey, recovery.newBoxItem, groundedExtracted, recovery.ownerUsername, recovery.message)
          this.clearShulkerRepackRecovery(id)
          return recovery
        })
      }
      return committed ? { recovery: committed, committed: true } : null
    } catch (error) {
      this.transaction(() => {
        const current = this.getShulkerRepackRecovery(id)
        if (!current || current.state !== 'physical_changed') return
        this.addInventoryMismatch(
          'missing',
          current.ownerUuid,
          current.ownerUsername || '',
          { itemKey: current.oldBoxItemKey, itemId: recovery.newBoxItem?.itemId || '', displayName: recovery.newBoxItem?.displayName || current.oldBoxItemKey },
          1,
          `潜影盒重打包恢复记录无法补记账本（${error.message}），已清除阻塞记录${reason ? `；来源：${reason}` : ''}。`
        )
        this.clearShulkerRepackRecovery(id)
      })
      return { recovery, committed: false, error: error.message }
    }
  }

  listRecoveryTasks () {
    return this.db.prepare(`
      SELECT bot_id AS botId, type, actor_username AS actorUsername,
             owner_uuid AS ownerUuid, target_username AS targetUsername, phase
      FROM bot_recovery_tasks
    `).all()
  }

  listBotAccounts () {
    return this.db.prepare(`
      SELECT id, username, bot_name AS botName, profiles_folder AS profilesFolder,
             enabled, created_at AS createdAt, updated_at AS updatedAt
      FROM bot_accounts ORDER BY created_at, bot_name COLLATE NOCASE
    `).all().map(row => ({ ...row, enabled: Boolean(row.enabled) }))
  }

  getBotAccount (id) {
    const row = this.db.prepare(`
      SELECT id, username, bot_name AS botName, profiles_folder AS profilesFolder,
             enabled, created_at AS createdAt, updated_at AS updatedAt
      FROM bot_accounts WHERE id = ?
    `).get(String(id || ''))
    return row ? { ...row, enabled: Boolean(row.enabled) } : null
  }

  createBotAccount ({ id, username, botName, profilesFolder, enabled = true }) {
    this.db.prepare(`
      INSERT INTO bot_accounts (id, username, bot_name, profiles_folder, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(id), String(username), String(botName), String(profilesFolder), enabled ? 1 : 0)
    return this.getBotAccount(id)
  }

  setBotAccountEnabled (id, enabled) {
    const result = this.db.prepare(`
      UPDATE bot_accounts SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(enabled ? 1 : 0, String(id || ''))
    if (!result.changes) throw new Error('找不到机器人账号。')
    return this.getBotAccount(id)
  }

  deleteBotAccount (id) {
    const account = this.getBotAccount(id)
    if (!account) throw new Error('找不到机器人账号。')
    this.db.prepare('DELETE FROM bot_accounts WHERE id = ?').run(account.id)
    return account
  }

  claimLegacyRecoveryTask (botId) {
    return this.transaction(() => {
      const existing = this.getRecoveryTask(botId)
      if (existing) return existing
      const legacy = this.db.prepare(`
        SELECT type, actor_username AS actorUsername, owner_uuid AS ownerUuid,
               owner_username AS ownerUsername, owner_scope AS ownerScope,
               vault_name AS vaultName, target_username AS targetUsername,
               phase, deduction_key AS deductionKey, items_json AS itemsJson
        FROM active_recovery_tasks WHERE id = 1
      `).get()
      if (!legacy) return null
      try {
        legacy.items = JSON.parse(legacy.itemsJson || '[]')
      } catch {
        legacy.items = []
      }
      this.saveRecoveryTask({ ...legacy, deductionKey: legacy.deductionKey || '' }, botId)
      this.db.prepare('DELETE FROM active_recovery_tasks WHERE id = 1').run()
      return this.getRecoveryTask(botId)
    })
  }

  reserveInventory (reservationId, items) {
    const grouped = new Map()
    for (const item of items || []) {
      const ownerUuid = String(item.ownerUuid || '')
      const itemKey = String(item.reservationItemKey || item.itemKey || '')
      const amount = Number(item.reservationAmount || item.amount || 0)
      if (!ownerUuid || !itemKey || amount <= 0) continue
      const key = `${ownerUuid}\u0000${itemKey}`
      const current = grouped.get(key) || { ownerUuid, itemKey, amount: 0 }
      current.amount += amount
      grouped.set(key, current)
    }

    this.transaction(() => {
      for (const item of grouped.values()) {
        const row = this.db.prepare(`
          SELECT b.amount - COALESCE(SUM(r.amount), 0) AS available
          FROM balances b
          LEFT JOIN inventory_reservations r
            ON r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key
          WHERE b.owner_uuid = ? AND b.item_key = ?
          GROUP BY b.owner_uuid, b.item_key
        `).get(item.ownerUuid, item.itemKey)
        if (Number(row?.available || 0) < item.amount) {
          throw new Error(`库存已被其他任务占用：${this.ownerLabel(item.ownerUuid)} ${item.itemKey}`)
        }
      }
      const insert = this.db.prepare(`
        INSERT INTO inventory_reservations (reservation_id, owner_uuid, item_key, amount)
        VALUES (?, ?, ?, ?)
      `)
      for (const item of grouped.values()) insert.run(String(reservationId), item.ownerUuid, item.itemKey, item.amount)
    })
  }

  releaseInventoryReservation (reservationId) {
    this.db.prepare('DELETE FROM inventory_reservations WHERE reservation_id = ?').run(String(reservationId))
  }

  consumeInventoryReservation (reservationId, ownerUuid, items) {
    this.transaction(() => {
      for (const item of items || []) this.adjustBalance(ownerUuid, item.itemKey, -Number(item.amount || 0))
      this.releaseInventoryReservation(reservationId)
    })
  }

  cleanupGhostOwners () {
    let invalidQuotas = 0
    let orphanPlayers = 0

    this.transaction(() => {
      invalidQuotas += this.db.prepare(`
        DELETE FROM player_quotas
        WHERE owner_uuid = 'name:momo'
           OR owner_uuid LIKE 'name:仓库:%'
           OR (
             owner_uuid LIKE 'name:%'
             AND lower(substr(owner_uuid, 6)) IN (
               SELECT name_lower FROM custom_warehouses
             )
           )
      `).run().changes

      orphanPlayers += this.db.prepare(`
        DELETE FROM players
        WHERE uuid LIKE 'name:%'
          AND uuid NOT IN (SELECT owner_uuid FROM balances)
          AND uuid NOT IN (SELECT owner_uuid FROM web_login_tokens)
          AND uuid NOT IN (SELECT owner_uuid FROM personal_warehouses)
          AND uuid NOT IN (SELECT player_uuid FROM player_item_name_overrides)
          AND uuid NOT IN (SELECT player_uuid FROM player_item_aliases)
          AND uuid NOT IN (SELECT player_uuid FROM player_item_display_names)
          AND uuid NOT IN (SELECT player_uuid FROM player_disabled_global_aliases)
          AND uuid NOT IN (SELECT player_uuid FROM custom_warehouse_members)
          AND uuid NOT IN (SELECT owner_uuid FROM player_quotas)
          AND uuid NOT IN (SELECT player_uuid FROM wallet_accounts)
          AND uuid NOT IN (SELECT payer_uuid FROM subscription_orders)
          AND uuid NOT IN (SELECT COALESCE(uuid, '') FROM admin_users)
      `).run().changes
    })

    return { invalidQuotas, orphanPlayers }
  }

  shortCodeForItemKey (itemKey) {
    const match = String(itemKey || '').match(/\|([0-9a-f]{6})/i)
    return match ? match[1].toLowerCase() : ''
  }

  getItemNameOverride (itemKey) {
    const shortCode = this.shortCodeForItemKey(itemKey)
    if (!shortCode) return null
    return this.db.prepare(`
      SELECT short_code AS shortCode, item_key AS itemKey, item_id AS itemId, display_name AS displayName
      FROM item_name_overrides
      WHERE short_code = ?
    `).get(shortCode) || null
  }

  listItemNameOverrides (query = '') {
    const rows = this.db.prepare(`
      SELECT o.short_code AS shortCode, o.item_key AS itemKey, o.item_id AS itemId,
             o.display_name AS displayName, o.created_at AS createdAt, o.updated_at AS updatedAt,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM item_name_overrides o
      LEFT JOIN items i ON i.item_key = o.item_key
      ORDER BY o.updated_at DESC, o.short_code ASC
    `).all()
    const text = String(query || '').trim().toLowerCase()
    return rows.filter(row => {
      if (!text) return true
      return [row.shortCode, row.itemKey, row.itemId, row.displayName, row.nbtJson, row.metaJson]
        .some(value => String(value || '').toLowerCase().includes(text))
    })
  }

  listGlobalItemAliases (query = '') {
    const rows = this.db.prepare(`
      SELECT a.alias, a.category, a.item_key AS itemKey, a.created_at AS createdAt, a.updated_at AS updatedAt,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM global_item_aliases a
      JOIN items i ON i.item_key = a.item_key
      ORDER BY i.display_name COLLATE NOCASE ASC, a.alias COLLATE NOCASE ASC
    `).all()
    const text = String(query || '').trim().toLowerCase()
    return rows.filter(row => !text || [
      row.alias, row.itemKey, row.itemId, row.displayName,
      this.shortCodeForItemKey(row.itemKey), row.nbtJson, row.metaJson
    ].some(value => String(value || '').toLowerCase().includes(text)))
  }

  getGlobalAliasesForItems (itemKeys = [], playerUuid = '') {
    const keys = [...new Set((itemKeys || []).filter(Boolean))]
    const result = new Map()
    if (!keys.length) return result
    const placeholders = keys.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT a.item_key AS itemKey, a.alias
      FROM global_item_aliases a
      WHERE a.item_key IN (${placeholders})
        AND (? = '' OR NOT EXISTS (
          SELECT 1 FROM player_disabled_global_aliases d
          WHERE d.player_uuid = ? AND d.alias_lower = a.alias_lower
        ))
      ORDER BY alias COLLATE NOCASE ASC
    `).all(...keys, playerUuid, playerUuid)
    for (const row of rows) {
      if (!result.has(row.itemKey)) result.set(row.itemKey, [])
      result.get(row.itemKey).push(row.alias)
    }
    return result
  }

  findItemByGlobalAlias (alias, playerUuid = '') {
    const text = String(alias || '').trim().toLowerCase()
    if (!text) return null
    return this.db.prepare(`
      SELECT i.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM global_item_aliases a
      JOIN items i ON i.item_key = a.item_key
      WHERE a.alias_lower = ?
        AND (? = '' OR NOT EXISTS (
          SELECT 1 FROM player_disabled_global_aliases d
          WHERE d.player_uuid = ? AND d.alias_lower = a.alias_lower
        ))
      LIMIT 1
    `).get(text, playerUuid, playerUuid) || null
  }

  normalizeGlobalAliasCategory (category) {
    const value = String(category || 'normal').trim().toLowerCase()
    if (!['normal', 'variant'].includes(value)) throw new Error('全局别名分类无效。')
    return value
  }

  saveGlobalItemAlias (itemKey, alias, category = 'normal') {
    const item = this.getItemByKey(itemKey)
    if (!item) throw new Error(`找不到物品：${itemKey}`)
    const nextAlias = String(alias || '').trim()
    if (!nextAlias) throw new Error('全局别名不能为空。')
    if ([...nextAlias].length > 40) throw new Error('全局别名不能超过 40 个字。')
    const aliasLower = nextAlias.toLowerCase()
    const nextCategory = this.normalizeGlobalAliasCategory(category)
    const existing = this.db.prepare(`
      SELECT item_key AS itemKey FROM global_item_aliases WHERE alias_lower = ?
    `).get(aliasLower)
    if (existing && existing.itemKey !== itemKey) throw new Error('这个全局别名已经被其他物品使用。')
    this.db.prepare(`
      INSERT INTO global_item_aliases (alias_lower, alias, item_key, category, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(alias_lower) DO UPDATE SET
        alias = excluded.alias,
        item_key = excluded.item_key,
        category = excluded.category,
        updated_at = CURRENT_TIMESTAMP
    `).run(aliasLower, nextAlias, itemKey, nextCategory)
    return { ...item, alias: nextAlias, category: nextCategory, shortCode: this.shortCodeForItemKey(itemKey) }
  }

  deleteGlobalItemAlias (alias) {
    const text = String(alias || '').trim()
    if (!text) throw new Error('缺少要删除的全局别名。')
    const changed = this.db.prepare('DELETE FROM global_item_aliases WHERE alias_lower = ?').run(text.toLowerCase()).changes
    return { changed, alias: text }
  }

  listGlobalItemAliasesForPlayer (playerUuid, query = '') {
    const rows = this.listGlobalItemAliases(query)
    const disabled = new Set(this.db.prepare(`
      SELECT alias_lower AS aliasLower FROM player_disabled_global_aliases WHERE player_uuid = ?
    `).all(playerUuid).map(row => row.aliasLower))
    return rows.map(row => ({ ...row, enabled: !disabled.has(String(row.alias || '').toLowerCase()) }))
  }

  setGlobalItemAliasEnabled (playerUuid, alias, enabled) {
    const player = String(playerUuid || '').trim()
    const text = String(alias || '').trim()
    const aliasLower = text.toLowerCase()
    if (!player || !aliasLower) throw new Error('缺少玩家或全局别名。')
    if (!this.db.prepare('SELECT 1 FROM global_item_aliases WHERE alias_lower = ?').get(aliasLower)) throw new Error('找不到这个全局别名。')
    if (enabled) {
      this.db.prepare('DELETE FROM player_disabled_global_aliases WHERE player_uuid = ? AND alias_lower = ?').run(player, aliasLower)
    } else {
      this.db.prepare(`INSERT OR IGNORE INTO player_disabled_global_aliases (player_uuid, alias_lower) VALUES (?, ?)`).run(player, aliasLower)
    }
    return { alias: text, enabled: Boolean(enabled) }
  }

  isGlobalItemAliasDisabled (playerUuid, alias) {
    const text = String(alias || '').trim().toLowerCase()
    if (!playerUuid || !text) return false
    return Boolean(this.db.prepare(`
      SELECT 1 FROM player_disabled_global_aliases
      WHERE player_uuid = ? AND alias_lower = ? LIMIT 1
    `).get(playerUuid, text))
  }

  saveItemNameOverride (itemKey, displayName) {
    const item = this.getItemByKey(itemKey)
    if (!item) throw new Error(`找不到物品：${itemKey}`)
    const shortCode = this.shortCodeForItemKey(itemKey)
    if (!shortCode) throw new Error('这个物品没有 6 位码，无法设置别名。')
    const nextName = String(displayName || '').trim()
    if (!nextName) throw new Error('别名不能为空。')
    if ([...nextName].length > 80) throw new Error('别名不能超过 80 个字。')

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO item_name_overrides (short_code, item_key, item_id, display_name, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(short_code) DO UPDATE SET
          item_key = excluded.item_key,
          item_id = excluded.item_id,
          display_name = excluded.display_name,
          updated_at = CURRENT_TIMESTAMP
      `).run(shortCode, item.itemKey, item.itemId, nextName)
      this.db.prepare(`
        UPDATE items
        SET display_name = ?, display_name_manual = 1
        WHERE item_key = ?
      `).run(nextName, item.itemKey)
    })

    return { ...item, oldDisplayName: item.displayName, displayName: nextName, shortCode }
  }

  deleteItemNameOverride (shortCode) {
    const code = String(shortCode || '').trim().replace(/^#/, '').toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(code)) throw new Error('短码必须是 6 位十六进制。')
    const row = this.db.prepare(`
      SELECT short_code AS shortCode, item_key AS itemKey
      FROM item_name_overrides
      WHERE short_code = ?
    `).get(code)
    if (!row) return { changed: 0, shortCode: code }

    this.transaction(() => {
      this.db.prepare('DELETE FROM item_name_overrides WHERE short_code = ?').run(code)
      if (row.itemKey) {
        const item = this.getItemByKey(row.itemKey)
        const restored = item && this.catalog
          ? this.catalog.describeStoredItem(item.itemId, item.metaJson, item.nbtJson)
          : null
        if (restored) {
          this.db.prepare(`
            UPDATE items
            SET display_name = ?, display_name_manual = 0
            WHERE item_key = ?
          `).run(restored, row.itemKey)
        } else {
          this.db.prepare(`
            UPDATE items
            SET display_name_manual = 0
            WHERE item_key = ?
          `).run(row.itemKey)
        }
      }
    })

    return { changed: 1, shortCode: code, itemKey: row.itemKey || '' }
  }

  getPlayerItemNameOverrides (playerUuid, itemKeys = []) {
    const aliases = this.getPlayerItemAliases(playerUuid, itemKeys)
    return new Map([...aliases].map(([itemKey, names]) => [itemKey, names[0] || '']))
  }

  getPlayerItemAliases (playerUuid, itemKeys = []) {
    const uniqueKeys = [...new Set((itemKeys || []).filter(Boolean))]
    if (!playerUuid || !uniqueKeys.length) return new Map()
    const placeholders = uniqueKeys.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, alias
      FROM player_item_aliases
      WHERE player_uuid = ? AND item_key IN (${placeholders})
      ORDER BY created_at ASC, alias COLLATE NOCASE ASC
    `).all(playerUuid, ...uniqueKeys)
    const result = new Map()
    for (const row of rows) {
      if (!result.has(row.itemKey)) result.set(row.itemKey, [])
      result.get(row.itemKey).push(row.alias)
    }
    return result
  }

  getPlayerItemDisplayNames (playerUuid, itemKeys = []) {
    const keys = [...new Set((itemKeys || []).filter(Boolean))]
    if (!playerUuid || !keys.length) return new Map()
    const placeholders = keys.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, display_name AS displayName
      FROM player_item_display_names
      WHERE player_uuid = ? AND item_key IN (${placeholders})
    `).all(playerUuid, ...keys)
    return new Map(rows.map(row => [row.itemKey, row.displayName]))
  }

  setPlayerItemDisplayName (playerUuid, itemKey, displayName) {
    const player = String(playerUuid || '').trim()
    const item = this.getItemByKey(itemKey)
    if (!player || !item) throw new Error('找不到玩家或物品。')
    const name = String(displayName || '').trim()
    if (!name) {
      this.db.prepare('DELETE FROM player_item_display_names WHERE player_uuid = ? AND item_key = ?').run(player, itemKey)
      return ''
    }
    this.db.prepare(`
      INSERT INTO player_item_display_names (player_uuid, item_key, display_name, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(player_uuid, item_key) DO UPDATE SET display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP
    `).run(player, itemKey, name)
    return name
  }

  savePlayerItemNameOverride (playerUuid, itemKey, displayName) {
    const item = this.getItemByKey(itemKey)
    if (!item) throw new Error(`找不到物品：${itemKey}`)
    const player = String(playerUuid || '').trim()
    if (!player) throw new Error('缺少玩家身份，无法设置个人别名。')
    const nextName = String(displayName || '').trim()
    const shortCode = this.shortCodeForItemKey(itemKey)

    if (!nextName) throw new Error('个人别名不能为空。')

    if ([...nextName].length > 40) throw new Error('个人别名不能超过 40 个字。')
    const aliasLower = nextName.toLowerCase()
    const existing = this.db.prepare(`
      SELECT item_key AS itemKey FROM player_item_aliases
      WHERE player_uuid = ? AND alias_lower = ?
    `).get(player, aliasLower)
    if (existing && existing.itemKey !== itemKey) throw new Error('你已经把这个别名用于其他物品。')
    this.db.prepare(`
      INSERT INTO player_item_aliases (player_uuid, alias_lower, alias, item_key, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(player_uuid, alias_lower) DO UPDATE SET
        alias = excluded.alias,
        item_key = excluded.item_key,
        updated_at = CURRENT_TIMESTAMP
    `).run(player, aliasLower, nextName, item.itemKey)

    return { ...item, displayName: nextName, personalAlias: nextName, personalAliases: this.getPlayerItemAliases(player, [itemKey]).get(itemKey) || [], shortCode, changed: 1 }
  }

  deletePlayerItemAlias (playerUuid, alias) {
    const player = String(playerUuid || '').trim()
    const text = String(alias || '').trim()
    if (!player || !text) throw new Error('缺少玩家或个人别名。')
    const row = this.db.prepare(`SELECT item_key AS itemKey FROM player_item_aliases WHERE player_uuid = ? AND alias_lower = ?`).get(player, text.toLowerCase())
    const changed = this.db.prepare(`
      DELETE FROM player_item_aliases WHERE player_uuid = ? AND alias_lower = ?
    `).run(player, text.toLowerCase()).changes
    return { changed, alias: text, itemKey: row?.itemKey || '' }
  }

  listPlayerItemAliases (playerUuid, query = '') {
    const rows = this.db.prepare(`
      SELECT a.alias, a.item_key AS itemKey, a.created_at AS createdAt, a.updated_at AS updatedAt,
             i.item_id AS itemId, i.display_name AS displayName, i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM player_item_aliases a JOIN items i ON i.item_key = a.item_key
      WHERE a.player_uuid = ?
      ORDER BY i.display_name COLLATE NOCASE ASC, a.created_at ASC
    `).all(playerUuid)
    const text = String(query || '').trim().toLowerCase()
    return rows.filter(row => !text || [row.alias, row.itemKey, row.itemId, row.displayName, this.shortCodeForItemKey(row.itemKey)]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }

  findItemByPlayerAlias (playerUuid, alias) {
    const text = String(alias || '').trim().toLowerCase()
    if (!playerUuid || !text) return null
    return this.db.prepare(`
      SELECT i.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM player_item_aliases a JOIN items i ON i.item_key = a.item_key
      WHERE a.player_uuid = ? AND a.alias_lower = ? LIMIT 1
    `).get(playerUuid, text) || null
  }

  migratePlayerItemNameOverridesToAliases () {
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO player_item_aliases (player_uuid, alias_lower, alias, item_key, created_at, updated_at)
        SELECT player_uuid, lower(display_name), display_name, item_key, created_at, updated_at
        FROM player_item_name_overrides
        WHERE trim(display_name) <> ''
      `).run()
      this.db.prepare('DELETE FROM player_item_name_overrides').run()
    })
  }

  migrateManualItemNamesToOverrides () {
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName
      FROM items
      WHERE display_name_manual = 1
    `).all()
    const stmt = this.db.prepare(`
      INSERT INTO item_name_overrides (short_code, item_key, item_id, display_name, updated_at)
      VALUES (@shortCode, @itemKey, @itemId, @displayName, CURRENT_TIMESTAMP)
      ON CONFLICT(short_code) DO UPDATE SET
        item_key = COALESCE(item_name_overrides.item_key, excluded.item_key),
        item_id = COALESCE(item_name_overrides.item_id, excluded.item_id),
        display_name = item_name_overrides.display_name,
        updated_at = CURRENT_TIMESTAMP
    `)
    this.transaction(() => {
      for (const row of rows) {
        const shortCode = this.shortCodeForItemKey(row.itemKey)
        if (!shortCode) continue
        stmt.run({ ...row, shortCode })
      }
    })
  }

  upsertPlayer (uuid, username) {
    let cleanUuid = String(uuid || '').trim()
    const cleanUsername = String(username || '').trim()
    if (!cleanUuid || !cleanUsername) return

    // “正版 v4 为准”：已被合并的旧 UUID、以及 v3 离线派生 UUID（同名 v4 主号在库），
    // 一律改挂主号。否则 v3 会原样插回 players 表，管理-库存又出现两个同名仓库。
    cleanUuid = this.canonicalPlayerUuid(cleanUuid)
    cleanUuid = this.resolveOfflineUuidToMojang(cleanUuid, cleanUsername)

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO players (uuid, username, last_seen_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uuid) DO UPDATE SET
          username = excluded.username,
          last_seen_at = CURRENT_TIMESTAMP
      `).run(cleanUuid, cleanUsername)

      this.migrateGhostPlayerIdentity(cleanUuid, cleanUsername)
      this.flagConflictingRealIdentities(cleanUuid, cleanUsername)

      this.db.prepare(`
        UPDATE admin_users
        SET uuid = COALESCE(uuid, ?)
        WHERE username_lower = ?
      `).run(cleanUuid, cleanUsername.toLowerCase())
      this.db.prepare('UPDATE personal_warehouses SET username = ? WHERE owner_uuid = ?').run(cleanUsername, cleanUuid)
    })
  }

  // 玩家当前上报的 UUID 若已被管理员合并进另一主 UUID（双号冲突处理），
  // 后续存取一律改挂主号。合并后 secondary 的 players 行已删，按用户名找到主号。
  canonicalPlayerUuid (uuid) {
    const cleanUuid = String(uuid || '').trim()
    if (!cleanUuid || cleanUuid.startsWith('name:') || cleanUuid.startsWith('vault:')) return cleanUuid
    const exists = this.db.prepare('SELECT 1 FROM players WHERE uuid = ? LIMIT 1').get(cleanUuid)
    if (exists) return cleanUuid
    // 未见过的 UUID：可能是双号冲突场景下 secondary 已被合并删除，也可能只是新玩家。
    // 只有当该 UUID 的用户名已存在主号且没有任何待处理冲突时才复用，避免误绑。
    const username = this.db.prepare(`
      SELECT username FROM players WHERE uuid = ? LIMIT 1
    `).get(cleanUuid)?.username
    if (!username) {
      // players 行已被合并删除：直接查“merged”审计记录找主号。
      const merged = this.db.prepare(`
        SELECT real_uuid AS primaryUuid FROM wallet_identity_conflicts
        WHERE status = 'merged' AND ghost_uuid = ?
        ORDER BY id DESC LIMIT 1
      `).get(cleanUuid)
      return merged?.primaryUuid || cleanUuid
    }
    const conflict = this.db.prepare(`
      SELECT 1 FROM wallet_identity_conflicts
      WHERE status = 'open' AND real_uuid LIKE '%,%' AND lower(username) = lower(?)
      LIMIT 1
    `).get(username)
    if (conflict) return cleanUuid
    const known = this.db.prepare(`
      SELECT uuid FROM players
      WHERE uuid NOT LIKE 'name:%' AND lower(username) = lower(?)
      ORDER BY last_seen_at DESC LIMIT 1
    `).get(username)
    return known?.uuid && known.uuid !== cleanUuid ? known.uuid : cleanUuid
  }

  // v3 离线派生 UUID（不在 players 表）遇到同名 v4 正版主号已在库时，
  // 一律改挂主号：v3 是服务器离线验证从用户名算出来的确定性 UUID，
  // 与 v4 的同名等价是“正版为准”策略下成立的；阻止它再插回 players 表。
  resolveOfflineUuidToMojang (uuid, username) {
    const cleanUuid = String(uuid || '').trim()
    if (!cleanUuid || !this.isOfflineDerivedUuid(cleanUuid)) return cleanUuid
    const exists = this.db.prepare('SELECT 1 FROM players WHERE uuid = ? LIMIT 1').get(cleanUuid)
    if (exists) return cleanUuid
    const mojang = this.db.prepare(`
      SELECT uuid FROM players
      WHERE substr(uuid, 15, 1) = '4'
        AND uuid NOT LIKE 'name:%'
        AND lower(username) = lower(?)
      ORDER BY last_seen_at DESC LIMIT 1
    `).get(String(username || ''))
    return mojang?.uuid || cleanUuid
  }

  // 同一用户名出现多个真实 UUID（正版改离线/皮肤站换 UUID 等场景）时，
  // 系统没有能力自动判断哪个是本人主号，不能擅自合并账本；
  // 这里只登记冲突（复用 wallet_identity_conflicts 表，留管理员在 Web 页处理）。
  flagConflictingRealIdentities (uuid, username) {
    if (uuid.startsWith('name:')) return false
    const others = this.db.prepare(`
      SELECT uuid FROM players
      WHERE uuid NOT LIKE 'name:%'
        AND lower(username) = lower(?)
        AND uuid <> ?
      LIMIT 1
    `).get(username, uuid)
    if (!others) return false
    const ghostUuid = `name:${username}`
    const realUuids = [uuid, others.uuid].sort()
    const exists = this.db.prepare(`
      SELECT 1 FROM wallet_identity_conflicts
      WHERE lower(username) = lower(?)
        AND ghost_uuid = ?
        AND status = 'open'
        AND (real_uuid = ? OR real_uuid = ?)
      LIMIT 1
    `).get(username, ghostUuid, realUuids.join(','), [...realUuids].reverse().join(','))
    if (exists) return true
    this.db.prepare(`
      INSERT INTO wallet_identity_conflicts (username, ghost_uuid, real_uuid, created_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(username, ghostUuid, realUuids.join(','), Date.now())
    console.warn(`[identity] 玩家 ${username} 存在多个真实 UUID（${realUuids.join(' / ')}），库存可能分裂，请在 Web 管理页处理。`)
    return true
  }

  listPlayerIdentityConflicts (limit = 200) {
    const rows = this.db.prepare(`
      SELECT id, username, ghost_uuid AS ghostUuid, real_uuid AS realUuid,
             status, created_at_ms AS createdAtMs
      FROM wallet_identity_conflicts
      WHERE status = 'open'
        AND real_uuid LIKE '%,%'
      ORDER BY id DESC LIMIT ?
    `).all(Math.max(1, Math.min(1000, Number(limit) || 200)))
    return rows.map(row => ({
      ...row,
      uuids: String(row.realUuid || '').split(',').map(uuid => uuid.trim()).filter(Boolean)
    }))
  }

  hasIdentityConflict (username) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM wallet_identity_conflicts
      WHERE status = 'open' AND real_uuid LIKE '%,%' AND lower(username) = lower(?)
      LIMIT 1
    `).get(String(username || '')))
  }

  // UUID 版本位：v3（名字派生，服务器离线验证生成）= 3；v4（Mojang 正版账号）= 4。
  // 服务器在正版/离线验证间切换时，同一个玩家会被两种模式分别记账，
  // 按“正版 v4 为准”的策略自动把离线 v3 身份并进 v4 主号。
  uuidVersion (uuid) {
    const match = String(uuid || '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-/i)
    return match ? Number.parseInt(match[1], 16) : -1
  }

  isOfflineDerivedUuid (uuid) {
    return !String(uuid || '').startsWith('name:') && this.uuidVersion(uuid) === 3
  }

  // 找出所有“同名 v3 离线身份 + v4 正版身份”的配对。
  // 只处理两个都真实存在于 players 表的；v4 不在库里的（v3 玩家从没用过正版身份）
  // 不动——没有主号可并，擅自清掉会丢库存。
  listOfflineUuidPairsToMerge () {
    return this.db.prepare(`
      SELECT v3.uuid AS offlineUuid, v3.username AS offlineUsername,
             v4.uuid AS mojangUuid, v4.username AS mojangUsername
      FROM players v3
      JOIN players v4 ON lower(v4.username) = lower(v3.username)
      WHERE substr(v3.uuid, 15, 1) = '3'
        AND substr(v4.uuid, 15, 1) = '4'
        AND v3.uuid NOT LIKE 'name:%'
        AND v4.uuid NOT LIKE 'name:%'
        AND v3.uuid <> v4.uuid
      ORDER BY lower(v3.username)
    `).all()
  }

  // 启动时自动执行：所有 v3 离线身份并入同名 v4 正版主号，并删除 v3 行。
  // 返回本次合并明细（给启动日志用）。
  autoMergeOfflineIdentities ({ throwOnError = false } = {}) {
    // A durable craft operation owns exact owner/item-key rows until it
    // finishes. Startup identity migration must wait for that journal too.
    if (this.hasPendingCraft()) {
      this.offlineIdentityMergeDeferred = true
      return []
    }
    const pairs = this.listOfflineUuidPairsToMerge()
    const merged = []
    for (const pair of pairs) {
      try {
        const result = this.mergePlayerIdentities(pair.mojangUuid, pair.offlineUuid, 'system')
        merged.push(result)
        console.log(`[identity] 自动合并：${result.username} 的离线身份 ${result.secondary} 已并入正版主号 ${result.primary}（${result.mergedTypes} 种、${result.mergedAmount} 个）。`)
      } catch (error) {
        console.warn(`[identity] 自动合并失败 ${pair.offlineUsername}（${pair.offlineUuid} -> ${pair.mojangUuid}）：${error.message}`)
        if (throwOnError) throw error
      }
    }
    return merged
  }

  // 把 secondaryUuid 的全部身份与账本合并进 primaryUuid（同一个人的两个真实 UUID）。
  // 管理员在 Web 页确认后调用；游戏内 upsertPlayer 只登记冲突，不自动合并。
  // 方向由调用方决定：一般把“库存多/更常用”的号留作 primary。
  mergePlayerIdentities (primaryUuid, secondaryUuid, adminUsername = '') {
    this.assertNoPendingCraft()
    const primary = String(primaryUuid || '').trim()
    const secondary = String(secondaryUuid || '').trim()
    if (!primary || !secondary) throw new Error('缺少要合并的 UUID。')
    if (primary === secondary) throw new Error('两个 UUID 相同，无需合并。')
    for (const uuid of [primary, secondary]) {
      if (uuid.startsWith('name:') || uuid.startsWith('vault:')) {
        throw new Error(`UUID 不是真实玩家身份：${uuid}`)
      }
    }
    const primaryPlayer = this.db.prepare('SELECT username FROM players WHERE uuid = ?').get(primary)
    const secondaryPlayer = this.db.prepare('SELECT username FROM players WHERE uuid = ?').get(secondary)
    if (!primaryPlayer || !secondaryPlayer) throw new Error('至少有一个 UUID 不存在于玩家表。')
    const username = primaryPlayer.username || secondaryPlayer.username

    const mergedItems = []
    const countRows = (uuid) => this.db.prepare(`
      SELECT COUNT(*) AS types, COALESCE(SUM(amount), 0) AS amount
      FROM balances WHERE owner_uuid = ?
    `).get(uuid)

    return this.transaction(() => {
      const before = { primary: countRows(primary), secondary: countRows(secondary) }

      // 1. 账本：secondary 的余额并入 primary，同种物品数量相加。
      for (const row of this.db.prepare('SELECT item_key AS itemKey, amount FROM balances WHERE owner_uuid = ?').all(secondary)) {
        const current = this.getBalance(primary, row.itemKey)
        this.db.prepare(`
          INSERT INTO balances (owner_uuid, item_key, amount)
          VALUES (?, ?, ?)
          ON CONFLICT(owner_uuid, item_key) DO UPDATE SET amount = excluded.amount
        `).run(primary, row.itemKey, current + row.amount)
        if (row.amount > 0) mergedItems.push({ itemKey: row.itemKey, amount: row.amount })
      }
      this.db.prepare('DELETE FROM balances WHERE owner_uuid = ?').run(secondary)

      // 2. 两个都创建了个人仓库时留 primary 的（旧数据历史更久）。
      if (this.hasPersonalWarehouse(primary) && this.hasPersonalWarehouse(secondary)) {
        this.db.prepare('DELETE FROM personal_warehouses WHERE owner_uuid = ?').run(secondary)
      } else if (this.hasPersonalWarehouse(secondary)) {
        this.db.prepare('UPDATE personal_warehouses SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(primary, username, secondary)
      }

      // 3. 组织仓库成员身份：保留 admin 角色。
      for (const row of this.db.prepare('SELECT warehouse_name_lower AS nameLower, role FROM custom_warehouse_members WHERE player_uuid = ?').all(secondary)) {
        const existing = this.db.prepare('SELECT role FROM custom_warehouse_members WHERE warehouse_name_lower = ? AND player_uuid = ?').get(row.nameLower, primary)
        if (existing) {
          if (row.role === 'admin' && existing.role !== 'admin') {
            this.db.prepare('UPDATE custom_warehouse_members SET role = ? WHERE warehouse_name_lower = ? AND player_uuid = ?').run('admin', row.nameLower, primary)
          }
          this.db.prepare('DELETE FROM custom_warehouse_members WHERE warehouse_name_lower = ? AND player_uuid = ?').run(row.nameLower, secondary)
        } else {
          this.db.prepare('UPDATE custom_warehouse_members SET player_uuid = ?, username = ? WHERE warehouse_name_lower = ? AND player_uuid = ?').run(primary, username, row.nameLower, secondary)
        }
      }

      // 4. 默认归属：primary 空时借用 secondary 的。
      const primaryDefault = this.db.prepare('SELECT default_owner_uuid AS d FROM players WHERE uuid = ?').get(primary)?.d
      if (!String(primaryDefault || '').trim() && this.db.prepare('SELECT default_owner_uuid AS d FROM players WHERE uuid = ?').get(secondary)?.d) {
        this.db.prepare('UPDATE players SET default_owner_uuid = ? WHERE uuid = ?').run(
          String(this.db.prepare('SELECT default_owner_uuid AS d FROM players WHERE uuid = ?').get(secondary).d), primary
        )
      }

      // 5. 其余按玩家 UUID 关联的表整体改挂（沿用幽灵号迁移的口径）。
      this.migrateGhostPlayerItemAliases(secondary, primary)
      this.migrateGhostPlayerAliases(secondary, primary)
      this.migrateGhostWebLoginToken(secondary, primary, username)
      this.migrateGhostPlayerQuota(secondary, primary)
      this.migrateGhostWalletIdentity(secondary, primary, username)
      this.db.prepare('UPDATE web_sessions SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(primary, username, secondary)
      this.db.prepare('UPDATE inventory_reservations SET owner_uuid = ? WHERE owner_uuid = ?').run(primary, secondary)
      this.db.prepare('UPDATE warehouse_subscriptions SET owner_uuid = ? WHERE owner_uuid = ?').run(primary, secondary)
      this.db.prepare('UPDATE warehouse_feature_settings SET owner_uuid = ? WHERE owner_uuid = ?').run(primary, secondary)
      this.db.prepare('UPDATE inventory_mismatches SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(primary, username, secondary)
      this.db.prepare('UPDATE active_recovery_tasks SET owner_uuid = ?, owner_username = ?, target_username = ? WHERE owner_uuid = ?').run(primary, username, username, secondary)
      this.db.prepare('UPDATE bot_recovery_tasks SET owner_uuid = ?, owner_username = ?, target_username = ? WHERE owner_uuid = ?').run(primary, username, username, secondary)
      this.db.prepare('UPDATE shulker_repack_recovery SET owner_uuid = ?, owner_username = ? WHERE owner_uuid = ?').run(primary, username, secondary)
      this.db.prepare('UPDATE transactions SET player_uuid = ?, username = ? WHERE player_uuid = ?').run(primary, username, secondary)
      this.db.prepare('UPDATE custom_warehouses SET creator_uuid = ?, creator_username = ? WHERE creator_uuid = ?').run(primary, username, secondary)
      this.db.prepare('UPDATE subscription_orders SET payer_uuid = ?, payer_username = ? WHERE payer_uuid = ?').run(primary, username, secondary)
      this.db.prepare('UPDATE wallet_ledger SET player_uuid = ?, username = ? WHERE player_uuid = ?').run(primary, username, secondary)
      this.db.prepare(`
        UPDATE admin_users
        SET uuid = CASE WHEN uuid IS NULL OR uuid = ? THEN ? ELSE uuid END
        WHERE lower(username) = lower(?)
      `).run(secondary, primary, username)
      // 登录密码（web_login_tokens）两个号各有一份时在 migrateGhostWebLoginToken 里已丢弃 secondary 的。

      this.db.prepare('DELETE FROM players WHERE uuid = ?').run(secondary)

      // 6. 关闭冲突登记，留合并审计。
      this.db.prepare(`
        UPDATE wallet_identity_conflicts
        SET status = 'resolved'
        WHERE status = 'open'
          AND lower(username) = lower(?)
          AND (real_uuid = ? OR real_uuid = ?)
      `).run(username, `${primary},${secondary}`, `${secondary},${primary}`)
      this.db.prepare(`
        INSERT INTO wallet_identity_conflicts (username, ghost_uuid, real_uuid, status, created_at_ms)
        VALUES (?, ?, ?, 'merged', ?)
      `).run(username, secondary, primary, Date.now())

      this.addTransaction(
        'web_admin_identity_merge',
        'ok',
        primary,
        username,
        mergedItems.map(item => ({
          ...this.db.prepare('SELECT item_id AS itemId, display_name AS displayName, nbt_json AS nbtJson, meta_json AS metaJson FROM items WHERE item_key = ?').get(item.itemKey),
          itemKey: item.itemKey,
          amount: item.amount
        })),
        `admin=${adminUsername}; from=${secondary}`
      )

      const after = countRows(primary)
      return {
        primary,
        secondary,
        username,
        mergedTypes: mergedItems.length,
        mergedAmount: mergedItems.reduce((sum, item) => sum + item.amount, 0),
        primaryBefore: before.primary,
        primaryAfter: after
      }
    })
  }

  migrateGhostPlayerIdentity (uuid, username) {
    if (uuid.startsWith('name:')) return

    const realIdentities = this.db.prepare(`
      SELECT uuid FROM players
      WHERE uuid NOT LIKE 'name:%' AND lower(username) = lower(?)
    `).all(username)
    if (realIdentities.length > 1) {
      const ghostUuid = `name:${username}`
      const exists = this.db.prepare(`
        SELECT 1 FROM wallet_identity_conflicts
        WHERE lower(username) = lower(?) AND ghost_uuid = ? AND status = 'open'
        LIMIT 1
      `).get(username, ghostUuid)
      if (!exists) {
        this.db.prepare(`
          INSERT INTO wallet_identity_conflicts (username, ghost_uuid, real_uuid, created_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(username, ghostUuid, realIdentities.map(row => row.uuid).join(','), Date.now())
      }
      return
    }

    const ghostUuids = new Set([`name:${username}`])
    const addRows = rows => {
      for (const row of rows) {
        if (row.uuid && row.uuid !== uuid) ghostUuids.add(row.uuid)
      }
    }

    addRows(this.db.prepare(`
      SELECT uuid
      FROM players
      WHERE uuid LIKE 'name:%' AND lower(username) = lower(?)
    `).all(username))
    addRows(this.db.prepare(`
      SELECT player_uuid AS uuid
      FROM custom_warehouse_members
      WHERE player_uuid LIKE 'name:%' AND lower(username) = lower(?)
    `).all(username))
    addRows(this.db.prepare(`
      SELECT owner_uuid AS uuid
      FROM web_login_tokens
      WHERE owner_uuid LIKE 'name:%' AND lower(username) = lower(?)
    `).all(username))
    addRows(this.db.prepare(`
      SELECT owner_uuid AS uuid
      FROM web_sessions
      WHERE owner_uuid LIKE 'name:%' AND lower(username) = lower(?)
    `).all(username))
    addRows(this.db.prepare(`
      SELECT player_uuid AS uuid
      FROM transactions
      WHERE player_uuid LIKE 'name:%' AND lower(username) = lower(?)
    `).all(username))

    for (const ghostUuid of ghostUuids) {
      if (!ghostUuid || ghostUuid === uuid || !ghostUuid.startsWith('name:')) continue
      this.migrateGhostPlayerDefaults(ghostUuid, uuid)
      this.migrateGhostPersonalWarehouse(ghostUuid, uuid, username)
      this.migrateGhostCustomWarehouseMembers(ghostUuid, uuid, username)
      this.db.prepare('UPDATE custom_warehouses SET creator_uuid = ?, creator_username = ? WHERE creator_uuid = ?').run(uuid, username, ghostUuid)
      this.migrateGhostPlayerItemAliases(ghostUuid, uuid)
      this.migrateGhostPlayerAliases(ghostUuid, uuid)
      this.migrateGhostWebLoginToken(ghostUuid, uuid, username)
      this.migrateGhostPlayerQuota(ghostUuid, uuid)
      this.migrateGhostWalletIdentity(ghostUuid, uuid, username)
      this.db.prepare('UPDATE web_sessions SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(uuid, username, ghostUuid)
      this.db.prepare('UPDATE transactions SET player_uuid = ?, username = ? WHERE player_uuid = ?').run(uuid, username, ghostUuid)
      this.deleteOrphanGhostPlayer(ghostUuid)
    }
  }

  migrateGhostPlayerDefaults (ghostUuid, uuid) {
    const ghostDefault = this.db.prepare(`
      SELECT default_owner_uuid AS defaultOwnerUuid
      FROM players
      WHERE uuid = ?
      LIMIT 1
    `).get(ghostUuid)?.defaultOwnerUuid
    if (!ghostDefault) return

    this.db.prepare(`
      UPDATE players
      SET default_owner_uuid = CASE
        WHEN default_owner_uuid = '' THEN ?
        ELSE default_owner_uuid
      END
      WHERE uuid = ?
    `).run(ghostDefault, uuid)
  }

  migrateGhostPersonalWarehouse (ghostUuid, uuid, username) {
    const ghost = this.db.prepare('SELECT 1 FROM personal_warehouses WHERE owner_uuid = ?').get(ghostUuid)
    if (!ghost) return
    if (this.hasPersonalWarehouse(uuid)) {
      this.db.prepare('DELETE FROM personal_warehouses WHERE owner_uuid = ?').run(ghostUuid)
    } else {
      this.db.prepare('UPDATE personal_warehouses SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(uuid, username, ghostUuid)
    }
  }

  migrateGhostCustomWarehouseMembers (ghostUuid, uuid, username) {
    const rows = this.db.prepare(`
      SELECT warehouse_name_lower AS warehouseNameLower, role
      FROM custom_warehouse_members
      WHERE player_uuid = ?
    `).all(ghostUuid)
    const existingStmt = this.db.prepare(`
      SELECT role
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ?
      LIMIT 1
    `)
    const updateExistingStmt = this.db.prepare(`
      UPDATE custom_warehouse_members
      SET username = ?, role = ?
      WHERE warehouse_name_lower = ? AND player_uuid = ?
    `)
    const moveStmt = this.db.prepare(`
      UPDATE custom_warehouse_members
      SET player_uuid = ?, username = ?
      WHERE warehouse_name_lower = ? AND player_uuid = ?
    `)
    const deleteGhostStmt = this.db.prepare(`
      DELETE FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ?
    `)

    for (const row of rows) {
      const existing = existingStmt.get(row.warehouseNameLower, uuid)
      if (existing) {
        const role = existing.role === 'admin' || row.role === 'admin' ? 'admin' : existing.role
        updateExistingStmt.run(username, role || 'member', row.warehouseNameLower, uuid)
        deleteGhostStmt.run(row.warehouseNameLower, ghostUuid)
      } else {
        moveStmt.run(uuid, username, row.warehouseNameLower, ghostUuid)
      }
    }
  }

  migrateGhostPlayerItemAliases (ghostUuid, uuid) {
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey
      FROM player_item_name_overrides
      WHERE player_uuid = ?
    `).all(ghostUuid)
    const existsStmt = this.db.prepare(`
      SELECT 1
      FROM player_item_name_overrides
      WHERE player_uuid = ? AND item_key = ?
      LIMIT 1
    `)
    const moveStmt = this.db.prepare(`
      UPDATE player_item_name_overrides
      SET player_uuid = ?
      WHERE player_uuid = ? AND item_key = ?
    `)
    const deleteStmt = this.db.prepare(`
      DELETE FROM player_item_name_overrides
      WHERE player_uuid = ? AND item_key = ?
    `)

    for (const row of rows) {
      if (existsStmt.get(uuid, row.itemKey)) {
        deleteStmt.run(ghostUuid, row.itemKey)
      } else {
        moveStmt.run(uuid, ghostUuid, row.itemKey)
      }
    }
  }

  migrateGhostPlayerAliases (ghostUuid, uuid) {
    this.db.prepare(`
      INSERT OR IGNORE INTO player_item_aliases (player_uuid, alias_lower, alias, item_key, created_at, updated_at)
      SELECT ?, alias_lower, alias, item_key, created_at, updated_at
      FROM player_item_aliases WHERE player_uuid = ?
    `).run(uuid, ghostUuid)
    this.db.prepare('DELETE FROM player_item_aliases WHERE player_uuid = ?').run(ghostUuid)
    this.db.prepare(`
      INSERT OR IGNORE INTO player_item_display_names (player_uuid, item_key, display_name, updated_at)
      SELECT ?, item_key, display_name, updated_at FROM player_item_display_names WHERE player_uuid = ?
    `).run(uuid, ghostUuid)
    this.db.prepare('DELETE FROM player_item_display_names WHERE player_uuid = ?').run(ghostUuid)
    this.db.prepare(`
      INSERT OR IGNORE INTO player_disabled_global_aliases (player_uuid, alias_lower, created_at)
      SELECT ?, alias_lower, created_at FROM player_disabled_global_aliases WHERE player_uuid = ?
    `).run(uuid, ghostUuid)
    this.db.prepare('DELETE FROM player_disabled_global_aliases WHERE player_uuid = ?').run(ghostUuid)
  }

  migrateGhostWebLoginToken (ghostUuid, uuid, username) {
    const ghost = this.db.prepare(`
      SELECT 1
      FROM web_login_tokens
      WHERE owner_uuid = ?
      LIMIT 1
    `).get(ghostUuid)
    if (!ghost) return

    const existing = this.db.prepare(`
      SELECT 1
      FROM web_login_tokens
      WHERE owner_uuid = ?
      LIMIT 1
    `).get(uuid)
    if (existing) {
      this.db.prepare('DELETE FROM web_login_tokens WHERE owner_uuid = ?').run(ghostUuid)
    } else {
      this.db.prepare('UPDATE web_login_tokens SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(uuid, username, ghostUuid)
    }
  }

  migrateGhostPlayerQuota (ghostUuid, uuid) {
    const ghost = this.db.prepare(`
      SELECT 1
      FROM player_quotas
      WHERE owner_uuid = ?
      LIMIT 1
    `).get(ghostUuid)
    if (!ghost) return

    const existing = this.db.prepare(`
      SELECT 1
      FROM player_quotas
      WHERE owner_uuid = ?
      LIMIT 1
    `).get(uuid)
    if (existing) {
      this.db.prepare('DELETE FROM player_quotas WHERE owner_uuid = ?').run(ghostUuid)
    } else {
      this.db.prepare('UPDATE player_quotas SET owner_uuid = ? WHERE owner_uuid = ?').run(uuid, ghostUuid)
    }
  }

  migrateGhostWalletIdentity (ghostUuid, uuid, username) {
    const ghost = this.db.prepare('SELECT balance_cents AS balanceCents FROM wallet_accounts WHERE player_uuid = ?').get(ghostUuid)
    if (ghost) {
      const real = this.db.prepare('SELECT balance_cents AS balanceCents FROM wallet_accounts WHERE player_uuid = ?').get(uuid)
      const mergedBalance = Number(real?.balanceCents || 0) + Number(ghost.balanceCents || 0)
      this.db.prepare(`
        INSERT INTO wallet_accounts (player_uuid, username, balance_cents, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(player_uuid) DO UPDATE SET
          username = excluded.username,
          balance_cents = excluded.balance_cents,
          updated_at = CURRENT_TIMESTAMP
      `).run(uuid, username, mergedBalance)
      this.db.prepare('DELETE FROM wallet_accounts WHERE player_uuid = ?').run(ghostUuid)
    }
    this.db.prepare('UPDATE wallet_ledger SET player_uuid = ?, username = ? WHERE player_uuid = ?').run(uuid, username, ghostUuid)
    this.db.prepare('UPDATE subscription_orders SET payer_uuid = ?, payer_username = ? WHERE payer_uuid = ?').run(uuid, username, ghostUuid)
    const ghostSubscription = this.db.prepare(`
      SELECT plan_id AS planId, expires_at_ms AS expiresAtMs, cancelled_at_ms AS cancelledAtMs,
             updated_at_ms AS updatedAtMs
      FROM warehouse_subscriptions WHERE owner_uuid = ?
    `).get(ghostUuid)
    if (ghostSubscription) {
      const realSubscription = this.db.prepare('SELECT expires_at_ms AS expiresAtMs FROM warehouse_subscriptions WHERE owner_uuid = ?').get(uuid)
      if (!realSubscription) {
        this.db.prepare('UPDATE warehouse_subscriptions SET owner_uuid = ? WHERE owner_uuid = ?').run(uuid, ghostUuid)
      } else {
        if (Number(ghostSubscription.expiresAtMs) > Number(realSubscription.expiresAtMs)) {
          this.db.prepare(`
            UPDATE warehouse_subscriptions
            SET plan_id = ?, expires_at_ms = ?, cancelled_at_ms = ?, updated_at_ms = ?, updated_at = CURRENT_TIMESTAMP
            WHERE owner_uuid = ?
          `).run(ghostSubscription.planId, ghostSubscription.expiresAtMs, ghostSubscription.cancelledAtMs, ghostSubscription.updatedAtMs, uuid)
        }
        this.db.prepare('DELETE FROM warehouse_subscriptions WHERE owner_uuid = ?').run(ghostUuid)
      }
    }
  }

  deleteOrphanGhostPlayer (ghostUuid) {
    this.db.prepare(`
      DELETE FROM players
      WHERE uuid = ?
        AND uuid LIKE 'name:%'
        AND uuid NOT IN (SELECT owner_uuid FROM balances)
        AND uuid NOT IN (SELECT owner_uuid FROM web_login_tokens)
        AND uuid NOT IN (SELECT owner_uuid FROM personal_warehouses)
        AND uuid NOT IN (SELECT owner_uuid FROM web_sessions)
        AND uuid NOT IN (SELECT player_uuid FROM player_item_name_overrides)
        AND uuid NOT IN (SELECT player_uuid FROM player_item_aliases)
        AND uuid NOT IN (SELECT player_uuid FROM player_item_display_names)
        AND uuid NOT IN (SELECT player_uuid FROM player_disabled_global_aliases)
        AND uuid NOT IN (SELECT player_uuid FROM custom_warehouse_members)
        AND uuid NOT IN (SELECT owner_uuid FROM player_quotas)
        AND uuid NOT IN (SELECT player_uuid FROM transactions)
        AND uuid NOT IN (SELECT player_uuid FROM wallet_accounts)
        AND uuid NOT IN (SELECT payer_uuid FROM subscription_orders)
        AND uuid NOT IN (SELECT COALESCE(uuid, '') FROM admin_users)
    `).run(ghostUuid)
  }

  hashWebLoginToken (token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
  }

  generateWebLoginToken (ownerUuid, username) {
    const random = crypto.randomBytes(18).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const token = `cs-${random}`
    return this.setWebLoginToken(ownerUuid, username, token)
  }

  setWebLoginToken (ownerUuid, username, token) {
    token = String(token || '').trim()
    if (!token) throw new Error('登录密码不能为空。')
    const tokenHash = this.hashWebLoginToken(token)
    const tokenHint = token.slice(-6)

    this.db.prepare(`
      INSERT INTO web_login_tokens (owner_uuid, username, token_hash, token_hint, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_uuid) DO UPDATE SET
        username = excluded.username,
        token_hash = excluded.token_hash,
        token_hint = excluded.token_hint,
        updated_at = CURRENT_TIMESTAMP
    `).run(ownerUuid, username, tokenHash, tokenHint)

    return { token, tokenHint }
  }

  getWebUserByToken (token) {
    const tokenHash = this.hashWebLoginToken(token)
    const row = this.db.prepare(`
      SELECT owner_uuid AS uuid, username, token_hint AS tokenHint, updated_at AS updatedAt
      FROM web_login_tokens
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash)
    return row || null
  }

  getPlayerByUsername (username) {
    return this.db.prepare(`
      SELECT uuid, username, default_owner_uuid AS defaultOwnerUuid
      FROM players
      WHERE lower(username) = lower(?)
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(username) || null
  }

  migrateExistingPersonalWarehouses () {
    this.db.prepare(`
      INSERT OR IGNORE INTO personal_warehouses (owner_uuid, username, created_by_username)
      SELECT DISTINCT b.owner_uuid, COALESCE(p.username, b.owner_uuid), '历史库存迁移'
      FROM balances b
      LEFT JOIN players p ON p.uuid = b.owner_uuid
      WHERE b.amount > 0
        AND b.owner_uuid <> ?
        AND b.owner_uuid NOT LIKE 'vault:%'
    `).run(this.momoOwner)
  }

  hasPersonalWarehouse (ownerUuid) {
    return Boolean(this.db.prepare('SELECT 1 FROM personal_warehouses WHERE owner_uuid = ? LIMIT 1').get(ownerUuid))
  }

  createPersonalWarehouse (ownerUuid, username, createdBy = {}) {
    const uuid = String(ownerUuid || '').trim()
    const name = String(username || '').trim()
    if (!uuid || !name) throw new Error('缺少个人仓库所属玩家。')
    const changed = this.db.prepare(`
      INSERT OR IGNORE INTO personal_warehouses (
        owner_uuid, username, created_by_uuid, created_by_username
      ) VALUES (?, ?, ?, ?)
    `).run(uuid, name, String(createdBy.uuid || ''), String(createdBy.username || '')).changes
    if (changed) this.db.prepare('DELETE FROM player_quotas WHERE owner_uuid = ?').run(uuid)
    return { changed, ownerUuid: uuid, username: name }
  }

  listPersonalWarehouses () {
    return this.db.prepare(`
      SELECT owner_uuid AS ownerUuid, username, created_by_uuid AS createdByUuid,
             created_by_username AS createdByUsername, created_at AS createdAt
      FROM personal_warehouses ORDER BY username COLLATE NOCASE ASC
    `).all()
  }

  deletePersonalWarehouseToMomo (ownerUuid, adminUsername = '') {
    const warehouse = this.db.prepare(`
      SELECT owner_uuid AS ownerUuid, username
      FROM personal_warehouses WHERE owner_uuid = ? LIMIT 1
    `).get(ownerUuid)
    if (!warehouse) throw new Error('找不到个人仓库。')
    return this.deleteOwnerWarehouseToMomo(warehouse.ownerUuid, warehouse.username, 'personal', adminUsername, () => {
      this.db.prepare('DELETE FROM personal_warehouses WHERE owner_uuid = ?').run(warehouse.ownerUuid)
    })
  }

  getPlayerDefaultOwnerUuid (playerUuid) {
    const row = this.db.prepare(`
      SELECT default_owner_uuid AS defaultOwnerUuid
      FROM players
      WHERE uuid = ?
      LIMIT 1
    `).get(playerUuid)
    return String(row?.defaultOwnerUuid || '').trim()
  }

  setPlayerDefaultOwnerUuid (playerUuid, ownerUuid) {
    this.db.prepare(`
      UPDATE players
      SET default_owner_uuid = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE uuid = ?
    `).run(String(ownerUuid || '').trim(), playerUuid)
  }

  addAdmin (username, uuid = null) {
    this.db.prepare(`
      INSERT INTO admin_users (username_lower, username, uuid)
      VALUES (?, ?, ?)
      ON CONFLICT(username_lower) DO UPDATE SET
        username = excluded.username,
        uuid = COALESCE(admin_users.uuid, excluded.uuid)
    `).run(username.toLowerCase(), username, uuid)
  }

  listAdmins () {
    return this.db.prepare(`
      SELECT username_lower AS usernameLower, username, uuid, created_at AS createdAt
      FROM admin_users
      ORDER BY username COLLATE NOCASE ASC
    `).all()
  }

  removeAdmin (username, uuid = null) {
    const usernameLower = String(username || '').trim().toLowerCase()
    const playerUuid = String(uuid || '').trim()
    if (!usernameLower && !playerUuid) return { changed: false }
    const row = this.db.prepare(`
      SELECT username_lower AS usernameLower, username, uuid
      FROM admin_users
      WHERE username_lower = ? OR (? != '' AND uuid = ?)
      LIMIT 1
    `).get(usernameLower, playerUuid, playerUuid)
    if (!row) return { changed: false }
    const changes = this.db.prepare('DELETE FROM admin_users WHERE username_lower = ?').run(row.usernameLower).changes
    return { changed: changes > 0, admin: row }
  }

  isAdmin (username, uuid = null) {
    const row = this.db.prepare(`
      SELECT 1
      FROM admin_users
      WHERE username_lower = ? OR (uuid IS NOT NULL AND uuid = ?)
      LIMIT 1
    `).get(username.toLowerCase(), uuid)
    return Boolean(row)
  }

  normalizeWarehouseName (name) {
    return String(name || '').trim().toLowerCase()
  }

  countWarehousesCreatedBy (creatorUuid) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM custom_warehouses
      WHERE creator_uuid = ?
    `).get(creatorUuid)
    return row.count
  }

  createCustomWarehouse (name, creatorUuid, creatorUsername) {
    const nameLower = this.normalizeWarehouseName(name)
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO custom_warehouses (name_lower, name, creator_uuid, creator_username)
        VALUES (?, ?, ?, ?)
      `).run(nameLower, name, creatorUuid, creatorUsername)

      this.db.prepare(`
        INSERT INTO custom_warehouse_members (warehouse_name_lower, player_uuid, username, role)
        VALUES (?, ?, ?, 'admin')
      `).run(nameLower, creatorUuid, creatorUsername)
    })
  }

  getCustomWarehouse (name) {
    return this.db.prepare(`
      SELECT name_lower AS nameLower, name, creator_uuid AS creatorUuid,
             creator_username AS creatorUsername, created_at AS createdAt
      FROM custom_warehouses
      WHERE name_lower = ?
      LIMIT 1
    `).get(this.normalizeWarehouseName(name)) || null
  }

  getWarehouseFeatureSettings (ownerUuid) {
    return this.db.prepare(`
      SELECT owner_uuid AS ownerUuid,
             quick_shulker_extraction_enabled AS quickShulkerExtractionEnabled,
             updated_at AS updatedAt
      FROM warehouse_feature_settings
      WHERE owner_uuid = ?
      LIMIT 1
    `).get(String(ownerUuid || '').trim()) || null
  }

  isQuickShulkerExtractionEnabled (ownerUuid) {
    const row = this.getWarehouseFeatureSettings(ownerUuid)
    if (row) return Boolean(row.quickShulkerExtractionEnabled)
    return this.config?.warehouse?.quickShulkerExtractionEnabled !== false
  }

  setQuickShulkerExtractionEnabled (ownerUuid, enabled) {
    const uuid = String(ownerUuid || '').trim()
    if (!uuid) throw new Error('缺少仓库归属。')
    this.db.prepare(`
      INSERT INTO warehouse_feature_settings (owner_uuid, quick_shulker_extraction_enabled, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_uuid) DO UPDATE SET
        quick_shulker_extraction_enabled = excluded.quick_shulker_extraction_enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(uuid, enabled ? 1 : 0)
    return this.getWarehouseFeatureSettings(uuid)
  }

  listCustomWarehousesForPlayer (playerUuid) {
    return this.db.prepare(`
      SELECT w.name_lower AS nameLower, w.name, w.creator_uuid AS creatorUuid,
             w.creator_username AS creatorUsername, m.role, w.created_at AS createdAt
      FROM custom_warehouse_members m
      JOIN custom_warehouses w ON w.name_lower = m.warehouse_name_lower
      WHERE m.player_uuid = ?
      ORDER BY w.created_at ASC, w.name ASC
    `).all(playerUuid)
  }

  isCustomWarehouseMember (name, playerUuid) {
    const row = this.db.prepare(`
      SELECT 1
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ?
      LIMIT 1
    `).get(this.normalizeWarehouseName(name), playerUuid)
    return Boolean(row)
  }

  isCustomWarehouseAdmin (name, playerUuid) {
    const row = this.db.prepare(`
      SELECT 1
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ? AND role = 'admin'
      LIMIT 1
    `).get(this.normalizeWarehouseName(name), playerUuid)
    return Boolean(row)
  }

  addCustomWarehouseMember (name, playerUuid, username) {
    this.db.prepare(`
      INSERT INTO custom_warehouse_members (warehouse_name_lower, player_uuid, username, role)
      VALUES (?, ?, ?, 'member')
      ON CONFLICT(warehouse_name_lower, player_uuid) DO UPDATE SET
        username = excluded.username
    `).run(this.normalizeWarehouseName(name), playerUuid, username)
  }

  setCustomWarehouseMemberRole (name, playerUuid, username, role) {
    this.db.prepare(`
      INSERT INTO custom_warehouse_members (warehouse_name_lower, player_uuid, username, role)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(warehouse_name_lower, player_uuid) DO UPDATE SET
        username = excluded.username,
        role = excluded.role
    `).run(this.normalizeWarehouseName(name), playerUuid, username, role)
  }

  setCustomWarehouseMemberRoleIfExists (name, playerUuid, role) {
    return this.db.prepare(`
      UPDATE custom_warehouse_members
      SET role = ?
      WHERE warehouse_name_lower = ? AND player_uuid = ?
    `).run(role, this.normalizeWarehouseName(name), playerUuid).changes
  }

  removeCustomWarehouseMember (name, playerUuid) {
    return this.db.prepare(`
      DELETE FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ? AND role <> 'admin'
    `).run(this.normalizeWarehouseName(name), playerUuid).changes
  }

  removeCustomWarehouseMemberAny (name, playerUuid) {
    return this.db.prepare(`
      DELETE FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ?
    `).run(this.normalizeWarehouseName(name), playerUuid).changes
  }

  listCustomWarehouseMembers (name) {
    return this.db.prepare(`
      SELECT player_uuid AS playerUuid, username, role, added_at AS addedAt
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ?
      ORDER BY role = 'admin' DESC, username COLLATE NOCASE ASC
    `).all(this.normalizeWarehouseName(name))
  }

  deleteCustomWarehouseToMomo (name, adminUsername = '') {
    const warehouse = this.getCustomWarehouse(name)
    if (!warehouse) throw new Error(`找不到组织仓库：${name}`)
    const ownerUuid = `vault:${warehouse.nameLower}`
    return this.deleteOwnerWarehouseToMomo(ownerUuid, `仓库:${warehouse.name}`, 'custom', adminUsername, () => {
      this.db.prepare('DELETE FROM custom_warehouses WHERE name_lower = ?').run(warehouse.nameLower)
    })
  }

  deleteOwnerWarehouseToMomo (ownerUuid, ownerUsername, warehouseType, adminUsername, deleteWarehouse) {
    this.assertNoPendingCraft()
    if (!ownerUuid || ownerUuid === this.momoOwner) throw new Error('不能删除该仓库。')
    const items = this.getOwnerBalances(ownerUuid)
    const totalAmount = items.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    this.transaction(() => {
      for (const item of items) this.adjustBalance(this.momoOwner, item.itemKey, Number(item.amount || 0))
      this.db.prepare('DELETE FROM balances WHERE owner_uuid = ?').run(ownerUuid)
      const message = `admin=${adminUsername}; deletedOwner=${ownerUuid}; warehouseType=${warehouseType}`
      this.addTransaction('warehouse_delete_transfer_out', 'ok', ownerUuid, ownerUsername, items, `${message}; to=${this.momoOwner}`)
      this.addTransaction('warehouse_delete_transfer_in', 'ok', this.momoOwner, 'momo', items, `${message}; from=${ownerUuid}`)
      this.db.prepare('DELETE FROM player_quotas WHERE owner_uuid = ?').run(ownerUuid)
      this.db.prepare('DELETE FROM warehouse_feature_settings WHERE owner_uuid = ?').run(ownerUuid)
      this.db.prepare('DELETE FROM warehouse_subscriptions WHERE owner_uuid = ?').run(ownerUuid)
      this.db.prepare("UPDATE players SET default_owner_uuid = '' WHERE default_owner_uuid = ?").run(ownerUuid)
      this.db.prepare(`
        UPDATE inventory_mismatches
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
            note = CASE WHEN note = '' THEN ? ELSE note || '; ' || ? END
        WHERE owner_uuid = ? AND status = 'open'
      `).run(`仓库删除，库存已转入momo，操作人=${adminUsername}`, `仓库删除，库存已转入momo，操作人=${adminUsername}`, ownerUuid)
      deleteWarehouse()
    })
    return { ownerUuid, ownerUsername, itemTypes: items.length, totalAmount, items }
  }

  renameCustomWarehouse (name, newName) {
    this.assertNoPendingCraft()
    const warehouse = this.getCustomWarehouse(name)
    if (!warehouse) throw new Error(`找不到仓库：${name}`)
    const nextName = String(newName || '').trim()
    const nextLower = this.normalizeWarehouseName(nextName)
    if (!nextLower) throw new Error('新仓库名不能为空。')
    if (nextLower === warehouse.nameLower) {
      const ownerUuid = `vault:${warehouse.nameLower}`
      this.transaction(() => {
        this.db.prepare('UPDATE custom_warehouses SET name = ? WHERE name_lower = ?').run(nextName, warehouse.nameLower)
        this.db.prepare('UPDATE transactions SET username = ? WHERE player_uuid = ?').run(`仓库:${nextName}`, ownerUuid)
        this.db.prepare('UPDATE inventory_mismatches SET username = ? WHERE owner_uuid = ?').run(`仓库:${nextName}`, ownerUuid)
        this.db.prepare('UPDATE active_recovery_tasks SET owner_username = ?, vault_name = ? WHERE owner_uuid = ?').run(`仓库:${nextName}`, nextName, ownerUuid)
        this.db.prepare('UPDATE bot_recovery_tasks SET owner_username = ?, vault_name = ? WHERE owner_uuid = ?').run(`仓库:${nextName}`, nextName, ownerUuid)
      })
      return { ...warehouse, name: nextName }
    }
    if (this.getCustomWarehouse(nextName)) throw new Error(`仓库名已存在：${nextName}`)
    const oldOwner = `vault:${warehouse.nameLower}`
    const newOwner = `vault:${nextLower}`
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO custom_warehouses (name_lower, name, creator_uuid, creator_username, created_at)
        SELECT ?, ?, creator_uuid, creator_username, created_at FROM custom_warehouses WHERE name_lower = ?
      `).run(nextLower, nextName, warehouse.nameLower)
      this.db.prepare('UPDATE custom_warehouse_members SET warehouse_name_lower = ? WHERE warehouse_name_lower = ?').run(nextLower, warehouse.nameLower)
      this.db.prepare('UPDATE balances SET owner_uuid = ? WHERE owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('UPDATE player_quotas SET owner_uuid = ? WHERE owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('UPDATE warehouse_feature_settings SET owner_uuid = ? WHERE owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('UPDATE warehouse_subscriptions SET owner_uuid = ? WHERE owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('UPDATE subscription_orders SET owner_uuid = ? WHERE owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('UPDATE subscription_cancellations SET owner_uuid = ? WHERE owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('UPDATE transactions SET player_uuid = ?, username = ? WHERE player_uuid = ?').run(newOwner, `仓库:${nextName}`, oldOwner)
      this.db.prepare('UPDATE inventory_mismatches SET owner_uuid = ?, username = ? WHERE owner_uuid = ?').run(newOwner, `仓库:${nextName}`, oldOwner)
      this.db.prepare('UPDATE active_recovery_tasks SET owner_uuid = ?, owner_username = ?, vault_name = ? WHERE owner_uuid = ?').run(newOwner, `仓库:${nextName}`, nextName, oldOwner)
      this.db.prepare('UPDATE bot_recovery_tasks SET owner_uuid = ?, owner_username = ?, vault_name = ? WHERE owner_uuid = ?').run(newOwner, `仓库:${nextName}`, nextName, oldOwner)
      this.db.prepare('UPDATE players SET default_owner_uuid = ? WHERE default_owner_uuid = ?').run(newOwner, oldOwner)
      this.db.prepare('DELETE FROM custom_warehouses WHERE name_lower = ?').run(warehouse.nameLower)
    })
    return this.getCustomWarehouse(nextName)
  }

  upsertItem (item, options = {}) {
    const override = this.getItemNameOverride(item.itemKey)
    const itemToSave = override ? { ...item, displayName: override.displayName } : item
    this.db.prepare(`
      INSERT INTO items (item_key, item_id, display_name, nbt_json, meta_json)
      VALUES (@itemKey, @itemId, @displayName, @nbtJson, @metaJson)
      ON CONFLICT(item_key) DO UPDATE SET
        display_name = CASE
          WHEN items.display_name_manual = 1 THEN items.display_name
          ELSE excluded.display_name
        END,
        nbt_json = excluded.nbt_json,
      meta_json = excluded.meta_json
    `).run(itemToSave)

    if (override && (!override.itemKey || !override.itemId)) {
      this.db.prepare(`
        UPDATE item_name_overrides
        SET item_key = COALESCE(item_key, ?),
            item_id = COALESCE(item_id, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE short_code = ?
      `).run(item.itemKey, item.itemId, override.shortCode)
    }

    if (options.indexShulker !== false) {
      this.replaceShulkerContentsForItem(itemToSave)
    }
  }

  replaceShulkerContentsForItem (item) {
    this.db.prepare('DELETE FROM shulker_contents WHERE shulker_item_key = ?').run(item.itemKey)
    if (!this.catalog) return

    const contents = this.catalog.extractShulkerContents(item)
    if (!contents.length) return

    const stmt = this.db.prepare(`
      INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count)
      VALUES (?, @itemKey, @itemId, @amount, @slotCount)
      ON CONFLICT(shulker_item_key, contained_item_key) DO UPDATE SET
        contained_item_id = excluded.contained_item_id,
        amount = excluded.amount,
        slot_count = excluded.slot_count
    `)

    for (const content of contents) {
      this.upsertItem(content.item, { indexShulker: false })
      stmt.run(item.itemKey, {
        itemKey: content.item.itemKey,
        itemId: content.item.itemId,
        amount: content.amount,
        slotCount: content.slotCount
      })
    }
  }

  refreshItemDisplayNames (catalog) {
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE display_name_manual = 0
    `).all()
    const stmt = this.db.prepare('UPDATE items SET display_name = ? WHERE item_key = ?')
    let changed = 0
    this.transaction(() => {
      for (const row of rows) {
        const override = this.getItemNameOverride(row.itemKey)
        const next = override?.displayName || catalog.describeStoredItem(row.itemId, row.metaJson, row.nbtJson)
        if (next && next !== row.displayName) {
          stmt.run(next, row.itemKey)
          changed++
        }
      }
    })
    return changed
  }

  applyWithdrawDeduction (deductionKey, groups, message = '') {
    const key = String(deductionKey || '').trim()
    if (!key) throw new Error('取货扣账缺少幂等键。')
    return this.transaction(() => {
      let applied = false
      for (const group of groups || []) {
        const ownerUuid = String(group.ownerUuid || '')
        if (!ownerUuid) continue
        const items = (group.items || []).filter(item => Number(item.amount || 0) > 0)
        if (!items.length) continue
        const username = String(group.username || this.ownerLabel(ownerUuid))
        const existing = this.db.prepare(`
          SELECT 1 FROM transactions
          WHERE type = 'withdraw' AND deduction_key = ? AND player_uuid = ?
          LIMIT 1
        `).get(key, ownerUuid)
        if (existing) {
          // 撞键只应发生在同一任务的正常/恢复双路径上；跨任务撞键意味着有交付未被扣账，
          // 不能无声跳过——留下告警便于对账（applyWithdrawDeduction 返回 applied=false）。
          console.warn(`[withdraw-deduction] 幂等键重复，跳过扣账：key=${key} owner=${ownerUuid} username=${username}`)
          continue
        }
        const result = this.db.prepare(`
          INSERT INTO transactions (
            type, status, player_uuid, username, items_json, message, deduction_key, bot_id, bot_name
          ) VALUES ('withdraw', 'ok', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ownerUuid,
          username,
          JSON.stringify(items),
          String(message || ''),
          key,
          String(this.transactionContext.getStore()?.botId || ''),
          String(this.transactionContext.getStore()?.botName || '')
        )
        if (!result.changes) continue
        applied = true
        for (const item of items) {
          const stored = this.getItemByKey(item.itemKey)
          const complete = { ...stored, ...item, itemId: item.itemId || stored?.itemId, displayName: item.displayName || stored?.displayName, nbtJson: item.nbtJson ?? stored?.nbtJson, metaJson: item.metaJson ?? stored?.metaJson }
          if (!complete.itemId || !complete.displayName || complete.nbtJson === undefined || complete.metaJson === undefined) {
            throw new Error(`扣账物品记录不完整：${item.itemKey}`)
          }
          this.upsertItem(complete)
          // 扣减按当前余额钳制：极端场景（如 Web 管理扣减与任务预留撞车）下
          // 账面可能不足以覆盖交付。物品已经交付给玩家，回滚整个扣账事务只会
          // 让"有交付无扣账"无迹可查——按现有余额扣减，缺额登记异常留痕。
          const amount = Number(item.amount || 0)
          const balance = this.getBalance(ownerUuid, item.itemKey)
          const deducted = Math.min(balance, amount)
          if (deducted < amount) {
            console.warn(`[withdraw-deduction] 账面余额不足：owner=${ownerUuid} item=${item.itemKey} 需扣=${amount} 实有=${balance}`)
            this.addInventoryMismatch(
              'missing',
              ownerUuid,
              username,
              complete,
              amount - deducted,
              `取货扣账时账面余额不足：需扣 ${amount}，实有 ${balance}，已按 ${deducted} 扣减；缺额留痕待管理员复核。`
            )
          }
          if (deducted > 0) this.adjustBalance(ownerUuid, item.itemKey, -deducted)
        }
      }
      return { applied }
    })
  }

  // 取货任务确认的缺失（现场搜桶/换桶重试后仍未取到的部分）当场修账：
  // 归属精确到该任务的 owner，比 !同步 的按比例估算更可靠。扣减按余额钳制，
  // 写 sync_deduct 流水与 missing 异常留痕（同 owner+item 已有 open 异常时不重复登记）。
  deductConfirmedMissing (ownerUuid, username, items, notePrefix = '取货时确认缺失') {
    if (!ownerUuid || !Array.isArray(items) || !items.length) return []
    const results = []
    this.db.transaction(() => {
      for (const item of items) {
        const amount = Number(item.amount || 0)
        if (amount <= 0) continue
        const stored = this.getItemByKey(item.itemKey)
        const complete = { ...stored, ...item }
        if (!complete.itemId || !complete.displayName) continue
        const balance = this.getBalance(ownerUuid, item.itemKey)
        const deducted = Math.min(balance, amount)
        if (deducted > 0) {
          this.adjustBalance(ownerUuid, item.itemKey, -deducted)
          this.addTransaction(
            'sync_deduct',
            'ok',
            ownerUuid,
            username,
            [{ ...complete, amount: deducted }],
            `${notePrefix}; requested=${amount}; deducted=${deducted}`
          )
        }
        if (typeof this.hasOpenInventoryMismatch !== 'function' ||
            !this.hasOpenInventoryMismatch(ownerUuid, item.itemKey)) {
          this.addInventoryMismatch(
            'missing',
            ownerUuid,
            username,
            complete,
            amount,
            `${notePrefix}：账面需修正 ${amount}，已自动扣除 ${deducted}${deducted < amount ? `（账面仅剩 ${deducted}）` : ''}；账本已与实物同步，留痕待管理员复核。`,
            deducted
          )
        }
        results.push({ itemKey: item.itemKey, requested: amount, deducted })
      }
    })()
    return results
  }

  // 取货时发现目标木桶实物多于记录：多出部分归属未知，与 !同步 的 extra 语义
  // 一致——划入 momo 并登记 extra 异常，供管理员在 Web 页转移给正确归属。
  creditExtraToMomo (item, amount, note = '') {
    const extra = Number(amount || 0)
    if (extra <= 0 || !item?.itemKey) return null
    return this.db.transaction(() => {
      this.upsertItem(item)
      this.adjustBalance(this.momoOwner, item.itemKey, extra)
      this.addTransaction('sync', 'ok', this.momoOwner, 'momo', [{ ...item, amount: extra }], note || `barrel_extra; key=${item.itemKey}; amount=${extra}`)
      this.addInventoryMismatch(
        'extra',
        this.momoOwner,
        'momo',
        item,
        extra,
        `取货时发现目标木桶实物比记录多 ${extra} 个，已划入 momo；请在 Web 管理页库存异常中转移给正确归属。`
      )
      return { itemKey: item.itemKey, amount: extra }
    })()
  }

  addTransaction (type, status, playerUuid, username, items, message = '') {
    const context = this.transactionContext.getStore() || {}
    this.db.prepare(`
      INSERT INTO transactions (type, status, player_uuid, username, items_json, message, deduction_key, bot_id, bot_name)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
    `).run(type, status, playerUuid, username, JSON.stringify(items), message, String(context.botId || ''), String(context.botName || ''))
  }

  runWithBotContext (bot, fn) {
    const current = this.transactionContext.getStore() || {}
    return this.transactionContext.run({
      ...current,
      botId: String(bot?.botId || ''),
      botName: String(bot?.botName || '')
    }, fn)
  }

  runWithCommandContext (commandLogId, fn) {
    const current = this.transactionContext.getStore() || {}
    return this.transactionContext.run({ ...current, commandLogId: Number(commandLogId || current.commandLogId || 0) }, fn)
  }

  currentCommandLogId () {
    return Number(this.transactionContext.getStore()?.commandLogId || 0)
  }

  createCommandLog ({ username, commandText, channel, receiverBotId, receiverBotName }) {
    const result = this.db.prepare(`
      INSERT INTO command_logs (username, command_text, channel, receiver_bot_id, receiver_bot_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(username || ''), String(commandText || ''), String(channel || 'private'), String(receiverBotId || ''), String(receiverBotName || ''))
    return Number(result.lastInsertRowid)
  }

  addCommandReply ({ commandLogId, targetUsername, channel = 'private', botId = '', botName = '', message }) {
    const id = Number(commandLogId || this.currentCommandLogId())
    if (!id) return 0
    const context = this.transactionContext.getStore() || {}
    return this.db.prepare(`
      INSERT INTO command_log_replies (command_log_id, target_username, channel, bot_id, bot_name, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, String(targetUsername || ''), String(channel || 'private'), String(botId || context.botId || ''), String(botName || context.botName || ''), String(message || '')).changes
  }

  listCommandLogs ({ page = 1, pageSize = 30, query = '', channel = '' } = {}) {
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1)
    const limit = Math.max(1, Math.min(100, Number.parseInt(pageSize, 10) || 30))
    const text = String(query || '').trim().toLowerCase()
    const channelText = String(channel || '').trim().toLowerCase()
    const where = []
    const params = []
    if (channelText) {
      where.push('c.channel = ?')
      params.push(channelText)
    }
    if (text) {
      where.push(`(
        lower(c.username) LIKE ? OR lower(c.command_text) LIKE ? OR
        lower(c.receiver_bot_name) LIKE ? OR EXISTS (
          SELECT 1 FROM command_log_replies qr
          WHERE qr.command_log_id = c.id AND (lower(qr.bot_name) LIKE ? OR lower(qr.message) LIKE ?)
        )
      )`)
      const like = `%${text}%`
      params.push(like, like, like, like, like)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM command_logs c ${whereSql}`).get(...params).count || 0)
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(currentPage, totalPages)
    const rows = this.db.prepare(`
      SELECT c.id, c.username, c.command_text AS commandText, c.channel,
             c.receiver_bot_id AS receiverBotId, c.receiver_bot_name AS receiverBotName,
             c.created_at AS createdAt
      FROM command_logs c ${whereSql}
      ORDER BY c.id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, (safePage - 1) * limit)
    if (rows.length) {
      const placeholders = rows.map(() => '?').join(',')
      const replies = this.db.prepare(`
        SELECT command_log_id AS commandLogId, target_username AS targetUsername,
               channel, bot_id AS botId, bot_name AS botName, message, created_at AS createdAt
        FROM command_log_replies WHERE command_log_id IN (${placeholders}) ORDER BY id
      `).all(...rows.map(row => row.id))
      const repliesByCommand = new Map()
      for (const reply of replies) {
        if (!repliesByCommand.has(reply.commandLogId)) repliesByCommand.set(reply.commandLogId, [])
        repliesByCommand.get(reply.commandLogId).push(reply)
      }
      for (const row of rows) row.replies = repliesByCommand.get(row.id) || []
    }
    return { page: safePage, pageSize: limit, total, totalPages, rows }
  }

  getBalance (ownerUuid, itemKey) {
    const row = this.db.prepare(`
      SELECT amount FROM balances WHERE owner_uuid = ? AND item_key = ?
    `).get(ownerUuid, itemKey)
    return row ? row.amount : 0
  }

  hasPendingCraft (botId = '') {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='craft_operations'").get()) return false
    return Boolean(botId
      ? this.db.prepare("SELECT 1 FROM craft_operations WHERE state NOT IN ('completed','complete','failed') AND bot_id = ? LIMIT 1").get(String(botId))
      : this.db.prepare("SELECT 1 FROM craft_operations WHERE state NOT IN ('completed','complete','failed') LIMIT 1").get())
  }

  pendingCraftBotIds () {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='craft_operations'").get()) return []
    return this.db.prepare("SELECT DISTINCT bot_id AS botId FROM craft_operations WHERE state NOT IN ('completed','complete','failed') ORDER BY bot_id")
      .all().map(row => String(row.botId || ''))
  }

  assertNoPendingCraft (allowedOperationId = '') {
    if (!this.hasPendingCraft()) return
    if (allowedOperationId && !this.db.prepare("SELECT 1 FROM craft_operations WHERE state NOT IN ('completed','complete','failed') AND id <> ? LIMIT 1").get(String(allowedOperationId))) return
    const owners = this.pendingCraftBotIds().filter(Boolean)
    const suffix = owners.length ? `（待恢复记录所属机器人：${owners.join('、')}）` : ''
    throw new Error('合成仍在进行或等待恢复；为保护物品归属，暂停库存变更和同步，请执行 !合成恢复。' + suffix)
  }

  adjustBalance (ownerUuid, itemKey, delta) {
    this.assertNoPendingCraft(this.transactionContext.getStore()?.craftOperationId || '')
    const current = this.getBalance(ownerUuid, itemKey)
    const next = current + delta
    if (next < 0) {
      throw new Error(`balance would become negative for ${ownerUuid} ${itemKey}: ${next}`)
    }
    this.db.prepare(`
      INSERT INTO balances (owner_uuid, item_key, amount)
      VALUES (?, ?, ?)
      ON CONFLICT(owner_uuid, item_key) DO UPDATE SET amount = excluded.amount
    `).run(ownerUuid, itemKey, next)
    return next
  }

  addBalanceItems (ownerUuid, items) {
    this.transaction(() => {
      for (const item of items) {
        this.upsertItem(item)
        this.adjustBalance(ownerUuid, item.itemKey, item.amount)
      }
    })
  }

  applyShulkerExtraction (ownerUuid, oldBoxItemKey, newBoxItem, extractedItems, username = '', message = '') {
    return this.transaction(() => this.applyShulkerExtractionBalance(ownerUuid, oldBoxItemKey, newBoxItem, extractedItems, username, message))
  }

  applyShulkerExtractionBalance (ownerUuid, oldBoxItemKey, newBoxItem, extractedItems, username = '', message = '') {
    const extracted = (extractedItems || []).filter(item => Number(item.amount || 0) > 0)
    if (!ownerUuid || !oldBoxItemKey || !newBoxItem?.itemKey || !extracted.length) {
      throw new Error('invalid shulker extraction balance update')
    }
    if (oldBoxItemKey === newBoxItem.itemKey) {
      throw new Error(`shulker contents changed without a new item fingerprint: ${oldBoxItemKey}`)
    }

    this.upsertItem(newBoxItem)
    this.adjustBalance(ownerUuid, oldBoxItemKey, -1)
    this.adjustBalance(ownerUuid, newBoxItem.itemKey, 1)
    for (const item of extracted) {
      this.upsertItem(item)
      this.adjustBalance(ownerUuid, item.itemKey, Number(item.amount || 0))
    }
    this.addTransaction('shulker_repack', 'ok', ownerUuid, username || this.ownerLabel(ownerUuid), extracted,
      message || `old_box=${oldBoxItemKey}, new_box=${newBoxItem.itemKey}`)
    return { ownerUuid, oldBoxItemKey, newBoxItem, extractedItems: extracted }
  }

  removeBalanceItems (ownerUuid, items) {
    this.transaction(() => {
      for (const item of items) {
        this.upsertItem(item)
        this.adjustBalance(ownerUuid, item.itemKey, -item.amount)
      }
    })
  }

  getOwnerItemsByItemId (ownerUuid, itemId) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND i.item_id = ?
        AND b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
          WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
      ORDER BY i.nbt_json = '' DESC, i.created_at ASC
    `).all(ownerUuid, itemId)
  }

  getOwnerItemsByItemKey (ownerUuid, itemKey) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND i.item_key = ?
        AND b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
          WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
      ORDER BY i.created_at ASC
    `).all(ownerUuid, itemKey)
  }

  // Read-only loose-stock snapshot for crafting previews. Keeping the query
  // here avoids initializing CraftLedger (and its schema) on a preview path.
  getCraftAvailableItems (ownerUuid) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount - COALESCE((SELECT SUM(r.amount)
        FROM inventory_reservations r WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
      ORDER BY i.item_id, i.created_at
    `).all(String(ownerUuid || ''))
  }

  getOwnerBalances (ownerUuid) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount > 0
      ORDER BY i.item_id, i.created_at
    `).all(ownerUuid)
  }

  ownerLabel (ownerUuid) {
    if (ownerUuid === this.momoOwner) return 'momo'
    if (ownerUuid.startsWith('vault:')) {
      const row = this.db.prepare('SELECT name FROM custom_warehouses WHERE name_lower = ? LIMIT 1').get(ownerUuid.slice(6))
      return row ? `仓库:${row.name}` : ownerUuid
    }
    if (ownerUuid.startsWith('name:')) return ownerUuid.slice(5)
    const row = this.db.prepare('SELECT username FROM players WHERE uuid = ? LIMIT 1').get(ownerUuid)
    return row?.username || ownerUuid
  }

  ownerTotalAmount (ownerUuid) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM balances
      WHERE owner_uuid = ? AND amount > 0
    `).get(ownerUuid)
    return row.amount || 0
  }

  isPlayerOwnerAccessible (playerUuid, ownerUuid) {
    if (!ownerUuid) return false
    if (ownerUuid === playerUuid) return this.hasPersonalWarehouse(playerUuid)
    if (ownerUuid.startsWith('vault:')) {
      return this.isCustomWarehouseMember(ownerUuid.slice(6), playerUuid)
    }
    return false
  }

  getEffectiveDefaultOwnerUuid (playerUuid) {
    const configured = this.getPlayerDefaultOwnerUuid(playerUuid)
    if (this.isPlayerOwnerAccessible(playerUuid, configured)) return configured
    if (this.hasPersonalWarehouse(playerUuid)) return playerUuid
    const warehouse = this.db.prepare(`
      SELECT 'vault:' || warehouse_name_lower AS ownerUuid
      FROM custom_warehouse_members WHERE player_uuid = ?
      ORDER BY added_at ASC LIMIT 1
    `).get(playerUuid)
    return warehouse?.ownerUuid || ''
  }

  listWebOwnersForUser (user) {
    const defaultOwnerUuid = this.getEffectiveDefaultOwnerUuid(user.uuid)
    const markDefault = owner => ({ ...owner, isDefault: owner.ownerUuid === defaultOwnerUuid })
    const owners = []

    if (this.hasPersonalWarehouse(user.uuid)) {
      owners.push(markDefault({
        ownerUuid: user.uuid,
        label: user.username,
        type: 'personal',
        role: 'owner',
        totalAmount: this.ownerTotalAmount(user.uuid)
      }))
    }

    for (const row of this.db.prepare(`
      SELECT w.name_lower AS nameLower, w.name, m.role, COALESCE(SUM(b.amount), 0) AS totalAmount
      FROM custom_warehouse_members m
      JOIN custom_warehouses w ON w.name_lower = m.warehouse_name_lower
      LEFT JOIN balances b ON b.owner_uuid = 'vault:' || w.name_lower AND b.amount > 0
      WHERE m.player_uuid = ?
      GROUP BY w.name_lower
      ORDER BY w.name COLLATE NOCASE ASC
    `).all(user.uuid)) {
      owners.push(markDefault({ ownerUuid: `vault:${row.nameLower}`, label: `仓库:${row.name}`, type: 'custom', role: row.role, totalAmount: row.totalAmount }))
    }

    return owners
  }

  canWebUserAccessOwner (user, ownerUuid) {
    if (ownerUuid === user.uuid) return this.hasPersonalWarehouse(user.uuid)
    if (ownerUuid.startsWith('vault:')) {
      return this.isCustomWarehouseMember(ownerUuid.slice(6), user.uuid)
    }
    return false
  }

  getWebInventory (ownerUuid, viewerUuid = '') {
    const rows = this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, i.item_key AS itemKey, i.item_id AS itemId,
             i.display_name AS displayName, i.nbt_json AS nbtJson,
             i.meta_json AS metaJson, b.amount,
             COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
                       WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS reserved
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount > 0
      ORDER BY i.display_name COLLATE NOCASE ASC, i.item_key ASC
    `).all(ownerUuid)

    const shulkerKeys = rows.filter(row => row.itemId.endsWith('shulker_box')).map(row => row.itemKey)
    const shulkerContents = this.getShulkerContentsByBox(shulkerKeys)
    const contentKeys = [...shulkerContents.values()].flat().map(item => item.itemKey)
    const personalAliasLists = this.getPlayerItemAliases(viewerUuid, [...rows.map(row => row.itemKey), ...contentKeys])
    const personalDisplayNames = this.getPlayerItemDisplayNames(viewerUuid, [...rows.map(row => row.itemKey), ...contentKeys])
    const globalAliases = this.getGlobalAliasesForItems([...rows.map(row => row.itemKey), ...contentKeys], viewerUuid)
    const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0)
    // 预留中：任务已挂起但账还没扣的数量。页面要展示"可取"口径，
    // 避免任务进行中数字虚高、玩家再下单被"库存已被其他任务占用"打回。
    const reservedAmount = rows.reduce((sum, row) => sum + Math.min(row.reserved, row.amount), 0)

    return {
      ownerUuid,
      ownerLabel: this.ownerLabel(ownerUuid),
      stats: {
        totalAmount,
        reservedAmount,
        itemTypes: rows.length
      },
      items: rows.map(row => {
        const personalAliases = personalAliasLists.get(row.itemKey) || []
        const personalAlias = personalAliases[0] || ''
        const personalDisplayName = personalDisplayNames.get(row.itemKey) || ''
        const contents = (shulkerContents.get(row.itemKey) || []).map(item => {
          const contentAliases = personalAliasLists.get(item.itemKey) || []
          const contentAlias = contentAliases[0] || ''
          const contentDisplayName = personalDisplayNames.get(item.itemKey) || ''
          return {
            ...item,
            adminDisplayName: item.displayName,
            globalAliases: globalAliases.get(item.itemKey) || [],
            personalAliases: contentAliases,
            personalAlias: contentAlias,
            personalDisplayName: contentDisplayName,
            displayName: contentDisplayName || item.displayName
          }
        })
        return {
          ...this.rowToItem(row),
          baseDisplayName: this.catalog?.getDisplayName(row.itemId) || '',
          adminDisplayName: row.displayName,
          globalAliases: globalAliases.get(row.itemKey) || [],
          personalAliases,
          personalAlias,
          personalDisplayName,
          displayName: personalDisplayName || row.displayName,
          amount: row.amount,
          reserved: Math.min(row.reserved, row.amount),
          available: Math.max(0, row.amount - row.reserved),
          shortCode: this.shortCodeForItemKey(row.itemKey),
          shulkerContents: contents
        }
      })
    }
  }

  getShulkerContentsByBox (shulkerKeys) {
    const result = new Map()
    const keys = [...new Set(shulkerKeys || [])].filter(Boolean)
    if (!keys.length) return result
    const chunkSize = 500
    for (let offset = 0; offset < keys.length; offset += chunkSize) {
      const chunk = keys.slice(offset, offset + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT sc.shulker_item_key AS shulkerItemKey,
               sc.amount, sc.slot_count AS slotCount,
               i.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
               i.nbt_json AS nbtJson, i.meta_json AS metaJson
        FROM shulker_contents sc
        JOIN items i ON i.item_key = sc.contained_item_key
        WHERE sc.shulker_item_key IN (${placeholders})
        ORDER BY i.display_name COLLATE NOCASE ASC
      `).all(...chunk)
      for (const row of rows) {
        const item = {
          ...this.rowToItem(row),
          baseDisplayName: this.catalog?.getDisplayName(row.itemId) || '',
          amount: row.amount,
          slotCount: row.slotCount,
          shortCode: this.shortCodeForItemKey(row.itemKey)
        }
        if (!result.has(row.shulkerItemKey)) result.set(row.shulkerItemKey, [])
        result.get(row.shulkerItemKey).push(item)
      }
    }
    return result
  }

  listWebTransactions (ownerUuid, limit = 80) {
    return this.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, bot_id AS botId, bot_name AS botName,
             created_at AS createdAt
      FROM transactions
      WHERE player_uuid = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(ownerUuid, limit).map(row => {
      let items = []
      try {
        items = JSON.parse(row.itemsJson || '[]')
      } catch {
        items = []
      }
      return {
        ...row,
        ownerLabel: this.ownerLabel(row.playerUuid),
        items: items.map(item => ({
          ...item,
          displayName: item.displayName || item.itemId,
          shortCode: this.shortCodeForItemKey(item.itemKey),
          amount: Number(item.amount || 0)
        }))
      }
    })
  }

  getQuotaSlots (ownerUuid, defaultSlots) {
    const row = this.db.prepare(`
      SELECT quota_slots AS quotaSlots
      FROM player_quotas
      WHERE owner_uuid = ?
    `).get(ownerUuid)
    return row ? row.quotaSlots : defaultSlots
  }

  getQuotaOverride (ownerUuid) {
    const row = this.db.prepare(`
      SELECT quota_slots AS quotaSlots, updated_at AS updatedAt
      FROM player_quotas WHERE owner_uuid = ?
    `).get(ownerUuid)
    return row || null
  }

  clearQuotaSlots (ownerUuid) {
    return this.db.prepare('DELETE FROM player_quotas WHERE owner_uuid = ?').run(ownerUuid).changes
  }

  setQuotaSlots (ownerUuid, slots) {
    this.db.prepare(`
      INSERT INTO player_quotas (owner_uuid, quota_slots, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_uuid) DO UPDATE SET
        quota_slots = excluded.quota_slots,
        updated_at = CURRENT_TIMESTAMP
    `).run(ownerUuid, slots)
  }

  getOwnerTotalByItemId (ownerUuid, itemId) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(b.amount), 0) AS amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND i.item_id = ?
    `).get(ownerUuid, itemId)
    return row.amount
  }

  getOwnerTotalByItemKey (ownerUuid, itemKey) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM balances
      WHERE owner_uuid = ? AND item_key = ?
    `).get(ownerUuid, itemKey)
    return row.amount
  }

  getOwnerShulkersContainingItemId (ownerUuid, itemId) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid,
             sc.shulker_item_key AS shulkerItemKey,
             box.item_id AS shulkerItemId,
             box.display_name AS shulkerDisplayName,
             box.nbt_json AS shulkerNbtJson,
             box.meta_json AS shulkerMetaJson,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS shulkerAmount,
             sc.contained_item_id AS containedItemId,
             sc.contained_item_key AS containedItemKey,
             contained.display_name AS containedDisplayName,
             GROUP_CONCAT(DISTINCT contained.display_name) AS containedDisplayNames,
             SUM(sc.amount) AS containedAmount,
             SUM(sc.slot_count) AS slotCount,
             (SELECT COALESCE(SUM(all_sc.slot_count), 0)
              FROM shulker_contents all_sc
              WHERE all_sc.shulker_item_key = sc.shulker_item_key) AS totalSlotCount,
             (SELECT COALESCE(SUM(all_sc.amount), 0)
              FROM shulker_contents all_sc
              WHERE all_sc.shulker_item_key = sc.shulker_item_key) AS boxContainedAmount,
             SUM(sc.amount) * (b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0)) AS totalContainedAmount
      FROM shulker_contents sc
      JOIN balances b ON b.item_key = sc.shulker_item_key
      JOIN items box ON box.item_key = sc.shulker_item_key
      JOIN items contained ON contained.item_key = sc.contained_item_key
      WHERE b.owner_uuid = ?
        AND b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
          WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
        AND sc.contained_item_id = ?
        AND sc.amount > 0
      GROUP BY b.owner_uuid, sc.shulker_item_key, sc.contained_item_key
      ORDER BY totalContainedAmount DESC, box.display_name COLLATE NOCASE ASC
    `).all(ownerUuid, itemId)
  }

  getOwnerShulkersContainingItemKey (ownerUuid, itemKey) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid,
             sc.shulker_item_key AS shulkerItemKey,
             box.item_id AS shulkerItemId,
             box.display_name AS shulkerDisplayName,
             box.nbt_json AS shulkerNbtJson,
             box.meta_json AS shulkerMetaJson,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS shulkerAmount,
             sc.contained_item_id AS containedItemId,
             sc.contained_item_key AS containedItemKey,
             contained.display_name AS containedDisplayName,
             contained.display_name AS containedDisplayNames,
             sc.amount AS containedAmount,
             sc.slot_count AS slotCount,
             (SELECT COALESCE(SUM(all_sc.slot_count), 0)
              FROM shulker_contents all_sc
              WHERE all_sc.shulker_item_key = sc.shulker_item_key) AS totalSlotCount,
             (SELECT COALESCE(SUM(all_sc.amount), 0)
              FROM shulker_contents all_sc
              WHERE all_sc.shulker_item_key = sc.shulker_item_key) AS boxContainedAmount,
             sc.amount * (b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0)) AS totalContainedAmount
      FROM shulker_contents sc
      JOIN balances b ON b.item_key = sc.shulker_item_key
      JOIN items box ON box.item_key = sc.shulker_item_key
      JOIN items contained ON contained.item_key = sc.contained_item_key
      WHERE b.owner_uuid = ?
        AND b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
          WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
        AND sc.contained_item_key = ?
        AND sc.amount > 0
      ORDER BY totalContainedAmount DESC, box.display_name COLLATE NOCASE ASC
    `).all(ownerUuid, itemKey)
  }

  findOwnerShulkersByContainedDisplayQuery (ownerUuid, query) {
    const text = String(query || '').trim()
    if (!text) return []
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid,
             sc.shulker_item_key AS shulkerItemKey,
             box.item_id AS shulkerItemId,
             box.display_name AS shulkerDisplayName,
             box.nbt_json AS shulkerNbtJson,
             box.meta_json AS shulkerMetaJson,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS shulkerAmount,
             sc.contained_item_id AS containedItemId,
             GROUP_CONCAT(DISTINCT contained.display_name) AS containedDisplayNames,
             SUM(sc.amount) AS containedAmount,
             SUM(sc.slot_count) AS slotCount,
             SUM(sc.amount) * (b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0)) AS totalContainedAmount
      FROM shulker_contents sc
      JOIN balances b ON b.item_key = sc.shulker_item_key
      JOIN items box ON box.item_key = sc.shulker_item_key
      JOIN items contained ON contained.item_key = sc.contained_item_key
      WHERE b.owner_uuid = ?
        AND b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
          WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
        AND sc.amount > 0
        AND (
          lower(contained.display_name) = lower(?)
          OR lower(contained.display_name) LIKE '%' || lower(?) || '%'
          OR lower(contained.item_id) = lower(?)
        )
      GROUP BY b.owner_uuid, sc.shulker_item_key, sc.contained_item_id
      ORDER BY lower(contained.display_name) = lower(?) DESC,
               totalContainedAmount DESC,
               box.display_name COLLATE NOCASE ASC
      LIMIT 10
    `).all(ownerUuid, text, text, text, text)
  }

  findItemsByDisplayQuery (query, playerUuid = '') {
    const text = String(query || '').trim()
    if (!text) return []
    return this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE lower(display_name) = lower(?)
         OR lower(display_name) LIKE '%' || lower(?) || '%'
         OR lower(item_id) = lower(?)
         OR EXISTS (
           SELECT 1 FROM global_item_aliases a
           WHERE a.item_key = items.item_key
             AND (a.alias_lower = lower(?) OR a.alias_lower LIKE '%' || lower(?) || '%')
             AND (? = '' OR NOT EXISTS (
               SELECT 1 FROM player_disabled_global_aliases d
               WHERE d.player_uuid = ? AND d.alias_lower = a.alias_lower
             ))
         )
         OR EXISTS (
           SELECT 1 FROM player_item_aliases pa
           WHERE pa.player_uuid = ? AND pa.item_key = items.item_key
             AND (pa.alias_lower = lower(?) OR pa.alias_lower LIKE '%' || lower(?) || '%')
         )
      ORDER BY lower(display_name) = lower(?) DESC, created_at ASC
      LIMIT 10
    `).all(text, text, text, text, text, playerUuid, playerUuid, playerUuid, text, text, text)
  }

  findOwnerItemsByDisplayQuery (ownerUuid, query, playerUuid = '') {
    const text = String(query || '').trim()
    if (!text) return []
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ?
        AND b.amount > 0
        AND (
          lower(i.display_name) = lower(?)
          OR lower(i.display_name) LIKE '%' || lower(?) || '%'
          OR lower(i.item_id) = lower(?)
          OR EXISTS (
            SELECT 1 FROM global_item_aliases a
            WHERE a.item_key = i.item_key
              AND (a.alias_lower = lower(?) OR a.alias_lower LIKE '%' || lower(?) || '%')
              AND (? = '' OR NOT EXISTS (
                SELECT 1 FROM player_disabled_global_aliases d
                WHERE d.player_uuid = ? AND d.alias_lower = a.alias_lower
              ))
          )
          OR EXISTS (
            SELECT 1 FROM player_item_aliases pa
            WHERE pa.player_uuid = ? AND pa.item_key = i.item_key
              AND (pa.alias_lower = lower(?) OR pa.alias_lower LIKE '%' || lower(?) || '%')
          )
        )
      ORDER BY lower(i.display_name) = lower(?) DESC, i.created_at ASC
      LIMIT 10
    `).all(ownerUuid, text, text, text, text, text, playerUuid, playerUuid, playerUuid, text, text, text)
  }

  findItemByShortCode (code) {
    const text = String(code || '').trim().replace(/^#/, '').toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(text)) return null
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE lower(substr(item_key, instr(item_key, '|') + 1, 6)) = ?
      ORDER BY created_at ASC
      LIMIT 2
    `).all(text)
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      throw new Error(`短码 ${text} 匹配到多个物品，请使用完整 itemKey。`)
    }
    return null
  }

  upsertChest (chest) {
    this.db.prepare(`
      INSERT INTO chests (chest_id, x, y, z, block_name, last_seen_at)
      VALUES (@chestId, @x, @y, @z, @blockName, CURRENT_TIMESTAMP)
      ON CONFLICT(chest_id) DO UPDATE SET
        x = excluded.x,
        y = excluded.y,
        z = excluded.z,
        block_name = excluded.block_name,
        last_seen_at = CURRENT_TIMESTAMP
    `).run(chest)
  }

  listChests () {
    return this.db.prepare(`
      SELECT chest_id AS chestId, x, y, z, block_name AS blockName
      FROM chests
      ORDER BY y, x, z
    `).all()
  }

  listChestSlots () {
    return this.db.prepare(`
      SELECT c.chest_id AS chestId, c.x, c.y, c.z, c.block_name AS blockName,
             cs.slot, cs.item_key AS itemKey, cs.amount
      FROM chests c
      LEFT JOIN chest_slots cs ON cs.chest_id = c.chest_id
      ORDER BY c.y, c.x, c.z, cs.slot
    `).all()
  }

  clearChests () {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chest_slots').run()
      this.db.prepare('DELETE FROM chests').run()
    })
  }

  clearInventoryData () {
    this.assertNoPendingCraft()
    const counts = {
      balances: this.db.prepare('SELECT COUNT(*) AS count FROM balances').get().count,
      chestSlots: this.db.prepare('SELECT COUNT(*) AS count FROM chest_slots').get().count,
      chests: this.db.prepare('SELECT COUNT(*) AS count FROM chests').get().count,
      transactions: this.db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,
      shulkerContents: this.db.prepare('SELECT COUNT(*) AS count FROM shulker_contents').get().count,
      inventoryMismatches: this.db.prepare('SELECT COUNT(*) AS count FROM inventory_mismatches').get().count,
      items: this.db.prepare('SELECT COUNT(*) AS count FROM items').get().count,
      botRecoveryTasks: this.db.prepare('SELECT COUNT(*) AS count FROM bot_recovery_tasks').get().count,
      shulkerRepackRecoveries: this.db.prepare('SELECT COUNT(*) AS count FROM shulker_repack_recovery').get().count
    }

    this.transaction(() => {
      this.db.prepare('DELETE FROM shulker_contents').run()
      this.db.prepare('DELETE FROM chest_slots').run()
      this.db.prepare('DELETE FROM chests').run()
      this.db.prepare('DELETE FROM balances').run()
      this.db.prepare('DELETE FROM inventory_mismatches').run()
      this.db.prepare('DELETE FROM transactions').run()
      this.db.prepare('DELETE FROM player_item_name_overrides').run()
      this.db.prepare('DELETE FROM player_item_aliases').run()
      this.db.prepare('DELETE FROM player_item_display_names').run()
      this.db.prepare('DELETE FROM player_disabled_global_aliases').run()
      this.db.prepare('DELETE FROM bot_recovery_tasks').run()
      this.db.prepare('DELETE FROM shulker_repack_recovery').run()
      this.db.prepare('DELETE FROM items').run()
    })

    return counts
  }

  getItemByKey (itemKey) {
    const row = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE item_key = ?
    `).get(itemKey)
    return row || null
  }

  replaceChestSlots (chestId, slots) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chest_slots WHERE chest_id = ?').run(chestId)
      const stmt = this.db.prepare(`
        INSERT INTO chest_slots (chest_id, slot, item_key, amount)
        VALUES (?, @slot, @itemKey, @amount)
      `)
      for (const slot of slots) {
        this.upsertItem(slot)
        stmt.run(chestId, slot)
      }
    })
  }

  listSlotsForItemKey (itemKey) {
    return this.db.prepare(`
      SELECT cs.chest_id AS chestId, cs.slot, cs.amount,
             c.x, c.y, c.z, c.block_name AS blockName
      FROM chest_slots cs
      JOIN chests c ON c.chest_id = cs.chest_id
      WHERE cs.item_key = ? AND cs.amount > 0
      ORDER BY c.y, c.x, c.z, cs.slot
    `).all(itemKey)
  }

  clearAllWarehouseSlots () {
    this.db.prepare('DELETE FROM chest_slots').run()
  }

  getLedgerTotals () {
    return this.db.prepare(`
      SELECT b.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson, SUM(b.amount) AS amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.amount > 0
      GROUP BY b.item_key
    `).all()
  }

  getOwnerLabelForMismatch (ownerUuid) {
    if (!ownerUuid) return ''
    if (ownerUuid === this.momoOwner) return 'momo'
    if (ownerUuid.startsWith('vault:')) {
      const row = this.db.prepare(`
        SELECT name FROM custom_warehouses WHERE name_lower = ? LIMIT 1
      `).get(ownerUuid.slice(6))
      return row ? `仓库:${row.name}` : ownerUuid
    }
    if (ownerUuid.startsWith('name:')) return ownerUuid.slice(5)
    const player = this.db.prepare(`
      SELECT username FROM players WHERE uuid = ? LIMIT 1
    `).get(ownerUuid)
    return player?.username || ownerUuid
  }

  allocateMissingOwners (itemKey, amount) {
    const rows = this.db.prepare(`
      SELECT owner_uuid AS ownerUuid, amount
      FROM balances
      WHERE item_key = ? AND amount > 0 AND owner_uuid <> ?
      ORDER BY owner_uuid LIKE 'vault:%' DESC, owner_uuid COLLATE NOCASE ASC
    `).all(itemKey, this.momoOwner)

    let remaining = amount
    const allocations = []
    for (const row of rows) {
      if (remaining <= 0) break
      const count = Math.min(remaining, row.amount)
      allocations.push({
        ownerUuid: row.ownerUuid,
        username: this.getOwnerLabelForMismatch(row.ownerUuid),
        amount: count
      })
      remaining -= count
    }
    if (remaining > 0) {
      allocations.push({ ownerUuid: '', username: '未知归属', amount: remaining })
    }
    return allocations
  }

  hasOpenInventoryMismatch (ownerUuid, itemKey) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM inventory_mismatches
      WHERE status = 'open' AND owner_uuid = ? AND item_key = ?
      LIMIT 1
    `).get(String(ownerUuid || ''), String(itemKey || '')))
  }

  addInventoryMismatch (kind, ownerUuid, username, item, amount, note = '', balanceAdjusted = 0) {
    if (!amount || amount <= 0 || !item?.itemKey) return
    const adjusted = Number(balanceAdjusted)
    if (!Number.isSafeInteger(adjusted) || adjusted < 0 || adjusted > amount) throw new Error('inventory mismatch balance adjustment is invalid')
    this.upsertItem(this.rowToItem(item))
    this.db.prepare(`
      INSERT INTO inventory_mismatches (
        kind, status, owner_uuid, username, item_key, item_id, display_name,
        nbt_json, meta_json, amount, note, balance_adjusted
      )
      VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kind,
      ownerUuid || '',
      username || '',
      item.itemKey,
      item.itemId,
      item.displayName,
      item.nbtJson || '',
      item.metaJson || '',
      amount,
      note,
      adjusted
    )
  }

  resolveOpenInventoryMismatches (note = '') {
    return this.db.prepare(`
      UPDATE inventory_mismatches
      SET status = 'resolved',
          resolved_at = CURRENT_TIMESTAMP,
          note = CASE
            WHEN ? = '' THEN note
            WHEN note = '' THEN ?
            ELSE note || '；' || ?
          END
      WHERE status = 'open'
    `).run(note, note, note).changes
  }

  reconcileTotalsToMomo (actualTotals, allowedOperationId = '') {
    // Recovery uses the same global reconciliation policy as normal sync. Its
    // own durable journal is exempt only inside this synchronous transaction.
    const operationId = String(allowedOperationId || '')
    this.assertNoPendingCraft(operationId)
    const context = this.transactionContext.getStore() || {}
    return this.transactionContext.run({ ...context, craftOperationId: operationId }, () => this.reconcileTotalsToMomoAllowed(actualTotals))
  }

  reconcileRecoveryDeltaToMomo (baselineTotals, actualTotals, allowedOperationId = '') {
    if (!Array.isArray(baselineTotals) || !Array.isArray(actualTotals)) throw new Error('recovery reconciliation requires baseline and current totals')
    const operationId = String(allowedOperationId || '')
    this.assertNoPendingCraft(operationId)
    const context = this.transactionContext.getStore() || {}
    return this.transactionContext.run({ ...context, craftOperationId: operationId }, () =>
      this.reconcileTotalsToMomoAllowed(actualTotals, baselineTotals))
  }

  reconcileTotalsToMomoAllowed (actualTotals, baselineTotals = null) {
    this.assertNoPendingCraft(this.transactionContext.getStore()?.craftOperationId || '')
    const ledgerRows = this.getLedgerTotals()
    const ledger = new Map(ledgerRows.map(row => [row.itemKey, row]))
    const actual = new Map(actualTotals.map(row => [row.itemKey, row]))
    const baseline = baselineTotals ? new Map(baselineTotals.map(row => [row.itemKey, row])) : null
    const reference = baseline || ledger
    const keys = new Set([...reference.keys(), ...actual.keys()])
    const addedToMomo = []
    const removedFromMomo = []
    const unresolved = []

    this.transaction(() => {
      if (!baseline) this.resolveOpenInventoryMismatches('新的同步已刷新库存异常状态。')

      for (const key of keys) {
        const actualRow = actual.get(key)
        const referenceRow = reference.get(key)
        const ledgerAmount = referenceRow?.amount || 0
        const actualAmount = actualRow?.amount || 0
        const diff = actualAmount - ledgerAmount
        const item = actualRow || referenceRow || ledger.get(key)

        if (item) this.upsertItem(this.rowToItem(item))

        if (diff > 0) {
          this.adjustBalance(this.momoOwner, key, diff)
          addedToMomo.push({ ...this.rowToItem(item), amount: diff })
        } else if (diff < 0) {
          const missing = Math.abs(diff)
          const momoBalance = this.getBalance(this.momoOwner, key)
          const covered = Math.min(missing, momoBalance)
          if (covered > 0) {
            this.adjustBalance(this.momoOwner, key, -covered)
            removedFromMomo.push({ ...this.rowToItem(item), amount: covered })
          }
          if (covered < missing) {
            const unresolvedAmount = missing - covered
            const missingItem = this.rowToItem(item)
            unresolved.push({ ...missingItem, amount: unresolvedAmount })
            for (const allocation of this.allocateMissingOwners(key, unresolvedAmount)) {
              if (!allocation.ownerUuid) {
                // 完全无法归属到任何账面持有者：只留痕，不动账。
                this.addInventoryMismatch(
                  'missing',
                  allocation.ownerUuid,
                  allocation.username,
                  missingItem,
                  allocation.amount,
                  baseline
                    ? '合成恢复对账发现实物净减少；无法归属到任何账面持有者，未自动扣除。'
                    : '同步发现仓库实物少于账本；无法归属到任何账面持有者，未自动扣除。'
                )
                continue
              }
              // 同步即扣：按归属估算直接扣减 owner 账面余额，让 Web 库存与实物
              // 一致，不再出现"登记了异常但库存数字一直虚高"。扣减按当前余额
              // 钳制，防止异常数据把整个对账事务顶回滚；异常仍登记留痕。
              const balance = this.getBalance(allocation.ownerUuid, key)
              const deducted = Math.min(balance, allocation.amount)
              if (deducted > 0) {
                this.adjustBalance(allocation.ownerUuid, key, -deducted)
                this.addTransaction(
                  'sync_deduct',
                  'ok',
                  allocation.ownerUuid,
                  allocation.username,
                  [{ ...missingItem, amount: deducted }],
                  `sync=missing; deduct=${deducted}; requested=${allocation.amount}`
                )
              }
              this.addInventoryMismatch(
                'missing',
                allocation.ownerUuid,
                allocation.username,
                missingItem,
                allocation.amount,
                deducted <= 0
                  ? (baseline ? '合成恢复对账发现实物净减少，账面已无可扣除数量；留痕待管理员复核。' : '同步发现仓库实物少于账本，账面已无可扣除数量；留痕待管理员复核。')
                  : `${baseline ? '合成恢复对账发现实物净减少' : '同步发现仓库实物少于账本'}，已自动扣除账面 x${deducted}${deducted < allocation.amount ? `（请求扣 ${allocation.amount}，账面仅剩 ${deducted}）` : ''}；留痕待管理员复核。`,
                deducted
              )
            }
          }
        }
      }

      for (const item of addedToMomo) {
        this.addInventoryMismatch(
          'extra',
          this.momoOwner,
          'momo',
          item,
          item.amount,
            baseline
              ? '合成恢复对账发现实物净增加，已按同步规则划入 momo，可在查看器转移给正确归属。'
              : '同步发现仓库实物多于账本，已自动划入 momo，可在查看器转移给正确归属。'
        )
      }
    })

    return { addedToMomo, removedFromMomo, unresolved }
  }

  rowToItem (row) {
    return {
      itemKey: row.itemKey,
      itemId: row.itemId,
      displayName: row.displayName,
      nbtJson: row.nbtJson || '',
      metaJson: row.metaJson || ''
    }
  }

  close () {
    this.db.close()
  }
}

module.exports = StoreDb
