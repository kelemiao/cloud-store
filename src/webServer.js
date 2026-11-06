const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { parseLitematicData } = require('../scripts/litematic-materials')
const { signCloudStoreToken } = require('./botPlatformSso')
const { logLocalError } = require('./localErrorLog')
const { snapshotConsoleLogs, pushPanelLog, isConsoleLogBufferInstalled } = require('./consoleLogBuffer')

class CloudStoreWebServer {
  constructor (db, config, serviceProvider, botManagerProvider = null, subscriptions = null) {
    this.db = db
    this.config = config
    this.serviceProvider = serviceProvider
    this.botManagerProvider = botManagerProvider
    this.subscriptions = subscriptions
    this.sessions = new Map()
    this.loginFailures = new Map()
    this.loginChallenges = new Map()
    this.server = null
    this.lastSessionCleanupAt = 0
  }

  start () {
    if (this.server || this.config.web?.enabled === false) return
    const { host, port } = this.resolveListenOptions()
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.once('error', error => {
      // 端口被占（EADDRINUSE）说明已有另一实例在跑（如热重载后的孤儿进程），
      // 直接退出让外层循环/守护拉起重试，而不是带着死面板继续跑。
      console.error(`[web] cloud store panel failed to listen on ${host}:${port}: ${error.code || error.message}`)
      logLocalError('web-listen-error', error)
      process.exit(1)
    })
    this.server.listen(port, host, () => {
      const actualPort = this.server.address()?.port || port
      console.log(`[web] cloud store panel listening on ${this.publicUrl(actualPort)}`)
    })
  }

  resolveListenOptions () {
    const host = this.config.web?.host || '127.0.0.1'
    let port = Number.parseInt(this.config.web?.port, 10)
    if (!Number.isFinite(port)) {
      try {
        port = Number.parseInt(new URL(this.config.web?.dashboardUrl || '').port, 10)
      } catch {
        port = NaN
      }
    }
    return { host, port: Number.isFinite(port) ? port : 8787 }
  }

  publicUrl (actualPort = null) {
    const configured = String(this.config.web?.dashboardUrl || '').trim()
    if (configured) return configured
    const { host, port } = this.resolveListenOptions()
    const displayHost = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host
    const parsedActualPort = actualPort === null || actualPort === undefined ? NaN : Number(actualPort)
    const finalPort = Number.isFinite(parsedActualPort) ? parsedActualPort : port
    const hostText = displayHost.includes(':') && !displayHost.startsWith('[') ? `[${displayHost}]` : displayHost
    const portText = finalPort === 80 ? '' : `:${finalPort}`
    return `http://${hostText}${portText}/`
  }

  async handle (req, res) {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch (error) {
      this.logRejectedRequest(req, error)
      return this.sendText(res, 400, 'Bad request')
    }
    try {
      const session = this.getSession(req, res)
      if (req.method === 'GET' && url.pathname === '/bot-platform') return await this.openBotPlatform(res, session)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) return this.sendHtml(res, HTML)
      if (req.method === 'GET' && url.pathname === '/api/me') return this.sendJson(res, this.apiMe(session))
      if (req.method === 'GET' && url.pathname === '/api/inventory') return this.sendJson(res, this.apiInventory(session, url))
      if (req.method === 'GET' && url.pathname === '/api/online-players') return this.sendJson(res, this.apiOnlinePlayers(session, url))
      if (req.method === 'GET' && url.pathname === '/api/transactions') return this.sendJson(res, this.apiTransactions(session, url))
      if (req.method === 'GET' && url.pathname === '/api/my/organizations') return this.sendJson(res, this.apiMyOrganizations(session))
      if (req.method === 'GET' && url.pathname === '/api/my/aliases') return this.sendJson(res, this.apiMyAliases(session, url))
      if (req.method === 'GET' && url.pathname === '/api/subscriptions') return this.sendJson(res, this.apiSubscriptions(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/owners') return this.sendJson(res, this.apiAdminOwners(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/warehouse-provisioning') return this.sendJson(res, this.apiAdminWarehouseProvisioning(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/organization-warehouse/detail') return this.sendJson(res, this.apiAdminOrganizationWarehouseDetail(session, url))
      if (req.method === 'GET' && url.pathname === '/api/warehouse-admin/organizations') return this.sendJson(res, this.apiWarehouseAdminOrganizations(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/inventory') return this.sendJson(res, this.apiAdminInventory(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/mismatches') return this.sendJson(res, this.apiAdminMismatches(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/transactions') return this.sendJson(res, this.apiAdminTransactions(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/commands') return this.sendJson(res, this.apiAdminCommands(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/chests') return this.sendJson(res, this.apiAdminChests(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/chest') return this.sendJson(res, this.apiAdminChest(session, url))
      if (req.method === 'POST' && url.pathname === '/api/admin/chest/live') {
        const body = await this.readBody(req)
        return this.sendJson(res, await this.apiAdminChestLive(session, body))
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/aliases') return this.sendJson(res, this.apiAdminAliases(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/quotas') return this.sendJson(res, this.apiAdminQuotas(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/users') return this.sendJson(res, this.apiAdminUsers(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/subscription/users') return this.sendJson(res, this.apiAdminSubscriptionUsers(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/subscription/user') return this.sendJson(res, this.apiAdminSubscriptionUser(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/subscription/config') return this.sendJson(res, this.apiAdminSubscriptionConfig(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/subscription/logs') return this.sendJson(res, this.apiAdminSubscriptionLogs(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/subscription/payments') return this.sendJson(res, this.apiAdminSubscriptionPayments(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/bots') return this.sendJson(res, this.apiAdminBots(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/console-logs') {
        if (!this.requireAdminQuiet(session)) return this.sendJson(res, { ok: false, error: '只有管理员可以查看运行日志。' }, 403)
        return this.sendJson(res, this.apiAdminConsoleLogs(session, url))
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/log-files') {
        if (!this.requireAdminQuiet(session)) return this.sendJson(res, { ok: false, error: '只有管理员可以查看日志文件。' }, 403)
        return this.sendJson(res, this.apiAdminLogFiles(session))
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/log-file') {
        if (!this.requireAdminQuiet(session)) return this.sendJson(res, { ok: false, error: '只有管理员可以查看日志文件。' }, 403)
        return this.sendJson(res, this.apiAdminLogFile(session, url))
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiLogin(session, body, this.clientIp(req)))
      }
      if (req.method === 'POST' && url.pathname === '/api/login/challenge') {
        await this.readBody(req)
        return this.sendJson(res, this.apiLoginChallengeCreate(session))
      }
      if (req.method === 'GET' && url.pathname === '/api/login/challenge') {
        return this.sendJson(res, this.apiLoginChallengeStatus(session))
      }
      if (req.method === 'POST' && url.pathname === '/api/login/challenge/cancel') {
        await this.readBody(req)
        return this.sendJson(res, this.apiLoginChallengeCancel(session))
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await this.readBody(req)
        return this.apiLogout(res, session)
      }
      if (req.method === 'POST' && url.pathname === '/api/action/deposit') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiDeposit(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/action/withdraw') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWithdraw(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/action/withdraw/plan') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWithdrawPlan(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/default-owner') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiDefaultOwner(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/subscriptions/purchase') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiSubscriptionPurchase(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/subscriptions/organization/create') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiSubscriptionOrganizationCreate(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/litematic/plan') {
        const body = await this.readBody(req, 12 * 1024 * 1024)
        return this.sendJson(res, await this.apiLitematicPlan(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/item-alias/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiItemAliasSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/item-alias/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiItemAliasDelete(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/my/global-alias/toggle') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiMyGlobalAliasToggle(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/member/add') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminMemberAdd(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/member/remove') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminMemberRemove(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/member/role') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminMemberRole(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/quick-shulker-extraction') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminQuickShulkerExtractionSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/rename') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminRename(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/adjust') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAdjust(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/personal-warehouse/create') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminCreatePersonalWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/create') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminCreateOrganizationWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/member/add') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminOrganizationMemberAdd(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/member/remove') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminOrganizationMemberRemove(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/member/role') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminOrganizationMemberRole(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/personal-warehouse/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminDeletePersonalWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminDeleteOrganizationWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/identity/merge') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminIdentityMerge(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/transfer') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminTransfer(session, body))
      }
      if (req.method === 'POST' && (url.pathname === '/api/admin/mismatch/delete' || url.pathname === '/api/admin/mismatch/deduct')) {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchDeduct(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mismatch/resolve') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchResolve(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mismatch/batch-deduct') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchBatchDeduct(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mismatch/batch-resolve') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchBatchResolve(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/alias/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAliasSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/alias/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAliasDelete(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/quota/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminQuotaSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/warehouse/quick-shulker-extraction') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminQuickShulkerExtractionSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/quota/restore') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminQuotaRestore(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/subscription/balance') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminSubscriptionBalance(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/subscription/cancel') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminSubscriptionCancel(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/subscription/config') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminSubscriptionConfigSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/subscription/plan') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminSubscriptionPlanSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/subscription/regex/test') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminSubscriptionRegexTest(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/subscription/time/sync') {
        await this.readBody(req)
        return this.sendJson(res, await this.apiAdminSubscriptionTimeSync(session))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/users/add') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminUserAdd(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/users/remove') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminUserRemove(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/bots/add') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminBotAdd(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/bots/enabled') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminBotEnabled(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/bots/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminBotDelete(session, body))
      }
      this.sendText(res, 404, 'Not found')
    } catch (error) {
      this.sendJson(res, { ok: false, error: error.message }, error.status || 400)
    }
  }

  apiMe (session) {
    if (!session.user) {
      return {
        ok: true,
        loggedIn: false,
        botName: this.botDisplayName(),
        hint: `请先在游戏内输入：/msg ${this.botDisplayName()} 设置密码 你的密码`
      }
    }
    const user = this.decorateUser(session.user)
    const autoRegistrationMessage = this.tryAutoRegisterOnWebLogin(user)
    const subscriptionData = this.subscriptions ? this.subscriptions.mySubscriptionData(user) : null
    return {
      ok: true,
      loggedIn: true,
      user,
      botName: this.botDisplayName(),
      owners: this.db.listWebOwnersForUser(user),
      defaultOwnerUuid: this.db.getEffectiveDefaultOwnerUuid(user.uuid),
      active: this.activeSnapshot(),
      wallet: subscriptionData?.wallet || null,
      subscriptions: subscriptionData,
      autoRegistrationMessage
    }
  }

  requireSubscriptions () {
    if (!this.subscriptions) throw new Error('订阅服务尚未启用。')
    return this.subscriptions
  }

  quotaEntitlement (ownerUuid) {
    if (this.subscriptions) return this.subscriptions.getOwnerEntitlement(ownerUuid)
    const isCustom = ownerUuid.startsWith('vault:')
    const defaultSlots = isCustom
      ? (this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270)
      : (this.config.storage?.defaultQuotaSlots || 270)
    return { quotaSlots: this.db.getQuotaSlots(ownerUuid, defaultSlots), quotaMode: this.db.getQuotaOverride?.(ownerUuid) ? 'custom' : 'plan' }
  }

  apiSubscriptions (session) {
    const user = this.requireUser(session)
    const data = this.requireSubscriptions().mySubscriptionData(user)
    const bots = this.botManagerProvider?.()?.list?.() || []
    return {
      ok: true,
      ...data,
      onlineBots: bots.filter(row => row.status === 'online').map(row => row.minecraftName || row.botName).filter(Boolean)
    }
  }

  apiSubscriptionPurchase (session, body) {
    const user = this.requireUser(session)
    const result = this.requireSubscriptions().purchase(user, String(body.ownerUuid || '').trim(), String(body.planId || '').trim())
    return {
      ok: true,
      ...result,
      message: `订阅成功，已扣除 ${result.plan.price} TSLC，到期时间 ${this.formatTimestampMs(result.newExpiresAtMs)}。`
    }
  }

  apiSubscriptionOrganizationCreate (session, body) {
    const user = this.requireUser(session)
    const warehouse = this.requireSubscriptions().createOrganization(user, body.name)
    return { ok: true, warehouse, message: `已创建组织仓库 ${warehouse.name}，当前未订阅，额度为 0 格。` }
  }

  tryAutoRegisterOnWebLogin (user) {
    if (!this.subscriptions || this.db.hasPersonalWarehouse(user.uuid)) return ''
    try {
      const result = this.subscriptions.maybeAutoRegister(user, 'web_login')
      return result.changed ? '已自动创建个人仓库。' : ''
    } catch (error) {
      return error.message
    }
  }

  botPlatformUrl () {
    return String(this.config.web?.botPlatformUrl || 'http://127.0.0.1:8788').replace(/\/+$/, '')
  }

  botPlatformHealthUrl () {
    return String(this.config.web?.botPlatformHealthUrl || this.botPlatformUrl()).replace(/\/+$/, '')
  }

  botPlatformSsoSecret () {
    const file = path.resolve(process.cwd(), this.config.web?.botPlatformSsoSecretFile || 'data/bot-platform-sso.key')
    return fs.readFileSync(file, 'utf8').trim()
  }

  botPlatformAvailable () {
    return new Promise(resolve => {
      let target
      try { target = new URL('/api/health', `${this.botPlatformHealthUrl()}/`) } catch { return resolve(false) }
      const client = target.protocol === 'https:' ? https : http
      const request = client.get(target, { headers: { accept: 'application/json' } }, response => {
        response.resume()
        resolve(response.statusCode === 200)
      })
      request.setTimeout(800, () => { request.destroy(); resolve(false) })
      request.on('error', () => resolve(false))
    })
  }

  async openBotPlatform (res, session) {
    const user = this.requireUser(session)
    if (!await this.botPlatformAvailable()) return this.sendText(res, 404, 'Bot 自托管平台未启动。')
    const token = signCloudStoreToken(user, this.botPlatformSsoSecret())
    const target = new URL('/auth/cloud-store', `${this.botPlatformUrl()}/`)
    target.searchParams.set('token', token)
    res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' })
    res.end()
  }

  apiInventory (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || user.uuid
    this.requireOwnerAccess(user, ownerUuid)
    const startedAt = Date.now()
    const entitlement = this.quotaEntitlement(ownerUuid)
    const quotaSlots = entitlement.quotaSlots
    const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
    const result = {
      ok: true,
      ...this.db.getWebInventory(ownerUuid, user.uuid),
      quota: { ...entitlement, usedSlots, quotaSlots, usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0 },
      active: this.activeSnapshot()
    }
    const elapsed = Date.now() - startedAt
    if (this.config.debug && elapsed > 100) {
      console.warn(`[web] slow inventory ${ownerUuid}: ${elapsed}ms, ${result.items?.length || 0} rows`)
    }
    return result
  }

  apiTransactions (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || this.db.getEffectiveDefaultOwnerUuid(user.uuid)
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1)
    const pageSize = this.clampLimit(url.searchParams.get('pageSize'), 30, 100)
    if (!ownerUuid) return { ok: true, ownerUuid: '', ownerLabel: '', page: 1, pageSize, total: 0, totalPages: 1, rows: [] }
    this.requireOwnerAccess(user, ownerUuid)
    const typeQ = String(url.searchParams.get('type') || '').trim().toLowerCase()
    const operatorQ = String(url.searchParams.get('operator') || '').trim().toLowerCase()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const statusQ = String(url.searchParams.get('status') || '').trim().toLowerCase()
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const dateFrom = String(url.searchParams.get('dateFrom') || '').trim()
    const dateTo = String(url.searchParams.get('dateTo') || '').trim()
    const rows = this.db.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, bot_id AS botId, bot_name AS botName,
             created_at AS createdAt
      FROM transactions WHERE player_uuid = ? ORDER BY id DESC LIMIT 10000
    `).all(ownerUuid)
    const transactionItems = this.prepareTransactionItems(rows)
    const result = []
    for (const row of rows) {
      const details = this.transactionDetails(row.message)
      const operator = this.transactionOperator(row, details)
      const botOperator = row.botName || row.botId || ''
      const items = this.decorateTransactionItems(transactionItems.itemsById.get(row.id) || [], transactionItems.contentsByBox)
      const createdAtLabel = this.formatBeijingTime(row.createdAt)
      const createdDate = createdAtLabel.slice(0, 10)
      if (typeQ && !this.textMatches(row.type, typeQ) && !this.textMatches(this.transactionTypeLabel(row.type), typeQ)) continue
      if (operatorQ && !this.textMatches(operator, operatorQ)) continue
      if (statusQ && row.status.toLowerCase() !== statusQ) continue
      if (dateFrom && createdDate < dateFrom) continue
      if (dateTo && createdDate > dateTo) continue
      if (itemQ && !items.some(item => this.adminTransactionItemMatches(item, itemQ))) continue
      if (q && !this.textMatches(row.message, q) && !this.textMatches(operator, q) && !this.textMatches(botOperator, q) && !items.some(item => this.adminTransactionItemMatches(item, q))) continue
      result.push({
        ...row,
        typeLabel: this.transactionTypeLabel(row.type),
        statusLabel: this.transactionStatusLabel(row.status),
        ownerLabel: this.db.ownerLabel(row.playerUuid),
        operator,
        botOperator,
        details,
        messageLabel: this.transactionMessageLabel(row.message),
        createdAtLabel,
        items
      })
    }
    const total = result.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(page, totalPages)
    return { ok: true, ownerUuid, ownerLabel: this.db.ownerLabel(ownerUuid), page: currentPage, pageSize, total, totalPages, rows: result.slice((currentPage - 1) * pageSize, currentPage * pageSize) }
  }

  apiMyOrganizations (session) {
    const user = this.requireUser(session)
    const rows = this.db.listCustomWarehousesForPlayer(user.uuid).map(warehouse => {
      const ownerUuid = `vault:${warehouse.nameLower}`
      const entitlement = this.quotaEntitlement(ownerUuid)
      const quotaSlots = entitlement.quotaSlots
      const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
      return {
        ...warehouse,
        ownerUuid,
        quickShulkerExtractionEnabled: this.db.isQuickShulkerExtractionEnabled(ownerUuid),
        isAdmin: warehouse.role === 'admin',
        usedSlots,
        ...entitlement,
        quotaSlots,
        usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0,
        members: this.db.listCustomWarehouseMembers(warehouse.name)
      }
    })
    return { ok: true, rows }
  }

  apiWarehouseAdminOrganizations (session) {
    const user = this.requireUser(session)
    const warehouses = this.db.listCustomWarehousesForPlayer(user.uuid).filter(warehouse => warehouse.role === 'admin')
    if (!warehouses.length) {
      const error = new Error('你不是任何组织仓库的仓库管理员。')
      error.status = 403
      throw error
    }
    const rows = warehouses.map(warehouse => {
      const ownerUuid = `vault:${warehouse.nameLower}`
      const entitlement = this.quotaEntitlement(ownerUuid)
      const quotaSlots = entitlement.quotaSlots
      const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
      return {
        ...warehouse,
        ownerUuid,
        quickShulkerExtractionEnabled: this.db.isQuickShulkerExtractionEnabled(ownerUuid),
        usedSlots,
        ...entitlement,
        quotaSlots,
        usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0,
        members: this.db.listCustomWarehouseMembers(warehouse.name)
      }
    })
    return { ok: true, rows }
  }

  requireWarehouseAdmin (session, name) {
    const user = this.requireUser(session)
    const warehouse = this.db.getCustomWarehouse(name)
    if (!warehouse) throw new Error(`找不到仓库：${name}`)
    if (!this.db.isCustomWarehouseAdmin(warehouse.name, user.uuid)) {
      const error = new Error('只有这个组织仓库的仓库管理员可以执行该操作。')
      error.status = 403
      throw error
    }
    return warehouse
  }

  apiMyAliases (session, url) {
    const user = this.requireUser(session)
    const q = String(url.searchParams.get('q') || '').trim()
    const personalRows = this.db.listPlayerItemAliases(user.uuid, '')
    const personalByItem = new Map()
    for (const row of personalRows) {
      if (!personalByItem.has(row.itemKey)) personalByItem.set(row.itemKey, { ...this.adminItem(row), aliases: [] })
      personalByItem.get(row.itemKey).aliases.push(row.alias)
    }
    const globalRows = this.db.listGlobalItemAliasesForPlayer(user.uuid, '')
    const matchingGlobalKeys = new Set(globalRows.filter(row => !q || this.adminItemMatches(this.adminItem(row), q) || this.textMatches(row.alias, q)).map(row => row.itemKey))
    return {
      ok: true,
      personal: [...personalByItem.values()].filter(row => !q || this.adminItemMatches(row, q) || row.aliases.some(alias => this.textMatches(alias, q))),
      global: globalRows.filter(row => !q || matchingGlobalKeys.has(row.itemKey)).map(row => ({ ...this.adminItem(row), alias: row.alias, category: row.category, enabled: row.enabled }))
    }
  }

  resolveKnownPlayer (value) {
    const raw = String(value || '').trim()
    if (!raw) throw new Error('请填写玩家 ID。')
    const service = this.serviceProvider()
    const onlineName = service?.bot?.players ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase()) : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return { uuid: this.db.canonicalPlayerUuid(online.uuid), username: onlineName }
    }
    const player = this.db.getPlayerByUsername(raw)
    if (!player?.uuid || player.uuid.startsWith('name:')) throw new Error(`找不到玩家：${raw}。玩家需要在线或曾经使用过云仓库。`)
    return player
  }

  apiWarehouseAdminMemberAdd (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const player = this.resolveKnownPlayer(body.username)
    this.db.addCustomWarehouseMember(warehouse.name, player.uuid, player.username)
    return { ok: true, message: `已把 ${player.username} 添加到仓库 ${warehouse.name}。` }
  }

  apiWarehouseAdminMemberRemove (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const playerUuid = String(body.playerUuid || '').trim()
    if (!playerUuid) throw new Error('缺少成员。')
    if (playerUuid === warehouse.creatorUuid) throw new Error('不能删除仓库创建者。')
    if (this.db.isCustomWarehouseAdmin(warehouse.name, playerUuid)) throw new Error('请先取消该成员的管理员身份。')
    const changed = this.db.removeCustomWarehouseMember(warehouse.name, playerUuid)
    return { ok: true, message: changed ? '已删除仓库成员。' : '该玩家不是普通成员。' }
  }

  apiWarehouseAdminMemberRole (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const playerUuid = String(body.playerUuid || '').trim()
    const role = String(body.role || '').trim()
    if (!['admin', 'member'].includes(role)) throw new Error('成员角色无效。')
    if (playerUuid === warehouse.creatorUuid && role !== 'admin') throw new Error('不能取消仓库创建者的管理员身份。')
    const member = this.db.listCustomWarehouseMembers(warehouse.name).find(row => row.playerUuid === playerUuid)
    if (!member) throw new Error('找不到该仓库成员。')
    this.db.setCustomWarehouseMemberRole(warehouse.name, member.playerUuid, member.username, role)
    return { ok: true, message: `已把 ${member.username} 设置为${role === 'admin' ? '仓库管理员' : '普通成员'}。` }
  }

  apiWarehouseAdminRename (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const newName = String(body.newName || '').trim()
    if (!newName) throw new Error('新仓库名不能为空。')
    if (/\s/.test(newName)) throw new Error('仓库名不能包含空格。')
    if ([...newName].length > 15) throw new Error('仓库名最多 15 个字。')
    const renamed = this.db.renameCustomWarehouse(warehouse.name, newName)
    return { ok: true, message: `仓库已改名为 ${renamed.name}。`, warehouse: renamed }
  }

  apiOnlinePlayers (session, url) {
    const user = this.requireUser(session)
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const service = this.serviceProvider()
    const bot = service?.bot
    if (!bot) return { ok: true, rows: [] }

    const rows = Object.entries(bot.players || {})
      .map(([name, player]) => ({
        username: player.username || name,
        uuid: player.uuid || '',
        ping: Number.isFinite(player.ping) ? player.ping : null,
        self: this.isSameUsername(player.username || name, bot.username)
      }))
      .filter(player => player.username && !player.self)
      .filter(player => !query || player.username.toLowerCase().includes(query))
      .sort((a, b) => a.username.localeCompare(b.username, 'zh-CN', { sensitivity: 'base' }))

    const ownName = String(user.username || '').trim()
    if (ownName && (!query || ownName.toLowerCase().includes(query)) && !rows.some(row => this.isSameUsername(row.username, ownName))) {
      rows.unshift({ username: ownName, uuid: user.uuid || '', ping: null, self: false, currentUser: true })
    }

    return { ok: true, rows }
  }

  apiDeposit (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid)
    this.requireOwnerAccess(user, ownerUuid)
    const service = this.requireService()
    const message = service.startWebDeposit(user, ownerUuid)
    return { ok: true, message, active: this.activeSnapshot() }
  }

  apiWithdraw (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid)
    this.requireOwnerAccess(user, ownerUuid)
    const service = this.requireService()
    const message = Array.isArray(body.items)
      ? service.startWebWithdrawMany(user, ownerUuid, body.items, body.targetUsername)
      : service.startWebWithdraw(user, ownerUuid, body.item, body.amount, body.targetUsername)
    return { ok: true, message, active: this.activeSnapshot() }
  }

  apiWithdrawPlan (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid).trim()
    this.requireOwnerAccess(user, ownerUuid)
    const items = body.items
    if (!Array.isArray(items) || !items.length) throw new Error('请先选择要取出的物品。')
    const targetUsername = String(body.targetUsername || user.username || '').trim()
    if (targetUsername && !/^[A-Za-z0-9_]{3,16}$/.test(targetUsername)) throw new Error('目标玩家 ID 格式不正确。')
    const service = this.requireService()
    const plan = service.previewWithdrawShortage(user, ownerUuid, items)
    return { ok: true, ...plan, active: this.activeSnapshot() }
  }

  apiDefaultOwner (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid).trim()
    this.requireOwnerAccess(user, ownerUuid)
    if (!this.db.isPlayerOwnerAccessible(user.uuid, ownerUuid)) {
      throw new Error('默认仓库只能设置为自己的个人仓库或已加入的组织仓库。')
    }
    if (ownerUuid === this.db.momoOwner || ownerUuid.startsWith('name:')) {
      throw new Error('这个归属不能设为默认仓库。')
    }
    this.db.setPlayerDefaultOwnerUuid(user.uuid, ownerUuid)
    const owners = this.db.listWebOwnersForUser(user)
    return {
      ok: true,
      message: `已设置默认仓库：${this.db.ownerLabel(ownerUuid)}`,
      defaultOwnerUuid: this.db.getEffectiveDefaultOwnerUuid(user.uuid),
      owners
    }
  }

  async apiLitematicPlan (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid)
    this.requireOwnerAccess(user, ownerUuid)

    const fileName = String(body.fileName || 'uploaded.litematic').trim()
    const dataBase64 = String(body.dataBase64 || '').replace(/^data:.*?;base64,/, '')
    if (!dataBase64) throw new Error('请先选择投影文件。')
    if (!/\.litematic$/i.test(fileName)) throw new Error('只支持 .litematic 投影文件。')

    const buffer = Buffer.from(dataBase64, 'base64')
    if (!buffer.length) throw new Error('投影文件为空。')
    if (buffer.length > 8 * 1024 * 1024) throw new Error('投影文件过大，请控制在 8MB 以内。')

    const materials = await parseLitematicData(buffer, {
      filePath: fileName,
      version: this.config.server?.version || '1.21.1',
      languageFile: path.resolve(process.cwd(), this.config.language?.file || 'data/zh_cn.json'),
      maxSlots: Number.MAX_SAFE_INTEGER
    })
    // 散装视图（不显示潜影盒）下允许用盒内物品补足；仓库关闭快捷潜影盒取货时保持只取散装。
    const includeBoxed = body.includeBoxed === true &&
      (!this.db.isQuickShulkerExtractionEnabled || this.db.isQuickShulkerExtractionEnabled(ownerUuid))
    const service = this.requireService()
    let eligibleOwnerUuids = [ownerUuid]
    try {
      const owner = service.resolveWebStorageOwner(user, ownerUuid)
      eligibleOwnerUuids = service.withdrawSourceOwners(user, owner).map(source => source.uuid)
    } catch {
      // Keep explicit-owner planning available for lightweight service fixtures
      // and custom integrations that do not expose the default-owner helpers.
    }
    return {
      ok: true,
      ...this.buildLitematicWithdrawPlan(ownerUuid, materials, user.uuid, { includeBoxed, eligibleOwnerUuids })
    }
  }

  buildLitematicWithdrawPlan (ownerUuid, parsed, viewerUuid = '', options = {}) {
    const includeBoxed = options.includeBoxed === true
    const selected = []
    const missing = []
    const unavailable = parsed.unavailable || []
    const requests = []
    const allocations = []
    let usedSlots = 0
    let boxedSelectedAmount = 0
    const findSelected = itemKey => selected.find(row => row.itemKey === itemKey)

    for (const [requestIndex, material] of (parsed.materials || []).entries()) {
      const wanted = Number(material.amount || 0)
      requests.push({
        itemId: material.itemId,
        displayName: material.displayName || material.itemId,
        amount: wanted,
        requestIndex
      })
      const rows = this.db.getOwnerItemsByItemId(ownerUuid, material.itemId)
      const shulkerRows = includeBoxed
        ? this.db.getOwnerShulkersContainingItemId(ownerUuid, material.itemId)
        : []
      const aliases = this.db.getPlayerItemNameOverrides(viewerUuid, [
        ...rows.map(row => row.itemKey),
        ...shulkerRows.map(row => row.containedItemKey)
      ].filter(Boolean))
      const stackSize = Number(material.stackSize || 64)
      const availableAmount = row => Math.max(0, Number(row.available ?? row.amount ?? 0))
      const looseAvailable = rows.reduce((sum, row) => sum + availableAmount(row), 0)
      const boxedByItemKey = new Map()
      let boxedAvailable = 0
      for (const row of shulkerRows) {
        const perBox = Number(row.containedAmount || 0)
        const boxes = Math.max(0, Number(row.available ?? row.shulkerAmount ?? row.amount ?? 0))
        if (!row.containedItemKey || perBox <= 0 || boxes <= 0) continue
        boxedAvailable += perBox * boxes
        boxedByItemKey.set(row.containedItemKey, (boxedByItemKey.get(row.containedItemKey) || 0) + perBox * boxes)
      }
      const available = looseAvailable + boxedAvailable
      const takeTotal = Math.min(wanted, available)

      if (takeTotal <= 0) {
        missing.push({ ...material, available: 0, selected: 0, missing: wanted, reason: 'unavailable' })
        continue
      }

      if (available < wanted) {
        missing.push({ ...material, available, selected: takeTotal, missing: wanted - available, reason: 'short' })
      }

      // 和游戏内 !取 一致：优先散装，不够时再从潜影盒内补足。
      let remaining = takeTotal
      for (const row of rows) {
        if (remaining <= 0) break
        const amount = Math.min(availableAmount(row), remaining)
        const slots = Math.ceil(amount / Math.max(1, stackSize))
        if (amount <= 0 || slots <= 0) continue
        const entry = findSelected(row.itemKey)
        if (entry) {
          entry.amount += amount
          entry.slots += slots
        } else {
          selected.push({
            itemKey: row.itemKey,
            itemId: row.itemId,
            displayName: aliases.get(row.itemKey) || row.displayName || material.displayName || row.itemId,
            amount,
            max: availableAmount(row),
            required: wanted,
            available,
            stackSize,
            slots,
            sourceItemId: material.itemId,
            sourceDisplayName: material.displayName || material.itemId
          })
        }
        allocations.push({
          requestIndex,
          itemId: material.itemId,
          itemKey: row.itemKey,
          ownerUuid,
          amount,
          displayName: material.displayName || row.displayName || material.itemId
        })
        usedSlots += slots
        remaining -= amount
      }

      for (const [itemKey, keyBoxedAvailable] of boxedByItemKey) {
        if (remaining <= 0) break
        const take = Math.min(remaining, keyBoxedAvailable)
        if (take <= 0) continue
        const row = shulkerRows.find(item => item.containedItemKey === itemKey)
        const slots = Math.ceil(take / Math.max(1, stackSize))
        const entry = findSelected(itemKey)
        if (entry) {
          entry.max += keyBoxedAvailable
          entry.amount += take
          entry.slots += slots
          entry.boxedAmount = Number(entry.boxedAmount || 0) + take
        } else {
          selected.push({
            itemKey,
            itemId: row?.containedItemId || material.itemId,
            displayName: aliases.get(itemKey) || row?.containedDisplayName || material.displayName || material.itemId,
            amount: take,
            max: keyBoxedAvailable,
            required: wanted,
            available,
            stackSize,
            slots,
            boxedAmount: take,
            sourceItemId: material.itemId,
            sourceDisplayName: material.displayName || material.itemId
          })
        }
        allocations.push({
          requestIndex,
          itemId: material.itemId,
          itemKey,
          ownerUuid,
          amount: take,
          displayName: material.displayName || row?.containedDisplayName || material.itemId,
          withdrawMode: 'shulker_extract'
        })
        usedSlots += slots
        boxedSelectedAmount += take
        remaining -= take
      }
    }

    const selectedAmount = selected.reduce((sum, row) => sum + row.amount, 0)
    const service = this.serviceProvider()
    let shortagePlan = null
    if (typeof service?.buildShortageCraftPlan === 'function') {
      try {
        shortagePlan = service.buildShortageCraftPlan(ownerUuid, requests, allocations, {
          eligibleOwnerUuids: options.eligibleOwnerUuids
        })
      } catch {
        shortagePlan = null
      }
    }
    const shortage = shortagePlan?.shortage || shortagePlan?.shortages || missing.map(row => ({
      itemId: row.itemId,
      displayName: row.displayName,
      requested: Number(row.required || row.amount || 0),
      allocated: Number(row.selected || row.available || 0),
      missing: Number(row.missing || 0),
      reason: row.reason || 'short'
    }))
    const craft = shortagePlan?.craft || []
    return {
      blueprint: {
        name: parsed.name,
        author: parsed.author,
        totalBlocks: parsed.totalBlocks,
        materialTypes: (parsed.materials || []).length,
        requiredSlots: parsed.requiredSlots,
        overBotInventory: parsed.overBotInventory
      },
      selected,
      missing,
      unavailable,
      shortage,
      craft,
      stats: {
        selectedTypes: selected.length,
        selectedAmount,
        usedSlots,
        maxSlots: null,
        missingTypes: missing.length,
        unavailableTypes: unavailable.length,
        boxedSelectedAmount,
        shortageTypes: shortage.length,
        craftTypes: craft.length
      }
    }
  }

  assertBotIdleForWebAction () {
    const active = this.activeSnapshot()
    if (!active) return
    const error = new Error(`机器人忙，玩家${active.username}使用中，请稍后再试。`)
    error.status = 409
    throw error
  }

  apiLogin (session, body, ip) {
    this.assertLoginAllowed(ip)
    const token = String(body.token || '').trim()
    if (!token) throw new Error('请填写登录密码。')
    const user = this.db.getWebUserByToken(token)
    if (!user) {
      this.recordLoginFailure(ip)
      const error = new Error(`登录密码错误。请在游戏内输入：/msg ${this.botDisplayName()} 设置密码 你的密码`)
      error.status = 401
      throw error
    }
    this.clearLoginFailure(ip)
    session.user = {
      uuid: user.uuid,
      username: user.username
    }
    session.loggedInAt = Date.now()
    this.persistWebSession(session)
    const autoRegistrationMessage = this.tryAutoRegisterOnWebLogin(session.user)
    return {
      ok: true,
      user: this.decorateUser(session.user),
      autoRegistrationMessage
    }
  }

  apiLoginChallengeCreate (session) {
    if (session.user) return { ok: true, loggedIn: true, user: this.decorateUser(session.user) }

    this.cancelLoginChallengeForSession(session, 'replaced')
    const ttlMs = Number.parseInt(this.config.web?.loginCodeTtlMs, 10) || 2 * 60 * 1000
    const code = this.generateLoginCode()
    const challenge = {
      id: crypto.randomBytes(12).toString('hex'),
      sid: session.sid,
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      consumedAt: 0,
      cancelledAt: 0,
      user: null
    }
    this.loginChallenges.set(challenge.id, challenge)
    session.loginChallengeId = challenge.id
    return {
      ok: true,
      id: challenge.id,
      code,
      command: `/msg ${this.botDisplayName()} 登录 ${code}`,
      expiresAt: challenge.expiresAt,
      ttlMs
    }
  }

  apiLoginChallengeStatus (session) {
    const challenge = this.currentLoginChallenge(session)
    if (!challenge) return { ok: true, status: 'none' }
    const status = this.loginChallengeStatus(challenge)
    if (status === 'approved') {
      session.user = { ...challenge.user }
      session.loggedInAt = Date.now()
      this.persistWebSession(session)
      this.loginChallenges.delete(challenge.id)
      session.loginChallengeId = null
      return { ok: true, status: 'approved', user: this.decorateUser(session.user), autoRegistrationMessage: this.tryAutoRegisterOnWebLogin(session.user) }
    }
    if (status !== 'pending') {
      this.loginChallenges.delete(challenge.id)
      session.loginChallengeId = null
    }
    return {
      ok: true,
      status,
      code: challenge.code,
      command: `/msg ${this.botDisplayName()} 登录 ${challenge.code}`,
      expiresAt: challenge.expiresAt,
      remainingMs: Math.max(0, challenge.expiresAt - Date.now())
    }
  }

  apiLoginChallengeCancel (session) {
    this.cancelLoginChallengeForSession(session, 'cancelled')
    return { ok: true }
  }

  generateLoginCode () {
    for (let i = 0; i < 20; i++) {
      const code = String(crypto.randomInt(100000, 1000000))
      if (![...this.loginChallenges.values()].some(challenge => challenge.code === code && this.loginChallengeStatus(challenge) === 'pending')) return code
    }
    return String(crypto.randomInt(100000, 1000000))
  }

  currentLoginChallenge (session) {
    const id = session.loginChallengeId
    if (!id) return null
    const challenge = this.loginChallenges.get(id)
    if (!challenge || challenge.sid !== session.sid) return null
    return challenge
  }

  loginChallengeStatus (challenge) {
    if (!challenge) return 'none'
    if (challenge.cancelledAt) return 'cancelled'
    if (challenge.consumedAt && challenge.user) return 'approved'
    if (challenge.expiresAt <= Date.now()) return 'expired'
    return 'pending'
  }

  cancelLoginChallengeForSession (session, reason = 'cancelled') {
    const challenge = this.currentLoginChallenge(session)
    if (challenge && this.loginChallengeStatus(challenge) === 'pending') {
      challenge.cancelledAt = Date.now()
      challenge.cancelReason = reason
    }
    session.loginChallengeId = null
  }

  approveLoginChallenge (username, code) {
    const text = String(code || '').trim()
    if (!/^\d{6}$/.test(text)) return { ok: false, reason: 'invalid_code' }
    const matches = [...this.loginChallenges.values()]
      .filter(challenge => challenge.code === text && this.loginChallengeStatus(challenge) === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
    const challenge = matches[0]
    if (!challenge) return { ok: false, reason: 'not_found' }

    const service = this.serviceProvider()
    const player = service?.resolvePlayer ? service.resolvePlayer(username) : this.db.getPlayerByUsername(username)
    if (!player?.uuid || player.uuid.startsWith('name:')) {
      return { ok: false, reason: 'unknown_player' }
    }

    challenge.user = {
      uuid: player.uuid,
      username: player.username || username
    }
    challenge.consumedAt = Date.now()
    return { ok: true, username: challenge.user.username }
  }

  assertLoginAllowed (ip) {
    const record = this.loginFailures.get(ip)
    if (!record?.blockedUntil) return
    if (record.blockedUntil <= Date.now()) {
      this.loginFailures.delete(ip)
      return
    }
    const seconds = Math.ceil((record.blockedUntil - Date.now()) / 1000)
    const error = new Error(`登录失败次数过多，请 ${seconds} 秒后再试。`)
    error.status = 429
    throw error
  }

  recordLoginFailure (ip) {
    const now = Date.now()
    const windowMs = this.config.web?.loginFailWindowMs || 10 * 60 * 1000
    const blockMs = this.config.web?.loginBlockMs || 10 * 60 * 1000
    const maxFailures = this.config.web?.maxLoginFailures || 5
    const record = this.loginFailures.get(ip) || { count: 0, firstFailedAt: now, blockedUntil: 0 }

    if (now - record.firstFailedAt > windowMs) {
      record.count = 0
      record.firstFailedAt = now
      record.blockedUntil = 0
    }

    record.count += 1
    if (record.count >= maxFailures) {
      record.blockedUntil = now + blockMs
      console.warn(`[web] blocked login attempts from ${ip}: ${record.count} failures, ${Math.ceil(blockMs / 1000)}s`)
    }
    this.loginFailures.set(ip, record)
  }

  clearLoginFailure (ip) {
    this.loginFailures.delete(ip)
  }

  apiLogout (res, session) {
    this.deletePersistedWebSession(session)
    session.user = null
    this.cancelLoginChallengeForSession(session, 'logout')
    res.setHeader('Set-Cookie', 'cs_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
    this.sendJson(res, { ok: true })
  }

  requireUser (session) {
    if (!session.user) {
      const error = new Error('请先登录。')
      error.status = 401
      throw error
    }
    return this.decorateUser(session.user)
  }

  decorateUser (user) {
    return {
      uuid: user.uuid,
      username: user.username,
      isAdmin: this.db.isAdmin(user.username, user.uuid),
      isWarehouseAdmin: this.db.listCustomWarehousesForPlayer(user.uuid).some(warehouse => warehouse.role === 'admin')
    }
  }

  isSameUsername (a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase()
  }

  requireOwnerAccess (user, ownerUuid) {
    if (!this.db.canWebUserAccessOwner(user, ownerUuid)) {
      const error = new Error('你没有权限查看或操作这个仓库。')
      error.status = 403
      throw error
    }
  }

  requireAdmin (session) {
    const user = this.requireUser(session)
    if (!user.isAdmin) {
      const error = new Error('只有管理员可以打开管理界面。')
      error.status = 403
      throw error
    }
    return user
  }

  requireAdminQuiet (session) {
    try {
      this.requireAdmin(session)
      return true
    } catch {
      return false
    }
  }

  requireService () {
    const service = this.serviceProvider()
    if (!service) throw new Error('机器人还没有进入服务器，请稍后再试。')
    return service
  }

  apiAdminOwners (session) {
    this.requireAdmin(session)
    const owners = new Map()
    const addOwner = ownerUuid => {
      if (!ownerUuid || owners.has(ownerUuid)) return
      owners.set(ownerUuid, {
        ownerUuid,
        label: this.db.ownerLabel(ownerUuid),
        totalAmount: this.db.ownerTotalAmount(ownerUuid)
      })
    }

    for (const row of this.db.db.prepare('SELECT DISTINCT owner_uuid AS ownerUuid FROM balances ORDER BY owner_uuid').all()) addOwner(row.ownerUuid)
    for (const row of this.db.listPersonalWarehouses()) addOwner(row.ownerUuid)
    for (const row of this.db.db.prepare('SELECT name_lower AS nameLower FROM custom_warehouses ORDER BY name COLLATE NOCASE ASC').all()) addOwner(`vault:${row.nameLower}`)
    addOwner(this.config.momoOwner)

    return { ok: true, rows: [...owners.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')) }
  }

  apiAdminBots (session) {
    this.requireAdmin(session)
    const manager = this.requireBotManager()
    return { ok: true, rows: manager.list(), auth: 'microsoft_oauth2_device_code' }
  }

  apiAdminUsers (session) {
    this.requireAdmin(session)
    const configAdmins = new Set((this.config.admins || []).map(name => String(name || '').toLowerCase()))
    return {
      ok: true,
      rows: this.db.listAdmins().map(row => ({
        ...row,
        createdAtLabel: this.formatBeijingTime(row.createdAt),
        fromConfig: configAdmins.has(String(row.username || '').toLowerCase())
      }))
    }
  }

  apiAdminSubscriptionUsers (session, url) {
    this.requireAdmin(session)
    return { ok: true, rows: this.requireSubscriptions().listAdminUsers(url.searchParams.get('q') || '') }
  }

  apiAdminSubscriptionUser (session, url) {
    this.requireAdmin(session)
    return { ok: true, ...this.requireSubscriptions().adminUserDetail(String(url.searchParams.get('uuid') || '').trim()) }
  }

  apiAdminSubscriptionConfig (session) {
    this.requireAdmin(session)
    const subscriptions = this.requireSubscriptions()
    return {
      ok: true,
      settings: subscriptions.getSettings(),
      plans: subscriptions.listPlans(),
      time: subscriptions.networkTime.status(),
      identityConflicts: subscriptions.listIdentityConflicts(),
      playerIdentityConflicts: this.db.listPlayerIdentityConflicts()
    }
  }

  apiAdminIdentityMerge (session, body) {
    const admin = this.requireAdmin(session)
    const primaryUuid = String(body.primaryUuid || '').trim()
    const secondaryUuid = String(body.secondaryUuid || '').trim()
    if (!primaryUuid || !secondaryUuid) throw new Error('请选择要合并的两个 UUID（保留号 + 合并号）。')
    const result = this.db.mergePlayerIdentities(primaryUuid, secondaryUuid, admin.username)
    return {
      ok: true,
      message: `已把 ${result.username} 的 ${result.secondary} 合并进主号 ${result.primary}：并入 ${result.mergedTypes} 种、共 ${result.mergedAmount} 个物品。`,
      result
    }
  }

  apiAdminSubscriptionLogs (session, url) {
    this.requireAdmin(session)
    return { ok: true, rows: this.requireSubscriptions().listUnrecognizedPaymentLogs(url.searchParams.get('limit')) }
  }

  // 终端实时日志（环形缓冲，默认 5000 条滚动）。afterSeq 增量轮询。
  apiAdminConsoleLogs (session, url) {
    this.requireAdmin(session)
    const afterSeq = Number.parseInt(url.searchParams.get('afterSeq'), 10)
    const limit = Number.parseInt(url.searchParams.get('limit'), 10)
    const snapshot = snapshotConsoleLogs({
      afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
      limit: Number.isFinite(limit) ? limit : undefined
    })
    return {
      ok: true,
      ...snapshot,
      rows: snapshot.rows.map(row => ({
        ...row,
        tsLabel: this.formatTimestampMs(row.ts)
      }))
    }
  }

  logsDirectory () {
    return path.resolve(process.cwd(), this.config.traceLog?.directory || 'logs')
  }

  // logs 目录下的文件清单（含大小/修改时间），按修改时间倒序。
  apiAdminLogFiles (session) {
    this.requireAdmin(session)
    const directory = this.logsDirectory()
    const rows = []
    try {
      for (const name of fs.readdirSync(directory)) {
        const filePath = path.join(directory, name)
        let stat
        try {
          stat = fs.statSync(filePath)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        rows.push({
          name,
          sizeBytes: stat.size,
          sizeLabel: this.formatFileSize(stat.size),
          modifiedAtMs: stat.mtimeMs,
          modifiedAtLabel: this.formatTimestampMs(stat.mtimeMs)
        })
      }
    } catch {
      // 目录不存在或不可读时返回空清单
    }
    rows.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    return { ok: true, directory, rows }
  }

  formatFileSize (bytes) {
    const size = Number(bytes) || 0
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  // 只允许读取 logs 目录内的常规文件；名字里不允许路径分隔符。
  resolveLogFile (name) {
    const fileName = String(name || '').trim()
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
      throw new Error('无效的日志文件名。')
    }
    const directory = this.logsDirectory()
    const filePath = path.join(directory, fileName)
    const resolved = path.resolve(filePath)
    if (resolved !== path.resolve(directory) && !resolved.startsWith(path.resolve(directory) + path.sep)) {
      throw new Error('只允许读取 logs 目录内的文件。')
    }
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      throw new Error(`日志文件不存在：${fileName}`)
    }
    if (!stat.isFile()) throw new Error('这不是一个常规文件。')
    return { filePath: resolved, stat }
  }

  // 查看单个日志文件内容：默认读末尾 256 KB（可调 maxBytes），带 size/offset 元数据。
  apiAdminLogFile (session, url) {
    this.requireAdmin(session)
    const name = String(url.searchParams.get('name') || '').trim()
    if (!name) throw new Error('请提供日志文件名。')
    const { filePath, stat } = this.resolveLogFile(name)
    const maxBytesDefault = 256 * 1024
    const maxBytesParam = Number.parseInt(url.searchParams.get('maxBytes'), 10)
    const maxBytes = Number.isFinite(maxBytesParam) && maxBytesParam > 0 ? Math.min(maxBytesParam, 4 * 1024 * 1024) : maxBytesDefault
    const sizeBytes = stat.size
    const start = Math.max(0, sizeBytes - maxBytes)
    const truncated = start > 0
    let text = ''
    if (sizeBytes > 0) {
      const fd = fs.openSync(filePath, 'r')
      try {
        const length = sizeBytes - start
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, start)
        text = buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      if (truncated) {
        // 从文件中部截断时丢掉第一个不完整的行
        const firstNewline = text.indexOf('\n')
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text
      }
    }
    return {
      ok: true,
      name,
      sizeBytes,
      sizeLabel: this.formatFileSize(sizeBytes),
      modifiedAtMs: stat.mtimeMs,
      modifiedAtLabel: this.formatTimestampMs(stat.mtimeMs),
      truncated,
      startByte: start,
      text
    }
  }


  apiAdminSubscriptionPayments (session, url) {
    this.requireAdmin(session)
    return {
      ok: true,
      ...this.requireSubscriptions().listPaymentRecords({
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize')
      })
    }
  }

  apiAdminSubscriptionBalance (session, body) {
    const admin = this.requireAdmin(session)
    const playerUuid = String(body.playerUuid || '').trim()
    const player = this.db.db.prepare('SELECT uuid, username FROM players WHERE uuid = ?').get(playerUuid)
    if (!player) throw new Error('找不到玩家。')
    const operation = String(body.operation || '').trim()
    const cents = this.parseTsclCents(body.amount)
    const subscriptions = this.requireSubscriptions()
    const meta = { adminUuid: admin.uuid, adminUsername: admin.username, message: String(body.message || '') }
    let wallet
    if (operation === 'set') wallet = subscriptions.setBalance(player.uuid, player.username, cents, meta)
    else if (operation === 'add') wallet = subscriptions.adjustBalance(player.uuid, player.username, cents, { ...meta, type: 'admin_balance_add' })
    else if (operation === 'subtract') wallet = subscriptions.adjustBalance(player.uuid, player.username, -cents, { ...meta, type: 'admin_balance_subtract' })
    else throw new Error('余额操作无效。')
    return { ok: true, wallet, message: `已把 ${player.username} 的余额调整为 ${wallet.balance} TSLC。` }
  }

  apiAdminSubscriptionCancel (session, body) {
    const admin = this.requireAdmin(session)
    const ownerUuid = String(body.ownerUuid || '').trim()
    const entitlement = this.requireSubscriptions().cancelSubscription(ownerUuid, admin)
    return { ok: true, entitlement, message: `已取消 ${this.db.ownerLabel(ownerUuid)} 的付费订阅。` }
  }

  apiAdminSubscriptionConfigSave (session, body) {
    this.requireAdmin(session)
    const settings = this.requireSubscriptions().updateSettings(body)
    return { ok: true, settings, message: '订阅设置已热更新。' }
  }

  apiAdminSubscriptionPlanSave (session, body) {
    this.requireAdmin(session)
    const plan = this.requireSubscriptions().updatePlan(String(body.id || ''), body)
    return { ok: true, plan, message: `${plan.name} 已热更新，使用套餐额度的仓库已立即同步。` }
  }

  apiAdminSubscriptionRegexTest (session, body) {
    this.requireAdmin(session)
    const result = this.requireSubscriptions().testPaymentRegex(String(body.paymentRegex || ''), String(body.sample || ''))
    return { ok: true, ...result }
  }

  async apiAdminSubscriptionTimeSync (session) {
    this.requireAdmin(session)
    const time = await this.requireSubscriptions().networkTime.sync()
    return { ok: true, time, message: '网络时间同步成功。' }
  }

  parseTsclCents (value) {
    const text = String(value ?? '').trim()
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('TSLC 金额必须是非负数，最多两位小数。')
    const [whole, fraction = ''] = text.split('.')
    const cents = (Number.parseInt(whole, 10) * 100) + Number.parseInt(fraction.padEnd(2, '0') || '0', 10)
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('TSLC 金额无效。')
    return cents
  }

  apiAdminUserAdd (session, body) {
    const admin = this.requireAdmin(session)
    const player = this.resolveProvisionPlayer(body.username)
    this.db.addAdmin(player.username, player.uuid.startsWith('name:') ? null : player.uuid)
    this.db.addTransaction('web_admin_user_add', 'ok', this.config.momoOwner, admin.username, [], `admin=${admin.username}; target=${player.username}`)
    return { ok: true, message: `已添加系统管理员：${player.username}` }
  }

  apiAdminUserRemove (session, body) {
    const admin = this.requireAdmin(session)
    const username = String(body.username || '').trim()
    const uuid = String(body.uuid || '').trim()
    if (!username && !uuid) throw new Error('缺少要删除的管理员。')
    if (this.isSameUsername(username, admin.username) || (uuid && uuid === admin.uuid)) {
      throw new Error('不能删除当前登录的管理员。')
    }
    if (this.db.listAdmins().length <= 1) throw new Error('至少需要保留一个系统管理员。')
    const result = this.db.removeAdmin(username, uuid)
    if (result.changed) {
      this.db.addTransaction('web_admin_user_remove', 'ok', this.config.momoOwner, admin.username, [], `admin=${admin.username}; target=${result.admin.username}`)
    }
    return { ok: true, message: result.changed ? `已删除系统管理员：${result.admin.username}` : '没有找到这个系统管理员。' }
  }

  apiAdminBotAdd (session, body) {
    this.requireAdmin(session)
    const account = this.requireBotManager().add({
      username: body.username,
      botName: body.botName
    })
    return { ok: true, account, message: '账号已添加，正在请求微软 OAuth2 登录。' }
  }

  apiAdminBotEnabled (session, body) {
    this.requireAdmin(session)
    const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1'
    const account = this.requireBotManager().setEnabled(String(body.id || ''), enabled)
    return {
      ok: true,
      account,
      message: enabled ? '账号正在启动。' : '账号已停止领取新任务，当前任务完成后下线。'
    }
  }

  apiAdminBotDelete (session, body) {
    this.requireAdmin(session)
    const account = this.requireBotManager().remove(String(body.id || ''))
    return { ok: true, account, message: '账号已删除，当前任务完成后下线。' }
  }

  requireBotManager () {
    const manager = this.botManagerProvider?.()
    if (!manager) throw new Error('机器人账号管理器尚未启动。')
    return manager
  }

  resolveProvisionPlayer (value) {
    const raw = String(value || '').trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(raw)) throw new Error('玩家 ID 格式不正确。')
    const service = this.serviceProvider()
    const onlineName = service?.bot?.players ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase()) : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return { uuid: this.db.canonicalPlayerUuid(online.uuid), username: onlineName }
    }
    const known = this.db.getPlayerByUsername(raw)
    if (known?.uuid) return known
    const player = { uuid: `name:${raw}`, username: raw }
    this.db.upsertPlayer(player.uuid, player.username)
    return player
  }

  apiAdminWarehouseProvisioning (session) {
    this.requireAdmin(session)
    return {
      ok: true,
      personal: this.db.listPersonalWarehouses().map(row => ({ ...row, quickShulkerExtractionEnabled: this.db.isQuickShulkerExtractionEnabled(row.ownerUuid), usedSlots: this.adminOwnerUsedSlots(row.ownerUuid), totalAmount: this.db.ownerTotalAmount(row.ownerUuid) })),
      organizations: this.db.db.prepare(`
        SELECT name_lower AS nameLower, name, creator_uuid AS creatorUuid,
               creator_username AS creatorUsername, created_at AS createdAt,
               (SELECT COUNT(*) FROM custom_warehouse_members m WHERE m.warehouse_name_lower = w.name_lower) AS memberCount
        FROM custom_warehouses w ORDER BY name COLLATE NOCASE ASC
      `).all().map(row => {
        const ownerUuid = `vault:${row.nameLower}`
        return { ...row, ownerUuid, quickShulkerExtractionEnabled: this.db.isQuickShulkerExtractionEnabled(ownerUuid), usedSlots: this.adminOwnerUsedSlots(ownerUuid), totalAmount: this.db.ownerTotalAmount(ownerUuid) }
      })
    }
  }

  apiAdminOrganizationWarehouseDetail (session, url) {
    this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(url.searchParams.get('name') || '')
    if (!warehouse) throw new Error('找不到组织仓库。')
    const ownerUuid = `vault:${warehouse.nameLower}`
    const entitlement = this.quotaEntitlement(ownerUuid)
    const quotaSlots = entitlement.quotaSlots
    const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
    return {
      ok: true,
      warehouse: {
        ...warehouse,
        ownerUuid,
        quickShulkerExtractionEnabled: this.db.isQuickShulkerExtractionEnabled(ownerUuid),
        ...entitlement,
        totalAmount: this.db.ownerTotalAmount(ownerUuid),
        usedSlots,
        quotaSlots,
        usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0,
        members: this.db.listCustomWarehouseMembers(warehouse.name)
      }
    }
  }

  apiAdminCreatePersonalWarehouse (session, body) {
    const admin = this.requireAdmin(session)
    const player = this.resolveProvisionPlayer(body.username)
    const result = this.db.createPersonalWarehouse(player.uuid, player.username, admin)
    return { ok: true, message: result.changed ? `已为 ${player.username} 创建个人仓库。` : `${player.username} 已经有个人仓库。`, warehouse: result }
  }

  apiAdminCreateOrganizationWarehouse (session, body) {
    this.requireAdmin(session)
    const name = String(body.name || '').trim()
    if (!name) throw new Error('组织仓库名不能为空。')
    if (/\s/.test(name)) throw new Error('组织仓库名不能包含空格。')
    if ([...name].length > 15) throw new Error('组织仓库名最多 15 个字。')
    if (this.db.getCustomWarehouse(name)) throw new Error(`仓库名已存在：${name}`)
    const creator = this.resolveProvisionPlayer(body.creatorUsername)
    this.db.createCustomWarehouse(name, creator.uuid, creator.username)
    return { ok: true, message: `已创建组织仓库 ${name}，仓库管理员为 ${creator.username}。` }
  }

  apiAdminOrganizationMemberAdd (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    const player = this.resolveProvisionPlayer(body.username)
    const role = String(body.role || 'member').trim()
    if (!['admin', 'member'].includes(role)) throw new Error('成员角色无效。')
    this.db.setCustomWarehouseMemberRole(warehouse.name, player.uuid, player.username, role)
    this.db.addTransaction('web_admin_organization_member_add', 'ok', `vault:${warehouse.nameLower}`, `仓库:${warehouse.name}`, [], `admin=${admin.username}; member=${player.username}; role=${role}`)
    return { ok: true, message: `已添加 ${player.username}，身份为${role === 'admin' ? '仓库管理员' : '普通成员'}。` }
  }

  apiAdminOrganizationMemberRemove (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    const playerUuid = String(body.playerUuid || '').trim()
    const member = this.db.listCustomWarehouseMembers(warehouse.name).find(row => row.playerUuid === playerUuid)
    if (!member) throw new Error('找不到该仓库成员。')
    this.db.removeCustomWarehouseMemberAny(warehouse.name, playerUuid)
    this.db.db.prepare("UPDATE players SET default_owner_uuid = '' WHERE uuid = ? AND default_owner_uuid = ?").run(playerUuid, `vault:${warehouse.nameLower}`)
    this.db.addTransaction('web_admin_organization_member_remove', 'ok', `vault:${warehouse.nameLower}`, `仓库:${warehouse.name}`, [], `admin=${admin.username}; member=${member.username}; role=${member.role}`)
    return { ok: true, message: `已从 ${warehouse.name} 删除成员 ${member.username}。` }
  }

  apiAdminOrganizationMemberRole (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    const playerUuid = String(body.playerUuid || '').trim()
    const role = String(body.role || '').trim()
    if (!['admin', 'member'].includes(role)) throw new Error('成员角色无效。')
    const member = this.db.listCustomWarehouseMembers(warehouse.name).find(row => row.playerUuid === playerUuid)
    if (!member) throw new Error('找不到该仓库成员。')
    this.db.setCustomWarehouseMemberRole(warehouse.name, member.playerUuid, member.username, role)
    this.db.addTransaction('web_admin_organization_member_role', 'ok', `vault:${warehouse.nameLower}`, `仓库:${warehouse.name}`, [], `admin=${admin.username}; member=${member.username}; role=${role}`)
    return { ok: true, message: `已把 ${member.username} 设置为${role === 'admin' ? '仓库管理员' : '普通成员'}。` }
  }

  ensureWarehouseDeletionSafe (ownerUuid) {
    const service = this.serviceProvider()
    const activeTasks = service?.taskPool?.snapshot()?.active || (service?.active ? [service.active] : [])
    if (activeTasks.some(active => (active.owner?.uuid || active.player?.uuid || '') === ownerUuid)) {
      throw new Error('该仓库正在进行存取操作，暂时不能删除。')
    }
    if (this.db.listRecoveryTasks().some(recovery => recovery.ownerUuid === ownerUuid)) {
      throw new Error('该仓库存在未完成的恢复任务，暂时不能删除。')
    }
  }

  apiAdminDeletePersonalWarehouse (session, body) {
    const admin = this.requireAdmin(session)
    const ownerUuid = String(body.ownerUuid || '').trim()
    if (!ownerUuid || String(body.confirmOwnerUuid || '') !== ownerUuid) throw new Error('删除确认信息不正确。')
    this.ensureWarehouseDeletionSafe(ownerUuid)
    const result = this.db.deletePersonalWarehouseToMomo(ownerUuid, admin.username)
    return { ok: true, message: `已删除 ${result.ownerUsername} 的个人仓库，${result.itemTypes} 种、共 ${result.totalAmount} 件物品已转入 momo。` }
  }

  apiAdminDeleteOrganizationWarehouse (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    if (this.db.normalizeWarehouseName(body.confirmName) !== warehouse.nameLower) throw new Error('删除确认信息不正确。')
    const ownerUuid = `vault:${warehouse.nameLower}`
    this.ensureWarehouseDeletionSafe(ownerUuid)
    const result = this.db.deleteCustomWarehouseToMomo(warehouse.name, admin.username)
    return { ok: true, message: `已删除组织仓库 ${warehouse.name}，${result.itemTypes} 种、共 ${result.totalAmount} 件物品已转入 momo。` }
  }

  apiAdminInventory (session, url) {
    this.requireAdmin(session)
    const ownerRaw = String(url.searchParams.get('owner') || '').trim()
    const ownerQ = ownerRaw.toLowerCase()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const limit = this.clampLimit(url.searchParams.get('limit'), 500, 2000)
    const where = ['b.amount > 0']
    const params = []
    if (ownerQ) {
      const matchingOwners = this.db.db.prepare(`
        SELECT owner_uuid AS ownerUuid
        FROM balances
        WHERE amount > 0
        GROUP BY owner_uuid
        ORDER BY owner_uuid COLLATE NOCASE ASC
      `).all().filter(row => {
        const ownerLabel = this.db.ownerLabel(row.ownerUuid)
        return this.textMatches(ownerLabel, ownerQ) || this.textMatches(row.ownerUuid, ownerQ)
      }).map(row => row.ownerUuid)
      if (!matchingOwners.length) return { ok: true, stats: { owners: 0, itemTypes: 0, totalAmount: 0 }, rows: [] }
      where.push(`b.owner_uuid IN (${matchingOwners.map(() => '?').join(', ')})`)
      params.push(...matchingOwners)
    }
    const rows = this.db.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, i.item_key AS itemKey, i.item_id AS itemId,
             i.display_name AS displayName, i.nbt_json AS nbtJson,
             i.meta_json AS metaJson, b.amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE ${where.join(' AND ')}
      ORDER BY b.owner_uuid COLLATE NOCASE ASC, i.display_name COLLATE NOCASE ASC
      LIMIT ?
    `).all(...params, limit * 3)

    const result = []
    const owners = new Set()
    const itemKeys = new Set()
    let totalAmount = 0
    const allItemKeys = rows.map(row => row.itemKey)
    const aliases = this.db.getGlobalAliasesForItems(allItemKeys)
    const shulkerContents = this.db.getShulkerContentsByBox(rows.filter(row => row.itemId.endsWith('shulker_box')).map(row => row.itemKey))
    for (const row of rows) {
      const ownerLabel = this.db.ownerLabel(row.ownerUuid)
      const item = this.adminItem(row)
      const decorated = {
        ...item,
        ownerUuid: row.ownerUuid,
        ownerLabel,
        amount: Number(row.amount || 0),
        globalAliases: aliases.get(row.itemKey) || [],
        shulkerContents: shulkerContents.get(row.itemKey) || []
      }
      if (itemQ && !this.adminItemMatches(decorated, itemQ) && !decorated.globalAliases.some(alias => this.textMatches(alias, itemQ)) && !decorated.shulkerContents.some(content => this.adminItemMatches(content, itemQ))) continue
      result.push(decorated)
      owners.add(row.ownerUuid)
      itemKeys.add(row.itemKey)
      totalAmount += Number(row.amount || 0)
      if (result.length >= limit) break
    }

    return { ok: true, stats: { owners: owners.size, itemTypes: itemKeys.size, totalAmount }, rows: result }
  }

  apiAdminMismatches (session, url) {
    this.requireAdmin(session)
    const status = String(url.searchParams.get('status') || 'open').trim()
    const kind = String(url.searchParams.get('kind') || '').trim()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const ownerQ = String(url.searchParams.get('owner') || '').trim().toLowerCase()
    if (status && !['open', 'resolved'].includes(status)) throw new Error('异常状态必须是 open 或 resolved。')
    if (kind && !['extra', 'missing'].includes(kind)) throw new Error('异常类型必须是 extra 或 missing。')
    const where = []
    const params = []
    if (status) {
      where.push('status = ?')
      params.push(status)
    }
    if (kind) {
      where.push('kind = ?')
      params.push(kind)
    }
    const rows = this.db.db.prepare(`
      SELECT id, kind, status, owner_uuid AS ownerUuid, username,
             item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, amount, balance_adjusted AS balanceAdjusted, note,
             created_at AS createdAt, resolved_at AS resolvedAt
      FROM inventory_mismatches
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY status = 'open' DESC, id DESC
      LIMIT 1000
    `).all(...params)

    const result = []
    let extraAmount = 0
    let missingAmount = 0
    const shulkerContents = this.db.getShulkerContentsByBox(rows
      .filter(row => String(row.itemId || '').endsWith('shulker_box'))
      .map(row => row.itemKey))
    for (const row of rows) {
      const ownerLabel = row.ownerUuid ? this.db.ownerLabel(row.ownerUuid) : (row.username || '未知归属')
      const item = {
        ...this.adminItem(row),
        shulkerContents: (shulkerContents.get(row.itemKey) || []).map(content => ({
          ...this.adminItem(content),
          amount: Number(content.amount || 0),
          slotCount: Number(content.slotCount || 0)
        }))
      }
      if (ownerQ && !this.textMatches(ownerLabel, ownerQ) && !this.textMatches(row.username, ownerQ) && !this.textMatches(row.ownerUuid, ownerQ)) continue
      if (itemQ && !this.adminItemMatches(item, itemQ) && !item.shulkerContents.some(content => this.adminItemMatches(content, itemQ))) continue
      const amount = Number(row.amount || 0)
      if (row.kind === 'extra') extraAmount += amount
      if (row.kind === 'missing') missingAmount += amount
      result.push({ ...item, id: row.id, kind: row.kind, status: row.status, ownerUuid: row.ownerUuid, ownerLabel, username: row.username, amount, balanceAdjusted: row.balanceAdjusted, note: row.note, createdAt: row.createdAt, resolvedAt: row.resolvedAt })
    }

    return { ok: true, stats: { openRows: result.filter(row => row.status === 'open').length, extraAmount, missingAmount }, rows: result }
  }

  apiAdminTransactions (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const typeQ = String(url.searchParams.get('type') || '').trim().toLowerCase()
    const operatorQ = String(url.searchParams.get('operator') || '').trim().toLowerCase()
    const statusQ = String(url.searchParams.get('status') || '').trim().toLowerCase()
    const ownerQ = String(url.searchParams.get('owner') || '').trim().toLowerCase()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const dateFrom = String(url.searchParams.get('dateFrom') || '').trim()
    const dateTo = String(url.searchParams.get('dateTo') || '').trim()
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1)
    const pageSize = this.clampLimit(url.searchParams.get('pageSize'), 30, 100)
    const fetchLimit = 10000
    const rows = this.db.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, bot_id AS botId, bot_name AS botName,
             created_at AS createdAt
      FROM transactions
      ORDER BY id DESC
      LIMIT ?
    `).all(fetchLimit)
    const transactionItems = this.prepareTransactionItems(rows)

    const result = []
    for (const row of rows) {
      const ownerLabel = this.db.ownerLabel(row.playerUuid)
      const decoratedItems = this.decorateTransactionItems(transactionItems.itemsById.get(row.id) || [], transactionItems.contentsByBox)
      const details = this.transactionDetails(row.message)
      const operator = this.transactionOperator(row, details)
      const botOperator = row.botName || row.botId || ''
      const createdAtLabel = this.formatBeijingTime(row.createdAt)
      const createdDate = createdAtLabel.slice(0, 10)
      if (typeQ && !this.textMatches(row.type, typeQ) && !this.textMatches(this.transactionTypeLabel(row.type), typeQ)) continue
      if (operatorQ && !this.textMatches(operator, operatorQ)) continue
      if (statusQ && row.status.toLowerCase() !== statusQ) continue
      if (ownerQ && !this.textMatches(ownerLabel, ownerQ) && !this.textMatches(row.username, ownerQ) && !this.textMatches(row.playerUuid, ownerQ)) continue
      if (dateFrom && createdDate < dateFrom) continue
      if (dateTo && createdDate > dateTo) continue
      if (itemQ && !decoratedItems.some(item => this.adminTransactionItemMatches(item, itemQ))) continue
      if (q && !this.textMatches(ownerLabel, q) && !this.textMatches(operator, q) && !this.textMatches(botOperator, q) && !this.textMatches(row.username, q) && !this.textMatches(row.type, q) && !this.textMatches(row.message, q) && !decoratedItems.some(item => this.adminTransactionItemMatches(item, q))) continue
      result.push({
        id: row.id,
        type: row.type,
        typeLabel: this.transactionTypeLabel(row.type),
        status: row.status,
        statusLabel: this.transactionStatusLabel(row.status),
        playerUuid: row.playerUuid,
        username: row.username,
        ownerLabel,
        operator,
        botOperator,
        message: row.message,
        messageLabel: this.transactionMessageLabel(row.message),
        createdAt: row.createdAt,
        createdAtLabel,
        details,
        items: decoratedItems
      })
    }
    const total = result.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(page, totalPages)
    const offset = (currentPage - 1) * pageSize
    return { ok: true, page: currentPage, pageSize, total, totalPages, rows: result.slice(offset, offset + pageSize) }
  }

  apiAdminCommands (session, url) {
    this.requireAdmin(session)
    const result = this.db.listCommandLogs({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      query: url.searchParams.get('q'),
      channel: url.searchParams.get('channel')
    })
    return {
      ok: true,
      ...result,
      rows: result.rows.map(row => ({
        ...row,
        channelLabel: row.channel === 'public' ? '公屏' : '私信',
        createdAtLabel: this.formatBeijingTime(row.createdAt),
        replies: (row.replies || []).map(reply => ({
          ...reply,
          channelLabel: reply.channel === 'public' ? '公屏' : '私信',
          createdAtLabel: this.formatBeijingTime(reply.createdAt)
        }))
      }))
    }
  }

  // 木桶视图列表：支持按物品名/ID/短码搜索（命中显示该桶含此物品的格数与数量）、
  // 坐标过滤、排序，返回每桶槽位统计 + 是否含潜影盒。
  apiAdminChests (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim()
    const sort = String(url.searchParams.get('sort') || 'coords').trim()
    const rangeX = this.parseCoordFilter(url.searchParams.get('x'))
    const rangeY = this.parseCoordFilter(url.searchParams.get('y'))
    const rangeZ = this.parseCoordFilter(url.searchParams.get('z'))
    const rows = this.db.db.prepare(`
      SELECT c.chest_id AS chestId, c.x, c.y, c.z, c.block_name AS blockName,
             c.last_seen_at AS lastSeenAt,
             COUNT(cs.slot) AS slotCount,
             COALESCE(SUM(cs.amount), 0) AS totalAmount,
             COALESCE(SUM(CASE WHEN i.item_id LIKE '%shulker_box' THEN cs.amount ELSE 0 END), 0) AS shulkerAmount
      FROM chests c
      LEFT JOIN chest_slots cs ON cs.chest_id = c.chest_id
      LEFT JOIN items i ON i.item_key = cs.item_key
      GROUP BY c.chest_id
    `).all().map(row => ({ ...row, slotCount: Number(row.slotCount || 0), totalAmount: Number(row.totalAmount || 0), shulkerAmount: Number(row.shulkerAmount || 0) }))
      .filter(row => this.chestMatchesCoord(row, { x: rangeX, y: rangeY, z: rangeZ }))

    let result = rows
    let matches = null
    if (q) {
      // 搜索：物品名/ID/短码/全局别名/盒内物品名。先全局找命中的 itemKey 集合，再按桶聚合。
      const qLower = q.toLowerCase()
      const aliasRows = this.db.db.prepare(`
        SELECT DISTINCT item_key AS itemKey FROM global_item_aliases WHERE alias_lower LIKE ?
      `).all(`%${qLower}%`)
      const aliasKeySet = new Set(aliasRows.map(row => row.itemKey))
      const itemKeyRows = this.db.db.prepare(`
        SELECT i.item_key AS itemKey, i.item_id AS itemId
        FROM items i
        WHERE i.display_name LIKE ? OR i.item_id LIKE ? OR i.item_key LIKE ?
      `).all(`%${q}%`, `%${q}%`, `%${q}%`)
      const keySet = new Set(itemKeyRows.map(row => row.itemKey))
      for (const key of aliasKeySet) keySet.add(key)
      // 短码（itemKey 末 6 位）与盒内物品名：通过 shulker_contents 聚合表反查外层盒子
      const shulkerRows = this.db.db.prepare(`
        SELECT shulker_item_key AS boxKey, contained_item_key AS innerKey,
               contained_item_id AS innerId, amount
        FROM shulker_contents
      `).all()
      const boxKeyByInner = new Map()
      for (const row of shulkerRows) {
        const innerKeyTail = String(row.innerKey || '').split('|').pop() || ''
        const innerHit = keySet.has(row.innerKey)
          || String(row.innerId || '').toLowerCase().includes(qLower)
          || innerKeyTail.toLowerCase().includes(qLower)
        if (innerHit) {
          if (!boxKeyByInner.has(row.boxKey)) boxKeyByInner.set(row.boxKey, 0)
        }
      }
      const chestSlotRows = this.db.db.prepare(`
        SELECT chest_id AS chestId, item_key AS itemKey, amount FROM chest_slots
      `).all()
      const chestMatches = new Map()
      const chestAmounts = new Map()
      for (const slot of chestSlotRows) {
        const keyTail = String(slot.itemKey || '').split('|').pop() || ''
        const hit = keySet.has(slot.itemKey)
          || keyTail.toLowerCase().includes(qLower)
          || boxKeyByInner.has(slot.itemKey)
        if (!hit) continue
        chestMatches.set(slot.chestId, (chestMatches.get(slot.chestId) || 0) + 1)
        chestAmounts.set(slot.chestId, (chestAmounts.get(slot.chestId) || 0) + Number(slot.amount || 0))
      }
      result = rows.filter(row => chestMatches.has(row.chestId)
        || this.textMatches(row.chestId, q)
        || `${row.x},${row.y},${row.z}`.includes(q))
        .map(row => ({
          ...row,
          matchedSlots: chestMatches.get(row.chestId) || 0,
          matchedAmount: chestAmounts.get(row.chestId) || 0
        }))
      matches = { itemKeys: keySet.size, chests: result.length }
    }

    const sorters = {
      coords: (a, b) => a.y - b.y || a.x - b.x || a.z - b.z,
      amount: (a, b) => b.totalAmount - a.totalAmount || a.x - b.x,
      slots: (a, b) => b.slotCount - a.slotCount || a.x - b.x,
      matched: (a, b) => (b.matchedAmount || 0) - (a.matchedAmount || 0) || a.x - b.x,
      updated: (a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))
    }
    result.sort(sorters[sort] || sorters.coords)
    return {
      ok: true,
      rows: result,
      matches,
      total: rows.length,
      now: Date.now(),
      nowLabel: this.formatTimestampMs(Date.now())
    }
  }

  parseCoordFilter (value) {
    const text = String(value || '').trim()
    if (!text) return null
    // 支持单值 "120"、范围 "120..130"、开区间 "120.." / "..130"
    const match = text.match(/^(-?\d+)?\.\.(-?\d+)?$/)
    if (match) {
      const min = match[1] === undefined || match[1] === null ? -Infinity : Number(match[1])
      const max = match[2] === undefined || match[2] === null ? Infinity : Number(match[2])
      return { min, max }
    }
    if (/^-?\d+$/.test(text)) {
      const exact = Number(text)
      return { min: exact, max: exact }
    }
    throw new Error('坐标过滤格式：单值 120 或范围 120..130。')
  }

  chestMatchesCoord (row, { x, y, z }) {
    const check = (range, value) => !range || (value >= range.min && value <= range.max)
    return check(x, row.x) && check(y, row.y) && check(z, row.z)
  }

  // 单桶详情：槽位按 slot 排列，潜影盒展开盒内聚合内容，支持“立即重读”实时数据。
  apiAdminChest (session, url) {
    this.requireAdmin(session)
    const chestId = String(url.searchParams.get('chest') || '').trim()
    if (!chestId) throw new Error('缺少木桶 ID。')
    const chest = this.db.db.prepare(`
      SELECT chest_id AS chestId, x, y, z, block_name AS blockName, last_seen_at AS lastSeenAt
      FROM chests
      WHERE chest_id = ?
    `).get(chestId)
    if (!chest) throw new Error(`找不到木桶：${chestId}`)
    const rows = this.db.db.prepare(`
      SELECT cs.slot, cs.amount, i.item_key AS itemKey, i.item_id AS itemId,
             i.display_name AS displayName, i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM chest_slots cs
      JOIN items i ON i.item_key = cs.item_key
      WHERE cs.chest_id = ?
      ORDER BY cs.slot
    `).all(chestId)
    const catalog = this.db.catalog
    const items = rows.map(row => {
      const base = this.adminItem(row)
      const entry = { ...base, slot: Number(row.slot), amount: Number(row.amount || 0) }
      if (catalog?.isShulkerBox?.(row.itemId)) {
        entry.isShulker = true
        entry.shulkerContents = this.chestShulkerContents(base)
      }
      return entry
    })
    return {
      ok: true,
      chest,
      chestLabel: `${chest.x},${chest.y},${chest.z}`,
      items,
      types: items.length,
      total: items.reduce((sum, item) => sum + item.amount, 0),
      now: Date.now(),
      nowLabel: this.formatTimestampMs(Date.now())
    }
  }

  chestShulkerContents (item) {
    const catalog = this.db.catalog
    if (!catalog?.extractShulkerContents) return []
    try {
      return catalog.extractShulkerContents(item).map(entry => ({
        itemId: entry.item.itemId,
        itemKey: entry.item.itemKey,
        displayName: entry.item.displayName || entry.item.itemId,
        amount: entry.amount,
        slotCount: entry.slotCount,
        shortCode: this.db.shortCodeForItemKey(entry.item.itemKey)
      }))
    } catch {
      return []
    }
  }

  // 实时重读：让在线机器人用 !同步木桶 的同一条链路开桶刷新，结果直接回面板。
  async apiAdminChestLive (session, body) {
    const admin = this.requireAdmin(session)
    const chest = String(body.chest || '').trim()
    const [x, y, z] = chest.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('格式：x,y,z。可用列表里的坐标。')
    }
    const service = this.requireService()
    const detail = await service.resyncBarrelForAdmin({ x, y, z }, admin)
    return { ok: true, message: `已重读木桶 ${chest}。`, ...this.chestDetailFromLive(detail) }
  }

  chestDetailFromLive (detail) {
    const items = (detail.items || []).map(item => ({
      slot: item.slot,
      itemKey: item.itemKey,
      itemId: item.id,
      displayName: item.name,
      amount: item.amount,
      shortCode: item.keyTail,
      shulkerContents: Array.isArray(item.shulkerContents)
        ? item.shulkerContents.map(entry => ({
          itemId: entry.id,
          displayName: entry.name,
          amount: entry.n,
          slotCount: entry.slots,
          shortCode: entry.key
        }))
        : undefined,
      isShulker: Array.isArray(item.shulkerContents)
    }))
    return {
      chestLabel: detail.chest?.describe || `${detail.chest?.x},${detail.chest?.y},${detail.chest?.z}`,
      types: detail.types,
      total: detail.total,
      items
    }
  }


  apiAdminAliases (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim()
    const aliasRows = this.db.listGlobalItemAliases('')
    const aliases = new Map()
    const aliasEntries = new Map()
    for (const row of aliasRows) {
      if (!aliases.has(row.itemKey)) aliases.set(row.itemKey, [])
      aliases.get(row.itemKey).push(row.alias)
      if (!aliasEntries.has(row.itemKey)) aliasEntries.set(row.itemKey, [])
      aliasEntries.get(row.itemKey).push({ alias: row.alias, category: row.category || 'normal' })
    }
    const items = new Map()
    for (const row of aliasRows) {
      if (!items.has(row.itemKey)) items.set(row.itemKey, this.adminItem(row))
    }
    return {
      ok: true,
      rows: [...items.values()].map(row => ({ ...row, aliases: aliases.get(row.itemKey) || [], aliasEntries: aliasEntries.get(row.itemKey) || [] }))
        .filter(row => !q || this.adminItemMatches(row, q) || row.aliases.some(alias => this.textMatches(alias, q)))
    }
  }

  apiAdminQuotas (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const owners = this.apiAdminOwners(session).rows
    const rows = owners.map(owner => {
      const entitlement = this.quotaEntitlement(owner.ownerUuid)
      const quotaSlots = entitlement.quotaSlots
      const usedSlots = this.adminOwnerUsedSlots(owner.ownerUuid)
      return { ...owner, ...entitlement, usedSlots, quotaSlots, usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0 }
    }).filter(row => !q || this.textMatches(row.label, q) || this.textMatches(row.ownerUuid, q))
    const chestCount = Number(this.db.db.prepare('SELECT COUNT(*) AS count FROM chests').get().count || 0)
    const usedPhysicalSlots = Number(this.db.db.prepare('SELECT COUNT(*) AS count FROM chest_slots WHERE amount > 0').get().count || 0)
    const slotsPerChest = Number(this.config.warehouse?.containerSlots || 27)
    const totalPhysicalSlots = chestCount * slotsPerChest
    return {
      ok: true,
      overall: {
        chestCount,
        usedSlots: usedPhysicalSlots,
        totalSlots: totalPhysicalSlots,
        usagePercent: totalPhysicalSlots > 0 ? Math.round(usedPhysicalSlots / totalPhysicalSlots * 1000) / 10 : 0
      },
      rows
    }
  }

  apiAdminAdjust (session, body) {
    const user = this.requireAdmin(session)
    const ownerUuid = String(body.ownerUuid || '').trim()
    const itemKey = this.resolveAdminItemKey(body.itemKey || '')
    const action = String(body.action || '').trim()
    const amount = Number.parseInt(body.amount, 10)
    if (!ownerUuid || !itemKey) throw new Error('缺少归属或物品。')
    if (!['add', 'subtract', 'set'].includes(action)) throw new Error('动作必须是 add / subtract / set。')
    if (!Number.isInteger(amount) || amount < 0) throw new Error('数量必须是非负整数。')
    const item = this.db.getItemByKey(itemKey)
    if (!item) throw new Error('找不到物品。')
    const current = this.db.getBalance(ownerUuid, itemKey)
    const delta = action === 'add' ? amount : action === 'subtract' ? -Math.min(amount, current) : amount - current
    if (delta === 0) return { ok: true, message: '数量没有变化。' }

    const changed = [{ ...item, amount: Math.abs(delta) }]
    this.db.transaction(() => {
      this.db.adjustBalance(ownerUuid, itemKey, delta)
      this.db.addTransaction(`web_admin_${action}`, 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), changed, `admin=${user.username}; action=${action}; item=${itemKey}; amount=${amount}`)
    })
    return { ok: true, message: `已更新 ${this.db.ownerLabel(ownerUuid)} 的 ${item.displayName}：${current} -> ${current + delta}。` }
  }

  apiAdminTransfer (session, body) {
    const user = this.requireAdmin(session)
    if (Array.isArray(body.items)) return this.apiAdminTransferMany(body, user)
    const fromOwnerUuid = this.resolveAdminOwnerArgument(body.fromOwnerUuid || body.fromOwnerText || '')
    const toOwnerUuid = this.resolveAdminOwnerArgument(body.toOwnerUuid || body.toOwnerText || '')
    const itemKey = this.resolveAdminItemKey(body.itemKey || '')
    const amount = Number.parseInt(body.amount, 10)
    if (!fromOwnerUuid || !toOwnerUuid || !itemKey) throw new Error('缺少原归属、新归属或物品。')
    if (fromOwnerUuid === toOwnerUuid) throw new Error('原归属和新归属不能相同。')
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('转移数量必须大于 0。')
    const item = this.db.getItemByKey(itemKey)
    if (!item) throw new Error('找不到物品。')
    const current = this.db.getBalance(fromOwnerUuid, itemKey)
    const movedAmount = Math.min(current, amount)
    if (movedAmount <= 0) throw new Error('原归属没有这个物品。')
    const moved = [{ ...item, amount: movedAmount }]
    this.db.transaction(() => {
      this.db.adjustBalance(fromOwnerUuid, itemKey, -movedAmount)
      this.db.adjustBalance(toOwnerUuid, itemKey, movedAmount)
      this.db.addTransaction('web_admin_transfer_out', 'ok', fromOwnerUuid, this.db.ownerLabel(fromOwnerUuid), moved, `admin=${user.username}; to=${toOwnerUuid}`)
      this.db.addTransaction('web_admin_transfer_in', 'ok', toOwnerUuid, this.db.ownerLabel(toOwnerUuid), moved, `admin=${user.username}; from=${fromOwnerUuid}`)
    })
    return { ok: true, message: `已转移 ${item.displayName} x${movedAmount}：${this.db.ownerLabel(fromOwnerUuid)} -> ${this.db.ownerLabel(toOwnerUuid)}。` }
  }

  apiAdminTransferMany (body, user) {
    const toOwnerUuid = this.resolveAdminOwnerArgument(body.toOwnerUuid || body.toOwnerText || '')
    if (!toOwnerUuid) throw new Error('缺少目标玩家或仓库。')
    if (body.items.length > 200) throw new Error('单次最多转账 200 种物品。')
    const requested = body.items.map(entry => {
      const fromOwnerUuid = this.resolveAdminOwnerArgument(entry.fromOwnerUuid || '')
      const itemKey = this.resolveAdminItemKey(entry.itemKey || '')
      const amount = Number.parseInt(entry.amount, 10)
      if (!fromOwnerUuid || !itemKey || !Number.isInteger(amount) || amount <= 0) throw new Error('待转账物品数据无效。')
      if (fromOwnerUuid === toOwnerUuid) throw new Error(`目标不能与来源仓库 ${this.db.ownerLabel(fromOwnerUuid)} 相同。`)
      const item = this.db.getItemByKey(itemKey)
      const current = this.db.getBalance(fromOwnerUuid, itemKey)
      if (!item || current < amount) throw new Error(`${this.db.ownerLabel(fromOwnerUuid)} 的物品库存不足。`)
      return { fromOwnerUuid, itemKey, amount, item }
    })
    if (!requested.length) throw new Error('没有待转账物品。')
    this.db.transaction(() => {
      for (const row of requested) {
        const moved = [{ ...row.item, amount: row.amount }]
        this.db.adjustBalance(row.fromOwnerUuid, row.itemKey, -row.amount)
        this.db.adjustBalance(toOwnerUuid, row.itemKey, row.amount)
        this.db.addTransaction('web_admin_transfer_out', 'ok', row.fromOwnerUuid, this.db.ownerLabel(row.fromOwnerUuid), moved, `admin=${user.username}; to=${toOwnerUuid}`)
        this.db.addTransaction('web_admin_transfer_in', 'ok', toOwnerUuid, this.db.ownerLabel(toOwnerUuid), moved, `admin=${user.username}; from=${row.fromOwnerUuid}`)
      }
    })
    const total = requested.reduce((sum, row) => sum + row.amount, 0)
    return { ok: true, message: `已向 ${this.db.ownerLabel(toOwnerUuid)} 转账 ${requested.length} 种、共 ${total} 个物品。` }
  }

  apiAdminMismatchDeduct (session, body) {
    const user = this.requireAdmin(session)
    const id = Number.parseInt(body.id, 10)
    if (!Number.isInteger(id) || id <= 0) throw new Error('异常 ID 必须是正整数。')
    return { ok: true, message: this.deductMismatchRow(user, id) }
  }

  parseMismatchIdList (value) {
    if (!Array.isArray(value)) return []
    const ids = []
    for (const entry of value) {
      const id = Number.parseInt(entry, 10)
      if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id)
      if (ids.length >= 1000) break
    }
    return ids
  }

  apiAdminMismatchBatchDeduct (session, body) {
    const user = this.requireAdmin(session)
    const ids = this.parseMismatchIdList(body.ids)
    if (!ids.length) throw new Error('请先勾选要批量清除的异常记录。')
    const results = []
    for (const id of ids) {
      try {
        results.push({ id, ok: true, message: this.deductMismatchRow(user, id) })
      } catch (error) {
        results.push({ id, ok: false, message: error.message })
      }
    }
    const failCount = results.filter(row => !row.ok).length
    return {
      ok: true,
      results,
      message: `批量清除完成：成功 ${results.length - failCount} 条${failCount ? `，失败 ${failCount} 条` : ''}。`
    }
  }

  apiAdminMismatchBatchResolve (session, body) {
    const user = this.requireAdmin(session)
    const ids = this.parseMismatchIdList(body.ids)
    if (!ids.length) throw new Error('请先勾选要批量转入的异常记录。')
    if (!this.resolveAdminOwnerArgument(body.targetOwnerUuid || body.targetOwnerText || '')) throw new Error('请先选择批量转入的目标仓库。')
    const results = []
    for (const id of ids) {
      try {
        results.push({ id, ok: true, message: this.resolveMismatchRow(user, id, body.targetOwnerUuid || body.targetOwnerText || '') })
      } catch (error) {
        results.push({ id, ok: false, message: error.message })
      }
    }
    const failCount = results.filter(row => !row.ok).length
    return {
      ok: true,
      results,
      message: `批量转入完成：成功 ${results.length - failCount} 条${failCount ? `，失败 ${failCount} 条` : ''}。`
    }
  }

  deductMismatchRow (user, id) {
    const row = this.db.db.prepare(`
      SELECT id, kind, status, owner_uuid AS ownerUuid, username,
             item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, amount, balance_adjusted AS balanceAdjusted
      FROM inventory_mismatches
      WHERE id = ?
      LIMIT 1
    `).get(id)
    if (!row) throw new Error('没有找到这条异常记录。')
    if (row.status !== 'open') return '这条异常已经处理过。'
    if (!row.ownerUuid) throw new Error('这条异常没有明确归属，不能直接扣除。')
    const item = this.db.getItemByKey(row.itemKey) || this.db.rowToItem(row)
    const current = this.db.getBalance(row.ownerUuid, row.itemKey)
    const adjusted = Math.min(Number(row.amount || 0), Math.max(0, Number(row.balanceAdjusted || 0)))
    const remaining = Math.max(0, Number(row.amount || 0) - adjusted)
    const amount = Math.min(current, remaining)
    if (amount <= 0) {
      // 账面已无可扣除数量：常见于同步对账时已自动扣过。这里不再报错卡死，
      // 只关闭留痕，避免这条异常永远无法处理。
      const closeNote = remaining <= 0 ? 'Web关闭留痕：此缺失数量已自动扣除，无需再次扣账' : 'Web关闭留痕：账面已无可扣除数量'
      this.db.db.prepare(`
        UPDATE inventory_mismatches
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP,
            note = CASE
              WHEN note = '' THEN ?
              ELSE note || '；' || ?
            END
        WHERE id = ?
      `).run(closeNote, closeNote, id)
      return remaining <= 0
        ? `此缺失数量已自动扣除，${row.displayName || row.itemId} 的异常留痕已关闭。`
        : `账面已无可扣除的 ${row.displayName || row.itemId}，异常留痕已关闭。`
    }

    const changed = [{ ...item, amount }]
    this.db.transaction(() => {
      this.db.adjustBalance(row.ownerUuid, row.itemKey, -amount)
      this.db.addTransaction('web_admin_mismatch_deduct', 'ok', row.ownerUuid, this.db.ownerLabel(row.ownerUuid), changed, `admin=${user.username}; mismatch=${row.kind}; id=${row.id}; deduct=${amount}`)
      this.db.db.prepare(`
        UPDATE inventory_mismatches
        SET status = 'resolved',
            balance_adjusted = ?,
            resolved_at = CURRENT_TIMESTAMP,
            note = CASE
              WHEN note = '' THEN ?
              ELSE note || '；' || ?
            END
        WHERE id = ?
      `).run(adjusted + amount, `Web已扣除账本库存 x${amount}`, `Web已扣除账本库存 x${amount}`, id)
    })
    return `已扣除 ${this.db.ownerLabel(row.ownerUuid)} 的 ${row.displayName || row.itemId} x${amount}，异常已处理。`
  }

  apiAdminMismatchResolve (session, body) {
    const user = this.requireAdmin(session)
    const id = Number.parseInt(body.id, 10)
    if (!Number.isInteger(id) || id <= 0) throw new Error('异常 ID 必须是正整数。')
    return { ok: true, message: this.resolveMismatchRow(user, id, body.targetOwnerUuid || body.targetOwnerText || '') }
  }

  resolveMismatchRow (user, id, targetOwnerArgument) {
    const row = this.db.db.prepare(`
      SELECT id, kind, status, owner_uuid AS ownerUuid, username,
             item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, amount
      FROM inventory_mismatches WHERE id = ? LIMIT 1
    `).get(id)
    if (!row) throw new Error('没有找到这条异常记录。')
    if (row.status !== 'open') return '这条异常已经处理过。'
    if (row.kind === 'missing') return this.deductMismatchRow(user, id)

    const targetOwnerUuid = this.resolveAdminOwnerArgument(targetOwnerArgument)
    if (!targetOwnerUuid) throw new Error('多余物品需要选择转入的目标仓库。')
    const amount = Number(row.amount || 0)
    if (amount <= 0) throw new Error('异常数量无效。')
    const item = this.db.getItemByKey(row.itemKey) || this.db.rowToItem(row)
    const sourceOwnerUuid = row.ownerUuid || this.db.momoOwner || this.config.momoOwner
    this.db.transaction(() => {
      this.db.upsertItem(item)
      if (sourceOwnerUuid !== targetOwnerUuid) {
        const sourceBalance = this.db.getBalance(sourceOwnerUuid, row.itemKey)
        if (sourceBalance < amount) {
          throw new Error(`${this.db.ownerLabel(sourceOwnerUuid)} 的 ${row.displayName || row.itemId} 仅剩 x${sourceBalance}，不足以转入 x${amount}。请重新同步库存异常。`)
        }
        this.db.adjustBalance(sourceOwnerUuid, row.itemKey, -amount)
        this.db.adjustBalance(targetOwnerUuid, row.itemKey, amount)
        this.db.addTransaction('web_admin_mismatch_transfer_out', 'ok', sourceOwnerUuid, this.db.ownerLabel(sourceOwnerUuid), [{ ...item, amount }], `mismatch #${row.id}; admin=${user.username}; to=${targetOwnerUuid}`)
      }
      this.db.addTransaction('web_admin_mismatch_transfer', 'ok', targetOwnerUuid, this.db.ownerLabel(targetOwnerUuid), [{ ...item, amount }], `mismatch #${row.id}; admin=${user.username}; source=physical_extra`)
      this.db.db.prepare(`
        UPDATE inventory_mismatches
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
            owner_uuid = ?, username = ?,
            note = CASE WHEN note = '' THEN ? ELSE note || '；' || ? END
        WHERE id = ?
      `).run(targetOwnerUuid, this.db.ownerLabel(targetOwnerUuid), `Web已转入目标库存 x${amount}`, `Web已转入目标库存 x${amount}`, id)
    })
    return `已把多余的 ${row.displayName || row.itemId} x${amount} 转入 ${this.db.ownerLabel(targetOwnerUuid)}。`
  }

  resolveAdminOwnerArgument (value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    if (raw === this.config.momoOwner || raw === 'momo') return this.config.momoOwner
    if (raw.startsWith('vault:')) {
      const warehouse = this.db.getCustomWarehouse(raw.slice(6))
      if (!warehouse) throw new Error(`找不到仓库：${raw}`)
      return `vault:${warehouse.nameLower}`
    }
    if (raw.startsWith('仓库:')) {
      const warehouse = this.db.getCustomWarehouse(raw.slice(3))
      if (!warehouse) throw new Error(`找不到仓库：${raw.slice(3)}`)
      return `vault:${warehouse.nameLower}`
    }

    const directPlayer = this.db.db.prepare('SELECT uuid FROM players WHERE uuid = ? LIMIT 1').get(raw)
    if (directPlayer) {
      if (!this.db.hasPersonalWarehouse(directPlayer.uuid)) throw new Error(`${this.db.ownerLabel(directPlayer.uuid)} 还没有个人仓库。`)
      return directPlayer.uuid
    }

    const warehouse = this.db.getCustomWarehouse(raw)
    if (warehouse) return `vault:${warehouse.nameLower}`

    const service = this.serviceProvider()
    const onlineName = service?.bot?.players
      ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase())
      : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      const uuid = this.db.canonicalPlayerUuid(online.uuid)
      if (!this.db.hasPersonalWarehouse(uuid)) throw new Error(`${onlineName} 还没有个人仓库。请先由管理员创建。`)
      return uuid
    }

    const player = this.db.getPlayerByUsername(raw)
    if (!player?.uuid || player.uuid.startsWith('name:')) {
      throw new Error(`找不到玩家或仓库：${raw}。玩家需要在线，或之前已用正版 UUID 使用过机器人。`)
    }
    if (!this.db.hasPersonalWarehouse(player.uuid)) throw new Error(`${player.username} 还没有个人仓库。请先由管理员创建。`)
    return player.uuid
  }

  resolveAdminItemKey (value) {
    const raw = String(value || '').trim().replace(/^#/, '')
    if (!raw) return ''
    if (this.db.getItemByKey(raw)) return raw
    if (/^[0-9a-fA-F]{6}$/.test(raw)) {
      const item = this.db.findItemByShortCode(raw)
      if (item) return item.itemKey
    }
    throw new Error(`找不到物品：${raw}`)
  }

  apiItemAliasSave (session, body) {
    const user = this.requireUser(session)
    const itemKey = String(body.itemKey || '').trim()
    const displayName = String(body.displayName || '').trim()
    const item = this.db.savePlayerItemNameOverride(user.uuid, itemKey, displayName)
    const personalDisplayName = body.updateDisplayName
      ? this.db.setPlayerItemDisplayName(user.uuid, itemKey, displayName)
      : (this.db.getPlayerItemDisplayNames(user.uuid, [itemKey]).get(itemKey) || '')
    return {
      ok: true,
      itemKey,
      displayName: item.displayName,
      personalAlias: item.personalAlias || '',
      personalAliases: item.personalAliases || [],
      personalDisplayName,
      message: `已添加个人别名：${item.shortCode || item.itemId} -> ${item.personalAlias}。`
    }
  }

  apiItemAliasDelete (session, body) {
    const user = this.requireUser(session)
    const result = this.db.deletePlayerItemAlias(user.uuid, body.alias)
    if (result.itemKey) {
      const displayName = this.db.getPlayerItemDisplayNames(user.uuid, [result.itemKey]).get(result.itemKey) || ''
      if (displayName.toLowerCase() === String(result.alias || '').toLowerCase()) this.db.setPlayerItemDisplayName(user.uuid, result.itemKey, '')
    }
    return { ok: true, message: result.changed ? `已删除个人别名：${result.alias}。` : '没有找到这个个人别名。' }
  }

  apiMyGlobalAliasToggle (session, body) {
    const user = this.requireUser(session)
    const result = this.db.setGlobalItemAliasEnabled(user.uuid, body.alias, Boolean(body.enabled))
    return { ok: true, ...result, message: `已${result.enabled ? '启用' : '禁用'}全局别名：${result.alias}。` }
  }

  apiAdminAliasSave (session, body) {
    const user = this.requireAdmin(session)
    const itemKey = String(body.itemKey || '').trim()
    const alias = String(body.alias || body.displayName || '').trim()
    const category = String(body.category || 'normal').trim()
    const item = this.db.saveGlobalItemAlias(itemKey, alias, category)
    if (body.updateDisplayName) this.db.saveItemNameOverride(itemKey, alias)
    this.db.addTransaction('web_admin_alias_save', 'ok', this.config.momoOwner, user.username, [{ ...item, amount: 0 }], `global_alias=${item.alias}; category=${item.category}; item=${item.shortCode}`)
    const categoryLabel = item.category === 'variant' ? '同 ID 物品' : '正常物品'
    return { ok: true, category: item.category, message: `已添加${categoryLabel}全局别名：${item.alias} -> ${item.displayName}。${body.updateDisplayName ? '库存显示名称也已更新。' : ''}` }
  }

  apiAdminAliasDelete (session, body) {
    const user = this.requireAdmin(session)
    const alias = String(body.alias || '').trim()
    const result = this.db.deleteGlobalItemAlias(alias)
    if (result.changed) {
      this.db.addTransaction('web_admin_alias_delete', 'ok', this.config.momoOwner, user.username, [], `delete global_alias=${result.alias}`)
    }
    return { ok: true, message: result.changed ? `已删除全局别名：${result.alias}。` : '没有找到这条全局别名。' }
  }

  apiAdminQuotaSave (session, body) {
    const user = this.requireAdmin(session)
    const ownerUuid = this.resolveAdminOwnerArgument(body.ownerUuid || body.ownerText || '')
    const quotaSlots = Number.parseInt(body.quotaSlots, 10)
    if (!ownerUuid) throw new Error('缺少仓库。')
    if (!Number.isInteger(quotaSlots) || quotaSlots < 0 || quotaSlots > 1000000) throw new Error('额度必须是 0 到 1000000 的整数。')
    this.db.setQuotaSlots(ownerUuid, quotaSlots)
    this.db.addTransaction('web_admin_quota_save', 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), [], `admin=${user.username}; quota_slots=${quotaSlots}`)
    return { ok: true, message: `已把 ${this.db.ownerLabel(ownerUuid)} 的额度设置为 ${quotaSlots} 格。` }
  }

  apiAdminQuotaRestore (session, body) {
    const user = this.requireAdmin(session)
    const ownerUuid = String(body.ownerUuid || '').trim()
    if (!ownerUuid) throw new Error('缺少仓库。')
    const entitlement = this.requireSubscriptions().restorePlanQuota(ownerUuid)
    this.db.addTransaction('web_admin_quota_restore', 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), [], `admin=${user.username}; quota_slots=${entitlement.quotaSlots}`)
    return { ok: true, entitlement, message: `已恢复 ${this.db.ownerLabel(ownerUuid)} 的套餐额度。` }
  }

  apiAdminQuickShulkerExtractionSave (session, body) {
    const user = this.requireAdmin(session)
    const ownerUuid = this.resolveAdminOwnerArgument(body.ownerUuid || body.ownerText || '')
    if (!ownerUuid || ownerUuid === this.config.momoOwner) throw new Error('请选择有效的个人或组织仓库。')
    if (typeof body.enabled !== 'boolean' && body.enabled !== 0 && body.enabled !== 1 && body.enabled !== '0' && body.enabled !== '1') {
      throw new Error('快捷潜影盒取货开关值无效。')
    }
    const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1'
    this.db.setQuickShulkerExtractionEnabled(ownerUuid, enabled)
    this.db.addTransaction('web_admin_quick_shulker_extraction_save', 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), [], `admin=${user.username}; enabled=${enabled}`)
    return { ok: true, enabled, message: `${this.db.ownerLabel(ownerUuid)} 已${enabled ? '启用' : '关闭'}快捷潜影盒散装取货。` }
  }

  apiWarehouseAdminQuickShulkerExtractionSave (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const raw = body.enabled
    if (typeof raw !== 'boolean' && raw !== 0 && raw !== 1 && raw !== '0' && raw !== '1') throw new Error('快捷潜影盒取货开关值无效。')
    const enabled = raw === true || raw === 1 || raw === '1'
    const ownerUuid = `vault:${warehouse.nameLower}`
    this.db.setQuickShulkerExtractionEnabled(ownerUuid, enabled)
    return { ok: true, enabled, message: `${warehouse.name} 已${enabled ? '启用' : '关闭'}快捷潜影盒散装取货。` }
  }

  adminOwnerUsedSlots (ownerUuid) {
    const rows = this.db.db.prepare(`
      SELECT b.amount, i.item_id AS itemId
      FROM balances b JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount > 0
    `).all(ownerUuid)
    return rows.reduce((sum, row) => {
      const stackSize = Math.max(1, Number(this.db.catalog?.getStackSize(row.itemId) || 64))
      return sum + Math.ceil(Number(row.amount || 0) / stackSize)
    }, 0)
  }

  adminItem (row) {
    const itemKey = row.itemKey || row.item_key || ''
    const itemId = row.itemId || row.item_id || ''
    return {
      itemKey,
      itemId,
      displayName: row.displayName || row.display_name || itemId,
      baseDisplayName: row.baseDisplayName || row.base_display_name || this.db.catalog?.getDisplayName(itemId) || '',
      nbtJson: row.nbtJson || row.nbt_json || '',
      metaJson: row.metaJson || row.meta_json || '',
      shortCode: this.db.shortCodeForItemKey(itemKey)
    }
  }

  adminItemMatches (item, query) {
    return [item.displayName, item.baseDisplayName, item.itemId, item.itemKey, item.shortCode, item.nbtJson, item.metaJson, ...(item.globalAliases || [])].some(value => this.textMatches(value, query))
  }

  adminTransactionItemMatches (item, query) {
    if (this.adminItemMatches(item, query)) return true
    if (!item.itemKey || !String(item.itemId || '').endsWith('shulker_box')) return false
    const contents = Array.isArray(item.shulkerContents)
      ? item.shulkerContents
      : (this.db.getShulkerContentsByBox([item.itemKey]).get(item.itemKey) || [])
    return contents.some(content => this.adminItemMatches(content, query))
  }

  prepareTransactionItems (rows) {
    const itemsById = new Map()
    const shulkerKeys = new Set()
    for (const row of rows || []) {
      const items = this.parseItemsJson(row.itemsJson)
      itemsById.set(row.id, items)
      for (const item of items) {
        const itemKey = item.itemKey || item.item_key || ''
        const itemId = item.itemId || item.item_id || ''
        if (itemKey && String(itemId).endsWith('shulker_box')) shulkerKeys.add(itemKey)
      }
    }
    return {
      itemsById,
      contentsByBox: this.db.getShulkerContentsByBox([...shulkerKeys])
    }
  }

  decorateTransactionItems (items, prefetchedContents = null) {
    const decorated = (items || []).map(item => ({
      ...this.adminItem(item),
      amount: Number(item.amount || 0)
    }))
    const shulkerKeys = [...new Set(decorated
      .filter(item => item.itemKey && String(item.itemId || '').endsWith('shulker_box'))
      .map(item => item.itemKey))]
    const contentsByBox = prefetchedContents || this.db.getShulkerContentsByBox(shulkerKeys)
    return decorated.map(item => ({
      ...item,
      shulkerContents: (contentsByBox.get(item.itemKey) || []).map(content => ({
        ...this.adminItem(content),
        amount: Number(content.amount || 0),
        slotCount: Number(content.slotCount || 0)
      }))
    }))
  }

  transactionDetails (message) {
    const details = {}
    for (const part of String(message || '').split(/[;,]\s*/)) {
      const match = part.match(/^([^=]+)=(.*)$/)
      if (match) details[match[1].trim()] = match[2].trim()
    }
    const transfer = String(message || '').match(/admin transfer (?:to|from) (.+)$/)
    if (transfer) details.counterparty = this.db.ownerLabel(transfer[1].trim())
    return details
  }

  transactionOperator (row, details = {}) {
    return String(details.admin || details.actor || details.operator || details.player || row.username || '').trim()
  }

  textMatches (value, query) {
    return String(value || '').toLowerCase().includes(String(query || '').toLowerCase())
  }

  parseItemsJson (text) {
    try {
      const value = JSON.parse(text || '[]')
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  decorateTransaction (row) {
    return {
      ...row,
      typeLabel: this.transactionTypeLabel(row.type),
      statusLabel: this.transactionStatusLabel(row.status),
      messageLabel: this.transactionMessageLabel(row.message),
      createdAtLabel: this.formatBeijingTime(row.createdAt)
    }
  }

  formatBeijingTime (value) {
    if (!value) return ''
    const text = String(value).trim()
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
    if (Number.isNaN(date.getTime())) return text
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value
      return result
    }, {})
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  }

  formatTimestampMs (value) {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(timestamp)).replaceAll('/', '-')
  }

  transactionTypeLabel (type) {
    const labels = {
      withdraw: '取货',
      deposit: '存货',
      deposit_session: '存货记录',
      sync: '同步仓库',
      residual_to_momo: '残留记入 momo',
      momo_residual_physical_store: '残留实物入库',
      withdraw_failed_return: '取货失败回收入库',
      withdraw_tpa_timeout: '取货超时回收入库',
      withdraw_residual_return: '取货残留回收入库',
      withdraw_death_recovery: '死亡恢复取货',
      disconnect_recovery_deposit: '重连恢复存货',
      disconnect_recovery_withdraw: '重连恢复取货',
      deposit_residual_recovery: '存货残留恢复',
      withdraw_residual_recovery: '取货残留恢复',
      admin_adjust_add: '指令增加库存',
      admin_adjust_remove: '指令减少库存',
      web_admin_add: '管理员增加库存',
      web_admin_subtract: '管理员减少库存',
      web_admin_set: '管理员设置库存',
      web_admin_transfer_out: '管理员转出',
      web_admin_transfer_in: '管理员转入',
      web_admin_mismatch_deduct: '异常扣除',
      web_admin_mismatch_transfer_out: '多余物品从 momo 转出',
      web_admin_mismatch_transfer: '多余物品转入库存',
      warehouse_delete_transfer_out: '删除仓库转出',
      warehouse_delete_transfer_in: '删除仓库转入 momo',
      web_admin_organization_member_add: '管理员添加组织成员',
      web_admin_organization_member_remove: '管理员删除组织成员',
      web_admin_organization_member_role: '管理员设置组织身份',
      web_admin_alias_save: '保存物品别名',
      web_admin_alias_delete: '删除物品别名',
      web_admin_quota_save: '设置仓库额度',
      web_admin_quick_shulker_extraction_save: '设置快捷潜影盒取货',
      craft_consume: '合成消耗',
      craft_produce: '合成产出',
      craft: '合成订单'
    }
    return labels[type] || String(type || '')
  }

  transactionStatusLabel (status) {
    const labels = {
      ok: '成功',
      partial: '部分完成',
      empty: '空操作',
      no_space: '空间不足',
      failed: '失败',
      cancelled: '已取消',
      error: '失败',
      teleport_timeout: '传送超时',
      ok_after_teleport_timeout: '传送超时后成功入库',
      partial_after_teleport_timeout: '传送超时后部分入库',
      no_space_after_teleport_timeout: '传送超时后空间不足',
      empty_after_teleport_timeout: '传送超时后未收到物品',
      quota_full: '额度已满',
      open: '未处理',
      resolved: '已处理'
    }
    return labels[status] || String(status || '')
  }

  transactionMessageLabel (message) {
    const text = String(message || '').trim()
    if (!text) return ''
    const fixed = {
      already_accounted_as_momo: '已提前记入 momo',
      'flush residual before task': '任务前清理残留'
    }
    if (fixed[text]) return fixed[text]

    const keyLabels = {
      actor: '操作人',
      target: '目标',
      owner: '归属',
      scope: '范围',
      phase: '阶段',
      depositedAmount: '存入数量',
      leftoverAmount: '剩余数量',
      finishedByUser: '玩家提前结束',
      stopReason: '结束原因',
      playerDistance: '玩家距离',
      vault: '仓库',
      radius: '半径',
      chests: '木桶数',
      leftOver_items: '剩余种类',
      leftover_items: '剩余种类',
      leftover_amount: '剩余数量',
      timeoutMs: '超时',
      recovery: '恢复方式',
      error: '错误',
      admin: '操作管理员',
      player: '玩家',
      requested: '请求数量',
      to: '转入目标',
      from: '来源仓库',
      action: '操作',
      item: '物品',
      amount: '数量',
      mismatch: '异常类型',
      id: '记录编号',
      deduct: '扣除数量',
      source: '来源',
      global_alias: '全局别名',
      'delete global_alias': '删除全局别名',
      quota_slots: '额度格数',
      deletedOwner: '被删除仓库',
      warehouseType: '仓库类型',
      member: '成员',
      role: '身份',
      batch: '批次',
      reason: '原因',
      usedSlots: '已用格数',
      quotaSlots: '额度格数'
    }
    const valueLabels = {
      personal: '个人仓库',
      custom: '组织仓库',
      true: '是',
      false: '否',
      player_left: '玩家离开超过距离',
      timeout: '等待时间结束',
      deposit_storing: '入库中',
      deposit_teleport_to_player: '等待玩家接受传送',
      deposit_collecting: '收集物品中',
      deposit_return_home: '返回仓库中',
      prepare_deposit: '准备存货',
      prepare_withdraw: '准备取货',
      withdraw_from_chests: '从木桶取货',
      withdraw_teleport_to_player: '等待玩家接受传送',
      withdraw_tpa_timeout_return_home: '传送超时返回仓库',
      withdraw_dropping: '交付物品',
      withdraw_return_home: '返回仓库',
      disconnect: '断线重连',
      quota_check: '检查额度',
      death: '机器人死亡',
      cancelled: '操作取消',
      physical_extra: '仓库实物多余'
    }
    const pairs = text.split(/\s*[;,]\s*/).map(part => {
      const index = part.indexOf('=')
      if (index <= 0) {
        const mismatch = part.match(/^mismatch\s+#(\d+)$/i)
        if (mismatch) return `异常记录 #${mismatch[1]}`
        const transfer = part.match(/^admin transfer (to|from) (.+)$/i)
        if (transfer) return `${transfer[1].toLowerCase() === 'to' ? '管理员转入目标' : '管理员转出来源'}：${transfer[2]}`
        return part
      }
      const key = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      let displayValue = value.startsWith('vault:') ? `仓库:${value.slice(6)}` : (valueLabels[value] || value)
      if (key === 'role') displayValue = value === 'admin' ? '仓库管理员' : (value === 'member' ? '普通成员' : displayValue)
      if (key === 'action') displayValue = ({ add: '增加库存', subtract: '减少库存', set: '设置库存' })[value] || displayValue
      if (key === 'mismatch') displayValue = ({ extra: '多余物品', missing: '缺失物品' })[value] || displayValue
      if (key === 'warehouseType') displayValue = ({ personal: '个人仓库', custom: '组织仓库' })[value] || displayValue
      return `${keyLabels[key] || key}：${displayValue}`
    })
    return pairs.join('，')
  }

  clampLimit (value, fallback, max) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed)) return fallback
    return Math.max(1, Math.min(max, parsed))
  }

  activeSnapshot () {
    const service = this.serviceProvider()
    const pool = service?.taskPool?.snapshot()
    const active = pool?.active?.[0] || service?.active
    if (!active && !pool?.queued?.length) return null
    if (!active) {
      const queued = pool.queued[0]
      return {
        type: queued.type,
        username: queued.username,
        targetUsername: queued.username,
        phase: 'queued',
        queuedCount: pool.queued.length,
        botName: '',
        message: `任务排队中（共 ${pool.queued.length} 个）`
      }
    }
    return {
      type: active.type,
      username: active.username,
      targetUsername: active.targetUsername || active.username,
      phase: active.phase || 'running',
      batchIndex: active.batchIndex || 0,
      totalBatches: active.totalBatches || 0,
      botName: active.botName || service?.bot?.username || '',
      queuedCount: pool?.queued?.length || 0,
      message: this.activePhaseMessage(active)
    }
  }

  activePhaseMessage (active) {
    const target = active.targetUsername || active.username
    const labels = {
      start: '任务启动中',
      queued: '任务排队中',
      prepare_deposit: '准备存货',
      deposit_teleport_to_player: '发送 tpa 中',
      deposit_collecting: '收集物品中',
      deposit_return_home: '返回仓库中',
      deposit_storing: '入库中',
      prepare_withdraw: '准备取货',
      withdraw_from_chests: '正在从木桶取货',
      withdraw_teleport_to_player: `已发送 tpa，等待 ${target} 接受`,
      withdraw_tpa_timeout_return_home: '对方未接受，正在回仓库',
      withdraw_dropping: `${target} 已接受，正在丢物品`,
      withdraw_return_home: '取货完成，正在回仓库',
      quota_check: '检查额度中'
    }
    const message = labels[active.phase] || '任务进行中'
    if (String(active.phase || '').startsWith('withdraw_') && Number(active.totalBatches || 0) > 1) {
      return `${message}（${active.batchIndex || 1}/${active.totalBatches} 批）`
    }
    return message
  }

  botDisplayName () {
    const value = String(this.serviceProvider()?.bot?.username || this.config.server?.botName || this.config.server?.username || '').trim()
    return value && !value.includes('@') ? value : 'NanKinz1'
  }

  getSession (req, res) {
    this.cleanupExpiredWebSessions()
    const cookies = parseCookies(req.headers.cookie || '')
    let sid = cookies.cs_sid
    let session = sid ? this.sessions.get(sid) : null

    if (session && this.isWebSessionExpired(session)) {
      this.sessions.delete(sid)
      session = null
    }

    if (!session && sid) {
      session = this.loadPersistedWebSession(sid)
      if (session) this.sessions.set(sid, session)
    }

    if (!sid || !session) {
      sid = crypto.randomBytes(18).toString('hex')
      session = { sid, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + this.webSessionTtlMs(), user: null }
      this.sessions.set(sid, session)
    }
    const now = Date.now()
    session.lastSeenAt = now
    session.expiresAt = now + this.webSessionTtlMs()
    this.setSessionCookie(res, sid)
    if (session.user && now - Number(session.lastPersistedAt || 0) > 60 * 1000) this.persistWebSession(session)
    return session
  }

  webSessionTtlMs () {
    const configured = Number.parseInt(this.config.web?.sessionTtlMs, 10)
    return Number.isFinite(configured) && configured > 0 ? configured : 30 * 24 * 60 * 60 * 1000
  }

  webSessionCookieMaxAge () {
    return Math.max(60, Math.floor(this.webSessionTtlMs() / 1000))
  }

  setSessionCookie (res, sid) {
    res.setHeader('Set-Cookie', `cs_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.webSessionCookieMaxAge()}`)
  }

  webSessionHash (sid) {
    return crypto.createHash('sha256').update(String(sid || '')).digest('hex')
  }

  isWebSessionExpired (session) {
    return Boolean(session?.expiresAt && session.expiresAt <= Date.now())
  }

  loadPersistedWebSession (sid) {
    const row = this.db.db.prepare(`
      SELECT owner_uuid AS uuid, username, expires_at AS expiresAt
      FROM web_sessions
      WHERE session_hash = ?
    `).get(this.webSessionHash(sid))
    if (!row || Number(row.expiresAt || 0) <= Date.now()) {
      if (row) this.db.db.prepare('DELETE FROM web_sessions WHERE session_hash = ?').run(this.webSessionHash(sid))
      return null
    }
    return {
      sid,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Number(row.expiresAt),
      lastPersistedAt: Date.now(),
      user: {
        uuid: row.uuid,
        username: row.username
      }
    }
  }

  persistWebSession (session) {
    if (!session?.sid || !session.user?.uuid || !session.user?.username) return
    const expiresAt = session.expiresAt || (Date.now() + this.webSessionTtlMs())
    session.expiresAt = expiresAt
    session.lastPersistedAt = Date.now()
    this.db.db.prepare(`
      INSERT INTO web_sessions (session_hash, owner_uuid, username, expires_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_hash) DO UPDATE SET
        owner_uuid = excluded.owner_uuid,
        username = excluded.username,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(this.webSessionHash(session.sid), session.user.uuid, session.user.username, expiresAt)
  }

  deletePersistedWebSession (session) {
    if (!session?.sid) return
    this.db.db.prepare('DELETE FROM web_sessions WHERE session_hash = ?').run(this.webSessionHash(session.sid))
  }

  cleanupExpiredWebSessions () {
    const now = Date.now()
    if (now - this.lastSessionCleanupAt < 10 * 60 * 1000) return
    this.lastSessionCleanupAt = now
    this.db.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now)
    for (const [sid, session] of this.sessions) {
      if (this.isWebSessionExpired(session)) this.sessions.delete(sid)
    }
  }

  logRejectedRequest (req, error) {
    const clientIp = this.clientIp(req)
    console.warn(`[web] rejected malformed request ${req.method} ${JSON.stringify(String(req.url))} from ${clientIp}: ${error.message}`)
    logLocalError('web-malformed-request-url', error, { method: req.method, url: String(req.url), clientIp })
  }

  clientIp (req) {
    if (this.config.web?.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim()
      if (forwarded) return forwarded
      const realIp = String(req.headers['x-real-ip'] || '').trim()
      if (realIp) return realIp
    }
    return req.socket.remoteAddress || 'unknown'
  }

  readBody (req, maxBytes = 1024 * 128) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) {
          reject(new Error('请求体过大。'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('请求体必须是 JSON。'))
        }
      })
      req.on('error', reject)
    })
  }

  sendHtml (res, html) {
    const data = Buffer.from(html, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length
    })
    res.end(data)
  }

  sendJson (res, payload, status = 200) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': data.length
    })
    res.end(data)
  }

  sendText (res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
}

function parseCookies (header) {
  const result = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return result
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>云仓库</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101012;
      --side: #17171a;
      --panel: #18181c;
      --panel2: #202022;
      --line: #2a2a2f;
      --text: #f1efe8;
      --muted: #8c8b91;
      --gold: #f4c15d;
      --orange: #f0a96a;
      --danger: #ff6b6b;
      --green: #50d05f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 "Microsoft YaHei", system-ui, sans-serif;
      letter-spacing: 0;
    }
    .app { height: 100vh; min-height: 0; display: grid; grid-template-columns: 250px minmax(0, 1fr); overflow: hidden; }
    aside {
      background: var(--side);
      border-right: 1px solid var(--line);
      padding: 28px 15px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      height: 100vh;
      min-height: 0;
      overflow: hidden;
    }
    .brand { font-size: 30px; font-weight: 800; color: var(--text); }
    .brand span { color: var(--orange); }
    nav { flex: 1 1 auto; border-top: 1px solid var(--line); padding-top: 14px; display: grid; gap: 8px; overflow-y: auto; min-height: 0; align-content: start; }
    .navbtn {
      width: 100%;
      display: block;
      border: 0;
      background: transparent;
      color: #b8b5ad;
      text-align: left;
      padding: 13px 18px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      text-decoration: none;
    }
    .navbtn.active { background: #2a251e; color: var(--gold); }
    .userbox { margin-top: auto; flex: 0 0 auto; border-top: 1px solid var(--line); padding-top: 20px; color: var(--gold); background: var(--side); }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: var(--green); margin-right: 9px; }
    button, input, select {
      border: 1px solid var(--line);
      background: #121214;
      color: var(--text);
      border-radius: 7px;
      padding: 9px 12px;
      font: inherit;
    }
    button { cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.primary { color: var(--gold); border-color: #4a3921; background: #1b1712; }
    button.solid { background: var(--gold); color: #1a1510; border-color: var(--gold); font-weight: 700; }
    button.ghost { color: var(--muted); }
    button.danger { color: #ffb1b1; border-color: #763f3f; background: #2a1717; }
    main { min-width: 0; height: 100vh; overflow-y: auto; padding: 40px; }
    .hero {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 9px;
      padding: 24px 30px;
      font-size: 23px;
      margin-bottom: 26px;
    }
    .hero strong { color: #fff; font-weight: 800; }
    .quota-inline { margin-left: 14px; color: var(--gold); font-size: 15px; white-space: nowrap; }
    .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
    .toolbar input { min-width: 260px; }
    .toolbar select { min-width: 210px; }
    .toolbar-check { display: inline-flex; gap: 6px; align-items: center; color: #d8d4ca; font-size: 13px; cursor: pointer; user-select: none; white-space: nowrap; }
    .toolbar-check input { min-width: 0; width: 15px; height: 15px; accent-color: var(--gold); cursor: pointer; }
    .boxed-badge { position: absolute; left: 3px; bottom: 2px; color: var(--gold); font-size: 10px; line-height: 1; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000; pointer-events: none; }
    .title { font-size: 22px; margin-right: auto; }
    .muted { color: var(--muted); }
    .panel {
      min-height: 155px;
      border: 1px dashed var(--line);
      border-radius: 9px;
      background: var(--panel);
      padding: 20px;
    }
    .help-layout { display: grid; gap: 18px; }
    .help-section {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .help-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 14px;
      padding: 16px 18px;
      background: #1f1f22;
      border-bottom: 1px solid var(--line);
    }
    .help-head h3 { margin: 0; color: var(--gold); font-size: 18px; }
    .help-head span { color: var(--muted); font-size: 13px; }
    .command-list { display: grid; }
    .command-row {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 14px;
      align-items: center;
      padding: 14px 18px;
      border-top: 1px solid rgba(255,255,255,.04);
    }
    .command-row:first-child { border-top: 0; }
    .command-name { color: #f1efe8; font-weight: 700; }
    .command-desc { color: var(--muted); font-size: 13px; margin-top: 3px; }
    .cmd {
      display: inline-block;
      max-width: 100%;
      border: 1px solid #3a352b;
      background: #121214;
      color: #f8d98b;
      border-radius: 6px;
      padding: 7px 9px;
      overflow-wrap: anywhere;
      font-family: Consolas, "Microsoft YaHei", monospace;
      font-size: 14px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, 78px); gap: 10px; align-items: start; }
    .item {
      width: 78px;
      background: #151518;
      border: 1px solid #25252a;
      border-radius: 8px;
      padding: 7px;
      min-height: 94px;
      position: relative;
      cursor: pointer;
    }
    .item:hover { border-color: #5d492a; }
    .item.selected { border-color: var(--gold); background: #211b12; }
    .icon { width: 62px; height: 62px; display: grid; place-items: center; background: #232327; border-radius: 6px; overflow: hidden; position: relative; }
    .icon img { max-width: 52px; max-height: 52px; image-rendering: pixelated; }
    .fallback { display: none; color: var(--gold); font-size: 12px; text-align: center; }
    .icon img:not([src]) { display: none; }
    .icon img:not([src]) + .fallback { display: block; }
    .icon img[src] + .fallback { display: none; }
    .name {
      font-size: 12px;
      color: #d8d4ca;
      margin-top: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: center;
    }
    .count {
      position: absolute;
      right: 3px;
      bottom: 2px;
      color: #fff;
      font-size: 13px;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
      pointer-events: none;
    }
    .code { color: var(--muted); font-size: 12px; }
    .withdrawbar { display: grid; grid-template-columns: minmax(0, 1fr) 190px auto; gap: 10px; align-items: start; margin-bottom: 18px; }
    .admin-transferbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      align-items: center;
      margin: -8px 0 14px;
    }
    .admin-transferbar input { width: min(360px, 38vw); }
    .admin-transferbar .muted {
      max-width: 160px;
      color: var(--gold);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .target-player-box { position: relative; min-width: 0; }
    .target-player-box input { width: 100%; }
    .player-menu {
      position: absolute;
      z-index: 60;
      left: 0;
      right: 0;
      top: calc(100% + 6px);
      max-height: 230px;
      overflow-x: hidden;
      overflow-y: auto;
      border: 1px solid #4b3d28;
      border-radius: 8px;
      background: #141416;
      box-shadow: 0 14px 42px rgba(0,0,0,.5);
      padding: 6px;
    }
    .player-option {
      width: 100%;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      border: 0;
      background: transparent;
      color: #e5dfd4;
      text-align: left;
      padding: 8px 9px;
      border-radius: 6px;
    }
    .player-option:hover, .player-option.active { background: #2a251e; color: var(--gold); }
    .player-option > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .player-option .ping { flex: 0 0 auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .player-empty { padding: 9px; color: var(--muted); font-size: 13px; }
    .litematicbar { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; margin: -6px 0 14px; }
    .litematic-result {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #121214;
      padding: 10px 12px;
      color: #d8d4ca;
      min-height: 40px;
    }
    .litematic-title { color: var(--gold); font-weight: 800; margin-bottom: 4px; }
    .litematic-lines { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
    .litematic-warn { color: var(--orange); margin-top: 5px; font-size: 13px; line-height: 1.55; max-height: 180px; overflow: auto; }
    .selected-list {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #121214;
      padding: 7px;
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
      align-items: center;
    }
    .selected-empty { color: var(--muted); padding: 4px 6px; }
    .pick {
      display: inline-grid;
      grid-template-columns: minmax(80px, auto) 64px 28px;
      align-items: center;
      gap: 5px;
      border: 1px solid #3d3323;
      background: #1d1811;
      border-radius: 7px;
      padding: 4px 5px;
      max-width: 260px;
    }
    .pick-name { color: var(--gold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pick input { min-width: 0; width: 64px; padding: 5px 6px; }
    .pick button { width: 28px; height: 28px; padding: 0; min-width: 0; color: var(--muted); }
    .selected-clear { padding: 6px 9px; min-width: 0; align-self: stretch; }
    .tooltip {
      position: fixed;
      z-index: 50;
      max-width: min(560px, calc(100vw - 18px));
      pointer-events: none;
      background: rgba(12, 12, 14, .97);
      border: 1px solid #4b3d28;
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      box-shadow: 0 12px 36px rgba(0,0,0,.45);
      display: none;
    }
    .tooltip.shulker-tip { width: min(540px, calc(100vw - 18px)); }
    .tooltip.locked { pointer-events: auto; border-color: var(--gold); }
    .tooltip .tip-title { color: var(--gold); font-weight: 800; margin-bottom: 4px; }
    .tooltip .tip-line { color: #d8d4ca; font-size: 13px; margin-top: 2px; }
    .tip-text-list { display: grid; gap: 4px; margin-top: 8px; min-width: 230px; max-height: 360px; overflow: auto; }
    .tip-text-row { display: flex; justify-content: space-between; gap: 18px; border-bottom: 1px solid #2c2c31; padding: 5px 2px; color: #eeeae1; font-size: 13px; }
    .tip-text-row:last-child { border-bottom: 0; }
    .tip-text-row span:last-child { color: var(--gold); white-space: nowrap; }
    .tip-grid { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 4px; margin-top: 8px; }
    .tip-slot {
      min-width: 0;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      position: relative;
      background: #242428;
      border: 1px solid #33343a;
      border-radius: 5px;
      padding: 3px;
      overflow: hidden;
    }
    .tip-slot.empty { background: #18181b; border-color: #29292e; }
    .tip-slot img { width: 100%; height: 100%; max-width: 42px; max-height: 42px; object-fit: contain; image-rendering: pixelated; }
    .tip-slot span { position: absolute; right: 3px; bottom: 1px; color: #fff; font-size: 12px; font-weight: 800; line-height: 1; text-shadow: 1px 1px 1px #000, -1px -1px 1px #000; }
    .tip-slot-detail { min-height: 22px; margin-top: 7px; padding-top: 5px; border-top: 1px solid #2c2c31; color: #f1efe8; font-size: 13px; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 11px 9px; text-align: left; vertical-align: top; }
    th { color: var(--gold); font-weight: 700; }
    .subnav { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .subnav button.active { background: #2a251e; color: var(--gold); border-color: #4a3921; }
    .admin-logs-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
    @media (max-width: 1100px) { .admin-logs-layout { grid-template-columns: 1fr; } }
    .log-console {
      margin: 12px 0 0;
      white-space: pre-wrap;
      word-break: break-all;
      font: 12px/1.5 Consolas, "Courier New", monospace;
      color: #dcd7cd;
      background: #0f0f11;
      border: 1px solid #2c2c33;
      border-radius: 8px;
      padding: 12px;
      max-height: 58vh;
      overflow: auto;
    }
    .log-line { display: block; }
    .log-line .log-time { color: #7d7668; margin-right: 8px; }
    .log-line.warn .log-text { color: #e0b153; }
    .log-line.error .log-text { color: #e07a5f; }
    .log-file-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow: auto; margin-top: 10px; }
    .log-file-item { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
    .log-file-item:hover { border-color: #4a3921; background: #1b1712; }
    .log-file-item .name { flex: 1; word-break: break-all; }
    .log-file-item.selected { border-color: var(--gold); }
    /* 木桶视图 */
    .chest-layout { display: grid; grid-template-columns: 340px 1fr; gap: 14px; align-items: start; margin-bottom: 14px; }
    @media (max-width: 1100px) { .chest-layout { grid-template-columns: 1fr; } }
    .chest-map-panel { padding: 12px; }
    .chest-map-title { font-size: 13px; color: var(--muted); margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .chest-map-canvas { position: relative; width: 100%; height: 340px; background: #0f0f11; border: 1px solid #2c2c33; border-radius: 8px; overflow: hidden; cursor: pointer; }
    .chest-map-cell { position: absolute; border-radius: 3px; border: 1px solid rgba(255,255,255,.18); }
    .chest-map-cell:hover { border-color: var(--gold); z-index: 3; }
    .chest-map-cell.selected { border-color: #fff; box-shadow: 0 0 0 2px rgba(212,175,55,.65); z-index: 2; }
    .chest-map-stack-badge {
      position: absolute; left: 50%; top: 50%;
      transform: translate(-50%, -50%) skewY(30deg) scaleY(1.25);
      color: #fff; font-size: 12px; font-weight: 700;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
      pointer-events: none; white-space: nowrap;
    }
    .chest-list-panel { max-height: 380px; }
    .chest-list-panel table { margin: 0; }
    .chest-list-panel td, .chest-list-panel th { white-space: nowrap; }
    tr.chest-row { cursor: pointer; }
    tr.chest-row:hover { background: #1b1712; }
    tr.chest-row.selected { background: #2a251e; }
    .chest-coord { font-family: Consolas, monospace; }
    .chest-detail-panel { padding: 14px; }
    .chest-slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 8px; margin-top: 10px; }
    .chest-item { width: auto; }
    .chest-item .code { color: var(--muted); font-size: 11px; margin-top: 3px; }
    .chest-item.chest-shulker-item { border-color: #4a3921; background: #1b1712; }
    .chest-shulker-contents { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
    .chest-shulker-contents .shulker-entry { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 13px; }
    .chest-detail-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat { border: 1px solid var(--line); background: #141416; border-radius: 8px; padding: 12px; }
    .stat strong { display: block; font-size: 22px; color: var(--gold); }
    .tablewrap { overflow: auto; max-height: 68vh; }
    .compact-input { width: 86px; padding: 6px 7px; }
    .compact-select { width: 150px; padding: 6px 7px; }
    .ops { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .ops button { padding: 6px 8px; }
    .wrap { max-width: 360px; white-space: normal; word-break: break-word; }
    .admin-grid-panel { padding: 14px; min-height: 150px; }
    .compact-admin-grid { display: grid; grid-template-columns: repeat(auto-fill, 78px); gap: 10px; align-items: start; }
    .compact-admin-grid .item { box-sizing: border-box; }
    .compact-admin-grid .item .owner-dot { position: absolute; left: 4px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--gold); box-shadow: 0 0 0 2px #151518; }
    .admin-transfer-top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, 280px) auto; gap: 9px; align-items: start; margin-bottom: 10px; }
    .admin-quick-alias { display: flex; gap: 9px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
    .alias-detail-panel { margin-top: 12px; padding: 14px; min-height: 90px; }
    .alias-detail-head { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 10px; align-items: center; margin-bottom: 10px; }
    .global-alias-toggle-list { display: grid; gap: 6px; }
    .global-alias-toggle-row { display: grid; grid-template-columns: minmax(120px, 1fr) auto 48px; gap: 10px; align-items: center; border-top: 1px solid var(--line); padding: 8px 0; }
    .admin-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .admin-item-card { min-width: 0; border: 1px solid #2d2d32; background: #151518; border-radius: 9px; padding: 10px; cursor: pointer; }
    .admin-item-card:hover { border-color: #5d492a; }
    .admin-item-card.selected { border-color: var(--gold); background: #211b12; }
    .admin-item-main { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 9px; align-items: center; }
    .admin-item-icon { width: 52px; height: 52px; background: #252529; border-radius: 7px; display: grid; place-items: center; position: relative; }
    .admin-item-icon img { width: 44px; height: 44px; object-fit: contain; image-rendering: pixelated; }
    .admin-item-icon .count { font-size: 12px; }
    .admin-item-name { color: #f1efe8; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .admin-item-meta { color: var(--muted); font-size: 12px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .admin-actionbar { position: sticky; bottom: 10px; z-index: 12; display: grid; grid-template-columns: minmax(180px, 1fr) minmax(180px, 260px) 130px auto; gap: 8px; align-items: center; margin-top: 12px; padding: 10px; border: 1px solid #4a3921; border-radius: 9px; background: rgba(20,18,15,.96); box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    .mismatch-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .mismatch-columns h3 { color: var(--gold); margin: 5px 0 9px; }
    .mismatch-card { cursor: default; }
    .mismatch-actions { display: flex; gap: 6px; margin-top: 9px; }
    .mismatch-actions select { min-width: 0; width: 100%; padding: 6px; }
    .mismatch-actions button { padding: 6px 8px; white-space: nowrap; }
    .mismatch-actions .mm-check { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
    .mismatch-actions .mm-check input { accent-color: var(--gold); cursor: pointer; }
    .mismatch-batch { flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
    .mismatch-batch #adminMmBatchCount { min-width: 0; align-self: center; }
    .mismatch-batch select { max-width: 220px; }
    .alias-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .alias-tag { display: inline-flex; gap: 5px; align-items: center; border: 1px solid #493a25; background: #201a12; color: #f4d48a; border-radius: 99px; padding: 3px 7px; font-size: 12px; }
    .transaction-shulker { cursor: help; text-decoration: underline dotted rgba(244, 212, 138, .7); text-underline-offset: 3px; }
    .alias-tag button { border: 0; padding: 0; color: #c9b47e; background: transparent; }
    .admin-alias-list { padding: 14px; display: grid; gap: 9px; }
    .alias-row { display: grid; grid-template-columns: 58px minmax(160px, 1fr) minmax(220px, 2fr); gap: 10px; align-items: center; border-bottom: 1px solid var(--line); padding: 8px 0; }
    .alias-add { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .alias-add input { min-width: 150px; flex: 1; }
    .usage-track { width: 150px; height: 7px; overflow: hidden; border-radius: 99px; background: #29292d; margin-top: 5px; }
    .usage-fill { height: 100%; background: var(--gold); }
    .pager { display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 12px; }
    .empty-state { padding: 70px 20px; text-align: center; color: var(--muted); }
    .empty-state h3 { color: var(--gold); margin: 8px 0; }
    .empty-icon { font-size: 48px; color: #6e5933; }
    .organization-list { display: grid; gap: 14px; }
    .organization-card { border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 16px; }
    .organization-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .organization-name { color: var(--gold); font-size: 20px; font-weight: 800; }
    .organization-summary { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
    .member-list { display: grid; gap: 7px; margin-top: 12px; }
    .member-row { display: grid; grid-template-columns: minmax(120px, 1fr) 130px auto; gap: 8px; align-items: center; border-top: 1px solid rgba(255,255,255,.05); padding-top: 7px; }
    .organization-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 12px; }
    .organization-actions input { min-width: 180px; }
    .section-title { color: var(--gold); margin: 18px 0 8px; }
    .warehouse-create-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .warehouse-create-card { padding: 16px; }
    .warehouse-create-card h3 { color: var(--gold); margin: 0 0 6px; }
    .subscription-hero { border: 1px solid #4a3921; background: linear-gradient(135deg, #211b12, #17171a 58%, #121214); border-radius: 14px; padding: 24px; margin-bottom: 18px; display: flex; gap: 20px; justify-content: space-between; align-items: center; flex-wrap: wrap; }
    .subscription-balance { color: var(--gold); font-size: 30px; font-weight: 850; }
    .subscription-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 300px)); gap: 14px; justify-content: start; align-items: stretch; }
    .plan-card { width: 100%; border: 1px solid var(--line); border-radius: 14px; background: linear-gradient(160deg, #202024, #151518); padding: 20px; display: flex; flex-direction: column; min-height: 310px; }
    .plan-card.featured { border-color: #765c2d; box-shadow: 0 14px 38px rgba(0,0,0,.28); }
    .plan-card h3 { color: #fff; font-size: 22px; margin: 0 0 5px; }
    .plan-price { color: var(--gold); font-size: 27px; font-weight: 850; margin: 14px 0; }
    .plan-price small { color: var(--muted); font-size: 12px; font-weight: 400; }
    .plan-features { display: grid; gap: 7px; color: #cbc7bd; margin: 0 0 18px; padding: 0; list-style: none; }
    .plan-features li::before { content: '✓'; color: var(--gold); margin-right: 8px; }
    .plan-card button { margin-top: auto; width: 100%; }
    .subscription-block { margin-top: 24px; }
    .subscription-block-head { display: flex; gap: 12px; justify-content: space-between; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
    .subscription-block-head h2 { margin: 0; color: var(--gold); }
    .subscription-status { display: inline-flex; gap: 7px; align-items: center; border: 1px solid var(--line); border-radius: 99px; padding: 5px 10px; color: var(--muted); font-size: 12px; }
    .subscription-status.active { color: var(--green); border-color: #285b31; }
    .subscription-create { display: flex; gap: 8px; flex-wrap: wrap; padding: 16px; border: 1px dashed #5a4728; border-radius: 10px; background: #17140f; }
    .subscription-create input { flex: 1; min-width: 180px; }
    .user-subscription { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); cursor: pointer; }
    .user-subscription strong { display: block; color: var(--gold); font-size: 14px; }
    .admin-subscription-layout { display: grid; grid-template-columns: minmax(280px, .8fr) minmax(420px, 1.4fr); gap: 14px; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .settings-grid label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    .settings-grid .wide { grid-column: 1 / -1; }
    .plan-editor { border-top: 1px solid var(--line); padding: 14px 0; display: grid; gap: 8px; }
    .plan-editor:first-child { border-top: 0; }
    .plan-editor textarea, .settings-grid textarea { min-height: 90px; resize: vertical; }
    .switch { width: 44px; height: 24px; border-radius: 99px; padding: 2px; background: #33343a; border: 0; }
    .switch::after { content: ''; display: block; width: 20px; height: 20px; border-radius: 50%; background: #aaa; transition: transform .15s; }
    .switch.on { background: #71582e; }
    .switch.on::after { transform: translateX(20px); background: var(--gold); }
    .nbt-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 90;
      background: rgba(0,0,0,.68);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .nbt-modal {
      width: min(920px, 100%);
      max-height: 86vh;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #151518;
      box-shadow: 0 18px 60px rgba(0,0,0,.55);
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .nbt-head { display: flex; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .nbt-title { color: var(--gold); font-size: 18px; font-weight: 800; margin-right: auto; }
    .nbt-body { overflow: auto; padding: 14px 16px; }
    .alias-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .alias-note { grid-column: 1 / -1; color: var(--muted); font-size: 13px; }
    .alias-form > .alias-tags { grid-column: 1 / -1; }
    .check-label { grid-column: 1 / -1; display: flex; gap: 7px; align-items: center; color: var(--muted); font-size: 13px; }
    .check-label input { width: auto; margin: 0; }
    .nbt-body pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 13px/1.45 Consolas, "Courier New", monospace;
      color: #e7e2d8;
    }
    .nbt-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
    .login {
      max-width: 560px;
      margin: 11vh auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 32px;
    }
    .codebox {
      font-size: 44px;
      font-weight: 800;
      color: var(--gold);
      letter-spacing: 6px;
      background: #111;
      border: 1px solid #2c2c33;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
      margin: 18px 0;
    }
    .login-tabs { display: flex; gap: 8px; margin: 18px 0 10px; }
    .login-tabs button { flex: 1; }
    .login-tabs button.active { color: var(--gold); border-color: #4a3921; background: #1b1712; }
    .login-wait {
      border: 1px solid var(--line);
      background: #121214;
      border-radius: 8px;
      padding: 14px;
      margin-top: 14px;
    }
    .login-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .toast { min-height: 24px; color: var(--gold); }
    .statusbar { min-height: 24px; color: var(--green); margin: -8px 0 14px; }
    .alias-mode .item { outline: 1px solid #5d492a; }
    .alias-mode .item:hover { border-color: var(--gold); background: #211b12; }
    .hidden { display: none !important; }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      body { height: auto; min-height: 100vh; overflow: auto; }
      .app { height: auto; min-height: 100vh; overflow: visible; }
      aside { height: auto; min-height: auto; overflow: visible; }
      nav { overflow: visible; }
      main { height: auto; overflow: visible; padding: 20px; }
      .withdrawbar { grid-template-columns: 1fr; }
      .admin-transferbar { justify-content: stretch; }
      .admin-transferbar input { width: 100%; flex: 1 1 220px; }
      .admin-transferbar .muted { white-space: normal; }
      .admin-actionbar { grid-template-columns: 1fr; }
      .admin-transfer-top { grid-template-columns: 1fr; }
      .mismatch-columns { grid-template-columns: 1fr; }
      .alias-row { grid-template-columns: 48px minmax(0, 1fr); }
      .alias-row .alias-add { grid-column: 1 / -1; }
      .member-row { grid-template-columns: 1fr; }
      .warehouse-create-grid { grid-template-columns: 1fr; }
      .subscription-grid { grid-template-columns: minmax(0, 1fr); }
      .admin-subscription-layout, .settings-grid { grid-template-columns: 1fr; }
      .litematicbar { grid-template-columns: 1fr; }
      .command-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="login" class="login hidden">
    <div class="brand"><span>云</span>仓库</div>
    <div class="login-tabs">
      <button id="loginCodeTab" class="active" type="button">临时验证码</button>
      <button id="loginTokenTab" type="button">密码登录</button>
    </div>
    <section id="loginCodePanel">
      <p class="muted">点击获取验证码，然后复制命令到游戏内发送。</p>
      <button id="loginCodeStart" class="solid" style="width:100%">获取验证码</button>
      <div id="loginCodeWait" class="login-wait hidden">
        <div class="muted">请在游戏内发送：</div>
        <div class="codebox" id="loginCodeCommand" style="font-size:20px;letter-spacing:0;text-align:left;word-break:break-all">/msg bot 登录 000000</div>
        <div id="loginCodeStatus" class="muted">等待验证...</div>
        <div class="login-actions">
          <button id="loginCodeCopy" class="primary" type="button">复制命令</button>
          <button id="loginCodeCancel" class="ghost" type="button">取消</button>
        </div>
      </div>
    </section>
    <section id="loginTokenPanel" class="hidden">
      <p class="muted">首次使用请在游戏内输入：</p>
      <div class="codebox" id="loginCommand" style="font-size:22px;letter-spacing:0">/msg bot 设置密码 xxx</div>
      <div class="withdrawbar" style="grid-template-columns:1fr auto;margin:18px 0 8px">
        <input id="tokenInput" type="password" placeholder="输入你设置的登录密码">
        <button id="loginBtn" class="solid">登录</button>
      </div>
      <p class="muted">例如：<code id="loginExample">/msg bot 设置密码 1234</code>。每次设置都会覆盖旧密码。</p>
    </section>
  </div>

  <div id="app" class="app hidden">
    <aside>
      <div class="brand"><span>云</span>仓库</div>
      <nav>
        <button class="navbtn active" data-view="inventory">▦　库存</button>
        <button class="navbtn" data-view="transactions">▤　交易记录</button>
        <button class="navbtn" data-view="subscriptions">◇　订阅</button>
        <button class="navbtn" data-view="my">☺　我的</button>
        <button id="warehouseAdminLink" class="navbtn hidden" data-view="warehouseAdmin">♜　组织管理</button>
        <button class="navbtn" data-view="help">？　帮助</button>
        <button id="botPlatformLink" class="navbtn" type="button">⌘　Bot 自托管平台</button>
        <button id="adminLink" class="navbtn hidden" data-view="admin">▣　管理</button>
      </nav>
      <div class="userbox">
        <div><span class="dot"></span><span id="username">-</span></div>
        <div id="sidebarSubscription" class="user-subscription"><strong>0.00 TSLC</strong><span>套餐信息加载中</span></div>
        <button id="logout" class="ghost" style="width:100%;margin-top:18px">登出</button>
      </div>
    </aside>
    <main>
      <div id="inventoryHero" class="hero">欢迎回来，<strong id="heroName">-</strong>。 共 <strong id="heroTypes">0</strong> 种物品，<strong id="heroAmount">0</strong> 件。 <span id="heroReserved" class="quota-inline"></span><span id="inventoryQuota" class="quota-inline">仓库额度 0/0格</span></div>
      <section id="inventoryView">
        <div class="toolbar">
          <div class="title">远程存储 <span id="loaded" class="muted">0/0 种已加载</span></div>
          <select id="owner"></select>
          <button id="setDefaultOwner" class="primary">设为默认</button>
          <label class="toolbar-check" title="勾选：显示潜影盒；不勾选：潜影盒内容与散装物品合并显示"><input id="shulkerBoxView" type="checkbox">显示潜影盒</label>
          <input id="search" placeholder="搜索物品、ID、6位码...">
          <button id="aliasMode" class="primary">物品别名</button>
          <button id="deposit" class="primary">远程存储</button>
          <button id="refresh" class="primary">刷新</button>
        </div>
        <div class="withdrawbar">
          <div id="selectedList" class="selected-list"><span class="selected-empty">点击物品加入待取列表</span></div>
          <div class="target-player-box">
            <input id="targetPlayer" autocomplete="off" placeholder="目标玩家，默认自己">
            <div id="onlinePlayers" class="player-menu hidden"></div>
          </div>
          <button id="withdraw" class="solid">取货</button>
        </div>
        <div class="litematicbar">
          <button id="litematicPick" class="primary">上传投影</button>
          <input id="litematicFile" class="hidden" type="file" accept=".litematic">
          <div id="litematicResult" class="litematic-result hidden"></div>
        </div>
        <div id="activeStatus" class="statusbar hidden"></div>
        <div id="inventory" class="panel"></div>
      </section>
      <section id="transactionsView" class="hidden">
        <div class="toolbar">
          <div class="title">交易记录</div>
          <select id="txOwner"></select>
          <input id="txType" placeholder="类型">
          <input id="txOperator" placeholder="操作者">
          <input id="txItem" placeholder="物品（含潜影盒内容）">
          <select id="txStatus"><option value="">全部状态</option><option value="ok">成功</option><option value="failed">失败</option></select>
          <input id="txFrom" type="date" title="开始日期">
          <input id="txTo" type="date" title="结束日期">
          <input id="txQ" placeholder="Bot/备注/其他字段">
          <button id="txLoad" class="primary">查询</button>
          <button id="txRefresh" class="primary">刷新</button>
        </div>
        <div id="transactions" class="panel tablewrap"></div>
        <div class="pager"><button id="txPrev">上一页</button><span id="txPage">第 1 / 1 页</span><button id="txNext">下一页</button></div>
      </section>
      <section id="subscriptionsView" class="hidden">
        <div class="toolbar"><div class="title">订阅中心</div><button id="subscriptionRefresh" class="primary">刷新</button></div>
        <div class="subscription-hero">
          <div><div class="muted">TSLC 可用余额</div><div id="subscriptionBalance" class="subscription-balance">0.00 TSLC</div><div id="subscriptionTimeStatus" class="muted"></div></div>
          <div><strong>游戏内充值</strong><div id="subscriptionTopupBots" class="muted">正在获取在线 Bot...</div><div class="muted">使用服务器命令 /pay Bot名称 金额</div></div>
        </div>
        <div class="subscription-block">
          <div class="subscription-block-head"><h2>个人仓库</h2><div id="personalSubscriptionStatus" class="subscription-status">加载中</div></div>
          <div id="personalPlanGrid" class="subscription-grid"></div>
        </div>
        <div class="subscription-block">
          <div class="subscription-block-head"><h2>组织仓库</h2><select id="subscriptionOrganization"></select></div>
          <div id="subscriptionOrganizationCreate" class="subscription-create hidden"><input id="subscriptionOrganizationName" placeholder="组织仓库名，最多15个字"><button id="subscriptionOrganizationCreateButton" class="solid">创建组织仓库</button></div>
          <div id="organizationSubscriptionStatus" class="subscription-status">未选择仓库</div>
          <div id="organizationPlanGrid" class="subscription-grid" style="margin-top:10px"></div>
        </div>
        <div class="subscription-block"><div class="subscription-block-head"><h2>订购记录</h2></div><div id="subscriptionOrders" class="panel tablewrap"></div></div>
      </section>
      <section id="helpView" class="hidden">
        <div class="toolbar">
          <div class="title">帮助</div>
        </div>
        <div class="help-layout">
          <section class="help-section">
            <div class="help-head">
              <h3>网页登录</h3>
              <span>私聊机器人</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">设置网页密码</div>
                  <div class="command-desc">每次设置都会覆盖旧密码。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 设置密码 1234</code>
              </div>
            </div>
          </section>

          <section class="help-section">
            <div class="help-head">
              <h3>默认仓库</h3>
              <span>常用存取</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">设置默认仓库</div>
                  <div class="command-desc">直接“存/取/查”会使用这个仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 设置默认仓库 椰汁橙</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">存物品</div>
                  <div class="command-desc">存入当前默认仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 存</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">取物品</div>
                  <div class="command-desc">从当前默认仓库取出，可以一次填写多种物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 取 石头64 红石块3</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">代取给别人</div>
                  <div class="command-desc">扣自己的默认仓库，交给目标玩家。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 取 石头5 玩家ID</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">查询物品</div>
                  <div class="command-desc">查询当前默认仓库，一次只查询一种物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 查 石头</code>
              </div>
            </div>
          </section>

          <section class="help-section">
            <div class="help-head">
              <h3>个人仓库</h3>
              <span>只操作自己</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">个人取物品</div>
                  <div class="command-desc">只从个人仓库取，不自动补组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 个人 取 石头64</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">个人存物品</div>
                  <div class="command-desc">强制存入个人仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 个人 存</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">默认改回个人</div>
                  <div class="command-desc">以后直接“存/取/查”会使用个人仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 设置默认仓库 个人</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">个人查询</div>
                  <div class="command-desc">只查询个人仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 个人 查 石头</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">查看额度</div>
                  <div class="command-desc">查看当前仓库已占用格数。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 额度</code>
              </div>
            </div>
          </section>

          <section class="help-section">
            <div class="help-head">
              <h3>组织仓库</h3>
              <span>多人共享库存</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">创建仓库</div>
                  <div class="command-desc">仅云仓库系统管理员可用；普通玩家需要由管理员分配仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 创建仓库 椰汁橙</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">我的仓库</div>
                  <div class="command-desc">查看自己关联的组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 我的仓库</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">组织存物品</div>
                  <div class="command-desc">物品会进入指定组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 存</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">组织取物品</div>
                  <div class="command-desc">从指定组织仓库取出物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 取 石头64</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">组织查询</div>
                  <div class="command-desc">查询指定组织仓库的单种物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 查 石头</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">查看成员</div>
                  <div class="command-desc">查看组织仓库成员列表。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 仓库成员</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">添加成员</div>
                  <div class="command-desc">组织仓库管理员可用。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 添加成员 玩家ID</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">删除成员</div>
                  <div class="command-desc">组织仓库管理员可用。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 删除成员 玩家ID</code>
              </div>
            </div>
          </section>
        </div>
      </section>
      <section id="myView" class="hidden">
        <div class="toolbar"><div class="title">我的</div><button id="myRefresh" class="primary">刷新</button></div>
        <div class="subnav">
          <button class="primary active" data-my-tab="organizations">组织</button>
          <button class="primary" data-my-tab="aliases">别名</button>
        </div>
        <section id="myOrganizations"><div id="myOrganizationList" class="organization-list"></div></section>
        <section id="myAliases" class="hidden">
          <div class="toolbar"><input id="myAliasQ" placeholder="筛选物品、短码或别名"><button id="myAliasLoad" class="primary">查询</button></div>
          <h3 class="section-title">我的个人别名</h3><div id="myPersonalAliases" class="panel admin-grid-panel"></div><div id="myPersonalAliasDetail" class="panel alias-detail-panel"><p class="muted">点击物品图标管理个人别名。</p></div>
          <h3 class="section-title">管理员全局别名</h3><p class="muted">默认全部启用。禁用后，该别名不会再用于你的搜索和取货指令。</p><div id="myGlobalAliases" class="panel admin-grid-panel"></div><div id="myGlobalAliasDetail" class="panel alias-detail-panel"><p class="muted">点击物品图标管理全局别名开关。</p></div>
        </section>
      </section>
      <section id="warehouseAdminView" class="hidden">
        <div class="toolbar"><div class="title">组织管理</div><button id="warehouseAdminRefresh" class="primary">刷新</button></div>
        <p class="muted">这里只显示你担任仓库管理员的组织仓库。系统管理员身份不会自动获得这里的权限。</p>
        <div id="warehouseAdminOrganizationList" class="organization-list"></div>
      </section>
      <section id="adminView" class="hidden">
        <div class="toolbar">
          <div class="title">管理面板</div>
          <button id="adminRefresh" class="primary">刷新</button>
        </div>
        <div class="subnav">
          <button class="primary" data-admin-tab="bots">机器人账号</button>
          <button class="primary" data-admin-tab="admins">系统管理员</button>
          <button class="primary" data-admin-tab="players">玩家管理</button>
          <button class="primary" data-admin-tab="subscriptions">订阅管理</button>
          <button class="primary active" data-admin-tab="inventory">库存</button>
          <button class="primary" data-admin-tab="warehouses">仓库管理</button>
          <button class="primary" data-admin-tab="mismatches">库存异常</button>
          <button class="primary" data-admin-tab="chests">木桶视图</button>
          <button class="primary" data-admin-tab="transactions">交易记录</button>
          <button class="primary" data-admin-tab="commands">命令记录</button>
          <button class="primary" data-admin-tab="aliases">全局别名</button>
          <button class="primary" data-admin-tab="logs">运行日志</button>
        </div>
        <section id="adminBots" class="hidden">
          <div class="panel" style="padding:14px;margin-bottom:14px">
            <h3>添加微软机器人账号</h3>
            <div class="alias-add"><input id="adminBotEmail" type="email" placeholder="Microsoft 账号邮箱"><input id="adminBotName" placeholder="Bot 标识"><button id="adminBotAdd" class="solid">添加并登录</button></div>
            <p class="muted">仅支持 Microsoft OAuth2 设备码登录，不保存密码。添加后请按表格中的链接和验证码完成登录。</p>
          </div>
          <div id="adminBotsTable" class="panel tablewrap"></div>
        </section>
        <section id="adminUsers" class="hidden">
          <div class="panel" style="padding:14px;margin-bottom:14px">
            <h3>系统管理员</h3>
            <div class="alias-add"><input id="adminUserName" placeholder="玩家 ID"><button id="adminUserAdd" class="solid">添加管理员</button></div>
            <p class="muted">系统管理员可以使用管理员命令、进入 Web 管理面板，并通过 !指令 让机器人发送游戏内内容。</p>
          </div>
          <div id="adminUsersTable" class="panel tablewrap"></div>
        </section>
        <section id="adminPlayers" class="hidden">
          <div class="toolbar"><input id="adminPlayerQ" placeholder="搜索玩家或 UUID"><button id="adminPlayerLoad" class="primary">查询</button></div>
          <div id="adminPlayerTable" class="panel tablewrap"></div>
          <div id="adminPlayerDetail" class="panel alias-detail-panel"><p class="muted">点击玩家右侧的“管理”查看余额、订阅和记录。</p></div>
        </section>
        <section id="adminSubscriptions" class="hidden">
          <div class="admin-subscription-layout">
            <div class="panel">
              <h3>自动注册与系统设置</h3>
              <div id="adminSubscriptionSettings" class="settings-grid"></div>
              <div class="alias-add" style="margin-top:12px"><button id="adminSubscriptionSettingsSave" class="solid">保存并热更新</button><button id="adminSubscriptionTimeSync" class="primary">同步网络时间</button></div>
              <div id="adminSubscriptionTime" class="muted" style="margin-top:10px"></div>
            </div>
            <div class="panel"><h3>套餐配置</h3><div id="adminSubscriptionPlans"></div></div>
          </div>
          <h3 class="section-title">充值正则测试</h3>
          <div class="panel"><div class="settings-grid"><label class="wide">测试日志<textarea id="adminPaymentRegexSample">✔ 收到「AMU471」转来的 5.00 TSLC，当前余额 29.00</textarea></label></div><div class="alias-add"><button id="adminPaymentRegexTest" class="primary">测试当前正则</button><span id="adminPaymentRegexResult" class="muted"></span></div></div>
          <h3 class="section-title">全部充值记录</h3><div id="adminPaymentRecords" class="panel tablewrap"></div>
          <div class="pager"><button id="adminPaymentPrev">上一页</button><span id="adminPaymentPage" class="muted"></span><button id="adminPaymentNext">下一页</button></div>
          <h3 class="section-title">未识别到账日志</h3><div id="adminPaymentLogs" class="panel tablewrap"></div>
          <h3 class="section-title">用户名合并异常</h3><div id="adminIdentityConflicts" class="panel tablewrap"></div>
          <h3 class="section-title">玩家双 UUID 冲突（同一玩家两个正版身份，库存分裂）</h3><div id="adminPlayerIdentityConflicts" class="panel tablewrap"></div>
        </section>
        <section id="adminInventory">
          <div class="toolbar">
            <span id="adminInvStatus" class="muted">等待加载</span>
            <select id="adminInvOwner"><option value="">全部仓库</option></select>
            <input id="adminInvItem" placeholder="按物品/ID/短码筛选">
            <button id="adminInvLoad" class="primary">查询</button>
          </div>
          <div class="admin-transfer-top">
            <div id="adminSelectedList" class="selected-list"><span class="selected-empty">点击物品加入待转账列表</span></div>
            <input id="adminTransferTarget" placeholder="目标玩家 ID 或仓库名">
            <button id="adminTransferRun" class="solid">转账</button>
          </div>
          <div class="admin-quick-alias">
            <button id="adminAliasMode" class="primary">全局别名</button>
            <span id="adminAliasModeHint" class="muted">开启后点击物品图标查看 NBT 并设置全局别名</span>
          </div>
          <div id="adminInvStats" class="stats"></div>
          <div id="adminInvGrid" class="panel admin-grid-panel"></div>
        </section>
        <section id="adminWarehouses" class="hidden">
          <div class="warehouse-create-grid">
            <div class="panel warehouse-create-card"><h3>创建个人仓库</h3><p class="muted">填写玩家 ID。创建后该玩家可以立即使用个人仓库。</p><div class="alias-add"><input id="adminPersonalWarehousePlayer" placeholder="玩家 ID"><button id="adminPersonalWarehouseCreate" class="solid">创建个人仓库</button></div></div>
            <div class="panel warehouse-create-card"><h3>创建组织仓库</h3><p class="muted">指定仓库名和首位仓库管理员。</p><div class="alias-add"><input id="adminOrganizationWarehouseName" placeholder="组织仓库名"><input id="adminOrganizationWarehouseCreator" placeholder="仓库管理员玩家 ID"><button id="adminOrganizationWarehouseCreate" class="solid">创建组织仓库</button></div></div>
          </div>
          <h3 class="section-title">已创建的个人仓库</h3><div id="adminPersonalWarehouseList" class="panel tablewrap"></div>
          <h3 class="section-title">已有组织仓库</h3><div id="adminOrganizationWarehouseList" class="panel tablewrap"></div>
          <div id="adminOrganizationWarehouseDetail" class="panel alias-detail-panel"><p class="muted">点击组织仓库右侧的“查看”管理详情、成员与管理员。</p></div>
          <h3 class="section-title">仓库容量与额度</h3>
          <div class="toolbar"><input id="adminQuotaQ" placeholder="筛选仓库"><button id="adminQuotaLoad" class="primary">查询</button></div>
          <div id="adminQuotaOverall" class="stats"></div>
          <div id="adminQuotaTable" class="panel tablewrap"></div>
        </section>
        <section id="adminMismatches" class="hidden">
          <div class="toolbar">
            <select id="adminMmStatus"><option value="open">未处理</option><option value="resolved">已处理</option></select>
            <select id="adminMmKind"><option value="">全部类型</option><option value="extra">多余</option><option value="missing">缺失</option></select>
            <input id="adminMmItem" placeholder="按物品筛选">
            <button id="adminMmLoad" class="primary">查询</button>
          </div>
          <div id="adminMmStats" class="stats"></div>
          <div class="toolbar mismatch-batch">
            <span id="adminMmBatchCount" class="muted">未勾选</span>
            <button type="button" data-admin-mm-select="extra">全选多余</button>
            <button type="button" data-admin-mm-select="missing">全选缺失</button>
            <button type="button" data-admin-mm-select="none">取消勾选</button>
            <select id="adminMmBatchTarget" title="批量转入目标仓库"><option value="">批量转入目标仓库</option></select>
            <button id="adminMmBatchResolve" class="primary">批量转入</button>
            <button id="adminMmBatchDeduct" class="danger">批量清除</button>
          </div>
          <div class="mismatch-columns">
            <div><h3>多余物品</h3><div id="adminMmExtra" class="panel admin-grid-panel"></div></div>
            <div><h3>缺失物品</h3><div id="adminMmMissing" class="panel admin-grid-panel"></div></div>
          </div>
        </section>
        <section id="adminChests" class="hidden">
          <div class="toolbar">
            <input id="adminChestQ" placeholder="搜索物品名/ID/短码/别名（含盒内物品）或坐标">
            <input id="adminChestX" placeholder="X 过滤，如 120 或 120..130">
            <input id="adminChestY" placeholder="Y 过滤">
            <input id="adminChestZ" placeholder="Z 过滤">
            <select id="adminChestSort"><option value="coords">按坐标</option><option value="amount">按总数</option><option value="slots">按格数</option><option value="matched">按命中数</option><option value="updated">按更新时间</option></select>
            <button id="adminChestLoad" class="primary">查询</button>
            <button id="adminChestRefresh" class="primary">刷新</button>
          </div>
          <div id="adminChestStats" class="stats"></div>
          <div class="chest-layout">
            <div id="adminChestMap" class="panel chest-map-panel"></div>
            <div id="adminChestListWrap" class="panel tablewrap chest-list-panel">
              <table><thead><tr><th>坐标</th><th>方块</th><th>物品格</th><th>总数</th><th>潜影盒</th><th>最近同步</th><th></th></tr></thead><tbody id="adminChestList"></tbody></table>
            </div>
          </div>
          <div id="adminChestDetail" class="panel alias-detail-panel chest-detail-panel hidden"></div>
        </section>
        <section id="adminTransactions" class="hidden">
          <div class="toolbar">
            <input id="adminTxOwner" placeholder="目标仓库/玩家">
            <input id="adminTxType" placeholder="类型">
            <input id="adminTxOperator" placeholder="操作者">
            <input id="adminTxItem" placeholder="物品（含潜影盒内容）">
            <select id="adminTxStatus"><option value="">全部状态</option><option value="ok">成功</option><option value="failed">失败</option></select>
            <input id="adminTxFrom" type="date" title="开始日期">
            <input id="adminTxTo" type="date" title="结束日期">
            <input id="adminTxQ" placeholder="Bot/备注/操作者/其他字段">
            <button id="adminTxLoad" class="primary">查询</button>
          </div>
          <div id="adminTxTable" class="panel tablewrap"></div>
          <div class="pager"><button id="adminTxPrev">上一页</button><span id="adminTxPage">第 1 / 1 页</span><button id="adminTxNext">下一页</button></div>
        </section>
        <section id="adminCommands" class="hidden">
          <div class="toolbar">
            <select id="adminCommandChannel"><option value="">全部来源</option><option value="public">公屏</option><option value="private">私信</option></select>
            <input id="adminCommandQ" placeholder="玩家/命令/Bot/回复内容">
            <button id="adminCommandLoad" class="primary">查询</button>
          </div>
          <div id="adminCommandTable" class="panel tablewrap"></div>
          <div class="pager"><button id="adminCommandPrev">上一页</button><span id="adminCommandPage">第 1 / 1 页</span><button id="adminCommandNext">下一页</button></div>
        </section>
        <section id="adminAliases" class="hidden">
          <div class="toolbar">
            <input id="adminAliasQ" placeholder="按别名/短码/ID/NBT筛选">
            <button id="adminAliasLoad" class="primary">查询</button>
          </div>
          <div id="adminAliasGrid" class="panel admin-grid-panel"></div>
          <div id="adminAliasDetail" class="panel alias-detail-panel"><p class="muted">点击上方物品图标管理全局别名。</p></div>
        </section>
        <section id="adminLogs" class="hidden">
          <div class="admin-logs-layout">
            <div class="panel" style="padding:14px">
              <h3>终端实时日志</h3>
              <p class="muted">机器人控制台的最新输出（环形缓冲 5000 条滚动）。每 3 秒自动刷新，可暂停。</p>
              <div class="alias-add">
                <button id="adminLogPause" class="primary">暂停刷新</button>
                <button id="adminLogClear" class="primary">清屏</button>
                <span id="adminLogStatus" class="muted"></span>
              </div>
              <pre id="adminLogConsole" class="log-console"></pre>
            </div>
            <div class="panel" style="padding:14px">
              <h3>logs 目录文件</h3>
              <p class="muted">点击文件查看内容（默认读末尾 256KB）。</p>
              <div id="adminLogFileList" class="log-file-list"></div>
              <div id="adminLogViewerWrap" class="hidden">
                <div class="alias-add" style="margin-top:12px">
                  <strong id="adminLogFileName"></strong>
                  <span id="adminLogFileMeta" class="muted"></span>
                  <button id="adminLogFileClose" class="primary">关闭</button>
                  <button id="adminLogFileRefresh" class="primary">刷新</button>
                  <button id="adminLogFileTail" class="primary">跟踪末尾 1MB</button>
                </div>
                <pre id="adminLogFileView" class="log-console"></pre>
              </div>
            </div>
          </div>
        </section>
      </section>
      <p id="toast" class="toast"></p>
    </main>
  </div>
  <div id="nbtModal" class="nbt-modal-backdrop hidden">
    <div class="nbt-modal" role="dialog" aria-modal="true">
      <div class="nbt-head">
        <div id="nbtModalTitle" class="nbt-title">物品详情</div>
        <button id="nbtCopy" class="primary">复制</button>
        <button id="nbtClose" class="ghost">关闭</button>
      </div>
      <div class="nbt-body">
        <div id="aliasEditor" class="alias-form hidden">
          <input id="aliasInput" placeholder="新增一个个人别名">
          <button id="aliasSave" class="solid">添加别名</button>
          <div id="aliasExisting" class="alias-tags"></div>
          <label class="check-label"><input id="aliasUseDisplayName" type="checkbox"> 同时修改我的库存显示名称</label>
          <div id="aliasNote" class="alias-note"></div>
        </div>
        <div id="globalAliasEditor" class="alias-form hidden">
          <input id="globalAliasInput" placeholder="新增一个全局别名">
          <select id="globalAliasCategory"><option value="normal">正常物品</option><option value="variant">同 ID 物品</option></select>
          <button id="globalAliasSave" class="solid">添加全局别名</button>
          <div id="globalAliasExisting" class="alias-tags"></div>
          <label class="check-label"><input id="globalAliasUseDisplayName" type="checkbox"> 同时修改所有库存中的显示名称</label>
          <div id="globalAliasNote" class="alias-note"></div>
        </div>
        <pre id="nbtModalText"></pre>
      </div>
      <div class="nbt-foot"><span id="nbtModalHint" class="muted"></span></div>
    </div>
  </div>
  <div id="tooltip" class="tooltip"></div>

  <script>
    const state = { view: 'inventory', myTab: 'organizations', myPersonalAliasItemKey: '', myGlobalAliasItemKey: '', user: null, owners: [], owner: '', items: [], tx: [], txPage: 1, txTotalPages: 1, selected: new Map(), aliasMode: false, aliasItem: null, adminTab: 'inventory', adminAliasMode: false, adminGlobalAliasItem: null, adminOrganizationName: '', adminInventoryLoadId: 0, adminOwners: [], adminInventoryRows: new Map(), adminMismatchRows: new Map(), adminSelected: new Map(), adminAliasItem: null, adminTxPage: 1, adminTxTotalPages: 1, adminPaymentPage: 1, adminPaymentTotalPages: 1, actionCooldownUntil: 0, actionCooldownTimer: null, iconRenderId: 0, activePoll: null, iconCache: new Map(), inventoryCache: new Map(), inventoryLoadId: 0, shulkerBoxView: false, bulkItems: [], lastInventoryStats: null, iconScrollTimer: null, tipLocked: false, onlinePlayersTimer: null, loginChallengeTimer: null, loginChallengeExpiresAt: 0, loginChallengeCommand: '', subscriptionData: null, subscriptionOrganizationOwner: '', adminSubscriptionUserUuid: '' };
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const num = value => Number(value || 0).toLocaleString('zh-CN');
    const money = cents => (Number(cents || 0) / 100).toFixed(2);
    const dateTime = value => Number(value || 0) > 0 ? new Date(Number(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    const toast = text => { $('toast').textContent = text || ''; };

    async function api(path, params = {}) {
      const url = new URL(path, location.origin);
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      });
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        if (res.status === 401 && path !== '/api/me') loadMe().catch(() => {});
        throw new Error(data.error || res.statusText);
      }
      return data;
    }

    async function post(path, body = {}) {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        if (res.status === 401) loadMe().catch(() => {});
        throw new Error(data.error || res.statusText);
      }
      return data;
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取投影文件失败。'));
        reader.readAsDataURL(file);
      });
    }

    async function copyText(text) {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!ok) throw new Error('浏览器禁止自动复制，请手动选中验证码命令复制。');
      return true;
    }

    function actionButtons() {
      return [$('deposit'), $('withdraw')].filter(Boolean);
    }

    function updateActionCooldown() {
      const remainingMs = state.actionCooldownUntil - Date.now();
      const cooling = remainingMs > 0;
      for (const button of actionButtons()) {
        if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
        button.disabled = cooling;
        button.textContent = cooling ? '冷却 ' + Math.ceil(remainingMs / 1000) + 's' : button.dataset.defaultText;
      }
      if (!cooling && state.actionCooldownTimer) {
        clearInterval(state.actionCooldownTimer);
        state.actionCooldownTimer = null;
      }
    }

    function startActionCooldown(ms = 3000) {
      state.actionCooldownUntil = Date.now() + ms;
      updateActionCooldown();
      if (state.actionCooldownTimer) clearInterval(state.actionCooldownTimer);
      state.actionCooldownTimer = setInterval(updateActionCooldown, 200);
    }

    async function runWebAction(action) {
      if (Date.now() < state.actionCooldownUntil) {
        toast('操作冷却中，请稍后再点。');
        return;
      }
      startActionCooldown(3000);
      await action();
    }

    async function runButtonTask(button, runningText, doneText, action) {
      if (!button || button.disabled) return;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = runningText;
      try {
        await action();
        button.textContent = doneText;
        toast(doneText);
        setTimeout(() => {
          button.textContent = oldText;
          button.disabled = false;
        }, 900);
      } catch (error) {
        button.textContent = oldText;
        button.disabled = false;
        throw error;
      }
    }

    function iconUrl(itemId, type = 'item') {
      return 'https://blocksitems.com/api/v1/' + type + 's/' + encodeURIComponent(itemId || 'minecraft:stone') + '/icon?size=64';
    }

    function setIcon(img, item, done) {
      const cached = state.iconCache.get(item.itemId);
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onload = () => {
        state.iconCache.set(item.itemId, img.src);
        if (typeof done === 'function') done();
      };
      img.onerror = () => {
        if (img.dataset.fallback) {
          img.style.display = 'none';
          img.parentElement.querySelector('.fallback').style.display = 'block';
          if (typeof done === 'function') done();
          return;
        }
        img.dataset.fallback = '1';
        img.src = iconUrl(item.itemId, 'block');
      };
      img.src = cached || iconUrl(item.itemId, 'item');
    }

    function scheduleIconLoading(rows) {
      const renderId = ++state.iconRenderId;
      const images = new Map([...document.querySelectorAll('.icon img[data-key]')].map(img => [img.dataset.key, img]));
      const visibleKeys = new Set();
      const viewportBottom = window.innerHeight + 260;
      for (const img of images.values()) {
        const rect = img.getBoundingClientRect();
        if (rect.top <= viewportBottom && rect.bottom >= -160) visibleKeys.add(img.dataset.key);
      }
      // Only enqueue items near the viewport, but do not cap the number of
      // visible items. The main content can show more than 180 icons on wide
      // screens, and a hard cap leaves the rest without a src forever.
      const queue = rows.filter(row => visibleKeys.has(row.itemKey));
      let active = 0;
      const limit = 4;
      const pump = () => {
        if (renderId !== state.iconRenderId) return;
        while (active < limit && queue.length) {
          const item = queue.shift();
          const img = images.get(item.itemKey);
          if (!img || img.dataset.loaded) continue;
          active += 1;
          img.dataset.loaded = '1';
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            active -= 1;
            pump();
          };
          setIcon(img, item, finish);
        }
      };
      setTimeout(pump, 0);
    }

    function updateActiveStatus(active) {
      const el = $('activeStatus');
      if (!active) {
        el.classList.add('hidden');
        el.textContent = '';
        if (state.activePoll) {
          clearInterval(state.activePoll);
          state.activePoll = null;
        }
        return;
      }
      el.classList.remove('hidden');
      const target = active.targetUsername && active.targetUsername !== active.username ? '，目标 ' + active.targetUsername : '';
      el.textContent = (active.message || '任务进行中') + '：' + active.username + target;
      if (!state.activePoll) {
        state.activePoll = setInterval(async () => {
          try {
            const data = await api('/api/me');
            updateActiveStatus(data.active);
          } catch {}
        }, 1000);
      }
    }

    function updateBotNameLabels(botName) {
      for (const el of document.querySelectorAll('.help-bot')) {
        el.textContent = botName || 'bot';
      }
    }

    async function loadMe() {
      const data = await api('/api/me');
      if (!data.loggedIn) {
        $('app').classList.add('hidden');
        $('login').classList.remove('hidden');
        const botName = data.botName || 'bot';
        $('loginCommand').textContent = '/msg ' + botName + ' 设置密码 xxx';
        $('loginExample').textContent = '/msg ' + botName + ' 设置密码 1234';
        updateBotNameLabels(botName);
        resetLoginChallengeUi(true);
        return;
      }
      stopLoginChallengePoll();
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      state.user = data.user;
      state.owners = data.owners || [];
      state.defaultOwnerUuid = data.defaultOwnerUuid || '';
      state.subscriptionData = data.subscriptions || state.subscriptionData;
      updateBotNameLabels(data.botName || 'bot');
      $('username').textContent = state.user.username;
      $('heroName').textContent = state.user.username;
      $('adminLink').classList.toggle('hidden', !state.user.isAdmin);
      $('warehouseAdminLink').classList.toggle('hidden', !state.user.isWarehouseAdmin);
      renderOwners();
      renderSidebarSubscription();
      if (data.autoRegistrationMessage) toast(data.autoRegistrationMessage);
      await loadInventory();
      loadOnlinePlayers('').catch(error => toast(error.message));
      if (state.user.isAdmin && location.pathname === '/admin') setView('admin');
    }

    async function loginWithToken() {
      const token = $('tokenInput').value.trim();
      if (!token) return toast('请填写登录密码。');
      try {
        await post('/api/login', { token });
        $('tokenInput').value = '';
        await loadMe();
        toast('');
      } catch (error) {
        toast(error.message);
      }
    }

    function setLoginMode(mode) {
      const codeMode = mode === 'code';
      $('loginCodeTab').classList.toggle('active', codeMode);
      $('loginTokenTab').classList.toggle('active', !codeMode);
      $('loginCodePanel').classList.toggle('hidden', !codeMode);
      $('loginTokenPanel').classList.toggle('hidden', codeMode);
      if (!codeMode) cancelLoginChallenge().catch(() => {});
    }

    function stopLoginChallengePoll() {
      if (state.loginChallengeTimer) {
        clearInterval(state.loginChallengeTimer);
        state.loginChallengeTimer = null;
      }
    }

    function resetLoginChallengeUi(showStart = true) {
      stopLoginChallengePoll();
      state.loginChallengeExpiresAt = 0;
      state.loginChallengeCommand = '';
      if ($('loginCodeStart')) $('loginCodeStart').classList.toggle('hidden', !showStart);
      if ($('loginCodeWait')) $('loginCodeWait').classList.add('hidden');
      if ($('loginCodeStatus')) $('loginCodeStatus').textContent = '等待验证...';
    }

    function updateLoginChallengeCountdown() {
      if (!state.loginChallengeExpiresAt) return;
      const remaining = Math.max(0, state.loginChallengeExpiresAt - Date.now());
      $('loginCodeStatus').textContent = remaining > 0
        ? '等待游戏内验证，剩余 ' + Math.ceil(remaining / 1000) + ' 秒。'
        : '验证码已过期，请重新获取。';
    }

    async function startLoginChallenge() {
      try {
        const data = await post('/api/login/challenge');
        if (data.loggedIn) {
          await loadMe();
          return;
        }
        state.loginChallengeExpiresAt = Number(data.expiresAt || 0);
        state.loginChallengeCommand = data.command || '';
        $('loginCodeCommand').textContent = state.loginChallengeCommand;
        $('loginCodeStart').classList.add('hidden');
        $('loginCodeWait').classList.remove('hidden');
        updateLoginChallengeCountdown();
        stopLoginChallengePoll();
        state.loginChallengeTimer = setInterval(pollLoginChallenge, 1000);
        pollLoginChallenge().catch(error => toast(error.message));
      } catch (error) {
        toast(error.message);
      }
    }

    async function pollLoginChallenge() {
      const data = await api('/api/login/challenge');
      if (data.status === 'approved') {
        stopLoginChallengePoll();
        await loadMe();
        toast('');
        return;
      }
      if (data.status === 'expired') {
        stopLoginChallengePoll();
        $('loginCodeStatus').textContent = '验证码已过期，请重新获取。';
        $('loginCodeStart').classList.remove('hidden');
        return;
      }
      if (data.status === 'cancelled' || data.status === 'none') {
        resetLoginChallengeUi(true);
        return;
      }
      if (data.command) {
        state.loginChallengeCommand = data.command;
        $('loginCodeCommand').textContent = data.command;
      }
      if (data.expiresAt) state.loginChallengeExpiresAt = Number(data.expiresAt);
      updateLoginChallengeCountdown();
    }

    async function cancelLoginChallenge() {
      stopLoginChallengePoll();
      try {
        await post('/api/login/challenge/cancel');
      } finally {
        resetLoginChallengeUi(true);
      }
    }

    async function copyLoginChallengeCommand() {
      if (!state.loginChallengeCommand) return toast('还没有可复制的验证码命令。');
      await copyText(state.loginChallengeCommand);
      const button = $('loginCodeCopy');
      const oldText = button.textContent;
      button.textContent = '已复制';
      button.disabled = true;
      toast('已复制临时验证码命令。');
      setTimeout(() => {
        button.textContent = oldText;
        button.disabled = false;
      }, 1200);
    }

    function renderOwners() {
      if (!state.owners.length) {
        $('owner').innerHTML = '<option value="">没有可用仓库</option>';
        state.owner = '';
        $('setDefaultOwner').disabled = true;
        $('deposit').disabled = true;
        $('withdraw').disabled = true;
        $('txOwner').innerHTML = '<option value="">没有可用仓库</option>';
        renderSidebarSubscription();
        return;
      }
      $('owner').innerHTML = state.owners.map(owner => {
        const label = owner.label + (owner.isDefault ? '（默认）' : '');
        return '<option value="' + esc(owner.ownerUuid) + '">' + esc(label) + '</option>';
      }).join('');
      const fallbackOwner = state.owners.find(owner => owner.ownerUuid === state.defaultOwnerUuid)?.ownerUuid || state.owners[0]?.ownerUuid || '';
      state.owner = state.owner && state.owners.some(owner => owner.ownerUuid === state.owner) ? state.owner : fallbackOwner;
      $('owner').value = state.owner;
      const txValue = $('txOwner').value || state.owner;
      $('txOwner').innerHTML = state.owners.map(owner => '<option value="' + esc(owner.ownerUuid) + '">' + esc(owner.label) + '</option>').join('');
      $('txOwner').value = state.owners.some(owner => owner.ownerUuid === txValue) ? txValue : state.owner;
      const selected = state.owners.find(owner => owner.ownerUuid === state.owner);
      if ($('setDefaultOwner')) {
        $('setDefaultOwner').textContent = selected?.isDefault ? '默认仓库' : '设为默认';
        $('setDefaultOwner').disabled = Boolean(selected?.isDefault);
      }
      $('deposit').disabled = false;
      $('withdraw').disabled = false;
      renderSidebarSubscription();
    }

    async function setDefaultOwner() {
      const ownerUuid = $('owner').value || state.owner;
      if (!ownerUuid) return toast('请先选择仓库。');
      const data = await post('/api/default-owner', { ownerUuid });
      state.owners = data.owners || state.owners;
      state.defaultOwnerUuid = data.defaultOwnerUuid || ownerUuid;
      renderOwners();
      toast(data.message || '已设置默认仓库。');
    }

    function subscriptionStatusText(entitlement) {
      if (!entitlement) return '尚未创建';
      if (entitlement.quotaMode === 'custom') return '自定义版 · ' + num(entitlement.quotaSlots) + ' 格';
      const name = entitlement.plan?.name || (entitlement.scope === 'custom' ? '未订阅' : '免费版');
      const expiry = entitlement.expiresAtMs ? ' · ' + dateTime(entitlement.expiresAtMs) + ' 到期' : (entitlement.scope === 'personal' ? ' · 长期有效' : '');
      return name + ' · ' + num(entitlement.quotaSlots) + ' 格' + expiry;
    }

    function renderSidebarSubscription() {
      const data = state.subscriptionData;
      if (!data) return;
      const entitlement = data.ownerEntitlements?.[state.owner] || (state.owner === state.user?.uuid ? data.personal : null);
      $('sidebarSubscription').innerHTML = '<strong>' + money(data.wallet?.balanceCents) + ' TSLC</strong><span>' + esc(subscriptionStatusText(entitlement)) + '</span>';
    }

    function subscriptionPlanCard(plan, ownerUuid, entitlement) {
      const active = entitlement?.activePlanId === plan.id && entitlement?.status === 'active';
      const isFreeBase = plan.id === 'personal_free';
      const insufficient = Number(state.subscriptionData?.wallet?.balanceCents || 0) < Number(plan.priceCents || 0);
      const unavailable = !ownerUuid || isFreeBase || insufficient;
      const buttonText = !ownerUuid ? '尚未创建仓库' : (isFreeBase ? '默认套餐' : (insufficient ? '余额不足' : (active ? '续费 30 天' : '订阅 30 天')));
      return '<article class="plan-card' + (!isFreeBase ? ' featured' : '') + '">' +
        '<div class="muted">' + esc(plan.scope === 'personal' ? '个人仓库' : '组织仓库') + '</div>' +
        '<h3>' + esc(plan.name) + '</h3><div class="muted">' + esc(plan.description) + '</div>' +
        '<div class="plan-price">' + (!isFreeBase ? money(plan.priceCents) + ' TSLC <small>/ 30天</small>' : '免费 <small>/ 长期</small>') + '</div>' +
        '<ul class="plan-features">' + (plan.features || []).map(feature => '<li>' + esc(feature) + '</li>').join('') + '</ul>' +
        '<button class="' + (!isFreeBase ? 'solid' : 'ghost') + '" data-subscription-purchase data-owner="' + esc(ownerUuid || '') + '" data-plan="' + esc(plan.id) + '"' + (unavailable ? ' disabled' : '') + '>' + buttonText + '</button>' +
      '</article>';
    }

    async function loadSubscriptions() {
      const data = await api('/api/subscriptions');
      state.subscriptionData = data;
      $('subscriptionBalance').textContent = money(data.wallet?.balanceCents) + ' TSLC';
      $('subscriptionTimeStatus').textContent = data.time?.trusted ? '网络时间已同步 · ' + dateTime(data.time.now) : '网络时间未同步，购买与自动注册暂停';
      $('subscriptionTopupBots').textContent = data.onlineBots?.length ? '在线收款 Bot：' + data.onlineBots.join('、') : '当前没有在线收款 Bot';
      $('personalSubscriptionStatus').textContent = subscriptionStatusText(data.personal);
      $('personalSubscriptionStatus').classList.toggle('active', data.personal?.status === 'active');
      $('personalPlanGrid').innerHTML = (data.plans || []).filter(plan => plan.scope === 'personal').map(plan => subscriptionPlanCard(plan, state.user?.uuid && data.personal ? state.user.uuid : '', data.personal)).join('');

      const organizations = data.organizations || [];
      if (!state.subscriptionOrganizationOwner || !organizations.some(row => row.ownerUuid === state.subscriptionOrganizationOwner)) state.subscriptionOrganizationOwner = organizations[0]?.ownerUuid || '';
      $('subscriptionOrganization').innerHTML = organizations.length
        ? organizations.map(row => '<option value="' + esc(row.ownerUuid) + '">' + esc(row.name) + '</option>').join('')
        : '<option value="">没有可管理的组织仓库</option>';
      $('subscriptionOrganization').value = state.subscriptionOrganizationOwner;
      $('subscriptionOrganizationCreate').classList.toggle('hidden', !data.canCreateOrganization);
      const organization = organizations.find(row => row.ownerUuid === state.subscriptionOrganizationOwner);
      $('organizationSubscriptionStatus').textContent = organization ? subscriptionStatusText(organization.entitlement) : '未选择仓库';
      $('organizationSubscriptionStatus').classList.toggle('active', organization?.entitlement?.status === 'active');
      $('organizationPlanGrid').innerHTML = (data.plans || []).filter(plan => plan.scope === 'custom').map(plan => subscriptionPlanCard(plan, organization?.ownerUuid || '', organization?.entitlement)).join('');
      renderTable('subscriptionOrders', ['时间', '仓库', '套餐', '实付', '到期日'], (data.orders || []).map(row =>
        '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(state.owners.find(owner => owner.ownerUuid === row.ownerUuid)?.label || row.ownerUuid) + '</td><td>' + esc(row.planName) + '</td><td>' + money(row.priceCents) + ' TSLC</td><td>' + esc(dateTime(row.newExpiresAtMs)) + '</td></tr>'
      ), '还没有订购记录。');
      renderSidebarSubscription();
    }

    async function purchaseSubscription(button) {
      const plan = state.subscriptionData?.plans?.find(row => row.id === button.dataset.plan);
      const ownerUuid = button.dataset.owner;
      if (!plan || !ownerUuid) return;
      const ownerLabel = state.owners.find(owner => owner.ownerUuid === ownerUuid)?.label || ownerUuid;
      const balanceAfter = Number(state.subscriptionData?.wallet?.balanceCents || 0) - Number(plan.priceCents || 0);
      if (!confirm('确认订阅？\\n仓库：' + ownerLabel + '\\n套餐：' + plan.name + '\\n扣款：' + money(plan.priceCents) + ' TSLC\\n购买后余额：' + money(balanceAfter) + ' TSLC\\n有效期：30天')) return;
      const result = await post('/api/subscriptions/purchase', { ownerUuid, planId: plan.id });
      toast(result.message);
      await loadSubscriptions();
      await loadMe();
    }

    async function createSubscriptionOrganization() {
      const name = $('subscriptionOrganizationName').value.trim();
      if (!name) throw new Error('请填写组织仓库名。');
      if (!confirm('确认创建组织仓库“' + name + '”？创建免费，初始额度为 0 格，购买组织套餐后才能存入。')) return;
      const result = await post('/api/subscriptions/organization/create', { name });
      toast(result.message);
      $('subscriptionOrganizationName').value = '';
      state.subscriptionOrganizationOwner = 'vault:' + String(result.warehouse.nameLower || '');
      await loadMe();
      await loadSubscriptions();
    }

    function applyInventoryData(data) {
      state.items = data.items || [];
      state.lastInventoryStats = data.stats || null;
      state.bulkItems = flattenBulkItems(state.items);
      updateActiveStatus(data.active);
      state.selected.clear();
      renderLitematicPlan(null);
      updateInventoryHeroStats();
      // 任务占用中的数量（预留已挂起、账还没扣）：提示玩家这部分暂时不可取。
      const reservedAmount = Number(data.stats?.reservedAmount || 0);
      $('heroReserved').textContent = reservedAmount > 0 ? '任务占用中 ' + num(reservedAmount) + ' 件' : '';
      $('inventoryQuota').textContent = '仓库额度 ' + num(data.quota?.usedSlots || 0) + '/' + num(data.quota?.quotaSlots || 0) + '格';
      renderSelected();
      renderInventory();
    }

    function updateInventoryHeroStats() {
      if (state.shulkerBoxView) {
        $('heroTypes').textContent = num(state.lastInventoryStats?.itemTypes || 0);
        $('heroAmount').textContent = num(state.lastInventoryStats?.totalAmount || 0);
        return;
      }
      $('heroTypes').textContent = num(state.bulkItems.length);
      $('heroAmount').textContent = num(state.bulkItems.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    }

    async function loadInventory(options = {}) {
      state.owner = $('owner').value || state.owner;
      if (!state.owner) {
        state.items = [];
        state.bulkItems = [];
        state.selected.clear();
        $('heroTypes').textContent = '0';
        $('heroAmount').textContent = '0';
        $('inventoryQuota').textContent = '当前没有可用仓库';
        $('loaded').textContent = '0/0 种已加载';
        $('inventory').innerHTML = '<div class="empty-state"><div class="empty-icon">▦</div><h3>没有可用仓库</h3><p>请联系云仓库管理员创建个人仓库，或让组织仓库管理员把你加入组织仓库。</p></div>';
        renderSelected();
        return;
      }
      const loadId = ++state.inventoryLoadId;
      const cached = state.inventoryCache.get(state.owner);
      if (cached && !options.force) {
        applyInventoryData(cached);
      }
      const data = await api('/api/inventory', { owner: state.owner });
      if (loadId !== state.inventoryLoadId) return;
      state.inventoryCache.set(state.owner, data);
      applyInventoryData(data);
    }

    async function loadOnlinePlayers(query = '') {
      const data = await api('/api/online-players', { q: query });
      const rows = data.rows || [];
      renderOnlinePlayers(rows);
    }

    function renderOnlinePlayers(rows) {
      const menu = $('onlinePlayers');
      if (!document.activeElement || document.activeElement !== $('targetPlayer')) return;
      menu.classList.remove('hidden');
      if (!rows.length) {
        menu.innerHTML = '<div class="player-empty">没有匹配的在线玩家</div>';
        return;
      }
      menu.innerHTML = rows.slice(0, 30).map(row => {
        const label = row.currentUser ? row.username + '（自己）' : row.username;
        const ping = Number.isFinite(row.ping) ? row.ping + 'ms' : 'tab';
        return '<button type="button" class="player-option" data-online-player="' + esc(row.username) + '">' +
          '<span>' + esc(label) + '</span>' +
          '<span class="ping">' + esc(ping) + '</span>' +
        '</button>';
      }).join('');
    }

    function scheduleOnlinePlayersLoad() {
      if (state.onlinePlayersTimer) clearTimeout(state.onlinePlayersTimer);
      state.onlinePlayersTimer = setTimeout(() => {
        loadOnlinePlayers($('targetPlayer').value).catch(error => toast(error.message));
      }, 180);
    }

    function hideOnlinePlayers() {
      $('onlinePlayers').classList.add('hidden');
    }

    function transactionItemsHtml(items, tooltipItems) {
      if (!items?.length) return '<span class="muted">无</span>';
      return items.map(item => {
        const name = item.displayName || item.itemId;
        const isShulker = String(item.itemId || '').endsWith('shulker_box');
        let tooltipKey = '';
        if (isShulker && tooltipItems) {
          tooltipKey = String(tooltipItems.size);
          tooltipItems.set(tooltipKey, item);
        }
        return '<span class="alias-tag' + (isShulker ? ' transaction-shulker' : '') + '"' + (tooltipKey ? ' data-transaction-tip="' + esc(tooltipKey) + '"' : '') + '>' + esc(name) + ' x' + num(item.amount) + '</span>';
      }).join(' ');
    }

    function itemText(item) {
      return [item.displayName, item.adminDisplayName, item.baseDisplayName, ...(item.personalAliases || []), ...(item.globalAliases || []), item.itemId, item.itemKey, item.shortCode, item.nbtJson, item.metaJson, ...(item.shulkerContents || []).map(x => x.displayName + ' ' + x.adminDisplayName + ' ' + x.baseDisplayName + ' ' + (x.personalAliases || []).join(' ') + ' ' + (x.globalAliases || []).join(' ') + ' ' + x.itemId + ' ' + x.shortCode)].join(' ').toLowerCase();
    }

    function shortCount(value) {
      const n = Number(value || 0);
      if (n >= 1000000) return Math.floor(n / 100000) / 10 + 'm';
      if (n >= 10000) return Math.floor(n / 1000) + 'k';
      return String(n);
    }

    function tooltipHtml(item) {
      const shulker = item.shulkerContents || [];
      const lines = [
        '<div class="tip-title">' + esc(item.displayName || item.itemId) + '</div>',
        item.personalAliases?.length ? '<div class="tip-line">个人别名：' + esc(item.personalAliases.join('、')) + '</div>' : '',
        item.globalAliases?.length ? '<div class="tip-line">全局别名：' + esc(item.globalAliases.join('、')) + '</div>' : '',
        item.adminDisplayName && item.adminDisplayName !== item.displayName ? '<div class="tip-line">默认名：' + esc(item.adminDisplayName) + '</div>' : '',
        item.ownerLabel ? '<div class="tip-line">归属：' + esc(item.ownerLabel) + '</div>' : '',
        '<div class="tip-line">可取：' + num(item.available ?? item.amount) + (Number(item.reserved || 0) > 0 ? '（总量 ' + num(item.amount) + '，预留 ' + num(item.reserved) + '）' : '') + bulkAmountSuffix(item) + '</div>',
        '<div class="tip-line">ID：' + esc(item.itemId) + '</div>'
      ].filter(Boolean);
      if (shulker.length) {
        lines.push('<div class="tip-line">潜影盒内容：</div>');
        const emptySlots = Array.from({ length: Math.max(0, 27 - shulker.length) }, () => '<div class="tip-slot empty" aria-hidden="true"></div>').join('');
        lines.push('<div class="tip-grid">' + shulker.map(x =>
          '<div class="tip-slot" role="img" data-tip-name="' + esc(x.displayName || x.itemId) + '" data-tip-amount="' + esc(x.amount) + '" aria-label="' + esc((x.displayName || x.itemId) + '，数量 ' + num(x.amount)) + '">' +
          '<img data-tip-icon="' + esc(x.itemId) + '" alt="">' +
          '<span>' + esc(shortCount(x.amount)) + '</span>' +
          '</div>'
        ).join('') + emptySlots + '</div><div class="tip-slot-detail" data-tip-slot-detail aria-live="polite"></div>');
      }
      return lines.join('');
    }

    function bulkAmountSuffix(item) {
      const boxed = Number(item.boxedAmount || 0);
      if (boxed <= 0) return '';
      const loose = Number(item.looseAmount || 0);
      return loose > 0 ? '（散装 ' + num(loose) + ' + 盒内 ' + num(boxed) + '）' : '（盒内）';
    }

    function bindTipSlotNames(tip) {
      const detail = tip.querySelector('[data-tip-slot-detail]');
      if (!detail) return;
      for (const slot of tip.querySelectorAll('[data-tip-name]')) {
        slot.addEventListener('mouseenter', () => {
          detail.textContent = slot.dataset.tipName + ' ×' + num(slot.dataset.tipAmount);
        });
      }
    }

    function lockTip() {
      const tip = $('tooltip');
      if (tip.style.display !== 'block' || !tip.classList.contains('shulker-tip')) return;
      state.tipLocked = true;
      tip.classList.add('locked');
    }

    function closeTip() {
      state.tipLocked = false;
      const tip = $('tooltip');
      tip.classList.remove('locked');
      tip.style.display = 'none';
    }

    function showTip(event, item) {
      if (!canHoverTooltip()) return;
      if (state.tipLocked) return;
      const tip = $('tooltip');
      tip.innerHTML = tooltipHtml(item);
      tip.classList.toggle('shulker-tip', Boolean(item.shulkerContents?.length));
      tip.style.display = 'block';
      moveTip(event);
      bindTipSlotNames(tip);
      for (const img of tip.querySelectorAll('[data-tip-icon]')) {
        const itemId = img.dataset.tipIcon;
        img.src = iconUrl(itemId, 'item');
        img.onerror = () => { img.style.display = 'none'; };
      }
      if (event.ctrlKey) lockTip();
    }

    function transactionTooltipHtml(item) {
      const contents = item.shulkerContents || [];
      const lines = [
        '<div class="tip-title">' + esc(item.displayName || item.itemId) + '</div>',
        '<div class="tip-line">交易数量：' + num(item.amount) + ' 盒</div>',
        '<div class="tip-line">盒内物品（每盒）</div>'
      ];
      if (contents.length) {
        lines.push('<div class="tip-text-list">' + contents.map(content =>
          '<div class="tip-text-row"><span>' + esc(content.displayName || content.itemId) + '</span><span>x' + num(content.amount) + '</span></div>'
        ).join('') + '</div>');
      } else {
        lines.push('<div class="tip-text-list"><div class="muted">潜影盒为空，或这条历史记录没有盒内物品索引。</div></div>');
      }
      return lines.join('');
    }

    function showTransactionTip(event, item) {
      if (!canHoverTooltip()) return;
      if (state.tipLocked) return;
      const tip = $('tooltip');
      tip.innerHTML = transactionTooltipHtml(item);
      tip.classList.remove('shulker-tip');
      tip.style.display = 'block';
      moveTip(event);
    }

    function bindTransactionTooltips(containerId, tooltipItems) {
      if (!canHoverTooltip()) return;
      for (const element of document.querySelectorAll('#' + containerId + ' [data-transaction-tip]')) {
        const item = tooltipItems.get(element.dataset.transactionTip);
        if (!item) continue;
        element.addEventListener('mouseenter', event => showTransactionTip(event, item));
        element.addEventListener('mousemove', moveTip);
        element.addEventListener('mouseleave', hideTip);
      }
    }

    function moveTip(event) {
      if (!canHoverTooltip()) return;
      if (state.tipLocked) return;
      const tip = $('tooltip');
      if (tip.style.display === 'none') return;
      const pad = 14;
      let x = event.clientX + pad;
      let y = event.clientY + pad;
      const rect = tip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
      tip.style.left = Math.max(8, x) + 'px';
      tip.style.top = Math.max(8, y) + 'px';
      if (event.ctrlKey) lockTip();
    }

    function hideTip() {
      if (state.tipLocked) return;
      closeTip();
    }

    function canHoverTooltip() {
      return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    }

    function defaultPickAmount(item) {
      const available = Math.max(0, Number(item.available ?? item.amount ?? 0));
      return Math.min(available, 64);
    }

    function toggleSelected(item) {
      hideTip();
      if (state.aliasMode) {
        openAliasModal(item);
        return;
      }
      if (state.selected.has(item.itemKey)) {
        state.selected.delete(item.itemKey);
      } else {
        if (defaultPickAmount(item) <= 0) return;
        state.selected.set(item.itemKey, {
          itemKey: item.itemKey,
          displayName: item.displayName || item.itemId,
          amount: defaultPickAmount(item),
          max: Number(item.available ?? item.amount ?? 0)
        });
      }
      renderSelected();
      renderInventory();
    }

    function pruneSelection() {
      const available = new Map(displayRows().map(row => [row.itemKey, row]));
      for (const [key, row] of [...state.selected]) {
        const item = available.get(key);
        if (!item) {
          state.selected.delete(key);
          continue;
        }
        row.displayName = item.displayName || row.displayName;
        row.max = Number(item.available ?? item.amount ?? 0);
        if (row.max <= 0) {
          state.selected.delete(key);
          continue;
        }
        row.amount = Math.max(1, Math.min(Number(row.amount || 1), row.max));
      }
    }

    function setAliasMode(enabled) {
      state.aliasMode = Boolean(enabled);
      $('aliasMode').classList.toggle('solid', state.aliasMode);
      $('aliasMode').textContent = state.aliasMode ? '退出别名' : '物品别名';
      $('inventory').classList.toggle('alias-mode', state.aliasMode);
      $('selectedList').innerHTML = state.aliasMode
        ? '<span class="selected-empty">别名模式：点击物品图标查看详情，可添加多个个人别名</span>'
        : (state.selected.size ? $('selectedList').innerHTML : '<span class="selected-empty">点击物品加入待取列表</span>');
      if (!state.aliasMode) renderSelected();
    }

    function renderSelected() {
      if (state.aliasMode) {
        $('selectedList').innerHTML = '<span class="selected-empty">别名模式：点击物品图标查看详情，可添加多个个人别名</span>';
        return;
      }
      const rows = [...state.selected.values()];
      if (!rows.length) {
        $('selectedList').innerHTML = '<span class="selected-empty">点击物品加入待取列表</span>';
        return;
      }
      $('selectedList').innerHTML = rows.map(row =>
        '<div class="pick" data-pick="' + esc(row.itemKey) + '">' +
        '<span class="pick-name" title="' + esc(row.displayName) + '">' + esc(row.displayName) + '</span>' +
        '<input type="number" min="1" max="' + esc(row.max || '') + '" value="' + esc(row.amount) + '" data-pick-amount>' +
        '<button class="ghost" data-pick-remove title="取消">×</button>' +
        '</div>'
      ).join('') + '<button id="clearSelected" class="ghost selected-clear" type="button">清空</button>';
      for (const input of document.querySelectorAll('[data-pick-amount]')) {
        input.addEventListener('change', () => {
          const key = input.closest('[data-pick]').dataset.pick;
          const row = state.selected.get(key);
          if (!row) return;
          const value = Number.parseInt(input.value, 10);
          row.amount = Math.max(1, Math.min(Number(row.max || value || 1), Number.isFinite(value) && value > 0 ? value : 1));
          input.value = row.amount;
        });
      }
      for (const button of document.querySelectorAll('[data-pick-remove]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const key = button.closest('[data-pick]').dataset.pick;
          state.selected.delete(key);
          renderSelected();
          renderInventory();
        });
      }
      $('clearSelected')?.addEventListener('click', event => {
        event.stopPropagation();
        state.selected.clear();
        renderSelected();
        renderInventory();
        toast('已清空取货列表。');
      });
    }

    function renderLitematicPlan(plan) {
      const el = $('litematicResult');
      if (!plan) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
      }

      const missing = plan.missing || [];
      const shortages = plan.shortage || plan.shortages || missing;
      const unavailable = plan.unavailable || [];
      const warnings = [];
      const boxedAmount = Number(plan.stats?.boxedSelectedAmount || 0);
      if (shortages.length) {
        const craftByItem = new Map((plan.craft || []).map(row => [row.itemId, row]));
        warnings.push('缺口：' + shortages.map(row => {
          const craft = craftByItem.get(row.itemId);
          const status = craft?.status === 'planned'
            ? '可合成'
            : craft
              ? '不可合成：' + (craft.reason || '暂无可用方案')
              : '暂无合成方案';
          const missingAmount = Number(row.missing || row.amount || 0);
          const availableAmount = Number(row.allocated ?? row.available ?? row.selected ?? 0);
          const requestedAmount = Number(row.requested ?? (availableAmount + missingAmount));
          return esc(row.displayName || row.itemId) + '：可取 ' + num(availableAmount) + '/' + num(requestedAmount) + '，缺口 ' + num(missingAmount) + '（' + esc(status) + '）';
        }).join('，'));
      }
      if (unavailable.length) {
        warnings.push('不可直接准备：' + unavailable.map(row => esc(row.displayName || row.blockId) + ' x' + num(row.amount)).join('，'));
      }

      el.classList.remove('hidden');
      el.innerHTML =
        '<div class="litematic-title">' + esc(plan.blueprint?.name || '投影') + '</div>' +
        '<div class="litematic-lines">' +
          '<span>已选 ' + num(plan.stats?.selectedTypes || 0) + ' 行</span>' +
          '<span>物品 ' + num(plan.stats?.selectedAmount || 0) + ' 个</span>' +
          (boxedAmount > 0 ? '<span>盒内补足 ' + num(boxedAmount) + ' 个</span>' : '') +
          '<span>预计格数 ' + num(plan.stats?.usedSlots || 0) + '</span>' +
          '<span>蓝图材料 ' + num(plan.blueprint?.materialTypes || 0) + ' 种</span>' +
        '</div>' +
        (warnings.length ? '<div class="litematic-warn">' + warnings.join('<br>') + '</div>' : '<div class="muted" style="margin-top:5px">材料已按当前库存自动加入待取列表' + (boxedAmount > 0 ? '，散装不足的部分会拆潜影盒取出' : '') + '。</div>');
    }

    function applyLitematicSelection(plan) {
      state.selected.clear();
      for (const row of plan.selected || []) {
        const max = Number(row.max ?? row.available ?? row.amount ?? 0);
        const amount = Math.min(Number(row.amount || 0), max);
        if (!row.itemKey || max <= 0 || amount <= 0) continue;
        state.selected.set(row.itemKey, {
          itemKey: row.itemKey,
          displayName: row.displayName || row.itemId,
          amount,
          max
        });
      }
      renderSelected();
      renderInventory();
    }

    async function uploadLitematic() {
      const input = $('litematicFile');
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (!/\\.litematic$/i.test(file.name)) throw new Error('只支持 .litematic 投影文件。');
        if (file.size > 8 * 1024 * 1024) throw new Error('投影文件过大，请控制在 8MB 以内。');
        toast('正在解析投影...');
        const dataUrl = await fileToDataUrl(file);
        const data = await post('/api/litematic/plan', {
          ownerUuid: state.owner,
          fileName: file.name,
          dataBase64: dataUrl,
          includeBoxed: !state.shulkerBoxView
        });
        applyLitematicSelection(data);
        renderLitematicPlan(data);
        toast((data.selected || []).length ? '已按投影自动加入待取列表。' : '投影已解析，但当前仓库没有可取材料。');
      } catch (error) {
        renderLitematicPlan(null);
        toast(error.message);
      } finally {
        input.value = '';
      }
    }

    function isShulkerItem(item) {
      return String(item.itemId || '').endsWith('shulker_box');
    }

    function displayRows() {
      return state.shulkerBoxView ? state.items : state.bulkItems;
    }

    function mergeBulkItem(merged, source, loose, boxed) {
      const key = source.itemKey || source.itemId;
      let target = merged.get(key);
      if (!target) {
        target = { ...source, shulkerContents: [], looseAmount: 0, boxedAmount: 0 };
        merged.set(key, target);
      }
      target.looseAmount += loose;
      target.boxedAmount += boxed;
      target.amount = target.looseAmount + target.boxedAmount;
      target.available = target.amount;
      target.reserved = 0;
    }

    // 散装视图：潜影盒本身不展示，盒内物品按 itemKey 与散装物品合并计数。
    function flattenBulkItems(items) {
      const merged = new Map();
      for (const item of items || []) {
        if (isShulkerItem(item)) {
          const boxCount = Math.max(0, Number(item.available ?? item.amount ?? 0));
          for (const content of item.shulkerContents || []) {
            mergeBulkItem(merged, content, 0, Math.max(0, Number(content.amount || 0)) * boxCount);
          }
        } else {
          mergeBulkItem(merged, item, Math.max(0, Number(item.available ?? item.amount ?? 0)), 0);
        }
      }
      return [...merged.values()].sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, { sensitivity: 'base' }));
    }

    function currentInventoryRows() {
      const q = $('search').value.trim().toLowerCase();
      const rows = displayRows();
      return q ? rows.filter(item => itemText(item).includes(q)) : rows;
    }

    function renderInventory() {
      const rows = currentInventoryRows();
      $('loaded').textContent = rows.length + '/' + displayRows().length + ' 种已加载';
      if (!rows.length) {
        $('inventory').innerHTML = '<p class="muted" style="text-align:center;margin:46px 0">账户为空，暂无物品存储。</p>';
        return;
      }
      $('inventory').innerHTML = '<div class="grid">' + rows.map(item => {
        const selected = state.selected.has(item.itemKey) ? ' selected' : '';
        const aliasTitle = item.personalAliases?.length ? '个人别名：' + item.personalAliases.join('、') : (item.adminDisplayName && item.adminDisplayName !== item.displayName ? '默认名：' + item.adminDisplayName : '');
        const boxedBadge = !state.shulkerBoxView && Number(item.boxedAmount || 0) > 0 ? '<span class="boxed-badge">盒</span>' : '';
        const reservedBadge = Number(item.reserved || 0) > 0 ? '<span class="boxed-badge" title="任务占用中 ' + esc(num(item.reserved)) + '，可取 ' + esc(num(item.available)) + '">占' + esc(shortCount(item.reserved)) + '</span>' : '';
        return '<div class="item' + selected + '" data-key="' + esc(item.itemKey) + '">' +
          '<div class="icon"><img data-key="' + esc(item.itemKey) + '" alt="" loading="lazy" decoding="async"><span class="fallback">' + esc((item.displayName || item.itemId).slice(0, 4)) + '</span><span class="count">' + esc(shortCount(item.available ?? item.amount)) + '</span>' + boxedBadge + reservedBadge + '</div>' +
          '<div class="name" title="' + esc(aliasTitle) + '">' + esc(item.displayName || item.itemId) + '</div>' +
          '</div>';
      }).join('') + '</div>';
      $('inventory').classList.toggle('alias-mode', state.aliasMode);
      scheduleIconLoading(rows);
      for (const el of document.querySelectorAll('.item[data-key]')) {
        const item = rows.find(row => row.itemKey === el.dataset.key);
        if (!item) continue;
        el.addEventListener('click', () => {
          toggleSelected(item);
        });
        if (canHoverTooltip()) {
          el.addEventListener('mouseenter', event => showTip(event, item));
          el.addEventListener('mousemove', moveTip);
          el.addEventListener('mouseleave', hideTip);
        }
      }
    }

    async function loadTransactions() {
      const data = await api('/api/transactions', { owner: $('txOwner').value, type: $('txType').value, operator: $('txOperator').value, item: $('txItem').value, status: $('txStatus').value, dateFrom: $('txFrom').value, dateTo: $('txTo').value, q: $('txQ').value, page: state.txPage, pageSize: 30 });
      state.tx = data.rows || [];
      state.txPage = data.page || 1;
      state.txTotalPages = data.totalPages || 1;
      $('txPage').textContent = '第 ' + state.txPage + ' / ' + state.txTotalPages + ' 页，共 ' + num(data.total || 0) + ' 条';
      $('txPrev').disabled = state.txPage <= 1;
      $('txNext').disabled = state.txPage >= state.txTotalPages;
      const tooltipItems = new Map();
      renderTable('transactions', ['时间', '类型', '操作者', 'Bot', '归属', '物品', '备注'], state.tx.map(row => {
        const items = transactionItemsHtml(row.items, tooltipItems);
        const details = row.messageLabel ? '<span class="alias-tag">' + esc(row.messageLabel) + '</span>' : '';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.typeLabel || row.type) + '<div class="muted">' + esc(row.statusLabel || row.status) + '</div></td><td>' + esc(row.operator || '') + '</td><td>' + esc(row.botOperator || '-') + '</td><td>' + esc(row.ownerLabel || '') + '</td><td class="wrap">' + items + '</td><td class="wrap muted">' + details + '</td></tr>';
      }), '没有交易记录。');
      bindTransactionTooltips('transactions', tooltipItems);
    }

    function renderTable(target, headers, rows, emptyText = '没有数据。') {
      if (!rows.length) {
        $(target).innerHTML = '<p class="muted" style="text-align:center;margin:30px 0">' + esc(emptyText) + '</p>';
        return;
      }
      $(target).innerHTML = '<table><thead><tr>' + headers.map(header => '<th>' + esc(header) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }

    function tableMarkup(headers, rows, emptyText = '没有数据。') {
      if (!rows.length) return '<p class="muted" style="text-align:center;margin:24px 0">' + esc(emptyText) + '</p>';
      return '<div class="tablewrap"><table><thead><tr>' + headers.map(header => '<th>' + esc(header) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }

    function renderStats(target, stats) {
      $(target).innerHTML = Object.entries(stats).map(([label, value]) =>
        '<div class="stat"><span class="muted">' + esc(label) + '</span><strong>' + num(value) + '</strong></div>'
      ).join('');
    }

    async function loadAdminOwners() {
      if (!state.user?.isAdmin) return;
      if (!state.adminOwners.length) {
        const data = await api('/api/admin/owners');
        state.adminOwners = data.rows || [];
      }
      const inventoryValue = $('adminInvOwner')?.value || '';
      if ($('adminInvOwner')) {
        const occupied = state.adminOwners.filter(owner => Number(owner.totalAmount || 0) > 0);
        $('adminInvOwner').innerHTML = '<option value="">全部有库存仓库</option>' + occupied.map(owner =>
          '<option value="' + esc(owner.ownerUuid) + '"' + (owner.ownerUuid === inventoryValue ? ' selected' : '') + '>' + esc(owner.label) + '（' + num(owner.totalAmount) + '件）</option>'
        ).join('');
      }
    }

    function ownerOptions(selected = '') {
      return state.adminOwners.map(owner =>
        '<option value="' + esc(owner.ownerUuid) + '"' + (owner.ownerUuid === selected ? ' selected' : '') + '>' + esc(owner.label) + '</option>'
      ).join('');
    }

    function formatJsonText(value) {
      const text = String(value || '').trim();
      if (!text) return '';
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }

    function adminItemDetailText(row) {
      return [
        '归属: ' + (row.ownerLabel || row.ownerUuid || ''),
        '短码: ' + (row.shortCode || ''),
        '名称: ' + (row.displayName || ''),
        row.personalAliases?.length ? '个人别名: ' + row.personalAliases.join('、') : '',
        row.adminDisplayName && row.adminDisplayName !== row.displayName ? '默认名: ' + row.adminDisplayName : '',
        'ID: ' + (row.itemId || ''),
        '数量: ' + Number(row.amount || 0),
        'itemKey: ' + (row.itemKey || ''),
        '',
        'NBT:',
        formatJsonText(row.nbtJson) || '无',
        '',
        'meta:',
        formatJsonText(row.metaJson) || '无'
      ].filter(line => line !== '').join('\\n');
    }

    function openNbtModal(row) {
      state.aliasItem = null;
      state.adminGlobalAliasItem = null;
      $('aliasEditor').classList.add('hidden');
      $('globalAliasEditor').classList.add('hidden');
      $('nbtModalTitle').textContent = (row.displayName || row.itemId || '物品详情') + (row.shortCode ? ' #' + row.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(row);
      $('nbtModalHint').textContent = row.nbtJson || row.metaJson ? '可以按 NBT 或 meta 里的关键词筛选总库存。' : '这个物品没有额外 NBT/meta。';
      $('nbtModal').classList.remove('hidden');
    }

    function openAliasModal(item) {
      state.aliasItem = item;
      state.adminGlobalAliasItem = null;
      $('aliasEditor').classList.remove('hidden');
      $('globalAliasEditor').classList.add('hidden');
      $('aliasInput').value = '';
      $('aliasUseDisplayName').checked = false;
      $('aliasExisting').innerHTML = (item.personalAliases || []).length
        ? item.personalAliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-personal-alias-delete="' + esc(alias) + '">×</button></span>').join('')
        : '<span class="muted">还没有设置个人别名</span>';
      $('aliasNote').textContent = '默认名：' + (item.adminDisplayName || item.itemId || '') + '；短码：' + (item.shortCode || '无');
      $('nbtModalTitle').textContent = (item.displayName || item.itemId || '物品详情') + (item.shortCode ? ' #' + item.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(item);
      $('nbtModalHint').textContent = '一件物品可以添加多个个人别名；这些别名只影响你自己的搜索、显示和取货。';
      $('nbtModal').classList.remove('hidden');
      $('aliasInput').focus();
    }

    function openGlobalAliasModal(item) {
      state.aliasItem = null;
      state.adminGlobalAliasItem = item;
      $('aliasEditor').classList.add('hidden');
      $('globalAliasEditor').classList.remove('hidden');
      $('globalAliasInput').value = '';
      $('globalAliasCategory').value = 'normal';
      $('globalAliasUseDisplayName').checked = false;
      $('globalAliasExisting').innerHTML = (item.globalAliases || []).length
        ? item.globalAliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-admin-alias-delete="' + esc(alias) + '">×</button></span>').join('')
        : '<span class="muted">还没有设置全局别名</span>';
      $('globalAliasNote').textContent = '物品：' + (item.displayName || item.itemId) + '；短码：' + (item.shortCode || '无');
      $('nbtModalTitle').textContent = (item.displayName || item.itemId || '物品详情') + (item.shortCode ? ' #' + item.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(item);
      $('nbtModalHint').textContent = '全局别名供所有启用该别名的玩家搜索和取货；修改库存显示名称为可选操作。';
      $('nbtModal').classList.remove('hidden');
      $('globalAliasInput').focus();
    }

    function closeNbtModal() {
      $('nbtModal').classList.add('hidden');
      $('nbtModalText').textContent = '';
      $('aliasEditor').classList.add('hidden');
      $('globalAliasEditor').classList.add('hidden');
      state.aliasItem = null;
      state.adminGlobalAliasItem = null;
    }

    async function copyNbtModal() {
      const text = $('nbtModalText').textContent || '';
      if (!text) return;
      await navigator.clipboard.writeText(text);
      toast('已复制物品详情。');
    }

    function applyAliasToLocalItem(itemKey, personalAliases, personalDisplayName = '') {
      for (const item of state.items) {
        if (item.itemKey !== itemKey) continue;
        item.personalAliases = personalAliases || [];
        item.personalAlias = item.personalAliases[0] || '';
        item.personalDisplayName = personalDisplayName || '';
        item.displayName = item.personalDisplayName || item.adminDisplayName || item.itemId;
      }
      const picked = state.selected.get(itemKey);
      if (picked) picked.displayName = personalDisplayName || picked.displayName;
      state.bulkItems = flattenBulkItems(state.items);
      state.inventoryCache.delete(state.owner);
      renderSelected();
      renderInventory();
    }

    async function savePersonalAlias() {
      if (!state.aliasItem) return;
      const nextName = $('aliasInput').value.trim();
      if (!nextName) throw new Error('请填写要新增的个人别名。');
      const data = await post('/api/item-alias/save', {
        itemKey: state.aliasItem.itemKey,
        displayName: nextName,
        updateDisplayName: $('aliasUseDisplayName').checked
      });
      applyAliasToLocalItem(data.itemKey, data.personalAliases || [], data.personalDisplayName || '');
      const updated = state.items.find(item => item.itemKey === data.itemKey) || {
        ...state.aliasItem,
        personalAliases: data.personalAliases || []
      };
      openAliasModal(updated);
      toast(data.message);
    }

    async function saveGlobalAliasFromModal() {
      if (!state.adminGlobalAliasItem) return;
      const alias = $('globalAliasInput').value.trim();
      if (!alias) throw new Error('请填写全局别名。');
      const data = await post('/api/admin/alias/save', { itemKey: state.adminGlobalAliasItem.itemKey, alias, category: $('globalAliasCategory').value, updateDisplayName: $('globalAliasUseDisplayName').checked });
      const itemKey = state.adminGlobalAliasItem.itemKey;
      toast(data.message);
      await loadAdminInventory();
      const updated = [...state.adminInventoryRows.values()].find(row => row.itemKey === itemKey);
      if (updated) { openGlobalAliasModal(updated); $('globalAliasCategory').value = data.category || 'normal'; }
    }

    async function loadMyOrganizations() {
      const data = await api('/api/my/organizations');
      const rows = data.rows || [];
      $('myOrganizationList').innerHTML = rows.length ? rows.map(warehouse => {
        const members = (warehouse.members || []).map(member =>
          '<div class="member-row" data-member="' + esc(member.playerUuid) + '"><div><strong>' + esc(member.username) + '</strong>' + (member.playerUuid === warehouse.creatorUuid ? '<div class="muted">创建者</div>' : '') + '</div>' +
          '<span class="muted">' + (member.role === 'admin' ? '管理员' : '成员') + '</span><span></span></div>'
        ).join('');
        return '<div class="organization-card" data-warehouse="' + esc(warehouse.name) + '"><div class="organization-head"><div><div class="organization-name">' + esc(warehouse.name) + '</div><div class="organization-summary"><span>' + (warehouse.role === 'admin' ? '仓库管理员' : '普通成员') + '</span><span>' + num((warehouse.members || []).length) + ' 名成员</span></div></div><div><strong>' + num(warehouse.usedSlots) + ' / ' + num(warehouse.quotaSlots) + ' 格</strong><div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(warehouse.usagePercent || 0)) + '%"></div></div><div class="muted">使用率 ' + esc(warehouse.usagePercent) + '%</div></div></div><div class="member-list">' + members + '</div></div>';
      }).join('') : '<div class="empty-state panel"><div class="empty-icon">♙</div><h3>还没有组织仓库</h3><p>你尚未创建或加入任何组织仓库。</p></div>';
    }

    async function loadMyAliases() {
      const data = await api('/api/my/aliases', { q: $('myAliasQ').value });
      const personal = data.personal || [];
      state.myPersonalAliasRows = new Map(personal.map(row => [row.itemKey, row]));
      $('myPersonalAliases').innerHTML = personal.length ? '<div class="compact-admin-grid">' + personal.map(row => aliasGridItemHtml(row, 'my-personal-alias-card', state.myPersonalAliasItemKey === row.itemKey, row.aliases.length + ' 个别名')).join('') + '</div>' : '<p class="muted">你还没有设置个人别名。可在库存页进入“物品别名”模式添加。</p>';

      const globalMap = new Map();
      for (const row of data.global || []) {
        if (!globalMap.has(row.itemKey)) globalMap.set(row.itemKey, { ...row, aliases: [] });
        globalMap.get(row.itemKey).aliases.push({ alias: row.alias, category: row.category || 'normal', enabled: row.enabled });
      }
      const globals = [...globalMap.values()];
      state.myGlobalAliasRows = globalMap;
      const globalCategory = (category, title) => {
        const rows = globals.filter(row => row.aliases.some(alias => alias.category === category));
        return '<h3 class="section-title">' + title + '</h3>' + (rows.length ? '<div class="compact-admin-grid">' + rows.map(row => aliasGridItemHtml(row, 'my-global-alias-card', state.myGlobalAliasItemKey === row.itemKey, row.aliases.filter(alias => alias.category === category).length + ' 个别名')).join('') + '</div>' : '<p class="muted">这一类还没有全局别名。</p>');
      };
      $('myGlobalAliases').innerHTML = globalCategory('normal', '正常物品') + globalCategory('variant', '同 ID 物品');

      if (state.myPersonalAliasItemKey && state.myPersonalAliasRows.has(state.myPersonalAliasItemKey)) renderMyPersonalAliasDetail(state.myPersonalAliasRows.get(state.myPersonalAliasItemKey));
      else { state.myPersonalAliasItemKey = ''; $('myPersonalAliasDetail').innerHTML = '<p class="muted">点击物品图标管理个人别名。</p>'; }
      if (state.myGlobalAliasItemKey && state.myGlobalAliasRows.has(state.myGlobalAliasItemKey)) renderMyGlobalAliasDetail(state.myGlobalAliasRows.get(state.myGlobalAliasItemKey));
      else { state.myGlobalAliasItemKey = ''; $('myGlobalAliasDetail').innerHTML = '<p class="muted">点击物品图标管理全局别名开关。</p>'; }
    }

    function aliasGridItemHtml(row, attribute, selected, note) {
      return '<div class="item' + (selected ? ' selected' : '') + '" data-' + attribute + '="' + esc(row.itemKey) + '" title="' + esc(row.displayName + ' · ' + note) + '"><div class="icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="fallback">' + esc((row.displayName || row.itemId).slice(0, 4)) + '</span></div><div class="name">' + esc(row.displayName) + '</div></div>';
    }

    function renderMyPersonalAliasDetail(row) {
      state.myPersonalAliasItemKey = row.itemKey;
      document.querySelectorAll('[data-my-personal-alias-card]').forEach(card => card.classList.toggle('selected', card.dataset.myPersonalAliasCard === row.itemKey));
      $('myPersonalAliasDetail').innerHTML = '<div class="alias-detail-head"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""></div><div><div class="admin-item-name">' + esc(row.displayName) + '</div><div class="admin-item-meta">#' + esc(row.shortCode) + ' · ' + esc(row.itemId) + '</div></div></div><div class="alias-tags">' + row.aliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-personal-alias-delete="' + esc(alias) + '">×</button></span>').join('') + '</div><div class="alias-add" data-item="' + esc(row.itemKey) + '" style="margin-top:10px"><input data-my-alias-input placeholder="新增个人别名"><button data-my-alias-add>添加</button></div>';
    }

    function renderMyGlobalAliasDetail(row) {
      state.myGlobalAliasItemKey = row.itemKey;
      document.querySelectorAll('[data-my-global-alias-card]').forEach(card => card.classList.toggle('selected', card.dataset.myGlobalAliasCard === row.itemKey));
      const aliasRows = (category, title) => '<div class="muted" style="margin-top:8px">' + title + '</div><div class="global-alias-toggle-list">' + row.aliases.filter(item => item.category === category).map(item => '<div class="global-alias-toggle-row"><span>' + esc(item.alias) + '</span><span class="muted">' + (item.enabled ? '已启用' : '已禁用') + '</span><button class="switch' + (item.enabled ? ' on' : '') + '" data-global-alias-toggle="' + esc(item.alias) + '" data-enabled="' + (item.enabled ? '1' : '0') + '"></button></div>').join('') + '</div>';
      $('myGlobalAliasDetail').innerHTML = '<div class="alias-detail-head"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""></div><div><div class="admin-item-name">' + esc(row.displayName) + '</div><div class="admin-item-meta">#' + esc(row.shortCode) + ' · ' + esc(row.itemId) + '</div></div></div>' + aliasRows('normal', '正常物品') + aliasRows('variant', '同 ID 物品');
    }

    function loadMyCurrent() {
      return state.myTab === 'organizations' ? loadMyOrganizations() : loadMyAliases();
    }

    function setMyTab(tab) {
      state.myTab = tab;
      document.querySelectorAll('[data-my-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.myTab === tab));
      $('myOrganizations').classList.toggle('hidden', tab !== 'organizations');
      $('myAliases').classList.toggle('hidden', tab !== 'aliases');
      loadMyCurrent().catch(error => toast(error.message));
    }

    function adminCardHtml(row, index, options = {}) {
      const selected = state.adminSelected.has(index) ? ' selected' : '';
      const aliases = (row.globalAliases || row.aliases || []).join('、');
      return '<div class="admin-item-card' + selected + (options.className ? ' ' + options.className : '') + '" data-admin-card="' + esc(index) + '">' +
        '<div class="admin-item-main"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="count">' + esc(shortCount(row.amount)) + '</span></div>' +
        '<div><div class="admin-item-name" title="' + esc(row.displayName) + '">' + esc(row.displayName || row.itemId) + '</div>' +
        '<div class="admin-item-meta">' + esc(row.ownerLabel || '') + '</div><div class="admin-item-meta">#' + esc(row.shortCode || '无短码') + (aliases ? ' · ' + esc(aliases) : '') + '</div></div></div>' +
        (options.actions || '') + '</div>';
    }

    function renderAdminTransferSelection() {
      if (state.adminAliasMode) {
        $('adminSelectedList').innerHTML = '<span class="selected-empty">别名模式：点击下方物品图标查看 NBT 和设置全局别名</span>';
        return;
      }
      const rows = [...state.adminSelected.values()];
      if (!rows.length) {
        $('adminSelectedList').innerHTML = '<span class="selected-empty">点击物品加入待转账列表</span>';
      } else {
        $('adminSelectedList').innerHTML = rows.map(row =>
          '<div class="pick" data-admin-pick="' + esc(row.selectionKey) + '"><span class="pick-name" title="' + esc(row.ownerLabel + ' · ' + row.displayName) + '">' + esc(row.displayName) + '</span><input type="number" min="1" max="' + esc(row.amount) + '" value="' + esc(row.selectedAmount) + '" data-admin-pick-amount><button class="ghost" data-admin-pick-remove>×</button></div>'
        ).join('') + '<button class="ghost selected-clear" data-admin-pick-clear>清空</button>';
      }
    }

    function compactAdminItemHtml(row, index, selected = false) {
      return '<div class="item' + (selected ? ' selected' : '') + '" data-admin-card="' + esc(index) + '"><div class="icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="fallback">' + esc((row.displayName || row.itemId).slice(0, 4)) + '</span><span class="count">' + esc(shortCount(row.amount)) + '</span></div><div class="name">' + esc(row.displayName || row.itemId) + '</div></div>';
    }

    function loadAdminInventorySelectionState() {
      document.querySelectorAll('#adminInvGrid [data-admin-card]').forEach(card => card.classList.toggle('selected', state.adminSelected.has(card.dataset.adminCard)));
    }

    function bindAdminInventoryTooltips() {
      if (!canHoverTooltip()) return;
      for (const card of document.querySelectorAll('#adminInvGrid [data-admin-card]')) {
        const item = state.adminInventoryRows.get(card.dataset.adminCard);
        if (!item) continue;
        card.addEventListener('mouseenter', event => showTip(event, item));
        card.addEventListener('mousemove', moveTip);
        card.addEventListener('mouseleave', hideTip);
      }
    }

    function bindAdminMismatchTooltips() {
      if (!canHoverTooltip()) return;
      for (const card of document.querySelectorAll('#adminMismatches [data-admin-card]')) {
        const item = state.adminMismatchRows.get(card.dataset.adminCard);
        if (!item) continue;
        card.addEventListener('mouseenter', event => showTip(event, item));
        card.addEventListener('mousemove', moveTip);
        card.addEventListener('mouseleave', hideTip);
      }
    }

    async function loadAdminInventory(options = {}) {
      const loadId = ++state.adminInventoryLoadId;
      const startedAt = performance.now();
      const requestedOwner = options.owner !== undefined ? String(options.owner || '') : String($('adminInvOwner').value || '');
      $('adminInvStatus').textContent = '加载中…';
      $('adminInvOwner').disabled = true;
      $('adminInvLoad').disabled = true;
      $('adminInvGrid').style.opacity = '.55';
      try {
        state.adminOwners = [];
        await loadAdminOwners();
        const ownerExists = [...$('adminInvOwner').options].some(option => option.value === requestedOwner);
        const owner = ownerExists ? requestedOwner : '';
        $('adminInvOwner').value = owner;
        const data = await api('/api/admin/inventory', { owner, item: $('adminInvItem').value });
        if (loadId !== state.adminInventoryLoadId) return;
        renderStats('adminInvStats', { '仓库数': data.stats?.owners || 0, '物品种类': data.stats?.itemTypes || 0, '物品总数': data.stats?.totalAmount || 0 });
        state.adminInventoryRows = new Map();
        state.adminSelected.clear();
        const rows = data.rows || [];
        rows.forEach((row, index) => state.adminInventoryRows.set(String(index), row));
        $('adminInvGrid').innerHTML = rows.length ? '<div class="compact-admin-grid">' + rows.map((row, index) => compactAdminItemHtml(row, String(index))).join('') + '</div>' : '<p class="muted" style="text-align:center">没有库存。</p>';
        $('adminInvStatus').textContent = '已加载 ' + rows.length + ' 种 · ' + Math.round(performance.now() - startedAt) + 'ms';
        renderAdminTransferSelection();
        bindAdminInventoryTooltips();
      } catch (error) {
        if (loadId === state.adminInventoryLoadId) $('adminInvStatus').textContent = '加载失败：' + error.message;
        throw error;
      } finally {
        if (loadId === state.adminInventoryLoadId) {
          $('adminInvOwner').disabled = false;
          $('adminInvLoad').disabled = false;
          $('adminInvGrid').style.opacity = '';
        }
      }
    }

    async function loadAdminMismatches() {
      const data = await api('/api/admin/mismatches', {
        status: $('adminMmStatus').value,
        kind: $('adminMmKind').value,
        item: $('adminMmItem').value
      });
      renderStats('adminMmStats', {
        '未处理行数': data.stats?.openRows || 0,
        '多余数量': data.stats?.extraAmount || 0,
        '缺失数量': data.stats?.missingAmount || 0
      });
      await loadAdminOwners();
      const batchTarget = $('adminMmBatchTarget');
      const batchTargetValue = batchTarget.value;
      batchTarget.innerHTML = '<option value="">批量转入目标仓库</option>' + ownerOptions();
      if ([...batchTarget.options].some(option => option.value === batchTargetValue)) batchTarget.value = batchTargetValue;
      const rows = data.rows || [];
      state.adminMismatchRows = new Map(rows.map(row => ['mm-' + row.id, row]));
      const mismatchHtml = row => {
        const detailButton = '<button class="ghost" data-admin-mm-components="' + esc(row.id) + '">查看组件</button>';
        const checkLabel = row.status === 'open'
          ? '<label class="mm-check"><input type="checkbox" data-mm-check="' + esc(row.id) + '" data-mm-kind="' + esc(row.kind) + '">选择</label>'
          : '';
        const actions = row.status !== 'open'
          ? '<div class="mismatch-actions">' + detailButton + '<span class="admin-item-meta">已处理 ' + esc(row.resolvedAt || '') + '</span></div>'
          : row.kind === 'extra'
            ? '<div class="mismatch-actions">' + checkLabel + '<select data-mm-target><option value="">目标仓库</option>' + ownerOptions() + '</select><button data-admin-mm-resolve="' + esc(row.id) + '">转入</button>' + detailButton + '</div>'
            : '<div class="mismatch-actions">' + checkLabel + '<button data-admin-mm-deduct="' + esc(row.id) + '">清除库存</button>' + detailButton + '</div>';
        return adminCardHtml(row, 'mm-' + row.id, { className: 'mismatch-card', actions });
      };
      const extra = rows.filter(row => row.kind === 'extra');
      const missing = rows.filter(row => row.kind === 'missing');
      $('adminMmExtra').innerHTML = extra.length ? '<div class="admin-item-grid">' + extra.map(mismatchHtml).join('') + '</div>' : '<p class="muted">没有多余物品。</p>';
      $('adminMmMissing').innerHTML = missing.length ? '<div class="admin-item-grid">' + missing.map(mismatchHtml).join('') + '</div>' : '<p class="muted">没有缺失物品。</p>';
      updateAdminMmBatchCount();
      bindAdminMismatchTooltips();
    }

    function updateAdminMmBatchCount() {
      const boxes = [...document.querySelectorAll('[data-mm-check]')];
      const extraChecked = boxes.filter(box => box.checked && box.dataset.mmKind === 'extra').length;
      const missingChecked = boxes.filter(box => box.checked && box.dataset.mmKind === 'missing').length;
      const total = extraChecked + missingChecked;
      $('adminMmBatchCount').textContent = total
        ? '已勾选 ' + total + ' 条（多余 ' + extraChecked + '、缺失 ' + missingChecked + '）'
        : '未勾选';
    }

    async function runAdminMmBatch(kind) {
      const ids = [...document.querySelectorAll('[data-mm-check]:checked')]
        .filter(box => box.dataset.mmKind === kind)
        .map(box => box.dataset.mmCheck);
      if (!ids.length) {
        toast(kind === 'extra' ? '请先勾选要批量转入的多余物品。' : '请先勾选要批量清除的缺失物品。');
        return;
      }
      if (kind === 'extra' && !$('adminMmBatchTarget').value) {
        toast('请先选择批量转入的目标仓库。');
        return;
      }
      const actionLabel = kind === 'extra'
        ? '把勾选的 ' + ids.length + ' 条多余物品转入所选仓库'
        : '清除勾选的 ' + ids.length + ' 条缺失物品对应的账本库存';
      if (!confirm('确认' + actionLabel + '吗？')) return;
      const body = { ids };
      if (kind === 'extra') body.targetOwnerUuid = $('adminMmBatchTarget').value;
      const data = await post(kind === 'extra' ? '/api/admin/mismatch/batch-resolve' : '/api/admin/mismatch/batch-deduct', body);
      const failures = (data.results || []).filter(item => !item.ok);
      toast(failures.length ? data.message + ' 第一条失败：' + failures[0].message : data.message);
      await loadAdminMismatches();
    }

    async function loadAdminWarehouseProvisioning() {
      const data = await api('/api/admin/warehouse-provisioning');
      renderTable('adminPersonalWarehouseList', ['玩家', '库存', '已用格数', '快捷潜影盒取货', '创建时间', '操作'], (data.personal || []).map(row =>
        '<tr><td>' + esc(row.username) + '<div class="muted">' + esc(row.ownerUuid) + '</div></td><td>' + num(row.totalAmount) + ' 件</td><td>' + num(row.usedSlots) + ' 格</td><td><button data-admin-quick-shulker="' + esc(row.ownerUuid) + '" data-enabled="' + (row.quickShulkerExtractionEnabled ? '1' : '0') + '">' + (row.quickShulkerExtractionEnabled ? '已启用' : '已关闭') + '</button></td><td>' + esc(row.createdAt || '') + '</td><td><button class="danger" data-admin-personal-delete="' + esc(row.ownerUuid) + '" data-owner-name="' + esc(row.username) + '">删除</button></td></tr>'
      ), '还没有创建个人仓库。');
      renderTable('adminOrganizationWarehouseList', ['仓库', '首位管理员', '成员', '库存', '已用格数', '快捷潜影盒取货', '创建时间', '操作'], (data.organizations || []).map(row =>
        '<tr><td>' + esc(row.name) + '</td><td>' + esc(row.creatorUsername) + '</td><td>' + num(row.memberCount) + ' 人</td><td>' + num(row.totalAmount) + ' 件</td><td>' + num(row.usedSlots) + ' 格</td><td><button data-admin-quick-shulker="' + esc(row.ownerUuid) + '" data-enabled="' + (row.quickShulkerExtractionEnabled ? '1' : '0') + '">' + (row.quickShulkerExtractionEnabled ? '已启用' : '已关闭') + '</button></td><td>' + esc(row.createdAt || '') + '</td><td><button data-admin-org-view="' + esc(row.name) + '">查看</button></td></tr>'
      ), '还没有组织仓库。');
      const names = new Set((data.organizations || []).map(row => row.name));
      if (state.adminOrganizationName && names.has(state.adminOrganizationName)) await loadAdminOrganizationDetail(state.adminOrganizationName);
      else if (state.adminOrganizationName) {
        state.adminOrganizationName = '';
        $('adminOrganizationWarehouseDetail').innerHTML = '<p class="muted">点击组织仓库右侧的“查看”管理详情、成员与管理员。</p>';
      }
    }

    async function loadAdminOrganizationDetail(name) {
      const data = await api('/api/admin/organization-warehouse/detail', { name });
      const warehouse = data.warehouse;
      state.adminOrganizationName = warehouse.name;
      const members = (warehouse.members || []).map(member =>
        '<div class="member-row" data-admin-org-member="' + esc(member.playerUuid) + '"><div><strong>' + esc(member.username) + '</strong>' + (member.playerUuid === warehouse.creatorUuid ? '<div class="muted">首位管理员</div>' : '') + '</div><select data-admin-org-role><option value="member"' + (member.role === 'member' ? ' selected' : '') + '>普通成员</option><option value="admin"' + (member.role === 'admin' ? ' selected' : '') + '>仓库管理员</option></select><button class="danger" data-admin-org-member-remove>删除成员</button></div>'
      ).join('');
      $('adminOrganizationWarehouseDetail').innerHTML =
        '<div class="organization-card" data-admin-org-detail="' + esc(warehouse.name) + '">' +
          '<div class="organization-head"><div><div class="organization-name">' + esc(warehouse.name) + '</div><div class="organization-summary"><span>首位管理员：' + esc(warehouse.creatorUsername) + '</span><span>' + num((warehouse.members || []).length) + ' 名成员</span><span>' + num(warehouse.totalAmount) + ' 件物品</span></div></div><div><strong>' + num(warehouse.usedSlots) + ' / ' + num(warehouse.quotaSlots) + ' 格</strong><div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(warehouse.usagePercent || 0)) + '%"></div></div><div class="muted">使用率 ' + esc(warehouse.usagePercent) + '%</div></div></div>' +
          '<div class="organization-actions"><input data-admin-org-add-name placeholder="玩家 ID"><select data-admin-org-add-role><option value="member">普通成员</option><option value="admin">仓库管理员</option></select><button data-admin-org-member-add>添加成员</button><button class="danger" data-admin-org-delete>删除组织仓库</button></div>' +
          '<div class="member-list">' + (members || '<p class="muted">没有成员。</p>') + '</div>' +
        '</div>';
    }

    async function createAdminPersonalWarehouse() {
      const data = await post('/api/admin/personal-warehouse/create', { username: $('adminPersonalWarehousePlayer').value });
      toast(data.message); $('adminPersonalWarehousePlayer').value = ''; state.adminOwners = []; await loadAdminWarehouses();
    }

    async function createAdminOrganizationWarehouse() {
      const data = await post('/api/admin/organization-warehouse/create', { name: $('adminOrganizationWarehouseName').value, creatorUsername: $('adminOrganizationWarehouseCreator').value });
      toast(data.message); $('adminOrganizationWarehouseName').value = ''; $('adminOrganizationWarehouseCreator').value = ''; state.adminOwners = []; await loadAdminWarehouses();
    }

    async function loadWarehouseAdminOrganizations() {
      const data = await api('/api/warehouse-admin/organizations');
      const rows = data.rows || [];
      $('warehouseAdminOrganizationList').innerHTML = rows.length ? rows.map(warehouse => {
        const actions = '<div class="organization-actions"><input data-org-new-name value="' + esc(warehouse.name) + '" placeholder="新仓库名"><button data-org-rename>修改仓库名</button><input data-org-add-name placeholder="玩家 ID"><button data-org-member-add>添加成员</button><button data-org-quick-shulker="' + esc(warehouse.name) + '" data-enabled="' + (warehouse.quickShulkerExtractionEnabled ? '1' : '0') + '">' + (warehouse.quickShulkerExtractionEnabled ? '已启用快捷潜影盒取货' : '已关闭快捷潜影盒取货') + '</button></div>';
        const members = (warehouse.members || []).map(member =>
          '<div class="member-row" data-member="' + esc(member.playerUuid) + '"><div><strong>' + esc(member.username) + '</strong>' + (member.playerUuid === warehouse.creatorUuid ? '<div class="muted">创建者</div>' : '') + '</div><select data-member-role' + (member.playerUuid === warehouse.creatorUuid ? ' disabled' : '') + '><option value="member"' + (member.role === 'member' ? ' selected' : '') + '>普通成员</option><option value="admin"' + (member.role === 'admin' ? ' selected' : '') + '>仓库管理员</option></select>' + (member.playerUuid !== warehouse.creatorUuid ? '<button data-org-member-remove>删除成员</button>' : '<span></span>') + '</div>'
        ).join('');
        return '<div class="organization-card" data-warehouse="' + esc(warehouse.name) + '"><div class="organization-head"><div><div class="organization-name">' + esc(warehouse.name) + '</div><div class="organization-summary"><span>创建者：' + esc(warehouse.creatorUsername) + '</span><span>' + num((warehouse.members || []).length) + ' 名成员</span></div></div><div><strong>' + num(warehouse.usedSlots) + ' / ' + num(warehouse.quotaSlots) + ' 格</strong><div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(warehouse.usagePercent || 0)) + '%"></div></div></div></div>' + actions + '<div class="member-list">' + members + '</div></div>';
      }).join('') : '<div class="empty-state panel"><div class="empty-icon">♙</div><h3>没有组织仓库</h3></div>';
    }

    async function runAdminTransfer() {
      const target = $('adminTransferTarget').value.trim();
      const rows = [...state.adminSelected.values()];
      if (!target) throw new Error('请输入目标玩家 ID 或仓库名。');
      if (!rows.length) throw new Error('请先选择要转账的物品。');
      const total = rows.reduce((sum, row) => sum + Number(row.selectedAmount || 0), 0);
      if (!confirm('确认把已选的 ' + rows.length + ' 种、共 ' + total + ' 个物品转账给 ' + target + ' 吗？')) return;
      const data = await post('/api/admin/transfer', { toOwnerText: target, items: rows.map(row => ({ fromOwnerUuid: row.ownerUuid, itemKey: row.itemKey, amount: row.selectedAmount })) });
      toast(data.message);
      state.adminOwners = [];
      await loadAdminInventory();
    }

    function setAdminAliasMode(enabled) {
      state.adminAliasMode = Boolean(enabled);
      state.adminSelected.clear();
      $('adminAliasMode').classList.toggle('solid', state.adminAliasMode);
      $('adminAliasMode').textContent = state.adminAliasMode ? '退出别名' : '全局别名';
      $('adminAliasModeHint').textContent = state.adminAliasMode ? '别名模式：点击物品图标查看 NBT 并设置全局别名' : '开启后点击物品图标查看 NBT 并设置全局别名';
      $('adminTransferTarget').disabled = state.adminAliasMode;
      $('adminTransferRun').disabled = state.adminAliasMode;
      renderAdminTransferSelection();
      loadAdminInventorySelectionState();
    }

    async function loadAdminTransactions() {
      const data = await api('/api/admin/transactions', { q: $('adminTxQ').value, owner: $('adminTxOwner').value, type: $('adminTxType').value, operator: $('adminTxOperator').value, item: $('adminTxItem').value, status: $('adminTxStatus').value, dateFrom: $('adminTxFrom').value, dateTo: $('adminTxTo').value, page: state.adminTxPage, pageSize: 30 });
      state.adminTxPage = data.page || 1;
      state.adminTxTotalPages = data.totalPages || 1;
      $('adminTxPage').textContent = '第 ' + state.adminTxPage + ' / ' + state.adminTxTotalPages + ' 页，共 ' + num(data.total || 0) + ' 条';
      $('adminTxPrev').disabled = state.adminTxPage <= 1;
      $('adminTxNext').disabled = state.adminTxPage >= state.adminTxTotalPages;
      const tooltipItems = new Map();
      renderTable('adminTxTable', ['时间', '类型', '操作者', 'Bot', '归属', '物品', '备注'], (data.rows || []).map(row => {
        const items = transactionItemsHtml(row.items, tooltipItems);
        const details = row.messageLabel ? '<span class="alias-tag">' + esc(row.messageLabel) + '</span>' : '';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.typeLabel || row.type) + '<div class="muted">' + esc(row.statusLabel || row.status) + '</div></td><td>' + esc(row.operator || '') + '</td><td>' + esc(row.botOperator || '-') + '</td><td>' + esc(row.ownerLabel || row.username || '') + '</td><td class="wrap">' + items + '</td><td class="wrap muted">' + details + '</td></tr>';
      }), '没有交易记录。');
      bindTransactionTooltips('adminTxTable', tooltipItems);
    }

    async function loadAdminCommands() {
      const data = await api('/api/admin/commands', { q: $('adminCommandQ').value, channel: $('adminCommandChannel').value, page: state.adminCommandPage || 1, pageSize: 30 });
      state.adminCommandPage = data.page || 1;
      state.adminCommandTotalPages = data.totalPages || 1;
      $('adminCommandPage').textContent = '第 ' + state.adminCommandPage + ' / ' + state.adminCommandTotalPages + ' 页，共 ' + num(data.total || 0) + ' 条';
      $('adminCommandPrev').disabled = state.adminCommandPage <= 1;
      $('adminCommandNext').disabled = state.adminCommandPage >= state.adminCommandTotalPages;
      renderTable('adminCommandTable', ['时间', '玩家', '来源', '命令', '接收 Bot', '回复'], (data.rows || []).map(row => {
        const replies = (row.replies || []).length ? '<div class="command-replies">' + row.replies.map(reply => '<div><span class="alias-tag">' + esc(reply.botName || reply.botId || '-') + '</span> <span class="muted">' + esc(reply.channelLabel) + ' → ' + esc(reply.targetUsername || row.username) + '</span><div class="wrap">' + esc(reply.message) + '</div></div>').join('') + '</div>' : '<span class="muted">暂无回复</span>';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.username) + '</td><td>' + esc(row.channelLabel) + '</td><td class="wrap"><code>' + esc(row.commandText) + '</code></td><td>' + esc(row.receiverBotName || row.receiverBotId || '-') + '</td><td class="wrap">' + replies + '</td></tr>';
      }), '没有命令记录。');
    }

    async function loadAdminAliases() {
      const data = await api('/api/admin/aliases', { q: $('adminAliasQ').value });
      const rows = data.rows || [];
      state.adminAliasRows = new Map(rows.map(row => [row.itemKey, row]));
      const renderCategory = (category, title) => {
        const categoryRows = rows.filter(row => (row.aliasEntries || []).some(entry => entry.category === category));
        return '<h3 class="section-title">' + title + '</h3>' + (categoryRows.length ? '<div class="compact-admin-grid">' + categoryRows.map(row => {
          const names = (row.aliasEntries || []).filter(entry => entry.category === category).map(entry => entry.alias);
          return '<div class="item' + (state.adminAliasItem?.itemKey === row.itemKey ? ' selected' : '') + '" data-admin-alias-card="' + esc(row.itemKey) + '" title="' + esc(row.displayName + ' · ' + names.join('、')) + '"><div class="icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="fallback">' + esc((row.displayName || row.itemId).slice(0, 4)) + '</span></div><div class="name">' + esc(row.displayName) + '</div></div>';
        }).join('') + '</div>' : '<p class="muted">这一类还没有全局别名。</p>');
      };
      $('adminAliasGrid').innerHTML = renderCategory('normal', '正常物品') + renderCategory('variant', '同 ID 物品');
      if (state.adminAliasItem && state.adminAliasRows.has(state.adminAliasItem.itemKey)) {
        renderAdminAliasDetail(state.adminAliasRows.get(state.adminAliasItem.itemKey));
      } else {
        state.adminAliasItem = null;
        $('adminAliasDetail').innerHTML = '<p class="muted">点击上方物品图标管理全局别名。</p>';
      }
    }

    function renderAdminAliasDetail(row) {
      state.adminAliasItem = row;
      document.querySelectorAll('[data-admin-alias-card]').forEach(card => card.classList.toggle('selected', card.dataset.adminAliasCard === row.itemKey));
      const entries = row.aliasEntries || row.aliases.map(alias => ({ alias, category: 'normal' }));
      const aliasGroup = (category, title) => '<div class="muted" style="margin-top:8px">' + title + '</div><div class="alias-tags">' + entries.filter(entry => entry.category === category).map(entry => '<span class="alias-tag">' + esc(entry.alias) + '<button data-admin-alias-delete="' + esc(entry.alias) + '">×</button></span>').join('') + '</div>';
      $('adminAliasDetail').innerHTML = '<div class="alias-detail-head"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""></div><div><div class="admin-item-name">' + esc(row.displayName) + '</div><div class="admin-item-meta">#' + esc(row.shortCode) + ' · ' + esc(row.itemId) + '</div></div></div>' + aliasGroup('normal', '正常物品') + aliasGroup('variant', '同 ID 物品') + '<div class="alias-add" style="margin-top:10px"><input id="adminAliasDetailInput" placeholder="新增全局别名"><select id="adminAliasDetailCategory"><option value="normal">正常物品</option><option value="variant">同 ID 物品</option></select><button data-admin-alias-detail-save>添加别名</button></div><label class="check-label" style="margin-top:8px"><input id="adminAliasDetailUseDisplayName" type="checkbox"> 同时修改所有库存中的显示名称</label>';
    }

    function botStatusLabel(status) {
      return { online: '在线', connecting: '连接中', logging_in: '登录中', auth_required: '等待微软登录', draining: '任务完成后下线', offline: '离线', disabled: '已停用', starting: '启动中', removing: '删除中' }[status] || status || '未知';
    }

    // ===== 管理面板：木桶视图 =====
    function chestFillLevel(row) {
      if (!row.slotCount) return 0
      return Math.max(0.08, Math.min(1, row.slotCount / 27))
    }
    function chestFillColor(row) {
      const level = chestFillLevel(row)
      if (!row.slotCount) return '#2c2c33'
      if (level < 0.34) return '#5a8f3c'
      if (level < 0.67) return '#b8862b'
      return '#c05b3c'
    }

    async function loadAdminChests() {
      const params = { q: $('adminChestQ').value, sort: $('adminChestSort').value }
      for (const axis of ['x', 'y', 'z']) {
        const value = $('adminChest' + axis.toUpperCase()).value.trim()
        if (value) params[axis] = value
      }
      const data = await api('/api/admin/chests', params)
      state.adminChestRows = data.rows || []
      renderAdminChestStats(data)
      renderAdminChestMap(data)
      renderAdminChestList(data)
      if (state.adminChestId) {
        // 刷新后保持选中态；若已不在过滤结果里则关闭详情
        if (state.adminChestRows.some(row => row.chestId === state.adminChestId)) {
          await openAdminChest(state.adminChestId)
        } else {
          closeAdminChest()
        }
      }
    }

    function renderAdminChestStats(data) {
      const rows = data.rows || []
      const totalAmount = rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)
      const totalSlots = rows.reduce((sum, row) => sum + Number(row.slotCount || 0), 0)
      const shulkerChests = rows.filter(row => Number(row.shulkerAmount || 0) > 0).length
      renderStats('adminChestStats', {
        '木桶数': rows.length,
        '物品总数': num(totalAmount),
        '已用格数': num(totalSlots),
        '含潜影盒桶数': shulkerChests
      })
      const stats = $('adminChestStats')
      if (data.matches) {
        stats.insertAdjacentHTML('beforeend', '<div class="stat"><span class="muted">搜索命中</span><strong style="font-size:16px">' + esc(data.matches.itemKeys) + ' 种物品 / ' + esc(data.matches.chests) + ' 个桶</strong></div>')
      }
    }

    function renderAdminChestList(data) {
      const tbody = $('adminChestList')
      const rows = data.rows || []
      tbody.innerHTML = rows.length ? rows.map(row => {
        const q = $('adminChestQ').value.trim()
        const matched = q && row.matchedSlots !== undefined
          ? '<span class="muted">命中 ' + esc(row.matchedSlots) + ' 格 / ' + esc(row.matchedAmount) + ' 个</span>' : ''
        return '<tr class="chest-row' + (state.adminChestId === row.chestId ? ' selected' : '') + '" data-admin-chest="' + esc(row.chestId) + '">' +
          '<td class="chest-coord">' + esc(row.chestId) + '</td>' +
          '<td class="muted">' + esc(row.blockName || '') + '</td>' +
          '<td>' + esc(row.slotCount) + '</td>' +
          '<td>' + num(row.totalAmount) + '</td>' +
          '<td>' + (Number(row.shulkerAmount || 0) > 0 ? num(row.shulkerAmount) + ' 个' : '<span class="muted">-</span>') + '</td>' +
          '<td class="muted">' + esc(String(row.lastSeenAt || '').slice(0, 19).replace('T', ' ')) + '</td>' +
          '<td>' + matched + '</td></tr>'
      }).join('') : '<tr><td colspan="7"><p class="muted" style="text-align:center;margin:20px 0">没有匹配的木桶。</p></td></tr>'
    }

    // ===== 木桶布局示意（轻量 2.5D：斜二测平面图，无拖拽无逐帧重绘） =====
    // 每个木桶画成一个斜方块（等距示意），Y 层错开排；同一位置上下堆叠的桶
    // 在格子里用堆叠数标注。点击方块打开该桶的库存界面风格详情。
    // 性能：纯 innerHTML 一次性渲染，无动画无监听循环。
    function renderAdminChestMap(data) {
      const rows = data.rows || []
      const mapWrap = document.createElement('div')
      mapWrap.innerHTML =
        '<div class="chest-map-title"><b>布局示意</b>' +
        '<span class="muted">斜视堆叠图 · 数字=该位置叠了几个桶 · 点击看详情</span>' +
        '<label class="toolbar-check">Y 层 <select id="adminChestMapLayer"></select></label>' +
        '</div><div id="adminChestMapCanvas" class="chest-map-canvas"></div>' +
        '<div id="adminChestMapHint" class="muted" style="margin-top:6px;font-size:12px"></div>'
      const canvas = $('adminChestMap')
      canvas.innerHTML = ''
      canvas.appendChild(mapWrap)
      const canvasEl = mapWrap.querySelector('#adminChestMapCanvas')
      const layerSelect = mapWrap.querySelector('#adminChestMapLayer')
      const hintEl = mapWrap.querySelector('#adminChestMapHint')

      if (!rows.length) {
        canvasEl.innerHTML = '<p class="muted" style="text-align:center;margin-top:150px">没有匹配的木桶。</p>'
        return
      }

      // 按位置分堆：x,z 相同的桶是一摞
      const stacks = new Map()
      for (const row of rows) {
        const key = row.x + ',' + row.z
        if (!stacks.has(key)) stacks.set(key, [])
        stacks.get(key).push(row)
      }
      for (const stack of stacks.values()) stack.sort((a, b) => a.y - b.y)
      const layers = [...new Set(rows.map(row => row.y))].sort((a, b) => a - b)
      let currentLayer = state.adminChestMapLayer !== undefined && layers.includes(state.adminChestMapLayer)
        ? state.adminChestMapLayer
        : layers[layers.length - 1]

      const draw = () => {
        state.adminChestMapLayer = currentLayer
        layerSelect.innerHTML = layers.map(y =>
          '<option value="' + esc(y) + '"' + (y === currentLayer ? ' selected' : '') + '>Y=' + esc(y) + '</option>').join('')
        // 该层的桶 + 每摞的堆叠信息
        const layerRows = rows.filter(row => row.y === currentLayer)
        const layerStacks = new Map()
        for (const row of layerRows) {
          const key = row.x + ',' + row.z
          if (!layerStacks.has(key)) layerStacks.set(key, [])
          layerStacks.get(key).push(row)
        }
        if (!layerRows.length) {
          canvasEl.innerHTML = '<p class="muted" style="text-align:center;margin-top:150px">这一层没有木桶。</p>'
          hintEl.textContent = ''
          return
        }
        const xs = layerRows.map(row => row.x)
        const zs = layerRows.map(row => row.z)
        const minX = Math.min(...xs), maxX = Math.max(...xs)
        const minZ = Math.min(...zs), maxZ = Math.max(...zs)
        const spanX = maxX - minX + 1, spanZ = maxZ - minZ + 1
        const padding = 14
        // 等距格子：屏幕 x = (X-X0 + Z-Z0) * cellHalf, y = (Z-Z0 - (X-X0)) * cellHalf * 0.5
        // 需要的画布宽 = (spanX + spanZ) * cellHalf，高 ≈ (spanX + spanZ) * cellHalf * 0.5 + cell
        const availW = (canvasEl.clientWidth || 620) - padding * 2
        const availH = (canvasEl.clientHeight || 340) - padding * 2
        const cellHalf = Math.max(10, Math.min(30,
          Math.min(availW / (spanX + spanZ), availH / ((spanX + spanZ) * 0.55 + 1))))
        const cell = cellHalf * 2
        const originX = padding + (spanZ - 1) * cellHalf + cellHalf  // 让最左的格子贴住 padding
        const originY = padding + cellHalf * 0.5
        canvasEl.innerHTML = ''
        // 画格：先画远处（x 大 z 小），后画近处，让近处格子盖住远处，形成斜视遮挡关系
        const sorted = layerRows.slice().sort((a, b) => (b.x - a.x) + (a.z - b.z))
        for (const row of sorted) {
          const stackAll = stacks.get(row.x + ',' + row.z) || []
          const stackAbove = stackAll.filter(other => other.y > row.y).length
          const stackTotal = stackAll.length
          const screenX = originX + (row.x - minX) * cellHalf - (row.z - minZ) * cellHalf
          const screenY = originY + (row.z - minZ) * cellHalf * 0.5 + (row.x - minX) * cellHalf * 0.5
          const el = document.createElement('div')
          el.className = 'chest-map-cell' + (state.adminChestId === row.chestId ? ' selected' : '')
          el.style.left = (screenX - cellHalf) + 'px'
          el.style.top = (screenY - cellHalf * 0.5) + 'px'
          el.style.width = cell + 'px'
          el.style.height = cell + 'px'
          // 等距菱形外观：用 transform 拉斜
          el.style.transform = 'skewY(-30deg) skewX(0deg) scaleY(.8)'
          const fill = chestFillLevel(row)
          el.style.background = chestFillColor(row)
          el.style.opacity = row.slotCount ? String(0.4 + fill * 0.6) : '0.4'
          const stackNote = stackTotal > 1 ? ' · 此位置叠 ' + stackTotal + ' 桶（上方还有 ' + stackAbove + '）' : ''
          el.title = row.chestId + ' · ' + row.slotCount + ' 格 / ' + num(row.totalAmount) + ' 个' +
            (Number(row.shulkerAmount || 0) > 0 ? ' · 含潜影盒' : '') + stackNote
          el.dataset.adminChest = row.chestId
          el.dataset.stackTotal = String(stackTotal)
          el.dataset.stackAbove = String(stackAbove)
          // 堆叠数字直接显示在格子里
          if (stackTotal > 1) {
            const badge = document.createElement('span')
            badge.className = 'chest-map-stack-badge'
            badge.textContent = '×' + stackTotal
            el.appendChild(badge)
          }
          canvasEl.appendChild(el)
        }
        hintEl.textContent = 'Y=' + currentLayer + ' 层 ' + layerRows.length + ' 个桶' +
          (layers.length > 1 ? '（共 ' + layers.length + ' 层，共 ' + rows.length + ' 桶；切换层看各层布局）' : '') +
          ' · 绿/黄/红=占用率'
      }
      layerSelect.addEventListener('change', () => {
        currentLayer = Number(layerSelect.value)
        draw()
      })
      draw()
      // Tab 刚显示时画布尺寸可能为 0，布局稳定后补一帧
      requestAnimationFrame(() => {
        if (canvasEl.clientWidth) draw()
      })
    }


    async function openAdminChest(chestId) {
      state.adminChestId = chestId
      document.querySelectorAll('[data-admin-chest]').forEach(el => el.classList.toggle('selected', el.dataset.adminChest === chestId))
      const detailEl = $('adminChestDetail')
      detailEl.classList.remove('hidden')
      detailEl.innerHTML = '<p class="muted">加载中……</p>'
      try {
        const data = await api('/api/admin/chest', { chest: chestId })
        renderAdminChestDetail(data)
      } catch (error) {
        detailEl.innerHTML = '<p class="muted">加载失败：' + esc(error.message) + '</p>'
      }
    }

    function renderAdminChestDetail(data) {
      const detailEl = $('adminChestDetail')
      const items = data.items || []
      const chestId = data.chestLabel
      const shulkerSlots = items.filter(item => item.isShulker)
      // 库存界面风格：和玩家库存页一致的 .item 卡片（图标 + 右下数量角标 + 名称 + 短码）
      const slotsHtml = items.length ? items.map(item =>
        '<div class="item chest-item' + (item.isShulker ? ' chest-shulker-item' : '') + '" data-chest-item="' + esc(item.itemKey) + '" title="' +
        esc(item.displayName + ' #' + item.shortCode + ' · 槽 ' + item.slot + (item.isShulker ? ' · 潜影盒（下方展开盒内物品）' : '')) + '">' +
        '<div class="icon"><img src="' + esc(iconUrl(item.itemId, 'item')) + '" alt="" loading="lazy"><span class="fallback">' + esc((item.displayName || item.itemId).slice(0, 4)) + '</span><span class="count">' + esc(shortCount(item.amount)) + '</span></div>' +
        '<div class="name">' + esc(item.displayName) + '</div>' +
        '<div class="code">#' + esc(item.shortCode) + '</div>' +
        '</div>'
      ).join('') : '<p class="muted">（这个桶是空的）</p>'
      const shulkerHtml = shulkerSlots.length ? '<div class="chest-shulker-contents"><h3 class="section-title">潜影盒内容（每盒聚合）</h3>' + shulkerSlots.map(item =>
        '<div class="shulker-box-block"><div class="shulker-entry"><img src="' + esc(iconUrl(item.itemId, 'item')) + '" alt="" style="width:24px;height:24px" loading="lazy"><strong>' + esc(item.displayName) + '</strong><span class="muted">x' + esc(item.amount) + ' · # ' + esc(item.shortCode) + '</span></div>' +
        (item.shulkerContents?.length
          ? item.shulkerContents.map(entry => '<div class="shulker-entry"><span class="muted">·</span><img src="' + esc(iconUrl(entry.itemId, 'item')) + '" alt="" style="width:18px;height:18px" loading="lazy"><span>' + esc(entry.displayName) + '</span><span class="item-amount">x' + esc(shortCount(entry.amount)) + '</span><span class="muted">(' + esc(entry.slotCount) + ' 格 · # ' + esc(entry.shortCode) + ')</span></div>').join('')
          : '<div class="shulker-entry muted">（空盒）</div>') +
        '</div>'
      ).join('') + '</div>' : ''
      detailEl.innerHTML =
        '<div class="chest-detail-head"><strong>木桶 ' + esc(chestId) + '</strong>' +
        '<span class="muted">' + esc(data.types) + ' 种 / ' + num(data.total) + ' 个 · 快照时间 ' + esc(data.nowLabel) + '</span>' +
        '<span style="flex:1"></span>' +
        '<button id="adminChestLiveBtn" class="solid">实时重读</button>' +
        '<button id="adminChestCloseBtn" class="primary">关闭</button></div>' +
        '<div id="adminChestLiveStatus" class="muted" style="margin-bottom:8px"></div>' +
        '<div class="chest-slots-grid">' + slotsHtml + '</div>' + shulkerHtml
      $('adminChestLiveBtn').addEventListener('click', () => resyncAdminChestLive(chestId))
      $('adminChestCloseBtn').addEventListener('click', closeAdminChest)
    }

    async function resyncAdminChestLive(chestId) {
      const statusEl = $('adminChestLiveStatus')
      statusEl.textContent = '实时重读中：机器人正在打开这个木桶（会走到桶边开桶，可能需要几秒到十几秒）……'
      $('adminChestLiveBtn').disabled = true
      try {
        const data = await post('/api/admin/chest/live', { chest: chestId })
        statusEl.textContent = data.message + ' 快照时间：' + data.nowLabel
        renderAdminChestDetail({ ...data, chestLabel: data.chestLabel || chestId, nowLabel: data.nowLabel })
        // 重读会更新数据库记录，顺手刷新列表统计
        loadAdminChests().catch(() => {})
      } catch (error) {
        statusEl.textContent = '实时重读失败：' + error.message
        $('adminChestLiveBtn').disabled = false
      }
    }

    function closeAdminChest() {
      state.adminChestId = ''
      $('adminChestDetail').classList.add('hidden')
      document.querySelectorAll('[data-admin-chest]').forEach(el => el.classList.remove('selected'))
    }

    // ===== 管理面板：终端实时日志 + logs 文件浏览 =====
    function adminLogTimeLabel(tsLabel) {
      return String(tsLabel || '').slice(11) || '';
    }

    function renderAdminLogRows(rows) {
      return rows.map(row =>
        '<span class="log-line ' + esc(row.level) + '"><span class="log-time">' + esc(adminLogTimeLabel(row.tsLabel)) + '</span><span class="log-text">' + esc(row.text) + '</span></span>'
      ).join('');
    }

    async function loadAdminConsoleLogs(reset) {
      if (reset) {
        state.adminLogAfterSeq = 0;
        state.adminLogClearedSeq = 0;
        $('adminLogConsole').innerHTML = '';
      }
      const data = await api('/api/admin/console-logs', { afterSeq: state.adminLogAfterSeq || 0 });
      state.adminLogAfterSeq = data.nextSeq || state.adminLogAfterSeq || 0;
      const consoleEl = $('adminLogConsole');
      if (reset && !data.rows.length) consoleEl.innerHTML = '<span class="muted">暂无日志。</span>';
      if (data.rows.length) {
        if (state.adminLogClearedSeq) {
          const fresh = data.rows.filter(row => row.seq > state.adminLogClearedSeq);
          consoleEl.innerHTML = renderAdminLogRows(fresh);
          state.adminLogClearedSeq = 0;
        } else {
          consoleEl.innerHTML += renderAdminLogRows(data.rows);
        }
        // 只保留最近 5000 行 DOM
        while (consoleEl.childElementCount > 5000) consoleEl.removeChild(consoleEl.firstElementChild);
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
      $('adminLogStatus').textContent = data.total + ' / ' + data.limit + ' 条缓冲' + (data.rows.length ? ' · +' + data.rows.length : '');
    }

    function startAdminLogPolling() {
      if (state.adminLogTimer) return;
      state.adminLogPaused = false;
      $('adminLogPause').textContent = '暂停刷新';
      state.adminLogTimer = setInterval(() => {
        if (state.adminLogPaused) return;
        loadAdminConsoleLogs(false).catch(() => {});
      }, 3000);
    }

    function stopAdminLogPolling() {
      if (state.adminLogTimer) { clearInterval(state.adminLogTimer); state.adminLogTimer = null; }
    }

    async function loadAdminLogFiles() {
      const data = await api('/api/admin/log-files');
      const listEl = $('adminLogFileList');
      state.adminLogFiles = data.rows || [];
      listEl.innerHTML = state.adminLogFiles.length ? state.adminLogFiles.map((row, index) =>
        '<div class="log-file-item" data-admin-log-file="' + esc(row.name) + '"><span class="name">' + esc(row.name) + '</span><span class="muted">' + esc(row.sizeLabel) + '</span><span class="muted">' + esc(row.modifiedAtLabel) + '</span></div>'
      ).join('') : '<p class="muted">logs 目录为空。</p>';
    }

    async function openAdminLogFile(name, maxBytes) {
      state.adminLogFileName = name;
      const data = await api('/api/admin/log-file', { name, maxBytes: maxBytes || state.adminLogFileMaxBytes || undefined });
      document.querySelectorAll('[data-admin-log-file]').forEach(item => item.classList.toggle('selected', item.dataset.adminLogFile === name));
      $('adminLogViewerWrap').classList.remove('hidden');
      $('adminLogFileName').textContent = data.name;
      $('adminLogFileMeta').textContent = data.sizeLabel + (data.truncated ? '（已截断，仅显示末尾 ' + Math.round((data.sizeBytes - data.startByte) / 1024) + ' KB）' : '') + ' · 修改于 ' + data.modifiedAtLabel;
      $('adminLogFileView').textContent = data.text || '（空文件）';
      $('adminLogFileView').scrollTop = 0;
      state.adminLogFileMaxBytes = maxBytes || state.adminLogFileMaxBytes;
    }

    async function loadAdminBots() {
      const data = await api('/api/admin/bots');
      const rows = data.rows || [];
      $('adminBotsTable').innerHTML = rows.length ? '<table><thead><tr><th>账号</th><th>状态</th><th>OAuth2 登录</th><th>当前任务</th><th>操作</th></tr></thead><tbody>' + rows.map(row => {
        const oauthStatus = row.status === 'online' || row.status === 'logging_in'
          ? '已完成'
          : (row.status === 'auth_required' ? '等待验证码' : (row.status === 'connecting' || row.status === 'starting' ? '正在登录' : '无需操作'));
        const device = row.deviceCode ? '<a href="' + esc(row.deviceCode.verificationUri) + '" target="_blank" rel="noreferrer">打开微软登录</a><div class="codebox" style="margin-top:6px">' + esc(row.deviceCode.userCode) + '</div>' : '<span class="muted">' + oauthStatus + '</span>';
        const action = row.enabled ? '<button data-bot-toggle="' + esc(row.id) + '">停用</button>' : '<button data-bot-toggle="' + esc(row.id) + '">启用</button>';
        return '<tr><td>' + esc(row.botName) + '<div class="muted">' + esc(row.username) + '</div><div class="muted">' + esc(row.minecraftName || '') + '</div></td><td>' + esc(botStatusLabel(row.status)) + (row.lastError ? '<div class="muted wrap">' + esc(row.lastError) + '</div>' : '') + '</td><td>' + device + '</td><td>' + (row.activeTask ? esc(row.activeTask.type + ' / ' + row.activeTask.username + ' / ' + row.activeTask.phase) : '<span class="muted">空闲</span>') + '</td><td>' + action + ' <button data-bot-delete="' + esc(row.id) + '">删除</button></td></tr>';
      }).join('') + '</tbody></table>' : '<p class="muted">暂无机器人账号。</p>';
      document.querySelectorAll('[data-bot-toggle]').forEach(button => button.addEventListener('click', async () => {
        try { await post('/api/admin/bots/enabled', { id: button.dataset.botToggle, enabled: button.textContent === '启用' }); await loadAdminBots(); } catch (error) { toast(error.message); }
      }));
      document.querySelectorAll('[data-bot-delete]').forEach(button => button.addEventListener('click', async () => {
        if (!window.confirm('确认删除这个机器人账号？')) return;
        try { await post('/api/admin/bots/delete', { id: button.dataset.botDelete }); await loadAdminBots(); } catch (error) { toast(error.message); }
      }));
    }

    async function loadAdminUsers() {
      const data = await api('/api/admin/users');
      renderTable('adminUsersTable', ['玩家', 'UUID', '来源', '添加时间', '操作'], (data.rows || []).map(row => {
        const source = row.fromConfig ? 'config.json / 数据库' : '数据库';
        const action = row.username === state.user?.username ? '<span class="muted">当前账号</span>' : '<button data-admin-user-remove="' + esc(row.username) + '" data-admin-user-uuid="' + esc(row.uuid || '') + '">删除</button>';
        return '<tr><td>' + esc(row.username) + '</td><td class="wrap">' + esc(row.uuid || '-') + '</td><td>' + esc(source) + '</td><td>' + esc(row.createdAtLabel || row.createdAt || '') + '</td><td>' + action + '</td></tr>';
      }), '暂无系统管理员。');
      document.querySelectorAll('[data-admin-user-remove]').forEach(button => button.addEventListener('click', async () => {
        if (!window.confirm('确认删除这个系统管理员？')) return;
        try {
          const data = await post('/api/admin/users/remove', { username: button.dataset.adminUserRemove, uuid: button.dataset.adminUserUuid });
          toast(data.message);
          await loadAdminUsers();
        } catch (error) { toast(error.message); }
      }));
    }

    async function loadAdminQuotas() {
      const data = await api('/api/admin/quotas', { q: $('adminQuotaQ').value });
      renderStats('adminQuotaOverall', { '木桶数量': data.overall?.chestCount || 0, '已用物理格数': data.overall?.usedSlots || 0, '总物理格数': data.overall?.totalSlots || 0, '整体使用率 %': data.overall?.usagePercent || 0 });
      renderTable('adminQuotaTable', ['仓库', '使用情况', '额度模式', '额度', '操作'], (data.rows || []).map(row =>
        '<tr data-owner="' + esc(row.ownerUuid) + '"><td>' + esc(row.label) + '<div class="muted">' + esc(row.ownerUuid) + '</div></td><td>' + num(row.usedSlots) + ' / ' + num(row.quotaSlots) + ' 格<div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(row.usagePercent || 0)) + '%"></div></div><div class="muted">' + esc(row.usagePercent) + '%</div></td><td>' + (row.quotaMode === 'custom' ? '自定义额度' : '套餐额度') + '</td><td><input class="compact-input" type="number" min="0" value="' + esc(row.quotaSlots) + '" data-quota-value></td><td><button data-quota-save>设为自定义</button>' + (row.quotaMode === 'custom' ? '<button data-admin-quota-restore="' + esc(row.ownerUuid) + '">恢复套餐</button>' : '') + '</td></tr>'
      ), '没有仓库额度。');
    }

    async function loadAdminSubscriptionUsers() {
      const data = await api('/api/admin/subscription/users', { q: $('adminPlayerQ').value });
      renderTable('adminPlayerTable', ['玩家', '余额', '个人仓库', '当前套餐', '操作'], (data.rows || []).map(row =>
        '<tr><td>' + esc(row.username) + '<div class="muted">' + esc(row.uuid) + '</div></td><td>' + money(row.balanceCents) + ' TSLC</td><td>' + (row.hasPersonalWarehouse ? '已创建' : '无') + '</td><td>' + esc(subscriptionStatusText(row.personal)) + '</td><td><button data-admin-sub-user="' + esc(row.uuid) + '">管理</button></td></tr>'
      ), '没有玩家。');
      if (state.adminSubscriptionUserUuid && data.rows?.some(row => row.uuid === state.adminSubscriptionUserUuid)) await loadAdminSubscriptionUser(state.adminSubscriptionUserUuid);
    }

    function adminEntitlementCard(label, ownerUuid, entitlement) {
      if (!entitlement) return '<div class="organization-card"><strong>' + esc(label) + '</strong><div class="muted">没有仓库</div></div>';
      return '<div class="organization-card"><div class="organization-head"><div><strong>' + esc(label) + '</strong><div class="muted">' + esc(subscriptionStatusText(entitlement)) + '</div></div><div class="organization-actions">' +
        (entitlement.status === 'active' ? '<button class="danger" data-admin-sub-cancel="' + esc(ownerUuid) + '">取消订阅</button>' : '') +
        (entitlement.quotaMode === 'custom' ? '<button data-admin-quota-restore="' + esc(ownerUuid) + '">恢复套餐额度</button>' : '') +
      '</div></div></div>';
    }

    async function loadAdminSubscriptionUser(uuid) {
      const data = await api('/api/admin/subscription/user', { uuid });
      state.adminSubscriptionUserUuid = data.player.uuid;
      const ledgerRows = (data.ledger || []).map(row => '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(row.type) + '</td><td>' + (row.amountCents >= 0 ? '+' : '') + money(row.amountCents) + '</td><td>' + money(row.balanceAfterCents) + '</td><td>' + esc(row.adminUsername || '') + '</td></tr>');
      const orderRows = (data.orders || []).map(row => '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(row.ownerUuid) + '</td><td>' + esc(row.planName) + '</td><td>' + money(row.priceCents) + '</td><td>' + esc(dateTime(row.newExpiresAtMs)) + '</td></tr>');
      $('adminPlayerDetail').innerHTML =
        '<h3>' + esc(data.player.username) + '</h3><div class="subscription-balance">' + money(data.wallet.balanceCents) + ' TSLC</div>' +
        '<div class="alias-add"><select data-admin-wallet-operation><option value="add">增加</option><option value="subtract">扣除</option><option value="set">设置为</option></select><input data-admin-wallet-amount placeholder="TSLC 金额，例如 1.00"><button class="solid" data-admin-wallet-save="' + esc(data.player.uuid) + '">调整余额</button></div>' +
        '<h3 class="section-title">订阅</h3>' + adminEntitlementCard('个人仓库', data.player.uuid, data.personal) +
        (data.organizations || []).map(row => adminEntitlementCard('组织仓库：' + row.name, row.ownerUuid, row.entitlement)).join('') +
        '<h3 class="section-title">余额流水</h3>' + tableMarkup(['时间', '类型', '变动', '余额', '管理员'], ledgerRows, '没有余额流水。') +
        '<h3 class="section-title">订购记录</h3>' + tableMarkup(['时间', '仓库', '套餐', '实付', '到期日'], orderRows, '没有订购记录。');
    }

    async function loadAdminSubscriptionConfig() {
      const data = await api('/api/admin/subscription/config');
      const settings = data.settings || {};
      $('adminSubscriptionSettings').innerHTML =
        '<label><span>存命令自动注册</span><input type="checkbox" data-sub-setting="autoRegisterOnDeposit"' + (settings.autoRegisterOnDeposit ? ' checked' : '') + '></label>' +
        '<label><span>网页登录自动注册</span><input type="checkbox" data-sub-setting="autoRegisterOnWebLogin"' + (settings.autoRegisterOnWebLogin ? ' checked' : '') + '></label>' +
        '<label><span>每日自动注册上限（-1无限）</span><input type="number" min="-1" data-sub-setting="dailyAutoRegistrationLimit" value="' + esc(settings.dailyAutoRegistrationLimit) + '"></label>' +
        '<label><span>每人组织仓库上限</span><input type="number" min="0" data-sub-setting="maxCustomWarehousesPerPlayer" value="' + esc(settings.maxCustomWarehousesPerPlayer) + '"></label>' +
        '<label><span>到账汇总窗口 ms</span><input type="number" data-sub-setting="paymentSummaryWindowMs" value="' + esc(settings.paymentSummaryWindowMs) + '"></label>' +
        '<label><span>私信发送间隔 ms</span><input type="number" data-sub-setting="paymentMessageIntervalMs" value="' + esc(settings.paymentMessageIntervalMs) + '"></label>' +
        '<label><span>未识别日志保留天数</span><input type="number" data-sub-setting="paymentLogRetentionDays" value="' + esc(settings.paymentLogRetentionDays) + '"></label>' +
        '<label><span>网络时间同步间隔 ms</span><input type="number" data-sub-setting="networkTimeSyncIntervalMs" value="' + esc(settings.networkTimeSyncIntervalMs) + '"></label>' +
        '<label class="wide"><span>到账正则（每行一条，按顺序匹配；识别不到时自动使用内置格式与关键词识别）</span><textarea data-sub-setting="paymentRegex" rows="4">' + esc(settings.paymentRegex) + '</textarea></label>' +
        '<label class="wide"><span>NTP 时间源（每行一个）</span><textarea data-sub-setting="networkTimeSources">' + esc((settings.networkTimeSources || []).join('\\n')) + '</textarea></label>';
      $('adminSubscriptionPlans').innerHTML = (data.plans || []).map(plan =>
        '<div class="plan-editor" data-plan-editor="' + esc(plan.id) + '"><strong>' + esc(plan.id) + '</strong>' +
        '<input data-plan-name value="' + esc(plan.name) + '" placeholder="套餐名"><input data-plan-description value="' + esc(plan.description) + '" placeholder="简介">' +
        '<div class="alias-add"><input type="number" min="0" data-plan-quota value="' + esc(plan.quotaSlots) + '" placeholder="额度格数"><input type="number" min="0" step="0.01" data-plan-price value="' + money(plan.priceCents) + '" placeholder="价格（TSLC）"><label class="check-label"><input type="checkbox" data-plan-visible' + (plan.visible ? ' checked' : '') + (plan.id === 'personal_free' ? ' disabled' : '') + '> 展示</label></div>' +
        '<textarea data-plan-features placeholder="每行一条权益">' + esc((plan.features || []).join('\\n')) + '</textarea><button class="primary" data-plan-save>保存此套餐</button></div>'
      ).join('');
      $('adminSubscriptionTime').textContent = data.time?.trusted
        ? '网络时间：' + dateTime(data.time.now) + ' · 来源 ' + data.time.source + ' · 偏差 ' + data.time.offsetMs + 'ms · 上次同步 ' + dateTime(data.time.lastSyncedAt)
        : '网络时间未同步：' + (data.time?.lastError || '等待同步');
      renderTable('adminIdentityConflicts', ['时间', '用户名', '临时账户', '冲突 UUID'], (data.identityConflicts || []).map(row => '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(row.username) + '</td><td>' + esc(row.ghostUuid) + '</td><td class="wrap">' + esc(row.realUuid) + '</td></tr>'), '没有用户名合并异常。');
      const conflicts = data.playerIdentityConflicts || [];
      state.adminPlayerIdentityConflicts = new Map(conflicts.map(row => [String(row.id), row]));
      $('adminPlayerIdentityConflicts').innerHTML = conflicts.length ? '<table><thead><tr><th>时间</th><th>玩家</th><th>冲突 UUID</th><th>操作</th></tr></thead><tbody>' + conflicts.map(row => {
        return '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(row.username) + '</td><td class="wrap">' + esc((row.uuids || []).join(' ')) + '</td><td><select data-pid-keep><option value="">选择要保留的主号</option>' + (row.uuids || []).map(uuid => '<option value="' + esc(uuid) + '">' + esc(uuid) + '</option>').join('') + '</select><button class="primary" data-pid-merge="' + esc(row.id) + '">合并到此号</button></td></tr>';
      }).join('') + '</tbody></table>' : '<p class="muted">没有双 UUID 冲突。</p>';
      const logs = await api('/api/admin/subscription/logs');
      renderTable('adminPaymentLogs', ['时间', 'Bot', '完整消息'], (logs.rows || []).map(row => '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(row.botName) + '</td><td class="wrap">' + esc(row.message) + '</td></tr>'), '没有未识别到账日志。');
      await loadAdminPaymentRecords();
    }

    async function loadAdminPaymentRecords() {
      const data = await api('/api/admin/subscription/payments', { page: state.adminPaymentPage, pageSize: 100 });
      state.adminPaymentPage = Number(data.page || 1);
      state.adminPaymentTotalPages = Number(data.totalPages || 1);
      renderTable('adminPaymentRecords', ['到账时间', '玩家', '金额', '到账后余额', '收款 Bot', '完整日志'], (data.rows || []).map(row =>
        '<tr><td>' + esc(dateTime(row.createdAtMs)) + '</td><td>' + esc(row.username) + '<div class="muted">' + esc(row.playerUuid) + '</div></td><td>+' + money(row.amountCents) + ' TSLC</td><td>' + money(row.balanceAfterCents) + ' TSLC</td><td>' + esc(row.botName || '-') + '</td><td class="wrap">' + esc(row.message) + '</td></tr>'
      ), '还没有充值记录。');
      $('adminPaymentPage').textContent = '第 ' + state.adminPaymentPage + ' / ' + state.adminPaymentTotalPages + ' 页 · 共 ' + Number(data.total || 0) + ' 条';
      $('adminPaymentPrev').disabled = state.adminPaymentPage <= 1;
      $('adminPaymentNext').disabled = state.adminPaymentPage >= state.adminPaymentTotalPages;
    }

    function collectAdminSubscriptionSettings() {
      const result = {};
      document.querySelectorAll('[data-sub-setting]').forEach(input => {
        if (input.type === 'checkbox') result[input.dataset.subSetting] = input.checked;
        else if (input.dataset.subSetting === 'networkTimeSources') result[input.dataset.subSetting] = input.value.split(/\\r?\\n/).map(value => value.trim()).filter(Boolean);
        else result[input.dataset.subSetting] = input.value;
      });
      return result;
    }

    async function saveAdminSubscriptionSettings() {
      const data = await post('/api/admin/subscription/config', collectAdminSubscriptionSettings());
      toast(data.message); await loadAdminSubscriptionConfig();
    }

    async function saveAdminSubscriptionPlan(editor) {
      const data = await post('/api/admin/subscription/plan', {
        id: editor.dataset.planEditor,
        name: editor.querySelector('[data-plan-name]').value,
        description: editor.querySelector('[data-plan-description]').value,
        quotaSlots: editor.querySelector('[data-plan-quota]').value,
        priceCents: Math.round(Number(editor.querySelector('[data-plan-price]').value || 0) * 100),
        visible: editor.querySelector('[data-plan-visible]').checked,
        features: editor.querySelector('[data-plan-features]').value.split(/\\r?\\n/)
      });
      toast(data.message); await loadAdminSubscriptionConfig();
    }

    async function loadAdminWarehouses() {
      await Promise.all([loadAdminWarehouseProvisioning(), loadAdminQuotas()]);
    }

    async function loadAdminCurrent() {
      if (!state.user?.isAdmin) return;
      if (state.adminTab === 'bots') return loadAdminBots();
      if (state.adminTab === 'admins') return loadAdminUsers();
      if (state.adminTab === 'players') return loadAdminSubscriptionUsers();
      if (state.adminTab === 'subscriptions') return loadAdminSubscriptionConfig();
      if (state.adminTab === 'inventory') return loadAdminInventory();
      if (state.adminTab === 'warehouses') return loadAdminWarehouses();
      if (state.adminTab === 'mismatches') return loadAdminMismatches();
      if (state.adminTab === 'chests') return loadAdminChests();
      if (state.adminTab === 'transactions') return loadAdminTransactions();
      if (state.adminTab === 'commands') return loadAdminCommands();
      if (state.adminTab === 'aliases') return loadAdminAliases();
      if (state.adminTab === 'logs') { await loadAdminConsoleLogs(true); await loadAdminLogFiles(); }
    }

    function setAdminTab(tab) {
      if (tab !== 'inventory' && state.adminAliasMode) setAdminAliasMode(false);
      state.adminTab = tab;
      document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.adminTab === tab));
      $('adminInventory').classList.toggle('hidden', tab !== 'inventory');
      $('adminBots').classList.toggle('hidden', tab !== 'bots');
      $('adminUsers').classList.toggle('hidden', tab !== 'admins');
      $('adminPlayers').classList.toggle('hidden', tab !== 'players');
      $('adminSubscriptions').classList.toggle('hidden', tab !== 'subscriptions');
      $('adminWarehouses').classList.toggle('hidden', tab !== 'warehouses');
      $('adminMismatches').classList.toggle('hidden', tab !== 'mismatches');
      $('adminChests').classList.toggle('hidden', tab !== 'chests');
      $('adminTransactions').classList.toggle('hidden', tab !== 'transactions');
      $('adminCommands').classList.toggle('hidden', tab !== 'commands');
      $('adminAliases').classList.toggle('hidden', tab !== 'aliases');
      $('adminLogs').classList.toggle('hidden', tab !== 'logs');
      loadAdminCurrent().catch(error => toast(error.message));
      if (state.adminBotsTimer) { clearInterval(state.adminBotsTimer); state.adminBotsTimer = null; }
      if (tab === 'bots') state.adminBotsTimer = setInterval(() => loadAdminBots().catch(() => {}), 2000);
      if (tab !== 'logs') stopAdminLogPolling(); else startAdminLogPolling();
    }

    function setView(view) {
      if (view === 'admin' && !state.user?.isAdmin) return toast('只有管理员可以打开管理界面。');
      if (view === 'warehouseAdmin' && !state.user?.isWarehouseAdmin) return toast('你不是任何组织仓库的仓库管理员。');
      state.view = view;
      document.querySelectorAll('.navbtn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
      $('inventoryView').classList.toggle('hidden', view !== 'inventory');
      $('inventoryHero').classList.toggle('hidden', view !== 'inventory');
      $('transactionsView').classList.toggle('hidden', view !== 'transactions');
      $('subscriptionsView').classList.toggle('hidden', view !== 'subscriptions');
      $('myView').classList.toggle('hidden', view !== 'my');
      $('warehouseAdminView').classList.toggle('hidden', view !== 'warehouseAdmin');
      $('helpView').classList.toggle('hidden', view !== 'help');
      $('adminView').classList.toggle('hidden', view !== 'admin');
      if (view !== 'admin') stopAdminLogPolling();
      if (view === 'transactions') loadTransactions().catch(error => toast(error.message));
      if (view === 'subscriptions') loadSubscriptions().catch(error => toast(error.message));
      if (view === 'my') loadMyCurrent().catch(error => toast(error.message));
      if (view === 'warehouseAdmin') loadWarehouseAdminOrganizations().catch(error => toast(error.message));
      if (view === 'admin') loadAdminCurrent().catch(error => toast(error.message));
    }

    $('owner').addEventListener('change', () => {
      state.owner = $('owner').value || state.owner;
      renderOwners();
      loadInventory().catch(error => toast(error.message));
    });
    $('setDefaultOwner').addEventListener('click', () => setDefaultOwner().catch(error => toast(error.message)));
    $('search').addEventListener('input', renderInventory);
    try { state.shulkerBoxView = localStorage.getItem('shulkerBoxView') === '1'; } catch { }
    $('shulkerBoxView').checked = state.shulkerBoxView;
    $('shulkerBoxView').addEventListener('change', () => {
      state.shulkerBoxView = $('shulkerBoxView').checked;
      try { localStorage.setItem('shulkerBoxView', state.shulkerBoxView ? '1' : '0'); } catch { }
      hideTip();
      pruneSelection();
      updateInventoryHeroStats();
      renderSelected();
      renderInventory();
    });
    $('targetPlayer').addEventListener('input', scheduleOnlinePlayersLoad);
    $('targetPlayer').addEventListener('focus', scheduleOnlinePlayersLoad);
    $('targetPlayer').addEventListener('keydown', event => {
      if (event.key === 'Escape') hideOnlinePlayers();
    });
    $('refresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '库存已刷新', () => loadInventory({ force: true })).catch(error => toast(error.message));
    });
    $('aliasMode').addEventListener('click', () => setAliasMode(!state.aliasMode));
    document.addEventListener('keydown', event => {
      if (event.key === 'Control' && !event.repeat) lockTip();
    });
    document.addEventListener('keyup', event => {
      if (event.key === 'Control' && state.tipLocked) closeTip();
    });
    window.addEventListener('blur', () => {
      if (state.tipLocked) closeTip();
    });
    const handleInventoryScroll = () => {
      hideTip();
      if (state.iconScrollTimer) clearTimeout(state.iconScrollTimer);
      state.iconScrollTimer = setTimeout(() => scheduleIconLoading(currentInventoryRows()), 80);
    };
    // On desktop the page scrolls inside <main>; on narrow layouts it falls
    // back to the document, so listen to both scroll containers.
    document.querySelector('main').addEventListener('scroll', handleInventoryScroll, { passive: true });
    window.addEventListener('scroll', handleInventoryScroll, { passive: true });
    window.addEventListener('touchstart', hideTip, { passive: true });
    $('litematicPick').addEventListener('click', () => $('litematicFile').click());
    $('litematicFile').addEventListener('change', uploadLitematic);
    $('txLoad').addEventListener('click', () => { state.txPage = 1; loadTransactions().catch(error => toast(error.message)); });
    $('txRefresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '交易记录已刷新', () => loadTransactions()).catch(error => toast(error.message));
    });
    $('txOwner').addEventListener('change', () => { state.txPage = 1; loadTransactions().catch(error => toast(error.message)); });
    $('txPrev').addEventListener('click', () => { if (state.txPage > 1) state.txPage--; loadTransactions().catch(error => toast(error.message)); });
    $('txNext').addEventListener('click', () => { if (state.txPage < state.txTotalPages) state.txPage++; loadTransactions().catch(error => toast(error.message)); });
    $('adminRefresh').addEventListener('click', event => {
      if (state.view === 'admin' && state.adminTab === 'logs') return loadAdminLogFiles().catch(error => toast(error.message));
      runButtonTask(event.currentTarget, '刷新中...', '管理数据已刷新', () => loadAdminCurrent()).catch(error => toast(error.message));
    });
    $('adminBotAdd').addEventListener('click', async event => {
      try {
        await runButtonTask(event.currentTarget, '添加中...', '账号已添加', () => post('/api/admin/bots/add', { username: $('adminBotEmail').value.trim(), botName: $('adminBotName').value.trim() }));
        $('adminBotEmail').value = ''; $('adminBotName').value = ''; await loadAdminBots();
      } catch (error) { toast(error.message); }
    });
    $('adminUserAdd').addEventListener('click', async event => {
      try {
        await runButtonTask(event.currentTarget, '添加中...', '管理员已添加', () => post('/api/admin/users/add', { username: $('adminUserName').value.trim() }));
        $('adminUserName').value = ''; await loadAdminUsers();
      } catch (error) { toast(error.message); }
    });
    $('adminUserName').addEventListener('keydown', event => {
      if (event.key === 'Enter') $('adminUserAdd').click();
    });
    $('adminInvLoad').addEventListener('click', () => loadAdminInventory({ owner: $('adminInvOwner').value }).catch(error => toast(error.message)));
    $('adminInvOwner').addEventListener('change', event => loadAdminInventory({ owner: event.currentTarget.value }).catch(error => toast(error.message)));
    $('adminMmLoad').addEventListener('click', () => loadAdminMismatches().catch(error => toast(error.message)));
    $('adminChestLoad').addEventListener('click', () => loadAdminChests().catch(error => toast(error.message)));
    $('adminChestRefresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '木桶列表已刷新', () => loadAdminChests()).catch(error => toast(error.message));
    });
    for (const axis of ['x', 'y', 'z']) {
      $('adminChest' + axis.toUpperCase()).addEventListener('keydown', event => {
        if (event.key === 'Enter') loadAdminChests().catch(error => toast(error.message));
      });
    }
    $('adminChestQ').addEventListener('keydown', event => {
      if (event.key === 'Enter') loadAdminChests().catch(error => toast(error.message));
    });
    document.addEventListener('click', event => {
      const chestEl = event.target.closest('[data-admin-chest]')
      if (chestEl) openAdminChest(chestEl.dataset.adminChest)
    })
    $('adminMmBatchResolve').addEventListener('click', () => runAdminMmBatch('extra').catch(error => toast(error.message)));
    $('adminMmBatchDeduct').addEventListener('click', () => runAdminMmBatch('missing').catch(error => toast(error.message)));
    document.querySelectorAll('[data-admin-mm-select]').forEach(button => button.addEventListener('click', () => {
      const mode = button.dataset.adminMmSelect;
      document.querySelectorAll('[data-mm-check]').forEach(box => {
        if (mode === 'none') box.checked = false;
        else if (box.dataset.mmKind === mode) box.checked = true;
      });
      updateAdminMmBatchCount();
    }));
    $('adminTransferRun').addEventListener('click', () => runAdminTransfer().catch(error => toast(error.message)));
    $('adminAliasMode').addEventListener('click', () => setAdminAliasMode(!state.adminAliasMode));
    $('globalAliasSave').addEventListener('click', () => saveGlobalAliasFromModal().catch(error => toast(error.message)));
    $('globalAliasInput').addEventListener('keydown', event => { if (event.key === 'Enter') saveGlobalAliasFromModal().catch(error => toast(error.message)); });
    $('adminPersonalWarehouseCreate').addEventListener('click', () => createAdminPersonalWarehouse().catch(error => toast(error.message)));
    $('adminOrganizationWarehouseCreate').addEventListener('click', () => createAdminOrganizationWarehouse().catch(error => toast(error.message)));
    $('adminTxLoad').addEventListener('click', () => { state.adminTxPage = 1; loadAdminTransactions().catch(error => toast(error.message)); });
    $('adminTxPrev').addEventListener('click', () => { if (state.adminTxPage > 1) state.adminTxPage--; loadAdminTransactions().catch(error => toast(error.message)); });
    $('adminTxNext').addEventListener('click', () => { if (state.adminTxPage < state.adminTxTotalPages) state.adminTxPage++; loadAdminTransactions().catch(error => toast(error.message)); });
    $('adminCommandLoad').addEventListener('click', () => { state.adminCommandPage = 1; loadAdminCommands().catch(error => toast(error.message)); });
    $('adminCommandChannel').addEventListener('change', () => { state.adminCommandPage = 1; loadAdminCommands().catch(error => toast(error.message)); });
    $('adminCommandPrev').addEventListener('click', () => { if ((state.adminCommandPage || 1) > 1) state.adminCommandPage--; loadAdminCommands().catch(error => toast(error.message)); });
    $('adminCommandNext').addEventListener('click', () => { if ((state.adminCommandPage || 1) < (state.adminCommandTotalPages || 1)) state.adminCommandPage++; loadAdminCommands().catch(error => toast(error.message)); });
    $('adminAliasLoad').addEventListener('click', () => loadAdminAliases().catch(error => toast(error.message)));
    $('adminLogPause').addEventListener('click', () => {
      state.adminLogPaused = !state.adminLogPaused;
      $('adminLogPause').textContent = state.adminLogPaused ? '恢复刷新' : '暂停刷新';
    });
    $('adminLogClear').addEventListener('click', () => {
      state.adminLogClearedSeq = state.adminLogAfterSeq || 0;
      $('adminLogConsole').innerHTML = '<span class="muted">已清屏（不影响缓冲，新日志会继续显示）。</span>';
    });
    $('adminLogFileClose').addEventListener('click', () => {
      $('adminLogViewerWrap').classList.add('hidden');
      state.adminLogFileName = '';
      document.querySelectorAll('[data-admin-log-file]').forEach(item => item.classList.remove('selected'));
    });
    $('adminLogFileRefresh').addEventListener('click', () => {
      if (state.adminLogFileName) openAdminLogFile(state.adminLogFileName).catch(error => toast(error.message));
    });
    $('adminLogFileTail').addEventListener('click', () => {
      if (state.adminLogFileName) openAdminLogFile(state.adminLogFileName, 1024 * 1024).catch(error => toast(error.message));
    });
    document.addEventListener('click', event => {
      const logFileItem = event.target.closest('[data-admin-log-file]');
      if (logFileItem) {
        state.adminLogFileMaxBytes = 256 * 1024;
        openAdminLogFile(logFileItem.dataset.adminLogFile).catch(error => toast(error.message));
      }
    });
    $('adminQuotaLoad').addEventListener('click', () => loadAdminQuotas().catch(error => toast(error.message)));
    $('subscriptionRefresh').addEventListener('click', () => loadSubscriptions().catch(error => toast(error.message)));
    $('sidebarSubscription').addEventListener('click', () => setView('subscriptions'));
    $('subscriptionOrganization').addEventListener('change', event => { state.subscriptionOrganizationOwner = event.currentTarget.value; loadSubscriptions().catch(error => toast(error.message)); });
    $('subscriptionOrganizationCreateButton').addEventListener('click', () => createSubscriptionOrganization().catch(error => toast(error.message)));
    $('adminPlayerLoad').addEventListener('click', () => loadAdminSubscriptionUsers().catch(error => toast(error.message)));
    $('adminSubscriptionSettingsSave').addEventListener('click', () => saveAdminSubscriptionSettings().catch(error => toast(error.message)));
    $('adminSubscriptionTimeSync').addEventListener('click', async () => { try { const data = await post('/api/admin/subscription/time/sync'); toast(data.message); await loadAdminSubscriptionConfig(); } catch (error) { toast(error.message); } });
      $('adminPaymentRegexTest').addEventListener('click', async () => { try { const settings = collectAdminSubscriptionSettings(); const data = await post('/api/admin/subscription/regex/test', { paymentRegex: settings.paymentRegex, sample: $('adminPaymentRegexSample').value }); if (!data.matched) { $('adminPaymentRegexResult').textContent = '未匹配（含内置与关键词兜底）'; } else { const via = data.lineIndex > 0 ? '第 ' + data.lineIndex + ' 行正则' : (data.lineIndex === 0 ? '内置格式' : '关键词识别'); $('adminPaymentRegexResult').textContent = '匹配成功（' + via + '）：' + data.player + ' / ' + data.amount + ' TSLC（' + (data.amountCents / 100).toFixed(2) + '）'; } } catch (error) { toast(error.message); } });
    $('adminPaymentPrev').addEventListener('click', () => { if (state.adminPaymentPage > 1) state.adminPaymentPage--; loadAdminPaymentRecords().catch(error => toast(error.message)); });
    $('adminPaymentNext').addEventListener('click', () => { if (state.adminPaymentPage < state.adminPaymentTotalPages) state.adminPaymentPage++; loadAdminPaymentRecords().catch(error => toast(error.message)); });
    $('myRefresh').addEventListener('click', () => loadMyCurrent().catch(error => toast(error.message)));
    $('warehouseAdminRefresh').addEventListener('click', () => loadWarehouseAdminOrganizations().catch(error => toast(error.message)));
    $('myAliasLoad').addEventListener('click', () => loadMyAliases().catch(error => toast(error.message)));
    $('nbtClose').addEventListener('click', closeNbtModal);
    $('nbtCopy').addEventListener('click', () => copyNbtModal().catch(error => toast(error.message)));
    $('aliasSave').addEventListener('click', () => savePersonalAlias().catch(error => toast(error.message)));
    $('aliasInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') savePersonalAlias().catch(error => toast(error.message));
    });
    $('nbtModal').addEventListener('click', event => {
      if (event.target === $('nbtModal')) closeNbtModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeNbtModal();
    });
    document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.addEventListener('click', () => setAdminTab(btn.dataset.adminTab)));
    document.querySelectorAll('[data-my-tab]').forEach(btn => btn.addEventListener('click', () => setMyTab(btn.dataset.myTab)));
    $('loginCodeTab').addEventListener('click', () => setLoginMode('code'));
    $('loginTokenTab').addEventListener('click', () => setLoginMode('token'));
    $('loginCodeStart').addEventListener('click', startLoginChallenge);
    $('loginCodeCancel').addEventListener('click', () => cancelLoginChallenge().catch(error => toast(error.message)));
    $('loginCodeCopy').addEventListener('click', () => copyLoginChallengeCommand().catch(error => toast(error.message)));
    $('loginBtn').addEventListener('click', loginWithToken);
    $('tokenInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') loginWithToken();
    });
    window.addEventListener('beforeunload', () => {
      if (!state.loginChallengeTimer) return;
      navigator.sendBeacon?.('/api/login/challenge/cancel', new Blob(['{}'], { type: 'application/json' }));
    });
    $('withdraw').addEventListener('click', async () => {
      const items = [...state.selected.values()].map(row => ({
        itemKey: row.itemKey,
        displayName: row.displayName,
        amount: row.amount
      }));
      if (!items.length) return toast('请先点击物品加入待取列表。');
      try {
        await runWebAction(async () => {
          const data = await post('/api/action/withdraw', { ownerUuid: state.owner, items, targetUsername: $('targetPlayer').value.trim() || state.user.username });
          toast(data.message);
          updateActiveStatus(data.active);
        });
      } catch (error) { toast(error.message); }
    });
    $('deposit').addEventListener('click', async () => {
      try {
        await runWebAction(async () => {
          const data = await post('/api/action/deposit', { ownerUuid: state.owner });
          toast(data.message);
          updateActiveStatus(data.active);
        });
      } catch (error) { toast(error.message); }
    });
    $('logout').addEventListener('click', async () => { await post('/api/logout'); location.reload(); });
    $('botPlatformLink').addEventListener('click', () => { location.href = '/bot-platform'; });
    document.querySelectorAll('.navbtn[data-view]').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    document.addEventListener('click', async event => {
      const onlinePlayer = event.target.closest('[data-online-player]');
      if (onlinePlayer) {
        $('targetPlayer').value = onlinePlayer.dataset.onlinePlayer;
        hideOnlinePlayers();
        return;
      }
      if (!event.target.closest('.target-player-box')) hideOnlinePlayers();
      const adminCard = event.target.closest('#adminInvGrid [data-admin-card]');
      const adminPickRemove = event.target.closest('[data-admin-pick-remove]');
      const adminPickClear = event.target.closest('[data-admin-pick-clear]');
      const mmDeduct = event.target.closest('[data-admin-mm-deduct]');
      const pidMerge = event.target.closest('[data-pid-merge]');
      const mmResolve = event.target.closest('[data-admin-mm-resolve]');
      const mmComponents = event.target.closest('[data-admin-mm-components]');
      const aliasSave = event.target.closest('[data-admin-alias-save]');
      const aliasDetailSave = event.target.closest('[data-admin-alias-detail-save]');
      const aliasDelete = event.target.closest('[data-admin-alias-delete]');
      const adminAliasCard = event.target.closest('[data-admin-alias-card]');
      const quotaSave = event.target.closest('[data-quota-save]');
      const adminQuickShulker = event.target.closest('[data-admin-quick-shulker]');
      const personalAliasDelete = event.target.closest('[data-personal-alias-delete]');
      const myAliasAdd = event.target.closest('[data-my-alias-add]');
      const myPersonalAliasCard = event.target.closest('[data-my-personal-alias-card]');
      const myGlobalAliasCard = event.target.closest('[data-my-global-alias-card]');
      const globalAliasToggle = event.target.closest('[data-global-alias-toggle]');
      const orgRename = event.target.closest('[data-org-rename]');
      const orgMemberAdd = event.target.closest('[data-org-member-add]');
      const orgMemberRemove = event.target.closest('[data-org-member-remove]');
      const orgQuickShulker = event.target.closest('[data-org-quick-shulker]');
      const adminOrgView = event.target.closest('[data-admin-org-view]');
      const adminOrgMemberAdd = event.target.closest('[data-admin-org-member-add]');
      const adminOrgMemberRemove = event.target.closest('[data-admin-org-member-remove]');
      const adminPersonalDelete = event.target.closest('[data-admin-personal-delete]');
      const adminOrgDelete = event.target.closest('[data-admin-org-delete]');
      const subscriptionPurchase = event.target.closest('[data-subscription-purchase]');
      const adminSubscriptionUser = event.target.closest('[data-admin-sub-user]');
      const adminWalletSave = event.target.closest('[data-admin-wallet-save]');
      const adminSubscriptionCancel = event.target.closest('[data-admin-sub-cancel]');
      const adminQuotaRestore = event.target.closest('[data-admin-quota-restore]');
      const adminPlanSave = event.target.closest('[data-plan-save]');
      try {
        if (subscriptionPurchase) {
          await purchaseSubscription(subscriptionPurchase);
        } else if (adminSubscriptionUser) {
          await loadAdminSubscriptionUser(adminSubscriptionUser.dataset.adminSubUser);
        } else if (adminWalletSave) {
          const detail = adminWalletSave.closest('#adminPlayerDetail');
          const operation = detail.querySelector('[data-admin-wallet-operation]').value;
          const amount = detail.querySelector('[data-admin-wallet-amount]').value;
          if (!confirm('确认对该玩家执行余额“' + operation + '”操作，金额 ' + amount + ' TSLC？')) return;
          const data = await post('/api/admin/subscription/balance', { playerUuid: adminWalletSave.dataset.adminWalletSave, operation, amount });
          toast(data.message); await loadAdminSubscriptionUser(adminWalletSave.dataset.adminWalletSave); await loadAdminSubscriptionUsers();
        } else if (adminSubscriptionCancel) {
          if (!confirm('确认立即取消这个仓库的付费订阅？不会自动退款，仓库将立即恢复默认套餐额度。')) return;
          const data = await post('/api/admin/subscription/cancel', { ownerUuid: adminSubscriptionCancel.dataset.adminSubCancel });
          toast(data.message); await loadAdminSubscriptionUser(state.adminSubscriptionUserUuid); await loadAdminSubscriptionUsers();
        } else if (adminQuotaRestore) {
          if (!confirm('确认清除自定义额度并恢复当前套餐额度？')) return;
          const data = await post('/api/admin/quota/restore', { ownerUuid: adminQuotaRestore.dataset.adminQuotaRestore });
          toast(data.message);
          if (state.adminTab === 'players' && state.adminSubscriptionUserUuid) await loadAdminSubscriptionUser(state.adminSubscriptionUserUuid);
          if (state.adminTab === 'warehouses') await loadAdminWarehouses();
        } else if (adminQuickShulker) {
          const enabled = adminQuickShulker.dataset.enabled !== '1';
          const data = await post('/api/admin/warehouse/quick-shulker-extraction', { ownerUuid: adminQuickShulker.dataset.adminQuickShulker, enabled });
          toast(data.message);
          await loadAdminWarehouses();
        } else if (adminPlanSave) {
          await saveAdminSubscriptionPlan(adminPlanSave.closest('[data-plan-editor]'));
        } else if (adminPickRemove) {
          state.adminSelected.delete(adminPickRemove.closest('[data-admin-pick]').dataset.adminPick);
          renderAdminTransferSelection();
          loadAdminInventorySelectionState();
        } else if (adminPickClear) {
          state.adminSelected.clear();
          renderAdminTransferSelection();
          loadAdminInventorySelectionState();
        } else if (personalAliasDelete) {
          const alias = personalAliasDelete.dataset.personalAliasDelete;
          const data = await post('/api/item-alias/delete', { alias });
          toast(data.message);
          if (state.aliasItem) {
            state.aliasItem.personalAliases = (state.aliasItem.personalAliases || []).filter(name => name.toLowerCase() !== alias.toLowerCase());
            applyAliasToLocalItem(state.aliasItem.itemKey, state.aliasItem.personalAliases);
            openAliasModal(state.items.find(item => item.itemKey === state.aliasItem.itemKey) || state.aliasItem);
          }
          state.inventoryCache.clear();
          if (state.owner) await loadInventory({ force: true });
          if (state.view === 'my' && state.myTab === 'aliases') await loadMyAliases();
        } else if (myAliasAdd) {
          const row = myAliasAdd.closest('[data-item]');
          const alias = row.querySelector('[data-my-alias-input]').value;
          const data = await post('/api/item-alias/save', { itemKey: row.dataset.item, displayName: alias });
          toast(data.message);
          state.inventoryCache.clear();
          if (state.owner) await loadInventory({ force: true });
          await loadMyAliases();
        } else if (myPersonalAliasCard) {
          const row = state.myPersonalAliasRows?.get(myPersonalAliasCard.dataset.myPersonalAliasCard);
          if (row) renderMyPersonalAliasDetail(row);
        } else if (myGlobalAliasCard) {
          const row = state.myGlobalAliasRows?.get(myGlobalAliasCard.dataset.myGlobalAliasCard);
          if (row) renderMyGlobalAliasDetail(row);
        } else if (globalAliasToggle) {
          const enabled = globalAliasToggle.dataset.enabled !== '1';
          const data = await post('/api/my/global-alias/toggle', { alias: globalAliasToggle.dataset.globalAliasToggle, enabled });
          toast(data.message);
          state.inventoryCache.clear();
          if (state.owner) await loadInventory({ force: true });
          await loadMyAliases();
        } else if (adminOrgView) {
          await loadAdminOrganizationDetail(adminOrgView.dataset.adminOrgView);
        } else if (adminOrgMemberAdd) {
          const card = adminOrgMemberAdd.closest('[data-admin-org-detail]');
          const data = await post('/api/admin/organization-warehouse/member/add', {
            warehouse: card.dataset.adminOrgDetail,
            username: card.querySelector('[data-admin-org-add-name]').value,
            role: card.querySelector('[data-admin-org-add-role]').value
          });
          toast(data.message); await loadAdminWarehouseProvisioning();
        } else if (adminOrgMemberRemove) {
          const card = adminOrgMemberRemove.closest('[data-admin-org-detail]');
          const member = adminOrgMemberRemove.closest('[data-admin-org-member]');
          if (!confirm('确认从这个组织仓库删除该成员吗？系统管理员可以删除包括首位管理员在内的任意成员。')) return;
          const data = await post('/api/admin/organization-warehouse/member/remove', { warehouse: card.dataset.adminOrgDetail, playerUuid: member.dataset.adminOrgMember });
          toast(data.message); await loadAdminWarehouseProvisioning();
        } else if (adminPersonalDelete) {
          const ownerUuid = adminPersonalDelete.dataset.adminPersonalDelete;
          const ownerName = adminPersonalDelete.dataset.ownerName;
          if (!confirm('确认删除 ' + ownerName + ' 的个人仓库吗？该仓库全部库存会转入 momo，此操作不可撤销。')) return;
          const data = await post('/api/admin/personal-warehouse/delete', { ownerUuid, confirmOwnerUuid: ownerUuid });
          toast(data.message); state.adminOwners = []; state.owners = []; state.inventoryCache.clear();
          const me = await api('/api/me'); state.owners = me.owners || []; state.defaultOwnerUuid = me.defaultOwnerUuid; renderOwners();
          await loadAdminWarehouses();
        } else if (adminOrgDelete) {
          const card = adminOrgDelete.closest('[data-admin-org-detail]');
          const warehouse = card.dataset.adminOrgDetail;
          const confirmation = prompt('删除组织仓库会把全部库存转入 momo。请输入仓库名 “' + warehouse + '” 确认删除：');
          if (confirmation === null) return;
          const data = await post('/api/admin/organization-warehouse/delete', { warehouse, confirmName: confirmation });
          toast(data.message); state.adminOrganizationName = ''; state.adminOwners = []; state.owners = []; state.inventoryCache.clear();
          const me = await api('/api/me'); state.owners = me.owners || []; state.defaultOwnerUuid = me.defaultOwnerUuid; renderOwners();
          await loadAdminWarehouses();
        } else if (orgQuickShulker) {
          const enabled = orgQuickShulker.dataset.enabled !== '1';
          const card = orgQuickShulker.closest('[data-warehouse]');
          const data = await post('/api/warehouse-admin/quick-shulker-extraction', { warehouse: card.dataset.warehouse, enabled });
          toast(data.message); await loadWarehouseAdminOrganizations();
        } else if (orgRename) {
          const card = orgRename.closest('[data-warehouse]');
          const data = await post('/api/warehouse-admin/rename', { warehouse: card.dataset.warehouse, newName: card.querySelector('[data-org-new-name]').value });
          toast(data.message);
          state.owners = [];
          state.inventoryCache.clear();
          const me = await api('/api/me'); state.owners = me.owners || []; state.defaultOwnerUuid = me.defaultOwnerUuid; renderOwners();
          await loadWarehouseAdminOrganizations();
        } else if (orgMemberAdd) {
          const card = orgMemberAdd.closest('[data-warehouse]');
          const data = await post('/api/warehouse-admin/member/add', { warehouse: card.dataset.warehouse, username: card.querySelector('[data-org-add-name]').value });
          toast(data.message); await loadWarehouseAdminOrganizations();
        } else if (orgMemberRemove) {
          const card = orgMemberRemove.closest('[data-warehouse]');
          const member = orgMemberRemove.closest('[data-member]');
          if (!confirm('确认删除这个仓库成员吗？')) return;
          const data = await post('/api/warehouse-admin/member/remove', { warehouse: card.dataset.warehouse, playerUuid: member.dataset.member });
          toast(data.message); await loadWarehouseAdminOrganizations();
        } else if (mmComponents) {
          const row = state.adminMismatchRows.get('mm-' + mmComponents.dataset.adminMmComponents);
          if (!row) throw new Error('找不到这条异常记录。');
          openNbtModal(row);
        } else if (pidMerge) {
          const row = pidMerge.closest('tr');
          const primaryUuid = row.querySelector('[data-pid-keep]').value;
          if (!primaryUuid) throw new Error('请先选择要保留的主号 UUID。');
          const conflict = state.adminPlayerIdentityConflicts?.get(String(pidMerge.dataset.pidMerge));
          const secondaryUuid = (conflict?.uuids || []).find(uuid => uuid !== primaryUuid);
          if (!secondaryUuid) throw new Error('冲突记录里找不到要合并的另一个 UUID。');
          if (!confirm('确认把 ' + secondaryUuid + ' 的库存和身份全部合并进 ' + primaryUuid + ' 吗？此操作会把被合并号的账本、成员身份、登录密码都归到主号名下，且不可撤销。')) return;
          const data = await post('/api/admin/identity/merge', { primaryUuid, secondaryUuid });
          toast(data.message);
          await loadAdminSubscriptionConfig();
        } else if (mmDeduct) {
          const ok = confirm('确认清除这条缺失物品对应的账本库存吗？');
          if (!ok) return;
          const data = await post('/api/admin/mismatch/deduct', { id: mmDeduct.dataset.adminMmDeduct });
          toast(data.message);
          await loadAdminMismatches();
        } else if (mmResolve) {
          const card = mmResolve.closest('[data-admin-card]');
          const targetOwnerUuid = card.querySelector('[data-mm-target]').value;
          if (!targetOwnerUuid) throw new Error('请选择多余物品要转入的目标仓库。');
          const data = await post('/api/admin/mismatch/resolve', { id: mmResolve.dataset.adminMmResolve, targetOwnerUuid });
          toast(data.message);
          await loadAdminMismatches();
        } else if (aliasDetailSave) {
          if (!state.adminAliasItem) throw new Error('请先选择物品。');
          const input = $('adminAliasDetailInput');
          const data = await post('/api/admin/alias/save', { itemKey: state.adminAliasItem.itemKey, alias: input.value, category: $('adminAliasDetailCategory').value, updateDisplayName: $('adminAliasDetailUseDisplayName').checked });
          toast(data.message);
          await loadAdminAliases();
        } else if (aliasSave) {
          const row = aliasSave.closest('.alias-row');
          const input = row.querySelector('[data-admin-alias-input]');
          const data = await post('/api/admin/alias/save', { itemKey: row.dataset.item, alias: input.value });
          toast(data.message);
          await loadAdminAliases();
        } else if (aliasDelete) {
          const deletedAlias = aliasDelete.dataset.adminAliasDelete;
          const data = await post('/api/admin/alias/delete', { alias: deletedAlias });
          toast(data.message);
          if (state.adminGlobalAliasItem) {
            state.adminGlobalAliasItem.globalAliases = (state.adminGlobalAliasItem.globalAliases || []).filter(alias => alias.toLowerCase() !== deletedAlias.toLowerCase());
            openGlobalAliasModal(state.adminGlobalAliasItem);
            await loadAdminInventory();
          } else {
            await loadAdminAliases();
          }
        } else if (adminAliasCard) {
          const row = state.adminAliasRows?.get(adminAliasCard.dataset.adminAliasCard);
          if (row) renderAdminAliasDetail(row);
        } else if (quotaSave) {
          const row = quotaSave.closest('tr');
          const data = await post('/api/admin/quota/save', { ownerUuid: row.dataset.owner, quotaSlots: row.querySelector('[data-quota-value]').value });
          toast(data.message);
          await loadAdminWarehouses();
        } else if (adminCard) {
          const key = adminCard.dataset.adminCard;
          const row = state.adminInventoryRows.get(key);
          if (!row) return;
          if (state.adminAliasMode) {
            openGlobalAliasModal(row);
            return;
          }
          if (state.adminSelected.has(key)) {
            state.adminSelected.delete(key);
          } else {
            state.adminSelected.set(key, { ...row, selectionKey: key, selectedAmount: Math.max(1, Math.min(Number(row.amount || 1), 64)) });
          }
          adminCard.classList.toggle('selected', state.adminSelected.has(key));
          renderAdminTransferSelection();
        }
      } catch (error) {
        toast(error.message);
      }
    });

    document.addEventListener('change', async event => {
      if (event.target.closest('[data-mm-check]')) {
        updateAdminMmBatchCount();
        return;
      }
      const adminAmount = event.target.closest('[data-admin-pick-amount]');
      if (adminAmount) {
        const key = adminAmount.closest('[data-admin-pick]').dataset.adminPick;
        const row = state.adminSelected.get(key);
        if (row) {
          row.selectedAmount = Math.max(1, Math.min(Number(row.amount || 1), Number.parseInt(adminAmount.value, 10) || 1));
          adminAmount.value = row.selectedAmount;
        }
        return;
      }
      const adminRoleSelect = event.target.closest('[data-admin-org-role]');
      if (adminRoleSelect) {
        try {
          const card = adminRoleSelect.closest('[data-admin-org-detail]');
          const member = adminRoleSelect.closest('[data-admin-org-member]');
          const data = await post('/api/admin/organization-warehouse/member/role', { warehouse: card.dataset.adminOrgDetail, playerUuid: member.dataset.adminOrgMember, role: adminRoleSelect.value });
          toast(data.message);
          await loadAdminOrganizationDetail(card.dataset.adminOrgDetail);
        } catch (error) {
          toast(error.message);
          if (state.adminOrganizationName) await loadAdminOrganizationDetail(state.adminOrganizationName).catch(() => {});
        }
        return;
      }
      const roleSelect = event.target.closest('[data-member-role]');
      if (!roleSelect) return;
      try {
        const card = roleSelect.closest('[data-warehouse]');
        const member = roleSelect.closest('[data-member]');
        const data = await post('/api/warehouse-admin/member/role', { warehouse: card.dataset.warehouse, playerUuid: member.dataset.member, role: roleSelect.value });
        toast(data.message);
        await loadWarehouseAdminOrganizations();
      } catch (error) {
        toast(error.message);
        await loadWarehouseAdminOrganizations().catch(() => {});
      }
    });

    loadMe().catch(error => toast(error.message));
  </script>
</body>
</html>`

module.exports = CloudStoreWebServer
