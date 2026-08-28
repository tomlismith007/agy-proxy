import {
  ActivityIcon,
  BookOpenIcon,
  BoxesIcon,
  ChartColumnIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SettingsIcon,
  UsersIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import type { Overview } from '@/lib/api'

export const SECTIONS = [
  { id: 'overview', label: '服务概览', icon: LayoutDashboardIcon },
  { id: 'apikey', label: '接入密钥', icon: KeyRoundIcon },
  { id: 'accounts', label: '账号池', icon: UsersIcon },
  { id: 'models', label: '模型目录', icon: BoxesIcon },
  { id: 'stats', label: '请求统计', icon: ChartColumnIcon },
  { id: 'settings', label: '网关设置', icon: SettingsIcon },
  { id: 'guide', label: '接入指南', icon: BookOpenIcon },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

export function parseSectionHash(): SectionId {
  const id = window.location.hash.replace(/^#/, '') as SectionId
  return SECTIONS.some((s) => s.id === id) ? id : 'overview'
}

type AppSidebarProps = {
  section: SectionId
  onSelect: (id: SectionId) => void
  overview: Overview | null
  connected: boolean | null
  uptime: string
  autoRefresh: boolean
  onAutoRefreshChange: (v: boolean) => void
  onRefresh: () => void
  onTogglePause: () => void
}

export function AppSidebar({
  section,
  onSelect,
  overview,
  connected,
  uptime,
  autoRefresh,
  onAutoRefreshChange,
  onRefresh,
  onTogglePause,
}: AppSidebarProps) {
  return (
    <Sidebar variant="sidebar" collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center">
          <ServerCogIcon className="text-primary size-5 shrink-0" />
          <span className="text-[15px] font-bold whitespace-nowrap group-data-[collapsible=icon]:hidden">
            agy-proxy
          </span>
          <span className="text-muted-foreground font-mono text-xs group-data-[collapsible=icon]:hidden">
            v{overview?.version ?? '…'}
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {SECTIONS.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    size="lg"
                    isActive={section === item.id}
                    tooltip={item.label}
                    onClick={() => onSelect(item.id)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-2">
        <div className="flex flex-wrap items-center gap-1.5 group-data-[collapsible=icon]:hidden">
          <Badge variant={connected === false ? 'destructive' : overview?.paused ? 'outline' : 'secondary'}>
            <ActivityIcon />
            {connected === null
              ? '连接中…'
              : connected === false
                ? '无法连接'
                : overview!.paused
                  ? '已暂停'
                  : `运行中 · ${overview!.accounts.enabled}/${overview!.accounts.total} 账号`}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {uptime}
          </Badge>
        </div>
        {overview && (
          <Button
            variant={overview.paused ? 'destructive' : 'outline'}
            size="sm"
            className="w-full"
            onClick={onTogglePause}
          >
            {overview.paused ? <PlayIcon /> : <PauseIcon />}
            <span className="group-data-[collapsible=icon]:hidden">
              {overview.paused ? '恢复服务' : '暂停服务'}
            </span>
          </Button>
        )}
        <div className="flex h-7 items-center justify-between group-data-[collapsible=icon]:justify-center">
          <div className="flex items-center gap-1.5 group-data-[collapsible=icon]:hidden">
            <Switch id="auto-refresh" checked={autoRefresh} onCheckedChange={onAutoRefreshChange} />
            <label htmlFor="auto-refresh" className="text-muted-foreground cursor-pointer text-xs select-none">
              自动刷新
            </label>
          </div>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onRefresh} />}>
              <RefreshCwIcon />
            </TooltipTrigger>
            <TooltipContent>立即刷新</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
