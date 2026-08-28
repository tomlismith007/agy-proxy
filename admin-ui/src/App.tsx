import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { OverviewCard } from '@/components/overview-card'
import { ApiKeyCard } from '@/components/apikey-card'
import { AccountsCard } from '@/components/accounts-card'
import { ModelsCard } from '@/components/models-card'
import { StatsCard } from '@/components/stats-card'
import { SettingsCard } from '@/components/settings-card'
import { GuideCard } from '@/components/guide-card'
import { useConfirm } from '@/components/confirm'
import { AppSidebar, parseSectionHash, type SectionId } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import {
  fmtUptime,
  get,
  post,
  type AccountRec,
  type DayUsageSummary,
  type GatewayConfig,
  type ModelEntry,
  type Overview,
  type StatsSnapshot,
} from '@/lib/api'
import { errMsg } from '@/lib/ui'

export default function App() {
  const confirm = useConfirm()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [accounts, setAccounts] = useState<AccountRec[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [modelsSource, setModelsSource] = useState('')
  const [stats, setStats] = useState<StatsSnapshot | null>(null)
  const [usageDays, setUsageDays] = useState<DayUsageSummary[] | null>(null)
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [, setUptimeTick] = useState(0)
  const [section, setSection] = useState<SectionId>(parseSectionHash)
  const fetchedAtRef = useRef(0)
  const uptimeBaseRef = useRef<number | null>(null)
  const pausedRef = useRef(false)

  const selectSection = useCallback((id: SectionId) => {
    setSection(id)
    history.replaceState(null, '', `#${id}`)
    window.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      setSection(parseSectionHash())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const loadOverview = useCallback(async () => {
    try {
      const o = await get<Overview>('/admin/overview')
      setOverview(o)
      setConnected(true)
      fetchedAtRef.current = Date.now()
      uptimeBaseRef.current = o.uptimeSeconds
      pausedRef.current = o.paused
    } catch {
      setConnected(false)
    }
  }, [])

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts((await get<{ accounts: AccountRec[] }>('/admin/accounts')).accounts)
    } catch {
      /* transient */
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      setStats(await get<StatsSnapshot>('/admin/stats'))
    } catch {
      /* transient */
    }
  }, [])

  const loadUsage = useCallback(async () => {
    try {
      setUsageDays((await get<{ days: DayUsageSummary[] }>('/admin/usage/days?limit=30')).days)
    } catch {
      /* transient */
    }
  }, [])

  const loadModels = useCallback(async () => {
    try {
      const r = await get<{ source: string; models: ModelEntry[]; error?: string }>('/admin/models')
      setModels(r.models)
      setModelsSource(r.source)
      if (r.error) toast.error('模型发现失败，已回退内置目录：' + r.error, { duration: 6000 })
    } catch {
      /* transient */
    }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await get<GatewayConfig>('/admin/config'))
    } catch (e) {
      toast.error('配置加载失败：' + errMsg(e))
    }
  }, [])

  const refreshLive = useCallback(() => {
    void loadOverview()
    void loadAccounts()
    void loadStats()
  }, [loadOverview, loadAccounts, loadStats])

  useEffect(() => {
    void loadConfig()
    refreshLive()
    void loadModels()
  }, [loadConfig, refreshLive, loadModels])

  // Usage history loads when its section is opened (kept out of refreshLive,
  // which runs on every page) and then rides the auto-refresh poll while visible.
  useEffect(() => {
    if (section === 'stats') void loadUsage()
  }, [section, loadUsage])

  useEffect(() => {
    const timer = setInterval(() => {
      if (autoRefresh && !document.hidden && !pausedRef.current) {
        refreshLive()
        if (section === 'stats') void loadUsage()
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [autoRefresh, refreshLive, section, loadUsage])

  useEffect(() => {
    const timer = setInterval(() => setUptimeTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const togglePause = async () => {
    if (!overview) return
    try {
      if (overview.paused) {
        await post('/admin/resume')
        toast.success('网关已恢复，/v1/* 正常服务')
      } else {
        const ok = await confirm({
          title: '暂停网关',
          text: '暂停后所有 /v1/* 请求立即返回 503，不再产生任何上游流量。\n随时可以在此页面或 agy-proxy resume 恢复。',
          yes: '暂停',
          danger: true,
        })
        if (!ok) return
        await post('/admin/pause')
        toast.success('网关已暂停')
      }
      await loadOverview()
    } catch (e) {
      toast.error('操作失败：' + errMsg(e))
    }
  }

  const uptime =
    uptimeBaseRef.current !== null
      ? fmtUptime(uptimeBaseRef.current + Math.floor((Date.now() - fetchedAtRef.current) / 1000)) + ' 运行'
      : '—'

  return (
    <SidebarProvider>
      <AppSidebar
        section={section}
        onSelect={selectSection}
        overview={overview}
        connected={connected}
        uptime={uptime}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onRefresh={refreshLive}
        onTogglePause={() => void togglePause()}
      />
      <SidebarInset>
        <div className="mx-auto w-full max-w-6xl px-8 py-8">
          {section === 'overview' && <OverviewCard overview={overview} uptime={uptime} />}
          {section === 'apikey' && (
            <ApiKeyCard config={config} onChanged={() => void loadConfig()} />
          )}
          {section === 'accounts' && (
            <AccountsCard
              accounts={accounts}
              onChanged={() => {
                refreshLive()
                void loadModels()
              }}
            />
          )}
          {section === 'models' && (
            <ModelsCard models={models} source={modelsSource} onReload={() => void loadModels()} />
          )}
          {section === 'stats' && <StatsCard stats={stats} usageDays={usageDays} />}
          {/* Saved config must re-fetch /admin/config so badges stay truthful. */}
          {section === 'settings' && (
            <SettingsCard
              config={config}
              onSaved={() => {
                refreshLive()
                void loadConfig()
              }}
            />
          )}
          {section === 'guide' && <GuideCard config={config} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
